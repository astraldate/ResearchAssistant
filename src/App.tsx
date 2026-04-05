import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Suspense, lazy } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
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
import {
  FileNode,
  FileTree,
  type TreeMutationPayload,
} from "./components/FileTree";
import { ChatInterface } from "./components/ChatInterface";
import { ModelSelector } from "./components/ModelSelector";
import { resolveMirrorModel } from "./utils/modelMirrors";
import "./App.css";

const CardLibrary = lazy(() =>
  import("./components/CardLibrary").then((module) => ({
    default: module.CardLibrary,
  })),
);
const PdfDock = lazy(() =>
  import("./components/PdfDock").then((module) => ({
    default: module.PdfDock,
  })),
);
const ResearchMemoryPanel = lazy(() =>
  import("./components/ResearchMemoryPanel").then((module) => ({
    default: module.ResearchMemoryPanel,
  })),
);

type InferenceMode = "single_mm" | "dual_pipeline";
type IngestMode = "overwrite" | "incremental";
type ExtractionRunMode = "fast" | "balanced";
type SidebarTool = "workspace" | "citations" | "notes" | "knowledge" | "cards";
type StatusTone = "info" | "error";
type AiRequirement = "chat" | "index" | "translate";
type SettingsTab = "general" | "models" | "mobile";

interface InferenceSettings {
  mode: InferenceMode;
}

type ExtractionProviderKind = "ollama" | "open_ai_compatible";

interface ExtractionProviderSettings {
  provider: ExtractionProviderKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  extractFastModel?: string | null;
  extractFallbackModel?: string | null;
  extractPipelineSummaryModel?: string | null;
  extractPipelineNameModel?: string | null;
  extractEdgeModel?: string | null;
  extractEdgeValidateModel?: string | null;
}

interface IngestProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
  noCandidateCount?: number;
  fallbackSuccessCount?: number;
  doubleFailureCount?: number;
}

interface IngestStageSnapshot {
  current: number;
  total: number;
}

interface StatusBanner {
  message: string;
  tone: StatusTone;
  progress?: number;
  details?: string[];
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

interface PdfOpenAnchorRequest {
  key: string;
  path: string;
  page: number;
  snippet?: string;
}

interface WorkspaceSelection {
  path: string;
  type_name: FileNode["type_name"];
  name: string;
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

interface PullProgress {
  status: string;
  modelName?: string;
  sourceUrl?: string;
  digest?: string;
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

const REQUIRED_MODELS = {
  embedding: "nomic-embed-text",
  extractFast: "qwen3:8b",
  extractFallback: "qwen3.5:9b",
  pipelineSummary: "qwen3.5:9b",
  pipelineName: "qwen3.5:9b",
  edgeExtract: "qwen3.5:9b",
  edgeValidate: "qwen3.5:9b",
  chat: "qwen3.5:9b",
  translation: "MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M",
};

const OLLAMA_MIN_RECOMMENDED_VERSION = "0.17.7";
const CHAT_MODEL_KEY = "ra_chat_model_v1";
const EXTRACT_MODEL_KEY = "ra_extract_fast_model_v3";
const EXTRACT_FALLBACK_MODEL_KEY = "ra_extract_fallback_model_v2";
const PIPELINE_SUMMARY_MODEL_KEY = "ra_pipeline_summary_model_v1";
const PIPELINE_NAME_MODEL_KEY = "ra_pipeline_name_model_v1";
const EDGE_EXTRACT_MODEL_KEY = "ra_edge_extract_model_v1";
const EDGE_VALIDATE_MODEL_KEY = "ra_edge_validate_model_v1";
const TRANSLATION_MODEL_KEY = "ra_translation_model_v1";
const INGEST_EXTRACTION_MODE_KEY = "ra_ingest_extraction_mode_v1";

const STAGE_LABELS: Record<string, string> = {
  prepare_ingest: "准备导入",
  prepare_models: "检查模型",
  scan: "扫描文件",
  parse_pages: "解析页面",
  candidate_extract: "抽取候选概念",
  pipeline_summarize: "总结 Pipeline 骨架",
  pipeline_name_extract: "提取 Pipeline 名称",
  edge_extract: "抽取 Edge",
  edge_validate: "校验 Edge",
  canonicalize: "归并候选概念",
  index_vectors: "重建向量索引",
  finalize: "保存索引",
};

const INGEST_STAGE_ORDER = [
  "prepare_ingest",
  "prepare_models",
  "scan",
  "parse_pages",
  "candidate_extract",
  "pipeline_summarize",
  "pipeline_name_extract",
  "edge_extract",
  "edge_validate",
  "canonicalize",
  "index_vectors",
  "finalize",
] as const;

const EXTRACTION_SUBSTAGE_ORDER = [
  "candidate_extract",
  "pipeline_summarize",
  "pipeline_name_extract",
  "edge_extract",
  "edge_validate",
] as const;

const INGEST_STAGE_WEIGHTS: Record<string, number> = {
  prepare_ingest: 2,
  prepare_models: 4,
  scan: 4,
  parse_pages: 10,
  candidate_extract: 28,
  pipeline_summarize: 14,
  pipeline_name_extract: 8,
  edge_extract: 14,
  edge_validate: 10,
  canonicalize: 3,
  index_vectors: 2,
  finalize: 1,
};

const TOTAL_INGEST_STAGE_WEIGHT = INGEST_STAGE_ORDER.reduce(
  (sum, stage) => sum + (INGEST_STAGE_WEIGHTS[stage] ?? 0),
  0,
);

const OLLAMA_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;
const CHAT_SESSION_KEY = "ra_chat_session_v3";

const isPdfFile = (path: string | null | undefined) =>
  Boolean(path && /\.pdf$/i.test(path));
const DEFAULT_TWO_PANEL_LAYOUT = { main: 55, pdf: 45 };
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

const formatByteSize = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
};

const isWeakExtractionModel = (name: string | null | undefined) => {
  const normalized = name?.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized.includes("embed") ||
    normalized.includes("tencent-hy-mt") ||
    normalized.includes("medaibase")
  ) {
    return true;
  }
  return (
    normalized.includes(":0.5b") ||
    normalized.includes(":1b") ||
    normalized.includes(":1.5b") ||
    normalized.includes(":1.8b") ||
    normalized.endsWith("0.5b") ||
    normalized.endsWith("1b") ||
    normalized.endsWith("1.5b") ||
    normalized.endsWith("1.8b")
  );
};

const sanitizeExtractFastModel = (name: string | null | undefined) => {
  const normalized = name?.trim();
  if (!normalized || isWeakExtractionModel(normalized)) {
    return REQUIRED_MODELS.extractFast;
  }
  return normalized;
};

const resolveInstalledModelName = (
  names: string[],
  preferred: string | null | undefined,
) => {
  const normalized = preferred?.trim();
  if (!normalized) return "";
  return (
    names.find((name) => name === normalized) ||
    names.find((name) => name.startsWith(`${normalized.split(":")[0]}:`)) ||
    ""
  );
};

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
  const [workspaceSelection, setWorkspaceSelection] =
    useState<WorkspaceSelection | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfOpenAnchorRequest, setPdfOpenAnchorRequest] =
    useState<PdfOpenAnchorRequest | null>(null);
  const [isPdfDockVisible, setIsPdfDockVisible] = useState(false);
  const [isPdfFocusMode, setIsPdfFocusMode] = useState(false);
  const [currentModel, setCurrentModel] = useState(() => {
    const stored = localStorage.getItem(CHAT_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.chat;
  });
  const [extractModel, setExtractModel] = useState(() => {
    const stored = localStorage.getItem(EXTRACT_MODEL_KEY)?.trim();
    if (!stored || stored === REQUIRED_MODELS.extractFallback) {
      return REQUIRED_MODELS.extractFast;
    }
    return sanitizeExtractFastModel(stored);
  });
  const [extractFallbackModel, setExtractFallbackModel] = useState(() => {
    const stored = localStorage.getItem(EXTRACT_FALLBACK_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.extractFallback;
  });
  const [pipelineSummaryModel, setPipelineSummaryModel] = useState(() => {
    const stored = localStorage.getItem(PIPELINE_SUMMARY_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.pipelineSummary;
  });
  const [pipelineNameModel, setPipelineNameModel] = useState(() => {
    const stored = localStorage.getItem(PIPELINE_NAME_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.pipelineName;
  });
  const [edgeExtractModel, setEdgeExtractModel] = useState(() => {
    const stored = localStorage.getItem(EDGE_EXTRACT_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.edgeExtract;
  });
  const [edgeValidateModel, setEdgeValidateModel] = useState(() => {
    const stored = localStorage.getItem(EDGE_VALIDATE_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.edgeValidate;
  });
  const [translationModel, setTranslationModel] = useState(() => {
    const stored = localStorage.getItem(TRANSLATION_MODEL_KEY)?.trim();
    return stored || REQUIRED_MODELS.translation;
  });
  const [activeSidebarTool, setActiveSidebarTool] =
    useState<SidebarTool>("workspace");
  const [ingestMode, setIngestMode] = useState<IngestMode>("overwrite");
  const [ingestRunMode, setIngestRunMode] =
    useState<ExtractionRunMode>("balanced");
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(
    null,
  );
  const [ingestExtractionMode, setIngestExtractionMode] =
    useState<ExtractionRunMode>("fast");
  const [ingestStageSnapshots, setIngestStageSnapshots] = useState<
    Record<string, IngestStageSnapshot>
  >({});
  const [isIngesting, setIsIngesting] = useState(false);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>("general");
  const [inferenceMode, setInferenceMode] =
    useState<InferenceMode>("single_mm");
  const [isSavingInferenceMode, setIsSavingInferenceMode] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [extractionProviderSettings, setExtractionProviderSettings] =
    useState<ExtractionProviderSettings>({
      provider: "ollama",
      baseUrl: "",
      apiKey: "",
      extractFastModel: "",
      extractFallbackModel: "",
      extractPipelineSummaryModel: "",
      extractPipelineNameModel: "",
      extractEdgeModel: "",
      extractEdgeValidateModel: "",
    });
  const [extractionProviderError, setExtractionProviderError] = useState<
    string | null
  >(null);
  const [isSavingExtractionProvider, setIsSavingExtractionProvider] =
    useState(false);
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

  const statusTimerRef = useRef<number | null>(null);
  const previousPdfPathRef = useRef<string | null>(null);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const mainPanelRef = useRef<PanelImperativeHandle | null>(null);
  const focusRestoreLayoutRef = useRef(DEFAULT_TWO_PANEL_LAYOUT);
  const pdfPanelRef = useRef<PanelImperativeHandle | null>(null);
  const aiPreparationPromiseRef = useRef<Promise<string> | null>(null);
  const aiPreparedStateRef = useRef<{
    chat: boolean;
    index: boolean;
    translate: boolean;
  }>({
    chat: false,
    index: false,
    translate: false,
  });

  const stageProgressPercent = useMemo(() => {
    if (!ingestProgress || ingestProgress.total <= 0) return 0;
    return Math.min(
      100,
      Math.round((ingestProgress.current / ingestProgress.total) * 100),
    );
  }, [ingestProgress]);
  const cumulativeProgressPercent = useMemo(() => {
    if (!ingestProgress) return 0;
    const stageIndex = INGEST_STAGE_ORDER.indexOf(
      ingestProgress.stage as (typeof INGEST_STAGE_ORDER)[number],
    );
    if (stageIndex === -1 || TOTAL_INGEST_STAGE_WEIGHT <= 0) {
      return stageProgressPercent;
    }
    const completedWeight = INGEST_STAGE_ORDER.slice(0, stageIndex).reduce(
      (sum, stage) => sum + (INGEST_STAGE_WEIGHTS[stage] ?? 0),
      0,
    );
    const currentWeight = INGEST_STAGE_WEIGHTS[ingestProgress.stage] ?? 0;
    const currentStageRatio =
      ingestProgress.total > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ingestProgress.current / Math.max(ingestProgress.total, 1),
            ),
          )
        : 0;
    return Math.min(
      100,
      Math.round(
        ((completedWeight + currentWeight * currentStageRatio) /
          TOTAL_INGEST_STAGE_WEIGHT) *
          100,
      ),
    );
  }, [ingestProgress, stageProgressPercent]);
  const activePdfPath = useMemo(
    () => (isPdfFile(activeFilePath) ? activeFilePath : null),
    [activeFilePath],
  );

  const stageLabel = STAGE_LABELS[ingestProgress?.stage || ""] || "处理中";
  const ingestStatusDetails = useMemo(() => {
    if (!ingestProgress) return [] as string[];
    const activeStageIndex = INGEST_STAGE_ORDER.indexOf(
      ingestProgress.stage as (typeof INGEST_STAGE_ORDER)[number],
    );
    return EXTRACTION_SUBSTAGE_ORDER.map((stage) => {
      const snapshot =
        stage === ingestProgress.stage
          ? { current: ingestProgress.current, total: ingestProgress.total }
          : ingestStageSnapshots[stage];
      const label = STAGE_LABELS[stage] || stage;
      if (!snapshot) {
        const substageIndex = INGEST_STAGE_ORDER.indexOf(stage);
        const skipped =
          activeStageIndex > substageIndex && ingestProgress.stage !== stage;
        if (!skipped) {
          return `${label} · 待开始`;
        }
        const skippedReason =
          ingestExtractionMode === "fast"
            ? "已跳过（当前为 fast 模式）"
            : "已跳过（当前批次无可继续处理节点）";
        return `${label} · ${skippedReason}`;
      }
      const ratioText =
        snapshot.total > 0 ? ` ${snapshot.current}/${snapshot.total}` : "";
      const statusText =
        stage === ingestProgress.stage
          ? "进行中"
          : snapshot.total > 0 && snapshot.current >= snapshot.total
            ? "已完成"
            : "处理中";
      return `${label}${ratioText} · ${statusText}`;
    });
  }, [ingestExtractionMode, ingestProgress, ingestStageSnapshots]);

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
      progress?: number,
      details?: string[],
      action?: StatusBannerAction,
    ) => {
      clearStatusTimer();
      const nextBanner: StatusBanner = {
        message,
        tone,
        progress,
        details,
        action,
      };
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
      progressOrAction?: number | StatusBannerAction,
      detailsOrAction?: string[] | StatusBannerAction,
      action?: StatusBannerAction,
    ) => {
      const progress =
        typeof progressOrAction === "number" ? progressOrAction : undefined;
      const resolvedAction =
        typeof progressOrAction === "number" ? action : progressOrAction;
      const details = Array.isArray(detailsOrAction)
        ? detailsOrAction
        : undefined;
      const resolvedActionWithDetails = Array.isArray(detailsOrAction)
        ? action
        : (detailsOrAction ?? resolvedAction);
      showStatus(
        message,
        tone,
        timeoutMs,
        progress,
        details,
        resolvedActionWithDetails,
      );
    },
    [showStatus],
  );

  const showPersistentStatus = useCallback(
    (
      message: string,
      tone: StatusTone = "info",
      progressOrAction?: number | StatusBannerAction,
      detailsOrAction?: string[] | StatusBannerAction,
      action?: StatusBannerAction,
    ) => {
      const progress =
        typeof progressOrAction === "number" ? progressOrAction : undefined;
      const resolvedAction =
        typeof progressOrAction === "number" ? action : progressOrAction;
      const details = Array.isArray(detailsOrAction)
        ? detailsOrAction
        : undefined;
      const resolvedActionWithDetails = Array.isArray(detailsOrAction)
        ? action
        : (detailsOrAction ?? resolvedAction);
      showStatus(
        message,
        tone,
        undefined,
        progress,
        details,
        resolvedActionWithDetails,
      );
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
        requirement === "index"
          ? preparedState.index
          : requirement === "translate"
            ? preparedState.translate
            : preparedState.chat;
      const activeModelForRequirement =
        requirement === "index"
          ? extractModel
          : requirement === "translate"
            ? translationModel
            : currentModel;
      if (alreadyPrepared && activeModelForRequirement) {
        return activeModelForRequirement;
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
            const candidates = mirror.candidates?.length
              ? mirror.candidates
              : [{ url: mirror.url, filename: mirror.filename }];
            for (const candidate of candidates) {
              try {
                showPersistentStatus(
                  `正在通过镜像拉取 ${name}...`,
                  "info",
                  undefined,
                  [`下载地址：${candidate.url}`],
                );
                await invoke("pull_model_from_modelscope", {
                  name,
                  url: candidate.url,
                  filename: candidate.filename,
                });
                return;
              } catch (error) {
                console.error("Mirror pull failed:", candidate.url, error);
                showPersistentStatus(
                  `镜像拉取失败，正在尝试下一个源：${name}`,
                  "error",
                  undefined,
                  [`失败地址：${candidate.url}`],
                );
              }
            }
          }
          showPersistentStatus(`正在拉取模型 ${name}...`);
          await invoke("pull_ollama_model", { name });
        };

        let models = await getInstalledModels();
        let names = models.map((model) => model.name);
        const indexModelTargets =
          requirement === "index"
            ? [
                sanitizeExtractFastModel(extractModel) ||
                  REQUIRED_MODELS.extractFast,
                extractFallbackModel || REQUIRED_MODELS.extractFallback,
                pipelineSummaryModel || REQUIRED_MODELS.pipelineSummary,
                pipelineNameModel ||
                  pipelineSummaryModel ||
                  REQUIRED_MODELS.pipelineName,
                edgeExtractModel || REQUIRED_MODELS.edgeExtract,
                edgeValidateModel ||
                  edgeExtractModel ||
                  REQUIRED_MODELS.edgeValidate,
              ].filter(Boolean)
            : [];

        let didFallbackToExtractFallback = false;
        if (
          requirement === "index" &&
          !resolveInstalledModelName(
            names,
            extractModel || REQUIRED_MODELS.extractFast,
          )
        ) {
          try {
            await pullModel(extractModel || REQUIRED_MODELS.extractFast);
          } catch (error) {
            console.warn("Fast extract model pull failed:", error);
            didFallbackToExtractFallback = true;
          }
        }
        if (
          requirement === "index" &&
          !resolveInstalledModelName(names, REQUIRED_MODELS.embedding)
        ) {
          await pullModel(REQUIRED_MODELS.embedding);
        }
        if (requirement === "index") {
          models = await getInstalledModels();
          names = models.map((model) => model.name);
          for (const modelName of indexModelTargets) {
            if (!resolveInstalledModelName(names, modelName)) {
              await pullModel(modelName);
              models = await getInstalledModels();
              names = models.map((model) => model.name);
            }
          }
        }
        if (
          requirement === "translate" &&
          !resolveInstalledModelName(names, REQUIRED_MODELS.translation)
        ) {
          await pullModel(REQUIRED_MODELS.translation);
        }
        if (
          requirement !== "translate" &&
          !resolveInstalledModelName(
            names,
            currentModel || REQUIRED_MODELS.chat,
          )
        ) {
          await pullModel(currentModel || REQUIRED_MODELS.chat);
        }

        models = await getInstalledModels();
        names = models.map((model) => model.name);
        const preferredChatModel = resolveInstalledModelName(
          names,
          currentModel,
        );
        const preferredTranslationModel = resolveInstalledModelName(
          names,
          translationModel,
        );
        const preferredExtractModel = resolveInstalledModelName(
          names,
          sanitizeExtractFastModel(extractModel),
        );
        const preferredExtractFallbackModel = resolveInstalledModelName(
          names,
          extractFallbackModel,
        );
        const resolvedFastExtractModel =
          preferredExtractModel ||
          resolveInstalledModelName(names, REQUIRED_MODELS.extractFast) ||
          sanitizeExtractFastModel(extractModel) ||
          REQUIRED_MODELS.extractFast;
        const installedFallbackExtractModel =
          preferredExtractFallbackModel ||
          resolveInstalledModelName(names, REQUIRED_MODELS.extractFallback);
        const resolvedFallbackExtractModel =
          installedFallbackExtractModel || resolvedFastExtractModel;
        const resolvedPipelineSummaryModel =
          resolveInstalledModelName(names, pipelineSummaryModel) ||
          resolveInstalledModelName(names, REQUIRED_MODELS.pipelineSummary) ||
          pipelineSummaryModel ||
          REQUIRED_MODELS.pipelineSummary;
        const resolvedPipelineNameModel =
          resolveInstalledModelName(names, pipelineNameModel) ||
          resolveInstalledModelName(names, resolvedPipelineSummaryModel) ||
          resolveInstalledModelName(names, REQUIRED_MODELS.pipelineName) ||
          pipelineNameModel ||
          resolvedPipelineSummaryModel ||
          REQUIRED_MODELS.pipelineName;
        const resolvedEdgeExtractModel =
          resolveInstalledModelName(names, edgeExtractModel) ||
          resolveInstalledModelName(names, REQUIRED_MODELS.edgeExtract) ||
          edgeExtractModel ||
          REQUIRED_MODELS.edgeExtract;
        const resolvedEdgeValidateModel =
          resolveInstalledModelName(names, edgeValidateModel) ||
          resolveInstalledModelName(names, resolvedEdgeExtractModel) ||
          resolveInstalledModelName(names, REQUIRED_MODELS.edgeValidate) ||
          edgeValidateModel ||
          resolvedEdgeExtractModel ||
          REQUIRED_MODELS.edgeValidate;
        const selectedModel =
          requirement === "index"
            ? didFallbackToExtractFallback
              ? resolvedFallbackExtractModel
              : resolvedFastExtractModel || resolvedFallbackExtractModel
            : requirement === "translate"
              ? preferredTranslationModel ||
                resolveInstalledModelName(names, REQUIRED_MODELS.translation) ||
                translationModel ||
                REQUIRED_MODELS.translation
              : preferredChatModel ||
                resolveInstalledModelName(names, REQUIRED_MODELS.chat) ||
                currentModel ||
                names[0] ||
                REQUIRED_MODELS.chat;

        if (requirement === "index") {
          setExtractModel(resolvedFastExtractModel);
          setExtractFallbackModel(
            installedFallbackExtractModel ||
              extractFallbackModel ||
              REQUIRED_MODELS.extractFallback,
          );
          setPipelineSummaryModel(resolvedPipelineSummaryModel);
          setPipelineNameModel(resolvedPipelineNameModel);
          setEdgeExtractModel(resolvedEdgeExtractModel);
          setEdgeValidateModel(resolvedEdgeValidateModel);
        } else if (requirement === "translate") {
          setTranslationModel(selectedModel);
        } else {
          setCurrentModel(selectedModel);
        }
        aiPreparedStateRef.current = {
          chat:
            requirement === "translate"
              ? aiPreparedStateRef.current.chat
              : true,
          index:
            requirement === "index" ? true : aiPreparedStateRef.current.index,
          translate:
            requirement === "translate"
              ? true
              : aiPreparedStateRef.current.translate,
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
      translationModel,
      extractModel,
      extractFallbackModel,
      waitForOllamaReady,
    ],
  );

  const ensureTranslationReady = useCallback(
    () => ensureAiReady("translate"),
    [ensureAiReady],
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
    const storedMode = localStorage.getItem("ra_ingest_mode_v1");
    if (storedMode === "overwrite" || storedMode === "incremental") {
      setIngestMode(storedMode);
    }
    const storedExtractionMode = localStorage.getItem(
      INGEST_EXTRACTION_MODE_KEY,
    );
    if (
      storedExtractionMode === "fast" ||
      storedExtractionMode === "balanced"
    ) {
      setIngestRunMode(storedExtractionMode);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ra_ingest_mode_v1", ingestMode);
  }, [ingestMode]);

  useEffect(() => {
    localStorage.setItem(INGEST_EXTRACTION_MODE_KEY, ingestRunMode);
  }, [ingestRunMode]);

  useEffect(() => {
    if (currentModel.trim()) {
      localStorage.setItem(CHAT_MODEL_KEY, currentModel.trim());
    } else {
      localStorage.removeItem(CHAT_MODEL_KEY);
    }
  }, [currentModel]);

  useEffect(() => {
    if (extractModel.trim()) {
      localStorage.setItem(
        EXTRACT_MODEL_KEY,
        sanitizeExtractFastModel(extractModel),
      );
    } else {
      localStorage.removeItem(EXTRACT_MODEL_KEY);
    }
  }, [extractModel]);

  useEffect(() => {
    const sanitized = sanitizeExtractFastModel(extractModel);
    if (sanitized !== extractModel) {
      setExtractModel(sanitized);
    }
  }, [extractModel]);

  useEffect(() => {
    if (extractFallbackModel.trim()) {
      localStorage.setItem(
        EXTRACT_FALLBACK_MODEL_KEY,
        extractFallbackModel.trim(),
      );
    } else {
      localStorage.removeItem(EXTRACT_FALLBACK_MODEL_KEY);
    }
  }, [extractFallbackModel]);

  useEffect(() => {
    if (pipelineSummaryModel.trim()) {
      localStorage.setItem(
        PIPELINE_SUMMARY_MODEL_KEY,
        pipelineSummaryModel.trim(),
      );
    } else {
      localStorage.removeItem(PIPELINE_SUMMARY_MODEL_KEY);
    }
  }, [pipelineSummaryModel]);

  useEffect(() => {
    if (pipelineNameModel.trim()) {
      localStorage.setItem(PIPELINE_NAME_MODEL_KEY, pipelineNameModel.trim());
    } else {
      localStorage.removeItem(PIPELINE_NAME_MODEL_KEY);
    }
  }, [pipelineNameModel]);

  useEffect(() => {
    if (edgeExtractModel.trim()) {
      localStorage.setItem(EDGE_EXTRACT_MODEL_KEY, edgeExtractModel.trim());
    } else {
      localStorage.removeItem(EDGE_EXTRACT_MODEL_KEY);
    }
  }, [edgeExtractModel]);

  useEffect(() => {
    if (edgeValidateModel.trim()) {
      localStorage.setItem(EDGE_VALIDATE_MODEL_KEY, edgeValidateModel.trim());
    } else {
      localStorage.removeItem(EDGE_VALIDATE_MODEL_KEY);
    }
  }, [edgeValidateModel]);

  useEffect(() => {
    if (translationModel.trim()) {
      localStorage.setItem(TRANSLATION_MODEL_KEY, translationModel.trim());
    } else {
      localStorage.removeItem(TRANSLATION_MODEL_KEY);
    }
  }, [translationModel]);

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

  const loadExtractionProviderSettings = async () => {
    try {
      const settings = await invoke<ExtractionProviderSettings>(
        "get_research_extraction_provider_settings",
      );
      setExtractionProviderSettings({
        provider: settings.provider ?? "ollama",
        baseUrl: settings.baseUrl ?? "",
        apiKey: settings.apiKey ?? "",
        extractFastModel: settings.extractFastModel ?? "",
        extractFallbackModel: settings.extractFallbackModel ?? "",
        extractPipelineSummaryModel: settings.extractPipelineSummaryModel ?? "",
        extractPipelineNameModel: settings.extractPipelineNameModel ?? "",
        extractEdgeModel: settings.extractEdgeModel ?? "",
        extractEdgeValidateModel: settings.extractEdgeValidateModel ?? "",
      });
      setExtractionProviderError(null);
    } catch (error) {
      setExtractionProviderError(
        `加载抽取实验 provider 失败：${String(error)}`,
      );
    }
  };

  const handleSaveExtractionProviderSettings = async () => {
    setIsSavingExtractionProvider(true);
    try {
      const saved = await invoke<ExtractionProviderSettings>(
        "set_research_extraction_provider_settings",
        {
          settings: {
            ...extractionProviderSettings,
            baseUrl: extractionProviderSettings.baseUrl?.trim() || null,
            apiKey: extractionProviderSettings.apiKey?.trim() || null,
            extractFastModel:
              extractionProviderSettings.extractFastModel?.trim() || null,
            extractFallbackModel:
              extractionProviderSettings.extractFallbackModel?.trim() || null,
            extractPipelineSummaryModel:
              extractionProviderSettings.extractPipelineSummaryModel?.trim() ||
              null,
            extractPipelineNameModel:
              extractionProviderSettings.extractPipelineNameModel?.trim() ||
              null,
            extractEdgeModel:
              extractionProviderSettings.extractEdgeModel?.trim() || null,
            extractEdgeValidateModel:
              extractionProviderSettings.extractEdgeValidateModel?.trim() ||
              null,
          },
        },
      );
      setExtractionProviderSettings({
        provider: saved.provider ?? "ollama",
        baseUrl: saved.baseUrl ?? "",
        apiKey: saved.apiKey ?? "",
        extractFastModel: saved.extractFastModel ?? "",
        extractFallbackModel: saved.extractFallbackModel ?? "",
        extractPipelineSummaryModel: saved.extractPipelineSummaryModel ?? "",
        extractPipelineNameModel: saved.extractPipelineNameModel ?? "",
        extractEdgeModel: saved.extractEdgeModel ?? "",
        extractEdgeValidateModel: saved.extractEdgeValidateModel ?? "",
      });
      setExtractionProviderError(null);
      showTemporaryStatus("已保存抽取实验 provider 设置。");
    } catch (error) {
      setExtractionProviderError(
        `保存抽取实验 provider 失败：${String(error)}`,
      );
    } finally {
      setIsSavingExtractionProvider(false);
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

  const handleTreeChanged = useCallback(
    async (payload: TreeMutationPayload) => {
      for (const path of payload.refreshPaths) {
        await loadDirectoryChildren(path);
      }

      if (payload.rebasedPath && workspaceSelection) {
        const { from, to } = payload.rebasedPath;
        if (
          workspaceSelection.path === from ||
          workspaceSelection.path.startsWith(`${from}\\`) ||
          workspaceSelection.path.startsWith(`${from}/`)
        ) {
          setWorkspaceSelection({
            ...workspaceSelection,
            path: workspaceSelection.path.replace(from, to),
          });
        }
      }

      if (payload.rebasedPath && activeFilePath) {
        const { from, to } = payload.rebasedPath;
        if (
          activeFilePath === from ||
          activeFilePath.startsWith(`${from}\\`) ||
          activeFilePath.startsWith(`${from}/`)
        ) {
          setActiveFilePath(activeFilePath.replace(from, to));
        }
        return;
      }

      if (payload.removedPath && activeFilePath) {
        const removedPath = payload.removedPath;
        if (
          activeFilePath === removedPath ||
          activeFilePath.startsWith(`${removedPath}\\`) ||
          activeFilePath.startsWith(`${removedPath}/`)
        ) {
          setActiveFilePath(null);
          setIsPdfDockVisible(false);
        }
      }

      if (payload.removedPath && workspaceSelection) {
        const removedPath = payload.removedPath;
        if (
          workspaceSelection.path === removedPath ||
          workspaceSelection.path.startsWith(`${removedPath}\\`) ||
          workspaceSelection.path.startsWith(`${removedPath}/`)
        ) {
          setWorkspaceSelection(null);
        }
      }
    },
    [activeFilePath, loadDirectoryChildren, workspaceSelection],
  );

  useEffect(() => {
    console.info("[startup] App mounted");
    void loadInferenceSettings();
    void loadExtractionProviderSettings();
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
      setIngestStageSnapshots((current) => ({
        ...current,
        [event.payload.stage]: {
          current: event.payload.current,
          total: event.payload.total,
        },
      }));
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    if (!isIngesting || !ingestProgress) return;
    showPersistentStatus(
      `总进度 ${cumulativeProgressPercent}% · 当前阶段：${stageLabel}`,
      "info",
      cumulativeProgressPercent,
      ingestStatusDetails,
    );
  }, [
    cumulativeProgressPercent,
    ingestStatusDetails,
    ingestProgress,
    isIngesting,
    stageLabel,
    showPersistentStatus,
  ]);

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
        showPersistentStatus(`${status} ${percent}%`, "info", percent);
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
    let unlistenFn: (() => void) | null = null;
    listen<PullProgress>("pull-progress", (event) => {
      const { status, total, completed, modelName, sourceUrl } = event.payload;
      if (!status) return;

      const normalizedStatusText = status.trim();
      const sourceLabel = sourceUrl?.includes("modelscope.cn")
        ? "ModelScope 镜像"
        : sourceUrl?.includes("hf-mirror.com")
          ? "HF Mirror"
          : sourceUrl?.includes("ollama.com")
            ? "Ollama 官方"
            : "";
      const mainStatus =
        modelName &&
        (/^pulling\b/i.test(normalizedStatusText) ||
          /^downloading\b/i.test(normalizedStatusText) ||
          /^importing\b/i.test(normalizedStatusText))
          ? `正在拉取模型 ${modelName}`
          : normalizedStatusText;

      const sizeDetail =
        typeof total === "number" && total > 0 && typeof completed === "number"
          ? `已下载 ${formatByteSize(completed)} / ${formatByteSize(total)}`
          : typeof completed === "number" && completed > 0
            ? `已下载 ${formatByteSize(completed)}`
            : "";
      const details = [
        modelName ? `模型：${modelName}` : "",
        sourceLabel ? `来源：${sourceLabel}` : "",
        sourceUrl ? `下载地址：${sourceUrl}` : "",
        sizeDetail,
      ].filter(Boolean);

      const normalizedStatus = status.trim().toLowerCase();
      if (normalizedStatus === "success") {
        showTemporaryStatus("模型拉取完成。", "info", 2600, 100, details);
        return;
      }

      if (
        typeof total === "number" &&
        total > 0 &&
        typeof completed === "number"
      ) {
        const percent = Math.max(
          0,
          Math.min(100, Math.round((completed / total) * 100)),
        );
        showPersistentStatus(mainStatus, "info", percent, details);
        return;
      }

      showPersistentStatus(mainStatus, "info", undefined, details);
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [showPersistentStatus, showTemporaryStatus]);

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

  const ingestWorkspacePath = async (
    path: string,
    modeOverride?: IngestMode,
  ) => {
    setActiveSidebarTool("workspace");
    setIsIngesting(true);
    setIngestStageSnapshots({
      prepare_ingest: {
        current: 0,
        total: 1,
      },
    });
    setIngestExtractionMode(ingestRunMode);
    setIngestProgress({
      stage: "prepare_ingest",
      current: 0,
      total: 1,
      message: "正在准备论文导入...",
    });
    showPersistentStatus("正在准备论文导入...", "info", 0);
    try {
      const effectiveIngestMode = modeOverride ?? ingestMode;
      const useApiProvider =
        extractionProviderSettings.provider === "open_ai_compatible";
      let fastModel = "";
      let installedFallbackModel = "";
      if (useApiProvider) {
        fastModel =
          extractionProviderSettings.extractFastModel?.trim() ||
          extractModel.trim() ||
          REQUIRED_MODELS.extractFast;
        installedFallbackModel =
          extractionProviderSettings.extractFallbackModel?.trim() ||
          extractFallbackModel.trim() ||
          fastModel;
      } else {
        fastModel = await ensureAiReady("index");
        installedFallbackModel = await invoke<OllamaModelSummary[]>(
          "get_ollama_models",
        ).then((models) => {
          const names = models.map((model) => model.name);
          return (
            resolveInstalledModelName(
              names,
              extractFallbackModel || REQUIRED_MODELS.extractFallback,
            ) || fastModel
          );
        });
      }
      setIngestProgress({
        stage: "prepare_models",
        current: 0,
        total: 1,
        message: `索引模型已就绪：${useApiProvider ? "OpenAI-compatible" : "Ollama"} / 模式 ${ingestRunMode} / 候选 ${fastModel} / 回退 ${installedFallbackModel}`,
      });
      const count = await invoke<number>("ingest_research_corpus", {
        options: {
          extractFastModel: useApiProvider ? null : fastModel,
          extractFallbackModel: useApiProvider ? null : installedFallbackModel,
          extractPipelineSummaryModel: useApiProvider
            ? null
            : pipelineSummaryModel.trim() || installedFallbackModel,
          extractPipelineNameModel: useApiProvider
            ? null
            : pipelineNameModel.trim() ||
              pipelineSummaryModel.trim() ||
              installedFallbackModel,
          extractEdgeModel: useApiProvider
            ? null
            : edgeExtractModel.trim() || installedFallbackModel,
          extractEdgeValidateModel: useApiProvider
            ? null
            : edgeValidateModel.trim() ||
              edgeExtractModel.trim() ||
              installedFallbackModel,
          allowAutoPullExtractModel: true,
          extractionMode: ingestRunMode,
          extractProvider: {
            provider: extractionProviderSettings.provider,
            baseUrl: extractionProviderSettings.baseUrl?.trim() || null,
            apiKey: extractionProviderSettings.apiKey?.trim() || null,
            extractFastModel:
              extractionProviderSettings.extractFastModel?.trim() || null,
            extractFallbackModel:
              extractionProviderSettings.extractFallbackModel?.trim() || null,
            extractPipelineSummaryModel:
              extractionProviderSettings.extractPipelineSummaryModel?.trim() ||
              null,
            extractPipelineNameModel:
              extractionProviderSettings.extractPipelineNameModel?.trim() ||
              null,
            extractEdgeModel:
              extractionProviderSettings.extractEdgeModel?.trim() || null,
            extractEdgeValidateModel:
              extractionProviderSettings.extractEdgeValidateModel?.trim() ||
              null,
          },
          embeddingModel: null,
          visionModel: null,
          mode: effectiveIngestMode,
        },
        path,
      });
      if (count === 0) {
        showPersistentStatus(
          "未发现可处理文献。当前只会自动处理 pdf、md、txt 文件。",
          "error",
        );
      } else {
        showTemporaryStatus(`索引完成，已处理 ${count} 篇文献。`);
      }
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
    setActiveSidebarTool("workspace");
    setWorkspacePath(imported.workspace_path);
    setFiles([imported.tree]);
    setActiveFilePath(null);
    showPersistentStatus("文件已导入工作空间，正在建立索引...");
    await ingestWorkspacePath(imported.ingest_path);
    if (successMessage) showTemporaryStatus(successMessage);
  };

  const applyImportedZotero = async (imported: ZoteroImportResult) => {
    setActiveSidebarTool("workspace");
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
    setWorkspaceSelection({
      path: node.path,
      type_name: node.type_name,
      name: node.name,
    });
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

  const handleOpenPathInApp = useCallback(
    (path: string, page?: number, snippet?: string) => {
      const name = path.split(/[\\/]/).pop() || path;
      setActiveSidebarTool("workspace");
      setWorkspaceSelection({
        path,
        type_name: "file",
        name,
      });
      setActiveFilePath(path);
      if (path.toLowerCase().endsWith(".pdf")) {
        const nextPage = Math.max(1, page || 1);
        setPdfPage(nextPage);
        setPdfOpenAnchorRequest({
          key: `${path}:${nextPage}:${Date.now()}`,
          path,
          page: nextPage,
          snippet,
        });
        setIsPdfDockVisible(true);
      } else {
        setPdfOpenAnchorRequest(null);
      }
    },
    [],
  );

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
    const isOpeningPdfDock = !isPdfDockVisible;
    if (previousPdfPathRef.current !== activePdfPath) {
      setIsPdfDockVisible(true);
      previousPdfPathRef.current = activePdfPath;
      if (isOpeningPdfDock) {
        window.requestAnimationFrame(() => {
          mainPanelRef.current?.resize(`${DEFAULT_TWO_PANEL_LAYOUT.main}%`);
          pdfPanelRef.current?.resize(`${DEFAULT_TWO_PANEL_LAYOUT.pdf}%`);
        });
      }
    }
  }, [activePdfPath, isPdfDockVisible, isPdfFocusMode]);

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
              {ingestProgress?.total
                ? `总进度 ${cumulativeProgressPercent}% · 当前阶段 ${ingestProgress.current}/${ingestProgress.total}`
                : `总进度 ${cumulativeProgressPercent}%`}
            </div>
            <div className="ingest-progress-track">
              <div
                className="ingest-progress-fill"
                style={{ width: `${cumulativeProgressPercent}%` }}
              />
            </div>
            <div className="ingest-subprogress-track">
              <div
                className="ingest-subprogress-fill"
                style={{ width: `${stageProgressPercent}%` }}
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
          activePath={workspaceSelection?.path ?? activeFilePath}
          workspacePath={workspacePath}
          onSelect={handleFileSelect}
          onIndexPath={async (node) => {
            setWorkspaceSelection({
              path: node.path,
              type_name: node.type_name,
              name: node.name,
            });
            await ingestWorkspacePath(node.path, "overwrite");
          }}
          onReindexPath={async (node) => {
            setWorkspaceSelection({
              path: node.path,
              type_name: node.type_name,
              name: node.name,
            });
            await ingestWorkspacePath(node.path, "overwrite");
          }}
          onResumeIndexPath={async (node) => {
            setWorkspaceSelection({
              path: node.path,
              type_name: node.type_name,
              name: node.name,
            });
            await ingestWorkspacePath(node.path, "incremental");
          }}
          onUnindexPath={async (node) => {
            setWorkspaceSelection({
              path: node.path,
              type_name: node.type_name,
              name: node.name,
            });
            try {
              showPersistentStatus(`正在解除索引：${node.name}`);
              const removed = await invoke<number>("unindex_research_path", {
                path: node.path,
              });
              if (removed === 0) {
                showTemporaryStatus("选中项当前没有已建立的索引记录。");
              } else {
                showTemporaryStatus(`已解除 ${removed} 条论文索引记录。`);
              }
            } catch (error) {
              showPersistentStatus(`解除索引失败：${String(error)}`, "error");
            }
          }}
          onLoadChildren={loadDirectoryChildren}
          onTreeChanged={handleTreeChanged}
          onStatus={handleChildStatus}
        />
      </>
    ) : activeSidebarTool === "cards" ? (
      <div className="sidebar-tool-scroll">
        <div className="sidebar-tool-title">Knowledge Cards</div>
        <Suspense
          fallback={<div className="support-empty">Loading cards...</div>}
        >
          <CardLibrary
            refreshToken={cardsRefreshToken}
            activeRoot={cardSettings?.active_root}
            onStatus={handleChildStatus}
          />
        </Suspense>
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
      <Suspense
        fallback={
          <div className="support-empty">Loading research memory...</div>
        }
      >
        <ResearchMemoryPanel
          chatModel={currentModel || REQUIRED_MODELS.chat}
          extractFastModel={extractModel || REQUIRED_MODELS.extractFast}
          extractFallbackModel={
            extractFallbackModel || REQUIRED_MODELS.extractFallback
          }
          pipelineSummaryModel={
            pipelineSummaryModel || REQUIRED_MODELS.pipelineSummary
          }
          pipelineNameModel={pipelineNameModel || REQUIRED_MODELS.pipelineName}
          edgeExtractModel={edgeExtractModel || REQUIRED_MODELS.edgeExtract}
          edgeValidateModel={edgeValidateModel || REQUIRED_MODELS.edgeValidate}
          translationModel={translationModel || REQUIRED_MODELS.translation}
          onOpenPathInApp={handleOpenPathInApp}
          ingestProgress={ingestProgress}
          onStatus={(message, tone = "info") => {
            if (tone === "error") {
              showPersistentStatus(message, "error");
              return;
            }
            showTemporaryStatus(message, "info", 2600);
          }}
        />
      </Suspense>
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

  const generalSettingsSection = (
    <>
      <div className="settings-section">
        <label htmlFor="inference-mode-select">推理模式</label>
        <select
          id="inference-mode-select"
          value={inferenceMode}
          onChange={(event) =>
            void handleInferenceModeChange(event.target.value as InferenceMode)
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
          onChange={(event) => setIngestMode(event.target.value as IngestMode)}
        >
          <option value="overwrite">覆盖导入</option>
          <option value="incremental">增量导入</option>
        </select>
        <p className="settings-help-text">
          覆盖导入会从零重建当前导入目标；增量导入会尽量保留已有内容，并在可恢复时续跑未完成索引。
        </p>
      </div>

      <div className="settings-section">
        <label htmlFor="ingest-extraction-mode-select">抽取深度</label>
        <select
          id="ingest-extraction-mode-select"
          value={ingestRunMode}
          onChange={(event) =>
            setIngestRunMode(event.target.value as ExtractionRunMode)
          }
        >
          <option value="balanced">完整抽取（候选 + Pipeline + Edge）</option>
          <option value="fast">快速抽取（仅候选优先）</option>
        </select>
        <p className="settings-help-text">
          `balanced` 会继续执行 Pipeline 与 Edge 阶段，适合正式建图；`fast`
          只做快速候选播种，速度更快但通常不会产出完整边。
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
    </>
  );

  const modelSettingsSection = (
    <div className="settings-model-grid">
      <div className="settings-section">
        <label>模型运行时</label>
        <div className="settings-runtime-summary">
          <div className="settings-runtime-row">
            <span>下载优先级</span>
            <strong>HF Mirror / ModelScope，可用时不直连官方</strong>
          </div>
          <div className="settings-runtime-row">
            <span>索引策略</span>
            <strong>优先准备快速抽取模型；回退模型仅在已安装时启用</strong>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label>Research Memory Extraction Provider</label>
        <p className="settings-help-text">
          默认仍使用本地 Ollama。切换到外部 API
          后，抽取测试与实验索引会把论文片段发送到外部服务。
        </p>
        <div className="settings-model-stack">
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>实验 Provider</strong>
              <span>仅作用于 Research Memory 抽取评测与实验索引</span>
            </div>
            <div className="settings-provider-grid">
              <label className="settings-provider-field">
                <span>Provider</span>
                <select
                  value={extractionProviderSettings.provider}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      provider: event.target.value as ExtractionProviderKind,
                    }))
                  }
                >
                  <option value="ollama">Ollama</option>
                  <option value="open_ai_compatible">OpenAI-compatible</option>
                </select>
              </label>
              <label className="settings-provider-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={extractionProviderSettings.baseUrl ?? ""}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-provider-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={extractionProviderSettings.apiKey ?? ""}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                  placeholder="sk-..."
                />
              </label>
              <label className="settings-provider-field">
                <span>Fast Model</span>
                <input
                  type="text"
                  value={extractionProviderSettings.extractFastModel ?? ""}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractFastModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>
              <label className="settings-provider-field">
                <span>Fallback Model</span>
                <input
                  type="text"
                  value={extractionProviderSettings.extractFallbackModel ?? ""}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractFallbackModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1"
                />
              </label>
              <label className="settings-provider-field">
                <span>Pipeline Summary Model</span>
                <input
                  type="text"
                  value={
                    extractionProviderSettings.extractPipelineSummaryModel ?? ""
                  }
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractPipelineSummaryModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1"
                />
              </label>
              <label className="settings-provider-field">
                <span>Pipeline Name Model</span>
                <input
                  type="text"
                  value={
                    extractionProviderSettings.extractPipelineNameModel ?? ""
                  }
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractPipelineNameModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>
              <label className="settings-provider-field">
                <span>Edge Model</span>
                <input
                  type="text"
                  value={extractionProviderSettings.extractEdgeModel ?? ""}
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractEdgeModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1"
                />
              </label>
              <label className="settings-provider-field">
                <span>Edge Validate Model</span>
                <input
                  type="text"
                  value={
                    extractionProviderSettings.extractEdgeValidateModel ?? ""
                  }
                  onChange={(event) =>
                    setExtractionProviderSettings((current) => ({
                      ...current,
                      extractEdgeValidateModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>
            </div>
            <div className="settings-button-row">
              <button
                className="action-button"
                onClick={() => void handleSaveExtractionProviderSettings()}
                disabled={isSavingExtractionProvider}
              >
                {isSavingExtractionProvider ? "保存中..." : "保存抽取实验设置"}
              </button>
            </div>
            {extractionProviderError && (
              <p className="settings-error-text">{extractionProviderError}</p>
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label>聊天模型</label>
        <p className="settings-help-text">
          默认对话模型，当前建议使用 `qwen3.5:9b`。
        </p>
        <ModelSelector
          currentModel={currentModel}
          onModelChange={setCurrentModel}
          onStatus={handleChildStatus}
          label="聊天模型"
          variant="compact"
        />
      </div>

      <div className="settings-section">
        <label>抽取模型</label>
        <p className="settings-help-text">
          候选节点、Pipeline、Edge
          和校验现在拆成独立模型职责，默认值会直接参与论文索引。
        </p>
        <div className="settings-model-stack">
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>快速抽取模型</strong>
              <span>候选 Task / Module / Challenge / Insight</span>
            </div>
            <ModelSelector
              currentModel={extractModel}
              onModelChange={setExtractModel}
              onStatus={handleChildStatus}
              label="快速抽取模型"
              variant="compact"
            />
          </div>
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>节点回退模型</strong>
              <span>Candidate 抽取失败时兜底</span>
            </div>
            <ModelSelector
              currentModel={extractFallbackModel}
              onModelChange={setExtractFallbackModel}
              onStatus={handleChildStatus}
              label="节点回退模型"
              variant="compact"
            />
          </div>
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>Pipeline Summary 模型</strong>
              <span>先总结方法骨架，再做命名</span>
            </div>
            <ModelSelector
              currentModel={pipelineSummaryModel}
              onModelChange={setPipelineSummaryModel}
              onStatus={handleChildStatus}
              label="Pipeline Summary 模型"
              variant="compact"
            />
          </div>
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>Pipeline 命名模型</strong>
              <span>从 summary 中提取稳定 pipeline 名称</span>
            </div>
            <ModelSelector
              currentModel={pipelineNameModel}
              onModelChange={setPipelineNameModel}
              onStatus={handleChildStatus}
              label="Pipeline 命名模型"
              variant="compact"
            />
          </div>
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>Edge 抽取模型</strong>
              <span>
                抽取 task-pipeline、pipeline-module、challenge-insight
              </span>
            </div>
            <ModelSelector
              currentModel={edgeExtractModel}
              onModelChange={setEdgeExtractModel}
              onStatus={handleChildStatus}
              label="Edge 抽取模型"
              variant="compact"
            />
          </div>
          <div className="settings-model-card">
            <div className="settings-model-card-head">
              <strong>Edge 校验模型</strong>
              <span>删除证据不足或语义不稳的边</span>
            </div>
            <ModelSelector
              currentModel={edgeValidateModel}
              onModelChange={setEdgeValidateModel}
              onStatus={handleChildStatus}
              label="Edge 校验模型"
              variant="compact"
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label>翻译模型</label>
        <p className="settings-help-text">
          用于选区翻译和整页翻译，建议选更稳定的中英翻译模型。
        </p>
        <ModelSelector
          currentModel={translationModel}
          onModelChange={setTranslationModel}
          onStatus={handleChildStatus}
          label="翻译模型"
          variant="compact"
        />
      </div>
    </div>
  );

  const statusBannerSummary = statusBanner
    ? statusBanner.action
      ? "需要处理的状态"
      : statusBanner.message.length > 26
        ? `${statusBanner.message.slice(0, 26)}...`
        : statusBanner.message
    : "";

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
              <div className="status-banner-content">
                <div className="status-banner-text">{statusBanner.message}</div>
                {statusBanner.details && statusBanner.details.length > 0 && (
                  <div className="status-banner-details">
                    {statusBanner.details.map((detail) => (
                      <div key={detail} className="status-banner-detail-line">
                        {detail}
                      </div>
                    ))}
                  </div>
                )}
                {typeof statusBanner.progress === "number" && (
                  <div className="status-banner-progress-track">
                    <div
                      className="status-banner-progress-fill"
                      style={{ width: `${statusBanner.progress}%` }}
                    />
                  </div>
                )}
              </div>
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
        <Group orientation="horizontal">
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
                <div className="sidebar-rail-spacer" aria-hidden="true" />
                <button
                  className={`rail-button ${isSettingsOpen ? "active" : ""}`}
                  onClick={() => setIsSettingsOpen(true)}
                  title="Settings"
                >
                  <Settings size={18} />
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
                  {activeSidebarTool === "workspace" ? (
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
                    </div>
                  ) : null}
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
                <Suspense
                  fallback={
                    <div className="pdf-empty-state">
                      <h2>Loading PDF Reader</h2>
                      <p>正在按需加载 PDF 阅读器...</p>
                    </div>
                  }
                >
                  <PdfDock
                    activePdfPath={activePdfPath}
                    currentModel={currentModel || REQUIRED_MODELS.chat}
                    ensureAiReady={ensureAiReady}
                    translationModel={
                      translationModel || REQUIRED_MODELS.translation
                    }
                    ensureTranslationReady={ensureTranslationReady}
                    currentPage={pdfPage}
                    requestedAnchorText={
                      pdfOpenAnchorRequest?.path === activePdfPath
                        ? pdfOpenAnchorRequest.snippet
                        : undefined
                    }
                    requestedAnchorKey={
                      pdfOpenAnchorRequest?.path === activePdfPath
                        ? pdfOpenAnchorRequest.key
                        : undefined
                    }
                    onPageChange={setPdfPage}
                    onStatus={handleChildStatus}
                    onCardSaved={handleCardSaved}
                    isFocusMode={isPdfFocusMode}
                    onToggleFocusMode={handleTogglePdfFocusMode}
                    onClose={handleClosePdfDock}
                  />
                </Suspense>
              ) : (
                <div className="pdf-empty-state">
                  <h2>PDF Reader</h2>
                  <p>
                    Select a PDF file from the left workspace to preview it
                    here.
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
      </div>

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

            <div className="settings-tabs">
              <button
                className={`settings-tab ${activeSettingsTab === "general" ? "active" : ""}`}
                onClick={() => setActiveSettingsTab("general")}
              >
                General
              </button>
              <button
                className={`settings-tab ${activeSettingsTab === "models" ? "active" : ""}`}
                onClick={() => setActiveSettingsTab("models")}
              >
                Models
              </button>
              <button
                className={`settings-tab ${activeSettingsTab === "mobile" ? "active" : ""}`}
                onClick={() => setActiveSettingsTab("mobile")}
              >
                Mobile
              </button>
            </div>

            <div className="settings-tab-body">
              {activeSettingsTab === "general"
                ? generalSettingsSection
                : activeSettingsTab === "models"
                  ? modelSettingsSection
                  : mobileSettingsSection}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
