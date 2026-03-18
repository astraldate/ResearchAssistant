import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  BookOpen,
  ChevronDown,
  ChevronUp,
  FilePlus,
  FolderOpen,
  LayoutGrid,
  MessageSquareText,
  Search,
  Settings,
  StickyNote,
  X,
} from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import { FileNode, FileTree } from "./components/FileTree";
import { ChatInterface } from "./components/ChatInterface";
import { CardLibrary } from "./components/CardLibrary";
import { PdfDock } from "./components/PdfDock";
import { resolveMirrorModel } from "./utils/modelMirrors";
import "./App.css";

type InferenceMode = "single_mm" | "dual_pipeline";
type IngestMode = "overwrite" | "incremental";
type SidebarTool = "workspace" | "citations" | "notes" | "knowledge" | "cards";
type StatusTone = "info" | "error";
type AiRequirement = "chat" | "index";
type LeftDrawerView = "workspace" | "models" | null;

interface InferenceSettings {
  mode: InferenceMode;
}

interface IngestProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

interface StatusBanner {
  message: string;
  tone: StatusTone;
  action?: StatusBannerAction;
}

interface StatusBannerAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface WorkspaceImportResult {
  source_path: string;
  workspace_path: string;
  ingest_path: string;
  tree: FileNode;
}

interface WorkspaceSnapshot {
  workspace_path: string;
  tree: FileNode;
}

interface ZoteroStorageCandidate {
  data_dir: string;
  storage_path: string;
  source: string;
  pdf_count: number;
}

interface ZoteroImportResult {
  source_storage_path: string;
  workspace_path: string;
  ingest_path: string;
  tree: FileNode;
  copied_pdfs: number;
  skipped_existing: number;
}

interface CardSettings {
  active_root: string;
  using_custom_root: boolean;
}

interface PairedDeviceSummary {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  lastSeenAt?: string | null;
}

interface MobileCompanionStatus {
  apiVersion: string;
  serviceName: string;
  pairCode: string;
  listenerPort: number;
  baseUrls: string[];
  pairedDevices: PairedDeviceSummary[];
  inboxCount: number;
  reviewRecordCount: number;
  cardCount: number;
  running: boolean;
  lastError?: string | null;
  inboxDir: string;
  reviewStateDir: string;
}

interface OllamaVersionInfo {
  version: string;
}

interface OllamaModelSummary {
  name: string;
}

interface PrivateOllamaRuntimeInfo {
  executable_path?: string | null;
  reported_version?: string | null;
  client_version?: string | null;
  runtime_root: string;
}

interface OllamaRuntimeProgress {
  status: string;
  total?: number;
  completed?: number;
}

interface CitationItem {
  id: string;
  path: string;
  page: number;
  snippet: string;
  createdAt: number;
}

interface NoteItem {
  id: string;
  text: string;
  createdAt: number;
}

interface ChatSessionSnapshot {
  citations?: CitationItem[];
  notes?: NoteItem[];
}

interface DocumentResult {
  id: string;
  path: string;
  content: string;
}

const REQUIRED_MODELS = {
  embedding: "nomic-embed-text",
  chat: "qwen2.5:0.5b",
};

const OLLAMA_MIN_RECOMMENDED_VERSION = "0.17.7";

const STAGE_LABELS: Record<string, string> = {
  scan: "扫描文件",
  chunk: "切分文本",
  summarize: "生成摘要",
  embed: "建立向量",
  finalize: "保存索引",
};

const OLLAMA_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;
const CHAT_SESSION_KEY = "ra_chat_session_v3";

const isPdfFile = (path: string | null | undefined) =>
  Boolean(path && /\.pdf$/i.test(path));
const DEFAULT_TWO_PANEL_LAYOUT = { main: 55, pdf: 45 };
const DEFAULT_WORKSPACE_DRAWER_WIDTH = 320;
const MIN_WORKSPACE_DRAWER_WIDTH = 220;
const MAX_WORKSPACE_DRAWER_WIDTH = 520;
const AI_IDLE_CHECK_DELAY_MS = 1200;
const logTiming = (label: string, startedAt: number) => {
  const duration = Math.round(performance.now() - startedAt);
  console.info(`[startup] ${label}: ${duration}ms`);
};

const attachChildrenToTree = (
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] =>
  nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, has_children: children.length > 0 };
    }
    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: attachChildrenToTree(node.children, targetPath, children),
      };
    }
    return node;
  });

const normalizeOllamaVersion = (value: string | null | undefined) => {
  const normalized = value?.trim();
  if (!normalized) return "unknown";
  const match = normalized.match(OLLAMA_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : normalized;
};

const parseOllamaVersionParts = (value: string | null | undefined) => {
  const match = normalizeOllamaVersion(value).match(OLLAMA_VERSION_PATTERN);
  if (!match) return [0, 0, 0];
  return match.slice(1).map((part) => Number.parseInt(part, 10));
};

const compareOllamaVersions = (
  left: string | null | undefined,
  right: string | null | undefined,
) => {
  const leftParts = parseOllamaVersionParts(left);
  const rightParts = parseOllamaVersionParts(right);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isOllamaUpgradeRequiredError = (message: string) => {
  const normalized = message.toLowerCase();
  const mentionsOllama =
    normalized.includes("ollama") || message.includes("Ollama");
  const indicatesUpgrade =
    normalized.includes("too old") ||
    normalized.includes("outdated") ||
    normalized.includes("unsupported") ||
    normalized.includes("upgrade") ||
    normalized.includes("update") ||
    message.includes("版本过旧") ||
    message.includes("至少需要");
  return mentionsOllama && indicatesUpgrade;
};

function App() {
  const appStartedAtRef = useRef(performance.now());
  const [files, setFiles] = useState<FileNode[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [isPdfDockVisible, setIsPdfDockVisible] = useState(false);
  const [isPdfFocusMode, setIsPdfFocusMode] = useState(false);
  const [activeLeftDrawer, setActiveLeftDrawer] =
    useState<LeftDrawerView>("workspace");
  const [workspaceDrawerWidth, setWorkspaceDrawerWidth] = useState(
    DEFAULT_WORKSPACE_DRAWER_WIDTH,
  );
  const [isWorkspaceDrawerResizing, setIsWorkspaceDrawerResizing] =
    useState(false);
  const [currentModel, setCurrentModel] = useState("");
  const [activeSidebarTool, setActiveSidebarTool] =
    useState<SidebarTool>("workspace");
  const [ingestMode, setIngestMode] = useState<IngestMode>("overwrite");
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(
    null,
  );
  const [isIngesting, setIsIngesting] = useState(false);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [inferenceMode, setInferenceMode] =
    useState<InferenceMode>("single_mm");
  const [isSavingInferenceMode, setIsSavingInferenceMode] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [cardSettings, setCardSettings] = useState<CardSettings | null>(null);
  const [cardSettingsError, setCardSettingsError] = useState<string | null>(
    null,
  );
  const [cardsRefreshToken, setCardsRefreshToken] = useState(0);
  const [mobileStatus, setMobileStatus] =
    useState<MobileCompanionStatus | null>(null);
  const [mobileStatusError, setMobileStatusError] = useState<string | null>(
    null,
  );
  const [isLoadingMobileStatus, setIsLoadingMobileStatus] = useState(false);
  const [isRefreshingMobilePairCode, setIsRefreshingMobilePairCode] =
    useState(false);
  const [isStatusBannerExpanded, setIsStatusBannerExpanded] = useState(false);
  const [sidebarCitations, setSidebarCitations] = useState<CitationItem[]>([]);
  const [sidebarNotes, setSidebarNotes] = useState<NoteItem[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<DocumentResult[]>(
    [],
  );
  const [isKnowledgeSearching, setIsKnowledgeSearching] = useState(false);
  const [lastKnowledgeQuery, setLastKnowledgeQuery] = useState("");

  const statusTimerRef = useRef<number | null>(null);
  const previousPdfPathRef = useRef<string | null>(null);
  const focusRestoreLayoutRef = useRef(DEFAULT_TWO_PANEL_LAYOUT);
  const mainPanelRef = useRef<PanelImperativeHandle | null>(null);
  const pdfPanelRef = useRef<PanelImperativeHandle | null>(null);
  const aiPreparationPromiseRef = useRef<Promise<string> | null>(null);
  const aiPreparedStateRef = useRef<{ chat: boolean; index: boolean }>({
    chat: false,
    index: false,
  });

  const progressPercent = useMemo(() => {
    if (!ingestProgress || ingestProgress.total <= 0) return 0;
    return Math.min(
      100,
      Math.round((ingestProgress.current / ingestProgress.total) * 100),
    );
  }, [ingestProgress]);
  const activePdfPath = useMemo(
    () => (isPdfFile(activeFilePath) ? activeFilePath : null),
    [activeFilePath],
  );

  const stageLabel = STAGE_LABELS[ingestProgress?.stage || ""] || "处理中";
  const isWorkspaceDrawerOpen = activeLeftDrawer === "workspace";
  const isModelDrawerOpen = activeLeftDrawer === "models";
  const isLeftDrawerOpen = activeLeftDrawer !== null;

  const clampWorkspaceDrawerWidth = useCallback((nextWidth: number) => {
    const viewportLimit = Math.max(
      MIN_WORKSPACE_DRAWER_WIDTH,
      window.innerWidth - 320,
    );
    const maxWidth = Math.min(MAX_WORKSPACE_DRAWER_WIDTH, viewportLimit);
    return Math.min(maxWidth, Math.max(MIN_WORKSPACE_DRAWER_WIDTH, nextWidth));
  }, []);

  const handleToggleWorkspaceDrawer = useCallback(() => {
    if (isPdfFocusMode) return;
    setActiveLeftDrawer((current) =>
      current === "workspace" ? null : "workspace",
    );
  }, [isPdfFocusMode]);

  const handleToggleModelDrawer = useCallback(() => {
    if (isPdfFocusMode) return;
    setActiveLeftDrawer((current) => (current === "models" ? null : "models"));
  }, [isPdfFocusMode]);

  const handleWorkspaceDrawerResizeStart = useCallback(
    (clientX: number) => {
      if (!isLeftDrawerOpen || isPdfFocusMode) return;

      const startWidth = workspaceDrawerWidth;
      setIsWorkspaceDrawerResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (event: PointerEvent) => {
        const deltaX = event.clientX - clientX;
        setWorkspaceDrawerWidth(
          clampWorkspaceDrawerWidth(startWidth + deltaX),
        );
      };

      const handlePointerUp = () => {
        setIsWorkspaceDrawerResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [
      clampWorkspaceDrawerWidth,
      isPdfFocusMode,
      isLeftDrawerOpen,
      workspaceDrawerWidth,
    ],
  );

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  const showStatus = useCallback(
    (
      message: string,
      tone: StatusTone = "info",
      timeoutMs?: number,
      action?: StatusBannerAction,
    ) => {
      clearStatusTimer();
      const nextBanner: StatusBanner = { message, tone, action };
      const startsExpanded = Boolean(
        (timeoutMs && timeoutMs > 0) || tone === "error" || action,
      );
      setIsStatusBannerExpanded((current) => current || startsExpanded);
      setStatusBanner(nextBanner);
      if (timeoutMs && timeoutMs > 0) {
        statusTimerRef.current = window.setTimeout(() => {
          setStatusBanner((current) => {
            if (current === nextBanner) {
              setIsStatusBannerExpanded(false);
              return null;
            }
            return current;
          });
          statusTimerRef.current = null;
        }, timeoutMs);
      }
    },
    [clearStatusTimer],
  );

  const showTemporaryStatus = useCallback(
    (
      message: string,
      tone: StatusTone = "info",
      timeoutMs = 3200,
      action?: StatusBannerAction,
    ) => {
      showStatus(message, tone, timeoutMs, action);
    },
    [showStatus],
  );

  const showPersistentStatus = useCallback(
    (
      message: string,
      tone: StatusTone = "info",
      action?: StatusBannerAction,
    ) => {
      showStatus(message, tone, undefined, action);
    },
    [showStatus],
  );

  const clearStatus = useCallback(() => {
    clearStatusTimer();
    setStatusBanner(null);
    setIsStatusBannerExpanded(false);
  }, [clearStatusTimer]);

  const readOllamaVersion = useCallback(async () => {
    const versionInfo = await invoke<OllamaVersionInfo>("get_ollama_version");
    return normalizeOllamaVersion(versionInfo.version);
  }, []);

  const getPrivateOllamaRuntimeInfo = useCallback(async () => {
    try {
      return await invoke<PrivateOllamaRuntimeInfo>(
        "get_private_ollama_runtime_info",
      );
    } catch (error) {
      console.warn("Failed to inspect private Ollama runtime:", error);
      return null;
    }
  }, []);

  const getPrivateRuntimeVersion = useCallback(
    (runtime: PrivateOllamaRuntimeInfo | null | undefined) => {
      return runtime?.client_version || runtime?.reported_version || null;
    },
    [],
  );
  const getInstalledModels = useCallback(async () => {
    return await invoke<OllamaModelSummary[]>("get_ollama_models");
  }, []);

  const waitForOllamaReady = useCallback(
    async (attempts = 12, delayMs = 500) => {
      for (let index = 0; index < attempts; index += 1) {
        try {
          if (await invoke<boolean>("check_ollama_status")) {
            return true;
          }
        } catch {
          // Ignore transient readiness checks while booting.
        }
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      return false;
    },
    [],
  );

  const buildOllamaUpgradeMessage = useCallback(
    async (currentVersion?: string | null) => {
      const runtime = await getPrivateOllamaRuntimeInfo();
      const privateVersionRaw = getPrivateRuntimeVersion(runtime);
      const privateVersion = privateVersionRaw
        ? normalizeOllamaVersion(privateVersionRaw)
        : null;
      if (
        privateVersion &&
        compareOllamaVersions(privateVersion, OLLAMA_MIN_RECOMMENDED_VERSION) >=
          0
      ) {
        return `当前 Ollama 服务仍然过旧（当前 ${currentVersion ?? "unknown"}），但应用私有引擎已准备到 ${privateVersion}。请点击“更新引擎”切换到应用私有引擎。`;
      }
      if (currentVersion && currentVersion.trim()) {
        return `当前 Ollama 版本过旧（当前 ${currentVersion}，至少需要 ${OLLAMA_MIN_RECOMMENDED_VERSION}）。请点击“更新引擎”，由应用自动下载并切换私有 Ollama 引擎。`;
      }
      return `当前 Ollama 引擎尚未准备好（至少需要 ${OLLAMA_MIN_RECOMMENDED_VERSION}）。请点击“更新引擎”，由应用自动下载并切换私有 Ollama 引擎。`;
    },
    [getPrivateOllamaRuntimeInfo, getPrivateRuntimeVersion],
  );

  const activatePrivateOllama = useCallback(
    async (forceUpdate: boolean, statusMessage: string) => {
      try {
        showPersistentStatus(statusMessage);
        const runtime = await invoke<PrivateOllamaRuntimeInfo>(
          "activate_private_ollama",
          { forceUpdate },
        );
        await new Promise((resolve) => window.setTimeout(resolve, 1600));
        const privateVersion = getPrivateRuntimeVersion(runtime);
        if (
          privateVersion &&
          compareOllamaVersions(
            privateVersion,
            OLLAMA_MIN_RECOMMENDED_VERSION,
          ) >= 0
        ) {
          return normalizeOllamaVersion(privateVersion);
        }
        const currentVersion = await readOllamaVersion();
        if (
          compareOllamaVersions(
            currentVersion,
            OLLAMA_MIN_RECOMMENDED_VERSION,
          ) < 0
        ) {
          return null;
        }
        return currentVersion;
      } catch (error) {
        console.warn("Failed to activate private Ollama runtime:", error);
        return null;
      }
    },
    [getPrivateRuntimeVersion, readOllamaVersion, showPersistentStatus],
  );

  const handleUpgradeOllama = useCallback(async () => {
    const switchedVersion = await activatePrivateOllama(
      true,
      "正在更新并切换应用私有 Ollama 引擎...",
    );
    if (switchedVersion) {
      showTemporaryStatus(
        `已切换到应用私有 Ollama ${switchedVersion}。`,
        "info",
        3200,
      );
      return;
    }
    showOllamaUpgradeStatus(await buildOllamaUpgradeMessage());
  }, [activatePrivateOllama, buildOllamaUpgradeMessage, showTemporaryStatus]);

  const showOllamaUpgradeStatus = useCallback(
    (message: string) => {
      showPersistentStatus(message, "error", {
        label: "更新引擎",
        onClick: () => {
          void handleUpgradeOllama();
        },
      });
    },
    [handleUpgradeOllama, showPersistentStatus],
  );
  const ensureAiReady = useCallback(
    async (requirement: AiRequirement = "chat") => {
      const preparedState = aiPreparedStateRef.current;
      const alreadyPrepared =
        requirement === "index" ? preparedState.index : preparedState.chat;
      if (alreadyPrepared && currentModel) {
        return currentModel;
      }

      if (aiPreparationPromiseRef.current) {
        return await aiPreparationPromiseRef.current;
      }

      const task = (async () => {
        showPersistentStatus("正在准备 AI 环境...");

        let isRunning = await invoke<boolean>("check_ollama_status");
        if (!isRunning) {
          const privateVersion = await activatePrivateOllama(
            false,
            "正在准备应用私有 Ollama 引擎...",
          );
          if (!privateVersion) {
            showPersistentStatus("正在启动应用内置 Ollama 引擎...");
            await invoke("start_ollama");
          }

          isRunning = await waitForOllamaReady();
          if (!isRunning) {
            throw new Error("Ollama 启动超时，请稍后重试。");
          }
        }

        try {
          const currentVersion = await readOllamaVersion();
          if (
            compareOllamaVersions(
              currentVersion,
              OLLAMA_MIN_RECOMMENDED_VERSION,
            ) < 0
          ) {
            const privateRuntime = await getPrivateOllamaRuntimeInfo();
            const installedPrivateVersion =
              getPrivateRuntimeVersion(privateRuntime);
            const shouldRedownload =
              !installedPrivateVersion ||
              compareOllamaVersions(
                installedPrivateVersion,
                OLLAMA_MIN_RECOMMENDED_VERSION,
              ) < 0;
            const switchedVersion = await activatePrivateOllama(
              shouldRedownload,
              shouldRedownload
                ? `检测到旧版 Ollama（当前 ${currentVersion}），正在更新应用私有引擎...`
                : `检测到旧版 Ollama（当前 ${currentVersion}），正在切换到已安装的私有引擎...`,
            );
            if (!switchedVersion) {
              showOllamaUpgradeStatus(
                await buildOllamaUpgradeMessage(currentVersion),
              );
            } else {
              await waitForOllamaReady();
            }
          }
        } catch (error) {
          console.warn(
            "Failed to validate Ollama version before AI use:",
            error,
          );
        }

        const pullModel = async (name: string) => {
          const mirror = resolveMirrorModel(name);
          if (mirror) {
            try {
              showPersistentStatus(`正在通过镜像拉取 ${name}...`);
              await invoke("pull_model_from_modelscope", {
                name,
                url: mirror.url,
                filename: mirror.filename,
              });
              return;
            } catch (error) {
              console.error("Mirror pull failed:", error);
            }
          }
          showPersistentStatus(`正在拉取模型 ${name}...`);
          await invoke("pull_ollama_model", { name });
        };

        let models = await getInstalledModels();
        let names = models.map((model) => model.name);

        if (
          requirement === "index" &&
          !names.some((name) => name.includes(REQUIRED_MODELS.embedding))
        ) {
          await pullModel(REQUIRED_MODELS.embedding);
        }
        if (!names.some((name) => name.includes(REQUIRED_MODELS.chat))) {
          await pullModel(REQUIRED_MODELS.chat);
        }

        models = await getInstalledModels();
        names = models.map((model) => model.name);
        const selectedModel =
          names.find((name) => name === REQUIRED_MODELS.chat) ||
          names.find((name) => name.includes(REQUIRED_MODELS.chat)) ||
          names[0] ||
          currentModel ||
          REQUIRED_MODELS.chat;

        setCurrentModel(selectedModel);
        aiPreparedStateRef.current = {
          chat: true,
          index:
            requirement === "index" ? true : aiPreparedStateRef.current.index,
        };
        clearStatus();
        return selectedModel;
      })();

      aiPreparationPromiseRef.current = task;
      try {
        return await task;
      } catch (error) {
        const message = getErrorMessage(error);
        if (isOllamaUpgradeRequiredError(message)) {
          showOllamaUpgradeStatus(await buildOllamaUpgradeMessage());
        } else {
          showPersistentStatus(`AI 环境准备失败：${message}`, "error");
        }
        throw error;
      } finally {
        aiPreparationPromiseRef.current = null;
      }
    },
    [
      activatePrivateOllama,
      buildOllamaUpgradeMessage,
      clearStatus,
      currentModel,
      getInstalledModels,
      getPrivateOllamaRuntimeInfo,
      getPrivateRuntimeVersion,
      readOllamaVersion,
      showOllamaUpgradeStatus,
      showPersistentStatus,
      waitForOllamaReady,
    ],
  );

  const handleChildStatus = useCallback(
    (message: string, tone: StatusTone = "info", persistent = false) => {
      if (tone === "error" && isOllamaUpgradeRequiredError(message)) {
        void (async () => {
          showOllamaUpgradeStatus(await buildOllamaUpgradeMessage());
        })();
        return;
      }
      if (persistent || tone === "error") {
        showPersistentStatus(message, tone);
        return;
      }
      showTemporaryStatus(message, tone);
    },
    [
      buildOllamaUpgradeMessage,
      showOllamaUpgradeStatus,
      showPersistentStatus,
      showTemporaryStatus,
    ],
  );

  useEffect(() => () => clearStatusTimer(), []);

  useEffect(() => {
    const syncDrawerWidth = () => {
      setWorkspaceDrawerWidth((current) =>
        clampWorkspaceDrawerWidth(current),
      );
    };

    window.addEventListener("resize", syncDrawerWidth);
    return () => window.removeEventListener("resize", syncDrawerWidth);
  }, [clampWorkspaceDrawerWidth]);

  useEffect(() => {
    const storedMode = localStorage.getItem("ra_ingest_mode_v1");
    if (storedMode === "overwrite" || storedMode === "incremental") {
      setIngestMode(storedMode);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ra_ingest_mode_v1", ingestMode);
  }, [ingestMode]);

  const loadInferenceSettings = async () => {
    const startedAt = performance.now();
    try {
      const settings = await invoke<InferenceSettings>(
        "get_inference_settings",
      );
      setInferenceMode(settings.mode);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(`加载推理模式失败：${String(error)}`);
    } finally {
      logTiming("loadInferenceSettings", startedAt);
    }
  };

  const loadWorkspaceSnapshot = async () => {
    const startedAt = performance.now();
    try {
      const snapshot = await invoke<WorkspaceSnapshot>(
        "get_workspace_snapshot",
      );
      setWorkspacePath(snapshot.workspace_path);
      setFiles([snapshot.tree]);
    } catch (error) {
      console.error("Failed to load workspace snapshot:", error);
    } finally {
      logTiming("loadWorkspaceSnapshot", startedAt);
    }
  };

  const loadCardSettings = async () => {
    const startedAt = performance.now();
    try {
      const settings = await invoke<CardSettings>("get_card_settings");
      setCardSettings(settings);
      setCardSettingsError(null);
    } catch (error) {
      setCardSettingsError(`加载知识卡片路径失败：${String(error)}`);
    } finally {
      logTiming("loadCardSettings", startedAt);
    }
  };

  const loadMobileCompanionStatus = async () => {
    const startedAt = performance.now();
    setIsLoadingMobileStatus(true);
    try {
      const status = await invoke<MobileCompanionStatus>(
        "get_mobile_companion_status",
      );
      setMobileStatus(status);
      setMobileStatusError(null);
    } catch (error) {
      setMobileStatusError(`加载移动端配套状态失败：${String(error)}`);
    } finally {
      setIsLoadingMobileStatus(false);
      logTiming("loadMobileCompanionStatus", startedAt);
    }
  };

  const loadDirectoryChildren = useCallback(async (path: string) => {
    const startedAt = performance.now();
    try {
      const children = await invoke<FileNode[]>("list_directory_children", {
        path,
      });
      console.info(
        "[tree] app received children",
        path,
        children.length,
        children.map((child) => `${child.type_name}:${child.name}`),
      );
      setFiles((previous) => attachChildrenToTree(previous, path, children));
      return children;
    } finally {
      logTiming(`loadDirectoryChildren ${path}`, startedAt);
    }
  }, []);

  useEffect(() => {
    console.info("[startup] App mounted");
    void loadInferenceSettings();
    void loadWorkspaceSnapshot();
    void loadCardSettings();
  }, []);

  useEffect(() => {
    logTiming("firstAppEffect", appStartedAtRef.current);
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;
    void loadMobileCompanionStatus();
  }, [isSettingsOpen]);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<IngestProgress>("ingest-progress", (event) => {
      setIngestProgress(event.payload);
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<OllamaRuntimeProgress>("ollama-runtime-progress", (event) => {
      const { status, total, completed } = event.payload;
      if (!status) return;
      if (
        typeof total === "number" &&
        total > 0 &&
        typeof completed === "number"
      ) {
        const percent = Math.max(
          0,
          Math.min(100, Math.round((completed / total) * 100)),
        );
        showPersistentStatus(`${status} ${percent}%`);
        return;
      }
      showPersistentStatus(status);
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [showPersistentStatus]);

    useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;
    let cancelIdleCheck: (() => void) | null = null;

    const runIdleCheck = async () => {
      try {
        const isRunning = await invoke<boolean>("check_ollama_status");
        if (!isRunning || cancelled) return;

        const models = await getInstalledModels();
        if (cancelled || models.length === 0 || currentModel) return;

        const idleApi = window as typeof window & {
          requestIdleCallback: (cb: IdleRequestCallback) => number;
          cancelIdleCallback?: (id: number) => void;
        };
        const idleId = idleApi.requestIdleCallback(() => {
          void runIdleCheck();
        });
        cancelIdleCheck = () => idleApi.cancelIdleCallback?.(idleId);
        return;
      } catch (error) {
        console.warn("Idle check failed:", error);
      }
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void runIdleCheck();
      }, AI_IDLE_CHECK_DELAY_MS);
    };

    void runIdleCheck();

    return () => {
      cancelled = true;
      if (timerId != null) {
        window.clearTimeout(timerId);
      }
      cancelIdleCheck?.();
    };
  }, [currentModel, getInstalledModels]);

  const ingestWorkspacePath = async (path: string) => {
    setIsIngesting(true);
    setIngestProgress({
      stage: "scan",
      current: 0,
      total: 0,
      message: "正在扫描文件...",
    });
    try {
      const model = await ensureAiReady("index");
      const count = await invoke<number>("ingest_knowledge_base", {
        path,
        model,
        mode: ingestMode,
      });
      showTemporaryStatus(`索引完成，已处理 ${count} 个片段。`);
    } catch (error) {
      showPersistentStatus(`建立索引失败：${String(error)}`, "error");
    } finally {
      setIsIngesting(false);
    }
  };

  const applyImportedWorkspace = async (
    imported: WorkspaceImportResult,
    successMessage?: string,
  ) => {
    setWorkspacePath(imported.workspace_path);
    setFiles([imported.tree]);
    setActiveFilePath(null);
    showPersistentStatus("文件已导入工作空间，正在建立索引...");
    await ingestWorkspacePath(imported.ingest_path);
    if (successMessage) showTemporaryStatus(successMessage);
  };

  const applyImportedZotero = async (imported: ZoteroImportResult) => {
    setWorkspacePath(imported.workspace_path);
    setFiles([imported.tree]);
    setActiveFilePath(null);
    showPersistentStatus("Zotero PDF 已导入工作空间，正在建立索引...");
    await ingestWorkspacePath(imported.ingest_path);
    showTemporaryStatus(
      `Zotero 导入完成：复制 ${imported.copied_pdfs} 个 PDF，跳过 ${imported.skipped_existing} 个。`,
      "info",
      4200,
    );
  };

  const importAndIngestPath = async (selectedPath: string) => {
    const imported = await invoke<WorkspaceImportResult>(
      "import_directory_to_workspace",
      {
        sourcePath: selectedPath,
        mode: ingestMode,
      },
    );
    await applyImportedWorkspace(imported, "文件夹已导入工作空间。");
  };

  const importAndIngestFiles = async (selectedPaths: string[]) => {
    const imported = await invoke<WorkspaceImportResult>(
      "import_paths_to_workspace",
      {
        sourcePaths: selectedPaths,
        mode: ingestMode,
      },
    );
    await applyImportedWorkspace(
      imported,
      `已导入 ${selectedPaths.length} 个项目到工作空间。`,
    );
  };

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择要导入的文件夹",
      });
      if (!selected || typeof selected !== "string") return;
      showPersistentStatus("正在导入文件夹...");
      await importAndIngestPath(selected);
    } catch (error) {
      showPersistentStatus(`导入文件夹失败：${String(error)}`, "error");
    }
  };

  const handleOpenFiles = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        title: "选择要导入的文件",
        filters: [{ name: "资料文件", extensions: ["pdf", "md", "txt"] }],
      });
      if (!selected) return;
      const selectedPaths = Array.isArray(selected) ? selected : [selected];
      if (selectedPaths.length === 0) return;
      showPersistentStatus("正在导入文件...");
      await importAndIngestFiles(selectedPaths);
    } catch (error) {
      showPersistentStatus(`导入文件失败：${String(error)}`, "error");
    }
  };

  const pickAndImportZoteroManually = async (fallbackMessage?: string) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "请选择 Zotero 数据目录或 storage 目录",
    });
    if (!selected || typeof selected !== "string") {
      if (fallbackMessage) showPersistentStatus(fallbackMessage, "error");
      return;
    }

    const imported = await invoke<ZoteroImportResult>(
      "import_zotero_storage_to_workspace",
      {
        sourceStorage: selected,
        sourceStoragePath: selected,
        mode: ingestMode,
      },
    );
    await applyImportedZotero(imported);
  };

  const handleImportZotero = async () => {
    try {
      showPersistentStatus("正在自动查找 Zotero 存储目录...");
      const candidates = await invoke<ZoteroStorageCandidate[]>(
        "detect_zotero_storage",
      );
      if (candidates.length === 0) {
        await pickAndImportZoteroManually(
          "没有自动发现 Zotero 目录，请手动选择。 ",
        );
        return;
      }
      const best = [...candidates].sort((a, b) => b.pdf_count - a.pdf_count)[0];
      const imported = await invoke<ZoteroImportResult>(
        "import_zotero_storage_to_workspace",
        {
          sourceStorage: best.storage_path,
          sourceStoragePath: best.storage_path,
          mode: ingestMode,
        },
      );
      await applyImportedZotero(imported);
    } catch (error) {
      try {
        await pickAndImportZoteroManually(
          `自动导入 Zotero 失败：${String(error)}`,
        );
      } catch (manualError) {
        showPersistentStatus(
          `导入 Zotero 失败：${String(manualError)}`,
          "error",
        );
      }
    }
  };

  const handleFileSelect = async (node: FileNode) => {
    if (node.type_name !== "file") return;
    setActiveFilePath(node.path);
    if (node.path.toLowerCase().endsWith(".pdf")) {
      setPdfPage(1);
      setIsPdfDockVisible(true);
      return;
    }
    try {
      await invoke("open_file", { path: node.path });
    } catch (error) {
      showPersistentStatus(`打开文件失败：${String(error)}`, "error");
    }
  };

  useEffect(() => {
    if (!activePdfPath) {
      if (isPdfFocusMode) {
        setIsPdfFocusMode(false);
      }
      focusRestoreLayoutRef.current = DEFAULT_TWO_PANEL_LAYOUT;
      previousPdfPathRef.current = null;
      setIsPdfDockVisible(false);
      window.requestAnimationFrame(() => {
        mainPanelRef.current?.resize("100%");
      });
      return;
    }
    if (previousPdfPathRef.current !== activePdfPath) {
      setIsPdfDockVisible(true);
      previousPdfPathRef.current = activePdfPath;
      window.requestAnimationFrame(() => {
        mainPanelRef.current?.resize(`${DEFAULT_TWO_PANEL_LAYOUT.main}%`);
        pdfPanelRef.current?.resize(`${DEFAULT_TWO_PANEL_LAYOUT.pdf}%`);
      });
    }
  }, [activePdfPath, isPdfFocusMode]);

  useEffect(() => {
    const syncSession = () => {
      try {
        const raw = localStorage.getItem(CHAT_SESSION_KEY);
        if (!raw) {
          setSidebarCitations([]);
          setSidebarNotes([]);
          return;
        }
        const parsed = JSON.parse(raw) as ChatSessionSnapshot;
        setSidebarCitations(
          Array.isArray(parsed.citations) ? parsed.citations : [],
        );
        setSidebarNotes(Array.isArray(parsed.notes) ? parsed.notes : []);
      } catch {
        setSidebarCitations([]);
        setSidebarNotes([]);
      }
    };

    syncSession();
    const timer = window.setInterval(syncSession, 900);
    return () => window.clearInterval(timer);
  }, []);

  const handleTogglePdfFocusMode = useCallback(() => {
    if (!activePdfPath || !isPdfDockVisible) return;

    if (isPdfFocusMode) {
      const restored = focusRestoreLayoutRef.current;
      setIsPdfFocusMode(false);
      window.requestAnimationFrame(() => {
        mainPanelRef.current?.resize(`${restored.main}%`);
        pdfPanelRef.current?.resize(`${restored.pdf}%`);
      });
      return;
    }

    focusRestoreLayoutRef.current = {
      main:
        mainPanelRef.current?.getSize().asPercentage ??
        DEFAULT_TWO_PANEL_LAYOUT.main,
      pdf:
        pdfPanelRef.current?.getSize().asPercentage ??
        DEFAULT_TWO_PANEL_LAYOUT.pdf,
    };

    setIsPdfFocusMode(true);
    window.requestAnimationFrame(() => {
      mainPanelRef.current?.resize("0%");
      mainPanelRef.current?.resize("100%");
      pdfPanelRef.current?.resize("0%");
    });
  }, [activePdfPath, isPdfDockVisible, isPdfFocusMode]);

  const handleClosePdfDock = useCallback(() => {
    setIsPdfFocusMode(false);
    focusRestoreLayoutRef.current = DEFAULT_TWO_PANEL_LAYOUT;
    setIsPdfDockVisible(false);
    window.requestAnimationFrame(() => {
      mainPanelRef.current?.resize("100%");
    });
  }, []);

  const handleKnowledgeSearch = useCallback(async () => {
    const query = knowledgeQuery.trim();
    if (!query) return;
    setIsKnowledgeSearching(true);
    setLastKnowledgeQuery(query);
    try {
      const docs = await invoke<DocumentResult[]>("query_knowledge_base", {
        query,
      });
      setKnowledgeResults(docs);
    } catch (error) {
      showPersistentStatus(
        `Knowledge search failed: ${String(error)}`,
        "error",
      );
      setKnowledgeResults([]);
    } finally {
      setIsKnowledgeSearching(false);
    }
  }, [knowledgeQuery, showPersistentStatus]);

  const handleInferenceModeChange = async (nextMode: InferenceMode) => {
    setIsSavingInferenceMode(true);
    try {
      const updated = await invoke<InferenceSettings>("set_inference_mode", {
        mode: nextMode,
      });
      setInferenceMode(updated.mode);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(`保存推理模式失败：${String(error)}`);
      await loadInferenceSettings();
    } finally {
      setIsSavingInferenceMode(false);
    }
  };

  const handlePickCardRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择知识卡片存放目录",
      });
      if (!selected || typeof selected !== "string") return;
      const next = await invoke<CardSettings>("set_card_root_path", {
        path: selected,
      });
      setCardSettings(next);
      setCardSettingsError(null);
      setCardsRefreshToken((value) => value + 1);
      showTemporaryStatus(`知识卡片目录已切换到：${next.active_root}`);
    } catch (error) {
      setCardSettingsError(`设置知识卡片目录失败：${String(error)}`);
    }
  };

  const handleResetCardRoot = async () => {
    try {
      const next = await invoke<CardSettings>("set_card_root_path", {
        path: null,
      });
      setCardSettings(next);
      setCardSettingsError(null);
      setCardsRefreshToken((value) => value + 1);
      showTemporaryStatus("知识卡片目录已恢复为默认路径。", "info", 3600);
    } catch (error) {
      setCardSettingsError(`恢复默认目录失败：${String(error)}`);
    }
  };

  const handleOpenCardRoot = async () => {
    try {
      await invoke("open_card_root_in_explorer");
    } catch (error) {
      setCardSettingsError(`打开知识卡片目录失败：${String(error)}`);
    }
  };

  const handleCardSaved = () => {
    setCardsRefreshToken((value) => value + 1);
  };

  const handleRefreshMobilePairCode = async () => {
    setIsRefreshingMobilePairCode(true);
    try {
      const status = await invoke<MobileCompanionStatus>(
        "refresh_mobile_pair_code",
      );
      setMobileStatus(status);
      setMobileStatusError(null);
      showTemporaryStatus(`新的移动端配对码：${status.pairCode}`, "info", 3600);
    } catch (error) {
      setMobileStatusError(`刷新移动端配对码失败：${String(error)}`);
    } finally {
      setIsRefreshingMobilePairCode(false);
    }
  };

  const handleCopyMobileAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      showTemporaryStatus(`已复制移动端地址：${address}`);
    } catch (error) {
      setMobileStatusError(`复制移动端地址失败：${String(error)}`);
    }
  };

  const sidebarToolBody =
    activeSidebarTool === "workspace" ? (
      <>
        {isIngesting && (
          <div className="ingest-panel">
            <div className="ingest-title">{stageLabel}</div>
            <div className="ingest-subtitle">
              {ingestProgress?.total ? `${ingestProgress.current}/${ingestProgress.total}` : "Preparing..."}
            </div>
            <div className="ingest-progress-track">
              <div className="ingest-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
        {workspacePath && (
          <div className="workspace-path" title={workspacePath}>
            {workspacePath}
          </div>
        )}
        <FileTree
          data={files.length > 0 ? files : undefined}
          activePath={activeFilePath}
          onSelect={handleFileSelect}
          onLoadChildren={loadDirectoryChildren}
        />\r\n      </>
    ) : activeSidebarTool === "cards" ? (
      <div className="sidebar-tool-scroll">
        <div className="sidebar-tool-title">Knowledge Cards</div>
        <CardLibrary
          refreshToken={cardsRefreshToken}
          activeRoot={cardSettings?.active_root}
          onStatus={handleChildStatus}
        />
      </div>
    ) : activeSidebarTool === "citations" ? (
      <div className="sidebar-tool-scroll">
        <div className="sidebar-tool-title">Citations</div>
        <div className="support-panel-body">
          {sidebarCitations.length === 0 && (
            <div className="support-empty">No citations yet.</div>
          )}
          {sidebarCitations.slice(0, 24).map((citation) => (
            <div key={citation.id} className="support-item">
              <div className="support-item-title">
                {citation.path.split(/[\/\\]/).pop()} p.{citation.page}
              </div>
              <div className="support-item-text">{citation.snippet}</div>
            </div>
          ))}
        </div>
      </div>
    ) : activeSidebarTool === "notes" ? (
      <div className="sidebar-tool-scroll">
        <div className="sidebar-tool-title">Notes</div>
        <div className="support-panel-body">
          {sidebarNotes.length === 0 && (
            <div className="support-empty">No notes yet.</div>
          )}
          {sidebarNotes.slice(0, 32).map((note) => (
            <div key={note.id} className="support-item">
              <div className="support-item-text">{note.text}</div>
            </div>
          ))}
        </div>
      </div>
    ) : (
      <div className="sidebar-tool-scroll">
        <div className="sidebar-tool-title">Knowledge Search</div>
        <div className="knowledge-search-row">
          <input
            className="knowledge-search-input"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleKnowledgeSearch();
              }
            }}
            placeholder="Search imported knowledge"
          />
          <button
            className="action-button"
            onClick={() => void handleKnowledgeSearch()}
            disabled={isKnowledgeSearching || !knowledgeQuery.trim()}
          >
            {isKnowledgeSearching ? "Searching" : "Search"}
          </button>
        </div>
        <div className="support-panel-body">
          {!lastKnowledgeQuery && !isKnowledgeSearching && (
            <div className="support-empty">
              Enter keywords to search local knowledge base.
            </div>
          )}
          {lastKnowledgeQuery && !isKnowledgeSearching && knowledgeResults.length === 0 && (
            <div className="support-empty">No related results found.</div>
          )}
          {knowledgeResults.map((doc, index) => (
            <div key={doc.id} className="support-item">
              <div className="support-item-title">
                {index + 1}. {doc.path.split(/[\/\\]/).pop()}
              </div>
              <div className="support-item-text">
                {doc.content.replace(/\s+/g, " ").trim().slice(0, 220)}...
              </div>
              <div className="support-item-actions">
                <button
                  className="action-button"
                  onClick={() => void invoke("open_file", { path: doc.path })}
                >
                  Open file
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );

  const mobileSettingsSection = (
    <div className="settings-section">
      <label>移动端配套</label>
      <div className="mobile-settings-panel">
        <div className="mobile-settings-hero">
          <div>
            <div className="mobile-settings-code">
              {mobileStatus?.pairCode || "------"}
            </div>
            <p className="settings-help-text">
              在手机 App 的“配对”页输入下面的局域网地址和 6 位配对码。
            </p>
          </div>
          <div
            className={`status-chip ${mobileStatus?.running ? "" : "muted"}`}
          >
            {mobileStatus?.running ? "服务运行中" : "服务未就绪"}
          </div>
        </div>

        <div className="settings-button-row">
          <button
            className="action-button"
            onClick={() => void loadMobileCompanionStatus()}
            disabled={isLoadingMobileStatus}
          >
            {isLoadingMobileStatus ? "刷新中" : "刷新状态"}
          </button>
          <button
            className="action-button"
            onClick={() => void handleRefreshMobilePairCode()}
            disabled={isRefreshingMobilePairCode}
          >
            {isRefreshingMobilePairCode ? "生成中" : "重生成配对码"}
          </button>
        </div>

        <div className="mobile-settings-grid">
          <div className="mobile-settings-label">服务名</div>
          <div>{mobileStatus?.serviceName || "未加载"}</div>
          <div className="mobile-settings-label">API 版本</div>
          <div>{mobileStatus?.apiVersion || "未加载"}</div>
          <div className="mobile-settings-label">已配对设备</div>
          <div>{mobileStatus?.pairedDevices.length ?? 0}</div>
          <div className="mobile-settings-label">卡片 / 复习 / 收件箱</div>
          <div>
            {mobileStatus
              ? `${mobileStatus.cardCount} / ${mobileStatus.reviewRecordCount} / ${mobileStatus.inboxCount}`
              : "未加载"}
          </div>
        </div>

        <div className="mobile-settings-address-list">
          {(mobileStatus?.baseUrls || []).map((address) => (
            <div key={address} className="mobile-settings-address-item">
              <div className="settings-path-box">{address}</div>
              <button
                className="action-button"
                onClick={() => void handleCopyMobileAddress(address)}
              >
                复制地址
              </button>
            </div>
          ))}
        </div>

        <div className="mobile-settings-grid">
          <div className="mobile-settings-label">Inbox 目录</div>
          <div className="mobile-settings-path">
            {mobileStatus?.inboxDir || "未加载"}
          </div>
          <div className="mobile-settings-label">Review 目录</div>
          <div className="mobile-settings-path">
            {mobileStatus?.reviewStateDir || "未加载"}
          </div>
        </div>

        {mobileStatus?.pairedDevices.length ? (
          <div className="mobile-settings-device-list">
            {mobileStatus.pairedDevices.map((device) => (
              <div
                key={device.deviceId}
                className="mobile-settings-device-item"
              >
                <strong>{device.deviceName}</strong>
                <span>
                  配对时间：{device.pairedAt}
                  {device.lastSeenAt ? ` · 最后连接：${device.lastSeenAt}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-help-text">还没有已配对的移动设备。</p>
        )}
      </div>
      {(mobileStatusError || mobileStatus?.lastError) && (
        <p className="settings-error-text">
          {mobileStatusError || mobileStatus?.lastError}
        </p>
      )}
    </div>
  );

  const statusBannerSummary = statusBanner
    ? statusBanner.action
      ? "需要处理的状态"
      : statusBanner.message.length > 26
        ? `${statusBanner.message.slice(0, 26)}...`
        : statusBanner.message
    : "";

  const leftDrawer = (
    <aside
      className={`workspace-drawer ${isLeftDrawerOpen && !isPdfFocusMode ? "open" : ""} ${isWorkspaceDrawerResizing ? "resizing" : ""} ${isModelDrawerOpen ? "model-drawer" : ""}`}
      style={
        isLeftDrawerOpen && !isPdfFocusMode
          ? {
              width: `${workspaceDrawerWidth}px`,
              flexBasis: `${workspaceDrawerWidth}px`,
            }
          : undefined
      }
    >
      {isWorkspaceDrawerOpen ? (
        <div className="sidebar">
          <div className="sidebar-header">
            <span>工作空间</span>
            <div className="sidebar-actions">
              <button
                className="icon-button"
                onClick={() => void handleImportZotero()}
                title="自动导入 Zotero PDF"
              >
                <BookOpen size={16} />
              </button>
              <button
                className="icon-button"
                onClick={() => void handleOpenFiles()}
                title="导入文件"
              >
                <FilePlus size={16} />
              </button>
              <button
                className="icon-button"
                onClick={() => void handleOpenFolder()}
                title="导入文件夹"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          {isIngesting && (
            <div className="ingest-panel">
              <div className="ingest-title">{stageLabel}</div>
              <div className="ingest-subtitle">
                {ingestProgress?.total
                  ? `${ingestProgress.current}/${ingestProgress.total}`
                  : "准备中..."}
              </div>
              <div className="ingest-progress-track">
                <div
                  className="ingest-progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {workspacePath && (
            <div className="workspace-path" title={workspacePath}>
              {workspacePath}
            </div>
          )}

          <FileTree
            data={files.length > 0 ? files : undefined}
            activePath={activeFilePath}
            onSelect={handleFileSelect}
            onLoadChildren={loadDirectoryChildren}
          />
        </div>
      ) : (
        <div className="sidebar model-drawer-sidebar">
          <ModelSelector
            currentModel={currentModel}
            onModelChange={setCurrentModel}
            onStatus={handleChildStatus}
            variant="drawer"
          />
        </div>
      )}
      <div
        className="workspace-drawer-resize-handle"
        role="separator"
        aria-label="调整工作空间宽度"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          handleWorkspaceDrawerResizeStart(event.clientX);
        }}
      />
    </aside>
  );

  return (
    <div className="app-shell">
      {statusBanner && (
        <div
          className={`status-banner-shell ${statusBanner.tone} ${isStatusBannerExpanded ? "expanded" : "collapsed"}`}
        >
          <button
            className={`status-banner-handle ${statusBanner.tone}`}
            onClick={() => setIsStatusBannerExpanded((current) => !current)}
            aria-label={
              isStatusBannerExpanded ? "收起状态面板" : "展开状态面板"
            }
            title={statusBanner.message}
          >
            <span className="status-banner-handle-line" />
            <span className="status-banner-handle-text">
              {isStatusBannerExpanded ? "后台状态" : statusBannerSummary}
            </span>
            {isStatusBannerExpanded ? (
              <ChevronUp size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </button>

          {isStatusBannerExpanded && (
            <div className={`status-banner ${statusBanner.tone}`}>
              <div className="status-banner-text">{statusBanner.message}</div>
              <div className="status-banner-controls">
                {statusBanner.action && (
                  <button
                    className="status-banner-action"
                    onClick={() => void statusBanner.action?.onClick()}
                  >
                    {statusBanner.action.label}
                  </button>
                )}
                <button
                  className="ghost-icon-button light"
                  onClick={() => setIsStatusBannerExpanded(false)}
                  aria-label="收起状态面板"
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  className="ghost-icon-button light"
                  onClick={clearStatus}
                  aria-label="关闭提示"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className={`app-layout-shell ${isPdfFocusMode ? "pdf-focus-mode" : ""}`}
      >
        <Panel
          panelRef={sidebarPanelRef}
          defaultSize="23%"
          minSize={isPdfFocusMode ? "0%" : "16%"}
          maxSize="38%"
          className={`sidebar-panel ${isPdfFocusMode ? "panel-collapsed" : ""}`}
        >
          <aside className="sidebar sidebar-with-rail">
            <div className="sidebar-rail">
              <button
                className={`rail-button ${activeSidebarTool === "workspace" ? "active" : ""}`}
                onClick={() => setActiveSidebarTool("workspace")}
                title="Workspace"
              >
                <FolderOpen size={18} />
              </button>
              <button
                className={`rail-button ${activeSidebarTool === "citations" ? "active" : ""}`}
                onClick={() => setActiveSidebarTool("citations")}
                title="Citations"
              >
                <MessageSquareText size={18} />
              </button>
              <button
                className={`rail-button ${activeSidebarTool === "notes" ? "active" : ""}`}
                onClick={() => setActiveSidebarTool("notes")}
                title="Notes"
              >
                <StickyNote size={18} />
              </button>
              <button
                className={`rail-button ${activeSidebarTool === "knowledge" ? "active" : ""}`}
                onClick={() => setActiveSidebarTool("knowledge")}
                title="Knowledge Search"
              >
                <Search size={18} />
              </button>
              <button
                className={`rail-button ${activeSidebarTool === "cards" ? "active" : ""}`}
                onClick={() => setActiveSidebarTool("cards")}
                title="Knowledge Cards"
              >
                <LayoutGrid size={18} />
              </button>
            </div>

            <div className="sidebar-content">
              <div className="sidebar-header">
                <span>
                  {activeSidebarTool === "workspace"
                    ? "Workspace"
                    : activeSidebarTool === "citations"
                      ? "Citations"
                      : activeSidebarTool === "notes"
                        ? "Notes"
                        : activeSidebarTool === "knowledge"
                          ? "Knowledge"
                          : "Knowledge Cards"}
                </span>
                <div className="sidebar-actions">
                  <button
                    className="icon-button"
                    onClick={() => void handleImportZotero()}
                    title="Auto import Zotero PDFs"
                  >
                    <BookOpen size={16} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => void handleOpenFiles()}
                    title="Import files"
                  >
                    <FilePlus size={16} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => void handleOpenFolder()}
                    title="Import folder"
                  >
                    <FolderOpen size={16} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => setIsSettingsOpen(true)}
                    title="Settings"
                  >
                    <Settings size={16} />
                  </button>
                </div>
              </div>

              {sidebarToolBody}
            </div>
          </aside>
        </Panel>

        <Separator
          className={`PanelResizeHandle ${isPdfFocusMode ? "panel-separator-hidden" : ""}`}
        />
        <Panel
          panelRef={mainPanelRef}
          defaultSize="45%"
          minSize={isPdfFocusMode ? "0%" : "24%"}
          className="main-panel pdf-center-panel"
        >
          <div className="pdf-center-shell">
            {activePdfPath && isPdfDockVisible ? (
              <PdfDock
                activePdfPath={activePdfPath}
                currentModel={currentModel || REQUIRED_MODELS.chat}
                ensureAiReady={ensureAiReady}
                currentPage={pdfPage}
                onPageChange={setPdfPage}
                onStatus={handleChildStatus}
                onCardSaved={handleCardSaved}
                isFocusMode={isPdfFocusMode}
                onToggleFocusMode={handleTogglePdfFocusMode}
                onClose={handleClosePdfDock}
              />
            ) : (
              <div className="pdf-empty-state">
                <h2>PDF Reader</h2>
                <p>
                  Select a PDF file from the left workspace to preview it here.
                </p>
              </div>
            )}
          </div>
        </Panel>

        <Separator
          className={`PanelResizeHandle ${isPdfFocusMode ? "panel-separator-hidden" : ""}`}
        />
        <Panel
          panelRef={pdfPanelRef}
          defaultSize="32%"
          minSize={isPdfFocusMode ? "0%" : "22%"}
          maxSize={isPdfFocusMode ? "0%" : "46%"}
          className={`pdf-dock-panel ai-right-panel ${isPdfFocusMode ? "panel-collapsed" : ""}`}
        >
          <ChatInterface
            currentModel={currentModel}
            activeFilePath={activeFilePath}
            pdfPage={pdfPage}
            onPdfPageChange={setPdfPage}
            onStatus={handleChildStatus}
            onCardSaved={handleCardSaved}
            onModelChange={setCurrentModel}
            showSupportPanels={false}
          />
        </Panel>
      </Group>

      {isSettingsOpen && (
        <div
          className="settings-overlay"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h3>设置</h3>
              <button
                className="ghost-icon-button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="关闭设置"
              >
                <X size={16} />
              </button>
            </div>

            <div className="settings-section">
              <label htmlFor="inference-mode-select">推理模式</label>
              <select
                id="inference-mode-select"
                value={inferenceMode}
                onChange={(event) =>
                  void handleInferenceModeChange(
                    event.target.value as InferenceMode,
                  )
                }
                disabled={isSavingInferenceMode}
              >
                <option value="single_mm">单模型原生多模态优先</option>
                <option value="dual_pipeline">双模型作为性能 / 精度备选</option>
              </select>
              <p className="settings-help-text">
                `single_mm` 走单模型图文理解；`dual_pipeline`
                目前保留为后续双路由扩展骨架。
              </p>
              {settingsError && (
                <p className="settings-error-text">{settingsError}</p>
              )}
            </div>

            <div className="settings-section">
              <label htmlFor="ingest-mode-select">导入索引模式</label>
              <select
                id="ingest-mode-select"
                value={ingestMode}
                onChange={(event) =>
                  setIngestMode(event.target.value as IngestMode)
                }
              >
                <option value="overwrite">覆盖导入</option>
                <option value="incremental">增量导入</option>
              </select>
              <p className="settings-help-text">
                覆盖导入会重建当前导入目标的索引；增量导入会尽量保留已存在内容。
              </p>
            </div>

            <div className="settings-section">
              <label>知识卡片路径</label>
              <div className="settings-path-box">
                {cardSettings?.active_root || "尚未加载"}
              </div>
              <div className="settings-button-row">
                <button
                  className="action-button"
                  onClick={() => void handlePickCardRoot()}
                >
                  选择路径
                </button>
                <button
                  className="action-button"
                  onClick={() => void handleResetCardRoot()}
                >
                  恢复默认
                </button>
                <button
                  className="action-button"
                  onClick={() => void handleOpenCardRoot()}
                >
                  打开目录
                </button>
              </div>
              <p className="settings-help-text">
                {cardSettings?.using_custom_root
                  ? "当前使用自定义卡片目录。"
                  : "当前使用应用默认卡片目录。"}
              </p>
              {cardSettingsError && (
                <p className="settings-error-text">{cardSettingsError}</p>
              )}
            </div>

            {mobileSettingsSection}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;








