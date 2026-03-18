import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Download, RefreshCw } from "lucide-react";
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
  onStatus?: (message: string, tone?: "info" | "error", persistent?: boolean) => void;
  variant?: "full" | "compact";
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
    summary: "General-purpose multilingual model for chat and mixed tasks.",
    approxSize: "~6.6GB",
    sourceUrl: "https://ollama.com/library/qwen3.5",
    checkedAt: "2026-03-12",
  },
  {
    name: "qwen3:8b",
    category: "general",
    summary: "Balanced Chinese/English general model for Q&A and reasoning.",
    approxSize: "~5GB",
    sourceUrl: "https://ollama.com/library/qwen3",
    checkedAt: "2026-03-05",
  },
  {
    name: "gemma3:4b",
    category: "general",
    summary: "Lightweight multimodal model for local use.",
    approxSize: "~3.3GB",
    sourceUrl: "https://www.ollama.com/library/gemma3",
    checkedAt: "2026-03-05",
  },
  {
    name: "deepseek-r1",
    category: "general",
    summary: "Reasoning-focused model for math, logic, and analysis.",
    approxSize: "~5GB (default distilled variant)",
    sourceUrl: "https://ollama.com/library/deepseek-r1",
    checkedAt: "2026-03-05",
  },
  {
    name: "llama3.3",
    category: "general",
    summary: "Large general model for long-form and multilingual chat.",
    approxSize: "~43GB",
    sourceUrl: "https://ollama.com/library/llama3.3",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen3-coder:30b",
    category: "general",
    summary: "Long-context coding model for repo-level reasoning.",
    approxSize: "~19GB",
    sourceUrl: "https://ollama.com/library/qwen3-coder",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen2.5-coder:7b",
    category: "general",
    summary: "Balanced coding model for local development.",
    approxSize: "~4.7GB",
    sourceUrl: "https://ollama.com/library/qwen2.5-coder",
    checkedAt: "2026-03-05",
  },
  {
    name: "qwen2.5vl:7b",
    category: "general",
    summary: "Vision-language model for image understanding and VQA.",
    approxSize: "~6GB",
    sourceUrl: "https://ollama.com/library/qwen2.5vl",
    checkedAt: "2026-03-05",
  },
  {
    name: "mistral-small3.1",
    category: "general",
    summary: "Vision-capable model with longer context.",
    approxSize: "~15GB",
    sourceUrl: "https://ollama.com/library/mistral-small3.1",
    checkedAt: "2026-03-05",
  },
  {
    name: "minicpm-v",
    category: "general",
    summary: "Lightweight vision model often used for OCR and image QA.",
    approxSize: "~8GB",
    sourceUrl: "https://ollama.com/library/minicpm-v",
    checkedAt: "2026-03-05",
  },
  {
    name: "nomic-embed-text",
    category: "general",
    summary: "Embedding model for local RAG indexing and search.",
    approxSize: "~274MB",
    sourceUrl: "https://ollama.com/library/nomic-embed-text",
    checkedAt: "2026-03-05",
  },
  {
    name: "mxbai-embed-large",
    category: "general",
    summary: "Stronger embedding model for higher recall.",
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

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onModelChange, onStatus, variant = "full" }) => {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [selectedRecommended, setSelectedRecommended] = useState<string>(
    RECOMMENDED_MODELS[0]?.name ?? "",
  );
  const [isPulling, setIsPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const handlePullSelectedModel = async () => {
    if (!selectedRecommended) return;
    setNewModelName(selectedRecommended);
    await pullModelByName(selectedRecommended);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

    if (variant === "compact") {
    const isSelectedInstalled = selectedRecommended ? isInstalled(selectedRecommended, models) : false;
    return (
      <div className="model-selector-compact">
        <div className="model-compact-row">
          <select
            value={selectedRecommended}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedRecommended(value);
              if (isInstalled(value, models)) {
                onModelChange(resolvePulledModelName(value, models));
              }
            }}
          >
            {groupedRecommended.map((group) => (
              <optgroup key={group.category} label={CATEGORY_LABELS[group.category]}>
                {group.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} {isInstalled(item.name, models) ? "(installed)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {!isSelectedInstalled && (
            <button
              className="model-compact-download"
              onClick={() => void handlePullSelectedModel()}
              disabled={isPulling || !selectedRecommended}
              title="Download model"
            >
              {isPulling ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="model-selector-container"
      style={{
        padding: "16px",
        borderTop: "1px solid var(--border-color)",
        flexShrink: 0,
        position: "relative",
        zIndex: 1,
        overflowX: "hidden",
      }}
    >
      <div
        className="model-selector-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <span
          style={{
            fontSize: "0.85rem",
            fontWeight: 600,
            color: "var(--text-secondary)",
          }}
        >
          {ZH.model}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            onClick={() => void fetchModels()}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: "2px",
            }}
            title={ZH.refresh}
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => setIsOpen(!isOpen)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span style={{ fontSize: "0.9rem" }}>
              {currentModel || ZH.selectModel}
            </span>
            {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          className="model-list"
          style={{
            marginBottom: "12px",
            maxHeight: "200px",
            overflowY: "auto",
            border: "1px solid var(--border-color)",
            borderRadius: "4px",
          }}
        >
          {models.map((model) => (
            <div
              key={model.name}
              onClick={() => {
                onModelChange(model.name);
                setIsOpen(false);
              }}
              style={{
                padding: "8px",
                cursor: "pointer",
                backgroundColor:
                  currentModel === model.name
                    ? "var(--bg-tertiary)"
                    : "transparent",
                fontSize: "0.9rem",
              }}
            >
              {model.name}{" "}
              <span style={{ color: "#999", fontSize: "0.8em" }}>
                ({formatBytes(model.size)})
              </span>
            </div>
          ))}
          {models.length === 0 && (
            <div style={{ padding: "8px", color: "#999" }}>{ZH.noModels}</div>
          )}
        </div>
      )}

      <div
        style={{
          marginBottom: "10px",
          padding: "8px",
          border: "1px solid var(--border-color)",
          borderRadius: "6px",
          background: "var(--bg-secondary)",
        }}
      >
        <div
          style={{
            fontSize: "0.8rem",
            color: "var(--text-secondary)",
            marginBottom: "6px",
          }}
        >
          {ZH.recTitle}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto auto",
            gap: "8px",
            alignItems: "center",
          }}
        >
          <select
            value={selectedRecommended}
            onChange={(event) => setSelectedRecommended(event.target.value)}
            style={{
              minWidth: 0,
              width: "100%",
              padding: "6px",
              borderRadius: "4px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              color: "var(--text-primary)",
              fontSize: "0.9rem",
            }}
          >
            {groupedRecommended.map((group) => (
              <optgroup
                key={group.category}
                label={CATEGORY_LABELS[group.category]}
              >
                {group.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}{" "}
                    {isInstalled(item.name, models) ? ZH.installed : ""}
                    {!isInstalled(item.name, models) && canUseMirror(item.name)
                      ? ` ${ZH.mirrorAvailable}`
                      : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            onClick={() => setNewModelName(selectedRecommended)}
            style={{
              padding: "6px 10px",
              borderRadius: "4px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {ZH.fill}
          </button>
          <button
            onClick={handlePullSelectedModel}
            disabled={isPulling || !selectedRecommended}
            style={{
              padding: "6px 10px",
              borderRadius: "4px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              cursor: isPulling ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {canUseMirror(selectedRecommended)
              ? ZH.pullMirror
              : ZH.pullSelected}
          </button>
        </div>

        {selectedRecommendedMeta && (
          <div
            style={{
              marginTop: "6px",
              fontSize: "0.78rem",
              color: "var(--text-secondary)",
              lineHeight: 1.4,
            }}
          >
            {selectedRecommendedMeta.summary}{" "}
            {selectedRecommendedMeta.approxSize}
            <br />
            {ZH.source}
            <a
              href={selectedRecommendedMeta.sourceUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text-accent)", textDecoration: "none" }}
            >
              Ollama Library
            </a>
            {` (${ZH.checkedAt}${selectedRecommendedMeta.checkedAt})`}
          </div>
        )}
      </div>

      <div
        className="pull-model-form"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: "8px",
        }}
      >
        <input
          type="text"
          placeholder={ZH.pullPlaceholder}
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          disabled={isPulling}
          style={{
            minWidth: 0,
            padding: "6px",
            borderRadius: "4px",
            border: "1px solid var(--border-color)",
            fontSize: "0.9rem",
          }}
        />
        <button
          onClick={handlePullModel}
          disabled={isPulling || !newModelName.trim()}
          style={{
            padding: "6px 10px",
            borderRadius: "4px",
            border: "1px solid var(--border-color)",
            background: "var(--bg-secondary)",
            cursor: isPulling ? "not-allowed" : "pointer",
          }}
        >
          {isPulling ? (
            <RefreshCw size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
        </button>
      </div>

      {pullProgress && (
        <div
          className="pull-progress"
          style={{
            marginTop: "8px",
            fontSize: "0.8rem",
            color: "var(--text-secondary)",
          }}
        >
          <div>{pullProgress.status}</div>
          {pullProgress.total && pullProgress.completed && (
            <div
              style={{
                width: "100%",
                height: "4px",
                background: "#eee",
                marginTop: "4px",
                borderRadius: "2px",
              }}
            >
              <div
                style={{
                  width: `${(pullProgress.completed / pullProgress.total) * 100}%`,
                  height: "100%",
                  background: "var(--text-accent)",
                  borderRadius: "2px",
                  transition: "width 0.2s",
                }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginTop: "8px", fontSize: "0.8rem", color: "#dc3545" }}>
          {error}
        </div>
      )}
    </div>
  );
};
