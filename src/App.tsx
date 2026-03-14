import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { BookOpen, FilePlus, FolderOpen, LayoutGrid, MessageSquareText, Settings, X } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FileNode, FileTree } from "./components/FileTree";
import { ChatInterface } from "./components/ChatInterface";
import { CardLibrary } from "./components/CardLibrary";
import { ModelSelector } from "./components/ModelSelector";
import "./App.css";

type InferenceMode = "single_mm" | "dual_pipeline";
type IngestMode = "overwrite" | "incremental";
type MainView = "chat" | "cards";
type StatusTone = "info" | "error";

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

const REQUIRED_MODELS = {
  embedding: "nomic-embed-text",
  chat: "qwen2.5:0.5b",
};

const MIRROR_MODELS: Record<string, { url: string; filename: string }> = {
  "nomic-embed-text": {
    url: "https://modelscope.cn/models/AI-ModelScope/nomic-embed-text-v1.5-GGUF/resolve/master/nomic-embed-text-v1.5.Q4_K_M.gguf",
    filename: "nomic-embed-text-v1.5.Q4_K_M.gguf",
  },
};

const STAGE_LABELS: Record<string, string> = {
  scan: "扫描文件",
  chunk: "切分文本",
  summarize: "生成摘要",
  embed: "建立向量",
  finalize: "保存索引",
};

function App() {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState("");
  const [mainView, setMainView] = useState<MainView>("chat");
  const [ingestMode, setIngestMode] = useState<IngestMode>("overwrite");
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>("single_mm");
  const [isSavingInferenceMode, setIsSavingInferenceMode] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [cardSettings, setCardSettings] = useState<CardSettings | null>(null);
  const [cardSettingsError, setCardSettingsError] = useState<string | null>(null);
  const [cardsRefreshToken, setCardsRefreshToken] = useState(0);

  const statusTimerRef = useRef<number | null>(null);

  const progressPercent = useMemo(() => {
    if (!ingestProgress || ingestProgress.total <= 0) return 0;
    return Math.min(100, Math.round((ingestProgress.current / ingestProgress.total) * 100));
  }, [ingestProgress]);

  const stageLabel = STAGE_LABELS[ingestProgress?.stage || ""] || "处理中";

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  const showStatus = useCallback((message: string, tone: StatusTone = "info", timeoutMs?: number) => {
    clearStatusTimer();
    setStatusBanner({ message, tone });
    if (timeoutMs && timeoutMs > 0) {
      statusTimerRef.current = window.setTimeout(() => {
        setStatusBanner((current) => (current?.message === message ? null : current));
        statusTimerRef.current = null;
      }, timeoutMs);
    }
  }, [clearStatusTimer]);

  const showTemporaryStatus = useCallback((message: string, tone: StatusTone = "info", timeoutMs = 3200) => {
    showStatus(message, tone, timeoutMs);
  }, [showStatus]);

  const showPersistentStatus = useCallback((message: string, tone: StatusTone = "info") => {
    showStatus(message, tone);
  }, [showStatus]);

  const clearStatus = useCallback(() => {
    clearStatusTimer();
    setStatusBanner(null);
  }, [clearStatusTimer]);

  const handleChildStatus = useCallback((message: string, tone: StatusTone = "info", persistent = false) => {
    if (persistent || tone === "error") {
      showPersistentStatus(message, tone);
      return;
    }
    showTemporaryStatus(message, tone);
  }, [showPersistentStatus, showTemporaryStatus]);

  useEffect(() => () => clearStatusTimer(), []);

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
    try {
      const settings = await invoke<InferenceSettings>("get_inference_settings");
      setInferenceMode(settings.mode);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(`加载推理模式失败：${String(error)}`);
    }
  };

  const loadWorkspaceSnapshot = async () => {
    try {
      const snapshot = await invoke<WorkspaceSnapshot>("get_workspace_snapshot");
      setWorkspacePath(snapshot.workspace_path);
      setFiles([snapshot.tree]);
    } catch (error) {
      console.error("Failed to load workspace snapshot:", error);
    }
  };

  const loadCardSettings = async () => {
    try {
      const settings = await invoke<CardSettings>("get_card_settings");
      setCardSettings(settings);
      setCardSettingsError(null);
    } catch (error) {
      setCardSettingsError(`加载知识卡片路径失败：${String(error)}`);
    }
  };

  useEffect(() => {
    void loadInferenceSettings();
    void loadWorkspaceSnapshot();
    void loadCardSettings();
  }, []);

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
    const initOllama = async () => {
      try {
        showPersistentStatus("正在检查本地 AI 环境...");
        const isRunning = await invoke<boolean>("check_ollama_status");
        if (!isRunning) {
          showPersistentStatus("正在启动内置 Ollama 服务...");
          await invoke("start_ollama");
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
        }

        const pullModel = async (name: string) => {
          const mirror = MIRROR_MODELS[name];
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

        let models = await invoke<Array<{ name: string }>>("get_ollama_models");
        let names = models.map((model) => model.name);

        if (!names.some((name) => name.includes(REQUIRED_MODELS.embedding))) {
          await pullModel(REQUIRED_MODELS.embedding);
        }
        if (!names.some((name) => name.includes(REQUIRED_MODELS.chat))) {
          await pullModel(REQUIRED_MODELS.chat);
        }

        models = await invoke<Array<{ name: string }>>("get_ollama_models");
        names = models.map((model) => model.name);
        const selectedModel =
          names.find((name) => name === REQUIRED_MODELS.chat) ||
          names.find((name) => name.includes(REQUIRED_MODELS.chat)) ||
          names[0] || "";
        setCurrentModel(selectedModel);
        clearStatus();
      } catch (error) {
        showPersistentStatus(`AI 初始化失败：${String(error)}`, "error");
      }
    };

    void initOllama();
  }, []);

  const ingestWorkspacePath = async (path: string) => {
    setIsIngesting(true);
    setIngestProgress({ stage: "scan", current: 0, total: 0, message: "正在扫描文件..." });
    try {
      const count = await invoke<number>("ingest_knowledge_base", {
        path,
        model: currentModel || REQUIRED_MODELS.chat,
        mode: ingestMode,
      });
      showTemporaryStatus(`索引完成，已处理 ${count} 个片段。`);
    } catch (error) {
      showPersistentStatus(`建立索引失败：${String(error)}`, "error");
    } finally {
      setIsIngesting(false);
    }
  };

  const applyImportedWorkspace = async (imported: WorkspaceImportResult, successMessage?: string) => {
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
    showTemporaryStatus(`Zotero 导入完成：复制 ${imported.copied_pdfs} 个 PDF，跳过 ${imported.skipped_existing} 个。`, "info", 4200);
  };

  const importAndIngestPath = async (selectedPath: string) => {
    const imported = await invoke<WorkspaceImportResult>("import_directory_to_workspace", {
      sourcePath: selectedPath,
      mode: ingestMode,
    });
    await applyImportedWorkspace(imported, "文件夹已导入工作空间。");
  };

  const importAndIngestFiles = async (selectedPaths: string[]) => {
    const imported = await invoke<WorkspaceImportResult>("import_paths_to_workspace", {
      sourcePaths: selectedPaths,
      mode: ingestMode,
    });
    await applyImportedWorkspace(imported, `已导入 ${selectedPaths.length} 个项目到工作空间。`);
  };

  const handleOpenFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择要导入的文件夹" });
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

    const imported = await invoke<ZoteroImportResult>("import_zotero_storage_to_workspace", {
      sourceStorage: selected,
      sourceStoragePath: selected,
      source_storage_path: selected,
      mode: ingestMode,
    });
    await applyImportedZotero(imported);
  };

  const handleImportZotero = async () => {
    try {
      showPersistentStatus("正在自动查找 Zotero 存储目录...");
      const candidates = await invoke<ZoteroStorageCandidate[]>("detect_zotero_storage");
      if (candidates.length === 0) {
        await pickAndImportZoteroManually("没有自动发现 Zotero 目录，请手动选择。 ");
        return;
      }
      const best = [...candidates].sort((a, b) => b.pdf_count - a.pdf_count)[0];
      const imported = await invoke<ZoteroImportResult>("import_zotero_storage_to_workspace", {
        sourceStorage: best.storage_path,
        sourceStoragePath: best.storage_path,
        source_storage_path: best.storage_path,
        mode: ingestMode,
      });
      await applyImportedZotero(imported);
    } catch (error) {
      try {
        await pickAndImportZoteroManually(`自动导入 Zotero 失败：${String(error)}`);
      } catch (manualError) {
        showPersistentStatus(`导入 Zotero 失败：${String(manualError)}`, "error");
      }
    }
  };

  const handleFileSelect = async (node: FileNode) => {
    if (node.type_name !== "file") return;
    setActiveFilePath(node.path);
    setMainView("chat");
    if (node.path.toLowerCase().endsWith(".pdf")) return;
    try {
      await invoke("open_file", { path: node.path });
    } catch (error) {
      showPersistentStatus(`打开文件失败：${String(error)}`, "error");
    }
  };

  const handleInferenceModeChange = async (nextMode: InferenceMode) => {
    setIsSavingInferenceMode(true);
    try {
      const updated = await invoke<InferenceSettings>("set_inference_mode", { mode: nextMode });
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
      const selected = await open({ directory: true, multiple: false, title: "选择知识卡片存放目录" });
      if (!selected || typeof selected !== "string") return;
      const next = await invoke<CardSettings>("set_card_root_path", { path: selected });
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
      const next = await invoke<CardSettings>("set_card_root_path", { path: null });
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

  return (
    <div className="app-shell">
      {statusBanner && (
        <div className={`status-banner ${statusBanner.tone}`}>
          <div className="status-banner-text">{statusBanner.message}</div>
          <button className="ghost-icon-button light" onClick={clearStatus} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}

      <Group orientation="horizontal" className="app-panels">
        <Panel defaultSize={320} minSize={260} maxSize={680} className="sidebar-panel">
          <aside className="sidebar">
            <div className="sidebar-header">
              <span>工作空间</span>
              <div className="sidebar-actions">
                <button className="icon-button" onClick={() => void handleImportZotero()} title="自动导入 Zotero PDF">
                  <BookOpen size={16} />
                </button>
                <button className="icon-button" onClick={() => void handleOpenFiles()} title="导入文件">
                  <FilePlus size={16} />
                </button>
                <button className="icon-button" onClick={() => void handleOpenFolder()} title="导入文件夹">
                  <FolderOpen size={16} />
                </button>
                <button className="icon-button" onClick={() => setIsSettingsOpen(true)} title="设置">
                  <Settings size={16} />
                </button>
              </div>
            </div>

            {isIngesting && (
              <div className="ingest-panel">
                <div className="ingest-title">{stageLabel}</div>
                <div className="ingest-subtitle">
                  {ingestProgress?.total ? `${ingestProgress.current}/${ingestProgress.total}` : "准备中..."}
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

            <FileTree data={files.length > 0 ? files : undefined} activePath={activeFilePath} onSelect={handleFileSelect} />
            <ModelSelector currentModel={currentModel} onModelChange={setCurrentModel} />
          </aside>
        </Panel>

        <Separator className="PanelResizeHandle" />

        <Panel className="main-panel">
          <div className="main-panel-tabs">
            <button className={`tab-button ${mainView === "chat" ? "active" : ""}`} onClick={() => setMainView("chat")}>
              <MessageSquareText size={16} />
              对话
            </button>
            <button className={`tab-button ${mainView === "cards" ? "active" : ""}`} onClick={() => setMainView("cards")}>
              <LayoutGrid size={16} />
              卡片库
            </button>
          </div>

          {mainView === "chat" ? (
            <ChatInterface
              currentModel={currentModel}
              activeFilePath={activeFilePath}
              onStatus={handleChildStatus}
              onCardSaved={handleCardSaved}
            />
          ) : (
            <CardLibrary refreshToken={cardsRefreshToken} activeRoot={cardSettings?.active_root} onStatus={handleChildStatus} />
          )}
        </Panel>
      </Group>

      <div className="app-copyright-badge" aria-label="版权声明">
        版权所有 © 4C 比赛参赛团队，仅限授权使用，未经许可严禁搬运
      </div>

      {isSettingsOpen && (
        <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>设置</h3>
              <button className="ghost-icon-button" onClick={() => setIsSettingsOpen(false)} aria-label="关闭设置">
                <X size={16} />
              </button>
            </div>

            <div className="settings-section">
              <label htmlFor="inference-mode-select">推理模式</label>
              <select
                id="inference-mode-select"
                value={inferenceMode}
                onChange={(event) => void handleInferenceModeChange(event.target.value as InferenceMode)}
                disabled={isSavingInferenceMode}
              >
                <option value="single_mm">单模型原生多模态优先</option>
                <option value="dual_pipeline">双模型作为性能 / 精度备选</option>
              </select>
              <p className="settings-help-text">`single_mm` 走单模型图文理解；`dual_pipeline` 目前保留为后续双路由扩展骨架。</p>
              {settingsError && <p className="settings-error-text">{settingsError}</p>}
            </div>

            <div className="settings-section">
              <label htmlFor="ingest-mode-select">导入索引模式</label>
              <select id="ingest-mode-select" value={ingestMode} onChange={(event) => setIngestMode(event.target.value as IngestMode)}>
                <option value="overwrite">覆盖导入</option>
                <option value="incremental">增量导入</option>
              </select>
              <p className="settings-help-text">覆盖导入会重建当前导入目标的索引；增量导入会尽量保留已存在内容。</p>
            </div>

            <div className="settings-section">
              <label>知识卡片路径</label>
              <div className="settings-path-box">{cardSettings?.active_root || "尚未加载"}</div>
              <div className="settings-button-row">
                <button className="action-button" onClick={() => void handlePickCardRoot()}>
                  选择路径
                </button>
                <button className="action-button" onClick={() => void handleResetCardRoot()}>
                  恢复默认
                </button>
                <button className="action-button" onClick={() => void handleOpenCardRoot()}>
                  打开目录
                </button>
              </div>
              <p className="settings-help-text">
                {cardSettings?.using_custom_root ? "当前使用自定义卡片目录。" : "当前使用应用默认卡片目录。"}
              </p>
              {cardSettingsError && <p className="settings-error-text">{cardSettingsError}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;



