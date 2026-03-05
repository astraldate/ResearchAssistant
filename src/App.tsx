import { useEffect, useMemo, useState } from "react";
// @ts-ignore
import { Group, Panel, Separator } from "react-resizable-panels";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BookOpen, FolderOpen, Settings, X } from "lucide-react";
import { FileTree, FileNode } from "./components/FileTree";
import { ChatInterface } from "./components/ChatInterface";
import { ModelSelector } from "./components/ModelSelector";
import "./App.css";

type InferenceMode = "single_mm" | "dual_pipeline";
type IngestMode = "overwrite" | "incremental";

interface InferenceSettings {
  mode: InferenceMode;
}

interface IngestProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

interface WorkspaceImportResult {
  source_path: string;
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
  tree: FileNode;
  copied_pdfs: number;
  skipped_existing: number;
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

const HF_MIRROR_REPOS: Record<string, string> = {};

function App() {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [ingestMode, setIngestMode] = useState<IngestMode>("overwrite");

  const [currentModel, setCurrentModel] = useState<string>("");
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [initStatus, setInitStatus] = useState<string | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>("single_mm");
  const [isSavingInferenceMode, setIsSavingInferenceMode] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const progressPercent = useMemo(() => {
    if (!ingestProgress || ingestProgress.total <= 0) return 0;
    return Math.min(100, Math.round((ingestProgress.current / ingestProgress.total) * 100));
  }, [ingestProgress]);

  const stageLabel = useMemo(() => {
    const stage = ingestProgress?.stage;
    if (!stage) return "";
    const map: Record<string, string> = {
      scan: "扫描",
      chunk: "切分",
      summarize: "摘要",
      embed: "向量化",
      finalize: "完成",
    };
    return map[stage] || stage;
  }, [ingestProgress]);

  const loadInferenceSettings = async () => {
    try {
      const settings = await invoke<InferenceSettings>("get_inference_settings");
      setInferenceMode(settings.mode);
      setSettingsError(null);
    } catch (error) {
      console.error("Failed to load inference settings:", error);
      setSettingsError("加载推理设置失败。");
    }
  };

  useEffect(() => {
    loadInferenceSettings();
  }, []);

  useEffect(() => {
    const storedMode = localStorage.getItem("ingest_mode");
    if (storedMode === "overwrite" || storedMode === "incremental") {
      setIngestMode(storedMode);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ingest_mode", ingestMode);
  }, [ingestMode]);

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
      setInitStatus("正在连接 AI 服务...");
      try {
        const isRunning = await invoke<boolean>("check_ollama_status");
        if (!isRunning) {
          setInitStatus("正在启动 AI 服务...");
          await invoke("start_ollama");
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        const pullModel = async (name: string) => {
          const hfRepo = HF_MIRROR_REPOS[name];
          if (hfRepo) {
            try {
              setInitStatus(`正在解析镜像模型：${name}...`);
              const resolved = await invoke<{ url: string; filename: string }>("resolve_hf_gguf", { repo: hfRepo });
              await invoke("pull_model_from_modelscope", {
                name,
                url: resolved.url,
                filename: resolved.filename,
              });
              return;
            } catch (error) {
              console.error("HF mirror pull failed:", error);
            }
          }

          const mirror = MIRROR_MODELS[name];
          if (mirror) {
            try {
              setInitStatus(`正在下载镜像模型：${name}...`);
              await invoke("pull_model_from_modelscope", {
                name,
                url: mirror.url,
                filename: mirror.filename,
              });
              return;
            } catch (error) {
              console.error("ModelScope mirror pull failed:", error);
            }
          }

          setInitStatus(`正在拉取模型：${name}...`);
          await invoke("pull_ollama_model", { name });
        };

        setInitStatus("正在检查必需模型...");
        let models = await invoke<{ name: string }[]>("get_ollama_models");
        let modelNames = models.map((m) => m.name);

        if (!modelNames.some((n) => n.includes(REQUIRED_MODELS.embedding))) {
          await pullModel(REQUIRED_MODELS.embedding);
        }
        if (!modelNames.some((n) => n.includes(REQUIRED_MODELS.chat))) {
          await pullModel(REQUIRED_MODELS.chat);
        }

        models = await invoke<{ name: string }[]>("get_ollama_models");
        modelNames = models.map((m) => m.name);
        const chatModel =
          modelNames.find((n) => n === REQUIRED_MODELS.chat) ||
          modelNames.find((n) => n.includes(REQUIRED_MODELS.chat)) ||
          modelNames[0];

        if (chatModel) {
          setCurrentModel(chatModel);
        }
        setInitStatus(null);
      } catch (error) {
        console.error("Initialization failed:", error);
        setInitStatus("初始化失败，请确认 Ollama 正在运行。");
      }
    };

    initOllama();
  }, []);

  const ingestWorkspacePath = async (path: string) => {
    setIsIngesting(true);
    setIngestProgress({
      stage: "scan",
      current: 0,
      total: 0,
      message: "正在准备导入...",
    });

    try {
      const count = await invoke<number>("ingest_knowledge_base", {
        path,
        model: currentModel || REQUIRED_MODELS.chat,
        mode: ingestMode,
      });
      console.log(`Ingested ${count} documents`);
    } catch (error) {
      console.error("Ingestion failed:", error);
    } finally {
      setIsIngesting(false);
    }
  };

  const importAndIngestPath = async (selectedPath: string) => {
    const imported = await invoke<WorkspaceImportResult>("import_directory_to_workspace", {
      source_path: selectedPath,
      mode: ingestMode,
    });
    setWorkspacePath(imported.workspace_path);
    setFiles([imported.tree]);
    await ingestWorkspacePath(imported.workspace_path);
  };

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (!selected || typeof selected !== "string") {
        return;
      }

      await importAndIngestPath(selected);
    } catch (error) {
      console.error("Failed to open folder:", error);
    }
  };

  const pickAndImportZoteroManually = async (prefixStatus?: string) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "请选择 Zotero 数据目录或 storage 目录（目录选择器不会显示 PDF 文件）",
    });
    if (!selected || typeof selected !== "string") {
      setInitStatus(prefixStatus ?? null);
      setTimeout(() => setInitStatus(null), 1200);
      return;
    }

    const manualImported = await invoke<ZoteroImportResult>("import_zotero_storage_to_workspace", {
      source_storage_path: selected,
      mode: ingestMode,
    });
    setWorkspacePath(manualImported.workspace_path);
    setFiles([manualImported.tree]);
    await ingestWorkspacePath(manualImported.workspace_path);
    setInitStatus(`Zotero 手动导入完成：新增 ${manualImported.copied_pdfs}，已存在 ${manualImported.skipped_existing}`);
    setTimeout(() => setInitStatus(null), 2600);
  };

  const handleImportZotero = async () => {
    try {
      setInitStatus("正在查找 Zotero 本地库...");
      const candidates = await invoke<ZoteroStorageCandidate[]>("detect_zotero_storage");
      if (candidates.length === 0) {
        await pickAndImportZoteroManually("未自动发现 Zotero，请手动选择目录...");
        return;
      }

      const best = [...candidates].sort((a, b) => b.pdf_count - a.pdf_count)[0];
      setInitStatus(`已找到 Zotero（${best.pdf_count} 篇 PDF），正在导入...`);
      const imported = await invoke<ZoteroImportResult>("import_zotero_storage_to_workspace", {
        source_storage_path: best.storage_path,
        mode: ingestMode,
      });
      setWorkspacePath(imported.workspace_path);
      setFiles([imported.tree]);
      await ingestWorkspacePath(imported.workspace_path);
      setInitStatus(`Zotero 导入完成：新增 ${imported.copied_pdfs}，已存在 ${imported.skipped_existing}`);
      setTimeout(() => setInitStatus(null), 2600);
    } catch (error) {
      console.error("Failed to import Zotero:", error);
      try {
        await pickAndImportZoteroManually(`自动导入失败：${String(error).slice(0, 120)}。请手动选择目录...`);
      } catch (manualError) {
        console.error("Manual Zotero import failed:", manualError);
        setInitStatus(`导入 Zotero 失败：${String(manualError).slice(0, 160)}`);
        setTimeout(() => setInitStatus(null), 3800);
      }
    }
  };

  const handleFileSelect = async (node: FileNode) => {
    if (node.type_name !== "file") {
      return;
    }

    setActiveFilePath(node.path);

    const lowerPath = node.path.toLowerCase();
    if (lowerPath.endsWith(".pdf")) {
      return;
    }

    try {
      await invoke("open_file", { path: node.path });
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleInferenceModeChange = async (nextMode: InferenceMode) => {
    setIsSavingInferenceMode(true);
    setSettingsError(null);
    try {
      const updated = await invoke<InferenceSettings>("set_inference_mode", { mode: nextMode });
      setInferenceMode(updated.mode);
    } catch (error) {
      console.error("Failed to save inference mode:", error);
      setSettingsError("保存推理模式失败。");
      await loadInferenceSettings();
    } finally {
      setIsSavingInferenceMode(false);
    }
  };

  return (
    <div className="app-container">
      {initStatus && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            backgroundColor: "var(--text-accent)",
            color: "white",
            padding: "4px 12px",
            fontSize: "0.8rem",
            textAlign: "center",
            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
          }}
        >
          {initStatus}
        </div>
      )}

      {/* @ts-ignore */}
      <Group direction="horizontal">
        <Panel defaultSize={300} minSize={250} maxSize={600} collapsible={false} className="sidebar-panel">
          <div className="sidebar">
            <div className="sidebar-header">
              <span>文件</span>
              <div className="sidebar-actions">
                <button
                  onClick={handleImportZotero}
                  className="icon-button"
                  title="自动导入 Zotero PDF（失败可手动选择）"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
                >
                  <BookOpen size={16} />
                </button>
                <button
                  onClick={handleOpenFolder}
                  className="icon-button"
                  title="打开文件夹"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="icon-button"
                  title="设置"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
                >
                  <Settings size={16} />
                </button>
              </div>
            </div>

            {isIngesting && (
              <div style={{ padding: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                <div>{ingestProgress?.message || "导入中..."}</div>
                {ingestProgress && ingestProgress.total > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div
                      style={{
                        width: "100%",
                        height: 4,
                        background: "var(--bg-tertiary)",
                        borderRadius: 2,
                      }}
                    >
                      <div
                        style={{
                          width: `${progressPercent}%`,
                          height: "100%",
                          background: "var(--text-accent)",
                          borderRadius: 2,
                          transition: "width 0.15s ease",
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {stageLabel}: {ingestProgress.current}/{ingestProgress.total}
                    </div>
                  </div>
                )}
              </div>
            )}

            {workspacePath && (
              <div
                style={{
                  padding: "4px 10px 8px 10px",
                  fontSize: "0.72rem",
                  color: "var(--text-secondary)",
                  borderBottom: "1px solid var(--border-color)",
                  wordBreak: "break-all",
                }}
                title={workspacePath}
              >
                工作区：{workspacePath}
              </div>
            )}

            <FileTree data={files.length > 0 ? files : undefined} onSelect={handleFileSelect} />
            <ModelSelector currentModel={currentModel} onModelChange={setCurrentModel} />
          </div>
        </Panel>

        <Separator className="PanelResizeHandle" />

        <Panel>
          <ChatInterface currentModel={currentModel} activeFilePath={activeFilePath} />
        </Panel>
      </Group>

      {isSettingsOpen && (
        <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>设置</h3>
              <button className="settings-close-button" onClick={() => setIsSettingsOpen(false)} aria-label="关闭设置">
                <X size={16} />
              </button>
            </div>

            <div className="settings-section">
              <label htmlFor="inference-mode-select">推理模式</label>
              <select
                id="inference-mode-select"
                value={inferenceMode}
                onChange={(event) => handleInferenceModeChange(event.target.value as InferenceMode)}
                disabled={isSavingInferenceMode}
              >
                <option value="single_mm">single_mm（默认）</option>
                <option value="dual_pipeline">dual_pipeline（备用）</option>
              </select>
              <p className="settings-help-text">
                `single_mm` 使用单个多模态模型。`dual_pipeline` 为性能或效果验证时的备用路径。
              </p>
              {settingsError && <p className="settings-error-text">{settingsError}</p>}
            </div>

            <div className="settings-section">
              <label htmlFor="ingest-mode-select">知识库导入模式</label>
              <select
                id="ingest-mode-select"
                value={ingestMode}
                onChange={(event) => setIngestMode(event.target.value as IngestMode)}
              >
                <option value="overwrite">overwrite（覆盖重建索引）</option>
                <option value="incremental">incremental（增量追加）</option>
              </select>
              <p className="settings-help-text">选择覆盖可重建索引，选择增量可保留并追加已有索引内容。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
