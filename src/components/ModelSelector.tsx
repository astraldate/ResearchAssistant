import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  Code2,
  Download,
  ExternalLink,
  Image,
  RefreshCw,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { resolveMirrorModel } from "../utils/modelMirrors";

interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  details: unknown;
}

interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (model: string) => void;
  onStatus?: (
    message: string,
    tone?: "info" | "error",
    persistent?: boolean,
  ) => void;
  variant?: "compact" | "drawer";
}

type ModelCategory =
  | "general"
  | "reasoning"
  | "coding"
  | "vision"
  | "embedding";

interface RecommendedModel {
  name: string;
  category: ModelCategory;
  summary: string;
  approxSize: string;
  sourceUrl: string;
  checkedAt: string;
}

const ZH = {
  model: "\u6a21\u578b",
  refresh: "\u5237\u65b0\u6a21\u578b\u5217\u8868",
  selectModel: "\u9009\u62e9\u6a21\u578b",
  noModels: "\u672a\u53d1\u73b0\u6a21\u578b\u3002",
  pullPlaceholder: "\u62c9\u53d6\u6a21\u578b\uff08\u5982 qwen3:8b\uff09",
  connectFailed:
    "\u8fde\u63a5 Ollama \u5931\u8d25\u3002\u8bf7\u786e\u8ba4\u670d\u52a1\u5df2\u542f\u52a8\u3002",
  pullStarted: "\u5f00\u59cb\u62c9\u53d6\u6a21\u578b\uff1a",
  pullFailed: "\u62c9\u53d6\u5931\u8d25\uff1a",
  pullFailedNetworkHint:
    "\u8fde\u63a5 Ollama \u5b98\u65b9\u6a21\u578b\u4ed3\u5e93\u5931\u8d25\uff0c\u53ef\u80fd\u662f\u7f51\u7edc\u88ab\u91cd\u7f6e\u6216\u62e6\u622a\u3002\u53ef\u5148\u4f7f\u7528\u5df2\u5b89\u88c5\u6a21\u578b\uff0c\u6216\u7a0d\u540e\u91cd\u8bd5\u3002",
  recTitle:
    "\u63a8\u8350\u6a21\u578b\uff08\u5df2\u8054\u7f51\u6574\u7406\uff0c\u53ef\u76f4\u63a5\u9009\u62e9\uff09",
  fill: "\u586b\u5165",
  pullSelected: "\u62c9\u53d6\u6240\u9009",
  pullMirror: "\u4f18\u5148\u955c\u50cf\u62c9\u53d6",
  source: "\u6765\u6e90\uff1a",
  checkedAt: "\u6700\u8fd1\u68c0\u67e5\uff1a",
  installed: "\uff08\u5df2\u5b89\u88c5\uff09",
  mirrorAvailable: "\uff08\u53ef\u8d70\u955c\u50cf\uff09",
  general: "\u901a\u7528",
  reasoning: "\u63a8\u7406",
  coding: "\u4ee3\u7801",
  vision: "\u89c6\u89c9",
  embedding: "\u5411\u91cf",
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  general: ZH.general,
  reasoning: ZH.reasoning,
  coding: ZH.coding,
  vision: ZH.vision,
  embedding: ZH.embedding,
};

const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    name: "qwen3.5:9b",
    category: "general",
    summary: "通用/多模态/中文友好/平衡型，适合中文对话、文档理解与混合任务。",
    approxSize: "~6.6GB",
    sourceUrl: "https://ollama.com/library/qwen3.5",
    checkedAt: "2026-03-12",
  },
  {
    name: "qwen3:8b",
    category: "general",
    summary: "Qwen 3 系列，中文能力、通用问答和推理能力比较均衡。",
    approxSize: "~5GB",
    sourceUrl: "https://ollama.com/library/qwen3",
    checkedAt: "2026-03-05",
  },
  {
    name: "gemma3:4b",
    category: "general",
    summary: "Gemma 3 小体量多模态模型，适合轻量本地部署。",
    approxSize: "~3.3GB",
    sourceUrl: "https://www.ollama.com/library/gemma3",
    checkedAt: "2026-03-05",
  },
  {
    name: "deepseek-r1",
    category: "reasoning",
    summary: "偏推理强化，适合数学、逻辑和复杂分析任务。",
    approxSize: "~5GB (default distilled variant)",
    sourceUrl: "https://ollama.com/library/deepseek-r1",
    checkedAt: "2026-03-05",
  },
  {
    name: "llama3.3",
    category: "general",
    summary: "大参数通用模型，适合多语言写作和长对话。",
    approxSize: "~43GB",
    sourceUrl: "https://ollama.com/library/llama3.3",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen3-coder:30b",
    category: "coding",
    summary: "长上下文代码模型，适合仓库级代码理解和生成。",
    approxSize: "~19GB",
    sourceUrl: "https://ollama.com/library/qwen3-coder",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen2.5-coder:7b",
    category: "coding",
    summary: "速度和效果更平衡的代码模型，适合本地开发辅助。",
    approxSize: "~4.7GB",
    sourceUrl: "https://ollama.com/library/qwen2.5-coder",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen2.5vl:7b",
    category: "vision",
    summary: "视觉语言模型，适合图片理解、表格和图文问答。",
    approxSize: "~6GB",
    sourceUrl: "https://ollama.com/library/qwen2.5vl",
    checkedAt: "2026-03-05",
  },
  {
    name: "mistral-small3.1",
    category: "vision",
    summary: "支持视觉能力和长上下文，适合复杂文档理解。",
    approxSize: "~15GB",
    sourceUrl: "https://ollama.com/library/mistral-small3.1",
    checkedAt: "2026-03-05",
  },
  {
    name: "minicpm-v",
    category: "vision",
    summary: "轻量视觉模型，常用于 OCR 和图像理解流程。",
    approxSize: "~8GB",
    sourceUrl: "https://ollama.com/library/minicpm-v",
    checkedAt: "2026-03-05",
  },
  {
    name: "nomic-embed-text",
    category: "embedding",
    summary: "适合本地 RAG 建库和检索的向量模型。",
    approxSize: "~274MB",
    sourceUrl: "https://ollama.com/library/nomic-embed-text",
    checkedAt: "2026-03-05",
  },
  {
    name: "mxbai-embed-large",
    category: "embedding",
    summary: "效果更强的检索向量模型，适合追求召回质量。",
    approxSize: "~670MB",
    sourceUrl: "https://ollama.com/library/mxbai-embed-large",
    checkedAt: "2026-03-05",
  },
];

const CATEGORY_ORDER: ModelCategory[] = [
  "general",
  "reasoning",
  "coding",
  "vision",
  "embedding",
];

const renderCategoryIcon = (category: ModelCategory) => {
  switch (category) {
    case "reasoning":
      return <BrainCircuit size={14} />;
    case "coding":
      return <Code2 size={14} />;
    case "vision":
      return <Image size={14} />;
    case "embedding":
      return <Waypoints size={14} />;
    case "general":
    default:
      return <Sparkles size={14} />;
  }
};

const resolvePulledModelName = (
  requested: string,
  list: OllamaModel[],
): string => {
  const exact = list.find((m) => m.name === requested);
  if (exact) return exact.name;

  if (!requested.includes(":")) {
    const latest = list.find((m) => m.name === `${requested}:latest`);
    if (latest) return latest.name;
  }

  const base = requested.split(":")[0];
  const sameFamily = list.find((m) => m.name.startsWith(`${base}:`));
  return sameFamily?.name ?? requested;
};

const isInstalled = (target: string, installed: OllamaModel[]) => {
  const targetBase = target.split(":")[0];
  return installed.some((m) => {
    const installedBase = m.name.split(":")[0];
    return m.name === target || installedBase === targetBase;
  });
};

const canUseMirror = (target: string) => Boolean(resolveMirrorModel(target));

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModel,
  onModelChange,
  onStatus,
  variant = "compact",
}) => {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [selectedRecommended, setSelectedRecommended] = useState<string>(
    RECOMMENDED_MODELS[0]?.name ?? "",
  );
  const [activeCategory, setActiveCategory] = useState<ModelCategory>(
    RECOMMENDED_MODELS[0]?.category ?? "general",
  );
  const [isPulling, setIsPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  const groupedRecommended = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: RECOMMENDED_MODELS.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0);
  }, []);

  const selectedRecommendedMeta = useMemo(
    () => RECOMMENDED_MODELS.find((item) => item.name === selectedRecommended),
    [selectedRecommended],
  );

  const currentModelSummary = useMemo(() => {
    if (!currentModel) return null;
    return (
      models.find((model) => model.name === currentModel) ||
      models.find((model) =>
        model.name.startsWith(`${currentModel.split(":")[0]}:`),
      ) ||
      null
    );
  }, [currentModel, models]);

  const visibleRecommended = useMemo(
    () =>
      groupedRecommended.find((group) => group.category === activeCategory)
        ?.items ?? [],
    [activeCategory, groupedRecommended],
  );

  const pullProgressPercent =
    pullProgress?.total && pullProgress.completed
      ? Math.min(
          100,
          Math.round((pullProgress.completed / pullProgress.total) * 100),
        )
      : 0;

  const fetchModels = useCallback(async (): Promise<OllamaModel[]> => {
    try {
      const list = await invoke<OllamaModel[]>("get_ollama_models");
      const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
      setModels(sorted);

      if (!currentModel && sorted.length > 0) {
        onModelChange(sorted[0].name);
      }

      setError(null);
      return sorted;
    } catch (err) {
      console.error("Failed to fetch models:", err);
      setError(ZH.connectFailed);
      return [];
    }
  }, [currentModel, onModelChange]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    if (isOpen) {
      void fetchModels();
    }
  }, [isOpen, fetchModels]);

  useEffect(() => {
    if (!currentModel) return;
    if (models.length === 0 || !models.some((m) => m.name === currentModel)) {
      void fetchModels();
    }
  }, [currentModel, models, fetchModels]);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    listen<PullProgress>("pull-progress", (event) => {
      setPullProgress(event.payload);
      if (event.payload.status?.toLowerCase() === "success") {
        void fetchModels();
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [fetchModels]);

  const pullModelByName = async (name: string) => {
    const requestedName = name.trim();
    if (!requestedName) return;

    setIsPulling(true);
    setPullProgress({ status: `${ZH.pullStarted}${requestedName}` });
    setError(null);

    try {
      const mirror = resolveMirrorModel(requestedName);
      if (mirror) {
        await invoke("pull_model_from_modelscope", {
          name: requestedName,
          url: mirror.url,
          filename: mirror.filename,
        });
      } else {
        await invoke("pull_ollama_model", { name: requestedName });
      }
      setNewModelName("");

      const latestList = await fetchModels();
      onModelChange(resolvePulledModelName(requestedName, latestList));
    } catch (err) {
      console.error("Pull failed:", err);
      const rawMessage = String(err);
      const networkHint =
        rawMessage.includes("registry.ollama.ai") ||
        rawMessage.includes("wsarecv") ||
        rawMessage.includes("forcibly closed")
          ? ` ${ZH.pullFailedNetworkHint}`
          : "";
      const message = `${ZH.pullFailed}${rawMessage}${networkHint}`;
      setError(message);
      onStatus?.(message, "error", true);
    } finally {
      setIsPulling(false);
      setPullProgress(null);
    }
  };

  const handlePullModel = async () => {
    await pullModelByName(newModelName);
  };

  const focusManualInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = manualInputRef.current;
      if (!input) return;
      input.scrollIntoView({ block: "nearest", behavior: "smooth" });
      input.focus();
      input.select();
    });
  }, []);

  const fillManualModelName = useCallback(
    (value: string | null | undefined) => {
      const nextValue = value?.trim();
      if (!nextValue) return;
      setNewModelName(nextValue);
      focusManualInput();
    },
    [focusManualInput],
  );

  const handleSelectRecommended = useCallback((model: RecommendedModel) => {
    setSelectedRecommended(model.name);
    setActiveCategory(model.category);
    setNewModelName(model.name);
  }, []);

  const handleUseInstalledModel = useCallback(
    (name: string) => {
      onModelChange(name);
      setIsOpen(false);
    },
    [onModelChange],
  );

  const handleApplyRecommended = useCallback(
    async (model: RecommendedModel) => {
      handleSelectRecommended(model);
      if (isInstalled(model.name, models)) {
        onModelChange(resolvePulledModelName(model.name, models));
        return;
      }
      await pullModelByName(model.name);
    },
    [handleSelectRecommended, models, onModelChange],
  );

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return (
    <div
      className={`model-selector-container ${variant === "drawer" ? "drawer-mode" : "compact-mode"}`}
    >
      <div className="model-selector-shell">
        <div className="model-selector-topbar">
          <div>
            <div className="model-selector-eyebrow">模型中心</div>
            <div className="model-selector-heading">切换与拉取本地模型</div>
            <div className="model-selector-caption">
              当前共检测到 {models.length} 个已安装模型
            </div>
          </div>
          <button
            type="button"
            className="model-toolbar-button"
            onClick={() => void fetchModels()}
            title={ZH.refresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>

        <section className="model-current-card">
          <div className="model-card-label">当前模型</div>
          <div className="model-current-name">
            {currentModelSummary?.name || currentModel || ZH.selectModel}
          </div>
          <div className="model-current-meta">
            <span>
              {currentModelSummary
                ? formatBytes(currentModelSummary.size)
                : "尚未加载大小"}
            </span>
            <span>{models.length} 个已安装</span>
            <span
              className={`model-state-badge ${currentModelSummary ? "installed" : "idle"}`}
            >
              {currentModelSummary ? "已就绪" : "待选择"}
            </span>
          </div>
          <div className="model-current-actions">
            <button
              type="button"
              className="model-secondary-button"
              onClick={() => setIsOpen((current) => !current)}
            >
              <span>{isOpen ? "收起已安装列表" : "切换已安装模型"}</span>
              {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {(currentModelSummary?.name || currentModel) && (
              <button
                type="button"
                className="model-secondary-button"
                onClick={() =>
                  fillManualModelName(currentModelSummary?.name || currentModel)
                }
              >
                填入手动框
              </button>
            )}
          </div>
        </section>

        {isOpen && (
          <section className="model-section model-installed-section">
            <div className="model-section-heading-row">
              <div>
                <div className="model-section-title">已安装模型</div>
                <div className="model-section-subtitle">
                  点击即可切换当前正在使用的模型
                </div>
              </div>
            </div>
            <div className="model-installed-list">
              {models.length > 0 ? (
                models.map((model) => (
                  <button
                    key={model.name}
                    type="button"
                    className={`model-installed-item ${currentModelSummary?.name === model.name ? "active" : ""}`}
                    onClick={() => handleUseInstalledModel(model.name)}
                  >
                    <span className="model-installed-name">{model.name}</span>
                    <span className="model-installed-size">
                      {formatBytes(model.size)}
                    </span>
                  </button>
                ))
              ) : (
                <div className="model-empty-state">{ZH.noModels}</div>
              )}
            </div>
          </section>
        )}

        <section className="model-section">
          <div className="model-section-heading-row">
            <div>
              <div className="model-section-title">推荐模型</div>
              <div className="model-section-subtitle">
                先选适合的任务类型，再决定直接使用还是拉取安装
              </div>
            </div>
          </div>

          <div className="model-category-tabs">
            {CATEGORY_ORDER.map((category) => (
              <button
                key={category}
                type="button"
                className={`model-category-tab ${activeCategory === category ? "active" : ""}`}
                onClick={() => setActiveCategory(category)}
                aria-pressed={activeCategory === category}
              >
                {renderCategoryIcon(category)}
                <span>{CATEGORY_LABELS[category]}</span>
              </button>
            ))}
          </div>

          <div className="model-recommend-grid">
            {visibleRecommended.map((item) => {
              const installed = isInstalled(item.name, models);
              const mirrorReady = !installed && canUseMirror(item.name);
              const selected = selectedRecommended === item.name;

              return (
                <article
                  key={item.name}
                  className={`model-recommend-card ${selected ? "selected" : ""}`}
                  onClick={() => handleSelectRecommended(item)}
                >
                  <div className="model-recommend-topline">
                    <span className={`model-category-chip ${item.category}`}>
                      {renderCategoryIcon(item.category)}
                      <span>{CATEGORY_LABELS[item.category]}</span>
                    </span>
                    <span
                      className={`model-state-badge ${installed ? "installed" : mirrorReady ? "mirror" : "plain"}`}
                    >
                      {installed
                        ? "已安装"
                        : mirrorReady
                          ? "可镜像"
                          : "可拉取"}
                    </span>
                  </div>

                  <div className="model-recommend-name">{item.name}</div>
                  <p className="model-recommend-summary">{item.summary}</p>

                  <div className="model-recommend-meta">
                    <span>{item.approxSize}</span>
                    <span>
                      {ZH.checkedAt}
                      {item.checkedAt}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          {selectedRecommendedMeta && (
            <div className="model-selected-panel">
              <div className="model-selected-panel-main">
                <div className="model-selected-label">已选推荐</div>
                <div className="model-selected-name">
                  {selectedRecommendedMeta.name}
                </div>
                <div className="model-selected-meta">
                  <span>{selectedRecommendedMeta.approxSize}</span>
                  <span>
                    {ZH.checkedAt}
                    {selectedRecommendedMeta.checkedAt}
                  </span>
                  <a
                    className="model-source-link"
                    href={selectedRecommendedMeta.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>Ollama Library</span>
                    <ExternalLink size={12} />
                  </a>
                </div>
                <p className="model-recommend-summary">
                  {selectedRecommendedMeta.summary}
                </p>
              </div>
              <div className="model-selected-actions">
                <button
                  type="button"
                  className="model-secondary-button"
                  onClick={() => fillManualModelName(selectedRecommendedMeta.name)}
                >
                  填入手动框
                </button>
                <button
                  type="button"
                  className="model-primary-button"
                  disabled={isPulling}
                  onClick={() => void handleApplyRecommended(selectedRecommendedMeta)}
                >
                  {isInstalled(selectedRecommendedMeta.name, models)
                    ? "直接使用"
                    : canUseMirror(selectedRecommendedMeta.name)
                      ? "镜像拉取"
                      : "拉取使用"}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="model-section model-manual-section">
          <div className="model-section-heading-row">
            <div>
              <div className="model-section-title">手动拉取</div>
              <div className="model-section-subtitle">
                适合输入自定义模型名，比如 `qwen3:8b`
              </div>
            </div>
            {selectedRecommendedMeta && (
              <span className="model-manual-hint">
                已带入：{selectedRecommendedMeta.name}
              </span>
            )}
          </div>

          <div className="model-manual-form">
            <input
              ref={manualInputRef}
              className="model-manual-input"
              type="text"
              placeholder={ZH.pullPlaceholder}
              value={newModelName}
              onChange={(event) => setNewModelName(event.target.value)}
              disabled={isPulling}
            />
            <button
              type="button"
              className="model-primary-button model-primary-button-inline"
              onClick={() => void handlePullModel()}
              disabled={isPulling || !newModelName.trim()}
            >
              {isPulling ? (
                <RefreshCw size={16} className="spin" />
              ) : (
                <Download size={16} />
              )}
              <span>{isPulling ? "拉取中" : "开始拉取"}</span>
            </button>
          </div>
        </section>

        {pullProgress && (
          <section className="model-progress-card">
            <div className="model-progress-label">{pullProgress.status}</div>
            {pullProgressPercent > 0 && (
              <div className="model-progress-track">
                <div
                  className="model-progress-fill"
                  style={{ width: `${pullProgressPercent}%` }}
                />
              </div>
            )}
          </section>
        )}

        {error && <div className="model-error-banner">{error}</div>}
      </div>
    </div>
  );
};
