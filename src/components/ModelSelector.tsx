import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
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
  variant?: "full" | "compact" | "drawer";
  label?: string;
}

type ModelCategory = "general" | "translation" | "embedding";

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
  translation: "\u7ffb\u8bd1",
  embedding: "\u5411\u91cf",
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  general: ZH.general,
  translation: ZH.translation,
  embedding: ZH.embedding,
};

const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    name: "qwen3.5:9b",
    category: "general",
    summary: "General-purpose multilingual model for chat and mixed tasks.",
    approxSize: "~6.6GB",
    sourceUrl: "https://ollama.com/library/qwen3.5",
    checkedAt: "2026-03-12",
  },
  {
    name: "qwen3:8b",
    category: "general",
    summary:
      "Fast extraction and balanced Chinese/English local indexing model.",
    approxSize: "~5GB",
    sourceUrl: "https://ollama.com/library/qwen3",
    checkedAt: "2026-03-05",
  },
  {
    name: "nomic-embed-text",
    category: "embedding",
    summary: "Embedding model for local RAG indexing and search.",
    approxSize: "~274MB",
    sourceUrl: "https://ollama.com/library/nomic-embed-text",
    checkedAt: "2026-03-05",
  },
  {
    name: "mxbai-embed-large",
    category: "embedding",
    summary: "Stronger embedding model for higher recall.",
    approxSize: "~670MB",
    sourceUrl: "https://ollama.com/library/mxbai-embed-large",
    checkedAt: "2026-03-05",
  },
  {
    name: "MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M",
    category: "translation",
    summary:
      "Current default translation model for PDF selection and page translation.",
    approxSize: "~1.8GB",
    sourceUrl:
      "https://www.modelscope.cn/models/MedAIBase/Tencent-HY-MT1.5-GGUF",
    checkedAt: "2026-03-24",
  },
];

const CATEGORY_ORDER: ModelCategory[] = ["general", "translation", "embedding"];

const renderCategoryIcon = (category: ModelCategory) => {
  switch (category) {
    case "translation":
      return <Sparkles size={14} />;
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
  variant = "full",
  label = "当前模型",
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
  const [deletingModelName, setDeletingModelName] = useState<string | null>(
    null,
  );
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  const groupedRecommended = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: RECOMMENDED_MODELS.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0);
  }, []);

  const compactOptions = useMemo(() => {
    const seen = new Set<string>();
    const currentExtras: string[] = [];
    const grouped = groupedRecommended.map((group) => ({
      category: group.category,
      items: group.items.filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      }),
    }));

    if (currentModel && !seen.has(currentModel)) {
      currentExtras.push(currentModel);
      seen.add(currentModel);
    }

    return { currentExtras, grouped };
  }, [currentModel, groupedRecommended]);

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
    if (!currentModel) return;
    setSelectedRecommended((previous) =>
      previous === currentModel ? previous : currentModel,
    );
  }, [currentModel]);

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
        const candidates = mirror.candidates?.length
          ? mirror.candidates
          : [{ url: mirror.url, filename: mirror.filename }];
        let pulledFromMirror = false;
        for (const candidate of candidates) {
          try {
            await invoke("pull_model_from_modelscope", {
              name: requestedName,
              url: candidate.url,
              filename: candidate.filename,
            });
            pulledFromMirror = true;
            break;
          } catch (error) {
            console.error("Mirror pull failed:", candidate.url, error);
          }
        }
        if (!pulledFromMirror) {
          await invoke("pull_ollama_model", { name: requestedName });
        }
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

  const handleDeleteInstalledModel = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      if (
        currentModel &&
        (currentModel === name ||
          name.startsWith(`${currentModel.split(":")[0]}:`) ||
          currentModel.startsWith(`${name.split(":")[0]}:`))
      ) {
        onStatus?.(
          "当前正在使用的模型不能直接卸载，请先切换到其他模型。",
          "error",
          true,
        );
        return;
      }
      setDeletingModelName(name);
      setError(null);
      try {
        await invoke("delete_ollama_model", { name });
        const latestList = await fetchModels();
        if (
          currentModel &&
          !latestList.some(
            (model) =>
              model.name === currentModel ||
              model.name.startsWith(`${currentModel.split(":")[0]}:`),
          )
        ) {
          const fallback = RECOMMENDED_MODELS[0]?.name ?? "";
          if (fallback) {
            onModelChange(fallback);
          }
        }
        onStatus?.(`已卸载模型：${name}`, "info");
      } catch (err) {
        const message = `卸载失败：${String(err)}`;
        setError(message);
        onStatus?.(message, "error", true);
      } finally {
        setDeletingModelName(null);
      }
    },
    [currentModel, fetchModels, onModelChange, onStatus],
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

  if (variant === "compact") {
    const compactValue = currentModel || selectedRecommended;
    const isSelectedInstalled = compactValue
      ? isInstalled(compactValue, models)
      : false;
    return (
      <div className="model-selector-compact">
        <div className="model-compact-label">{label}</div>
        <div className="model-compact-row">
          <select
            value={compactValue}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedRecommended(value);
              if (isInstalled(value, models)) {
                onModelChange(resolvePulledModelName(value, models));
              }
            }}
          >
            {compactOptions.currentExtras.length > 0 && (
              <optgroup label="当前已选">
                {compactOptions.currentExtras.map((name) => (
                  <option key={name} value={name}>
                    {name} (current)
                  </option>
                ))}
              </optgroup>
            )}
            {compactOptions.grouped.map((group) => (
              <optgroup
                key={group.category}
                label={CATEGORY_LABELS[group.category]}
              >
                {group.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}{" "}
                    {isInstalled(item.name, models) ? "(installed)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {!isSelectedInstalled && (
            <button
              className="model-compact-download"
              onClick={() => void pullModelByName(compactValue)}
              disabled={isPulling || !compactValue}
              title="Download model"
            >
              {isPulling ? (
                <RefreshCw size={16} className="spin" />
              ) : (
                <Download size={16} />
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`model-selector-container ${variant === "drawer" ? "drawer-mode" : "full-mode"}`}
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
          <div className="model-card-label">{label}</div>
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
                  <div
                    key={model.name}
                    className={`model-installed-item ${currentModelSummary?.name === model.name ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="model-installed-main"
                      onClick={() => handleUseInstalledModel(model.name)}
                    >
                      <span className="model-installed-name">{model.name}</span>
                      <span className="model-installed-size">
                        {formatBytes(model.size)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="model-installed-delete"
                      onClick={() =>
                        void handleDeleteInstalledModel(model.name)
                      }
                      disabled={deletingModelName === model.name}
                    >
                      {deletingModelName === model.name ? "卸载中" : "卸载"}
                    </button>
                  </div>
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
                      {installed ? "已安装" : mirrorReady ? "可镜像" : "可拉取"}
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
                  onClick={() =>
                    fillManualModelName(selectedRecommendedMeta.name)
                  }
                >
                  填入手动框
                </button>
                <button
                  type="button"
                  className="model-primary-button"
                  disabled={isPulling}
                  onClick={() =>
                    void handleApplyRecommended(selectedRecommendedMeta)
                  }
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
