import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Download, RefreshCw } from "lucide-react";

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
}

type ModelCategory = "general" | "reasoning" | "coding" | "vision" | "embedding";

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
  connectFailed: "\u8fde\u63a5 Ollama \u5931\u8d25\u3002\u8bf7\u786e\u8ba4\u670d\u52a1\u5df2\u542f\u52a8\u3002",
  pullStarted: "\u5f00\u59cb\u62c9\u53d6\u6a21\u578b\uff1a",
  pullFailed: "\u62c9\u53d6\u5931\u8d25\uff1a",
  recTitle: "\u63a8\u8350\u6a21\u578b\uff08\u5df2\u8054\u7f51\u6574\u7406\uff0c\u53ef\u76f4\u63a5\u9009\u62e9\uff09",
  fill: "\u586b\u5165",
  pullSelected: "\u62c9\u53d6\u6240\u9009",
  source: "\u6765\u6e90\uff1a",
  checkedAt: "\u6700\u8fd1\u68c0\u67e5\uff1a",
  installed: "\uff08\u5df2\u5b89\u88c5\uff09",
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

const CATEGORY_ORDER: ModelCategory[] = ["general", "reasoning", "coding", "vision", "embedding"];

const resolvePulledModelName = (requested: string, list: OllamaModel[]): string => {
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

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onModelChange }) => {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [selectedRecommended, setSelectedRecommended] = useState<string>(RECOMMENDED_MODELS[0]?.name ?? "");
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
      await invoke("pull_ollama_model", { name: requestedName });
      setNewModelName("");

      const latestList = await fetchModels();
      onModelChange(resolvePulledModelName(requestedName, latestList));
    } catch (err) {
      console.error("Pull failed:", err);
      setError(`${ZH.pullFailed}${String(err)}`);
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

  return (
    <div className="model-selector-container" style={{ padding: "16px", borderTop: "1px solid var(--border-color)" }}>
      <div
        className="model-selector-header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
      >
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)" }}>{ZH.model}</span>
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
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
          >
            <span style={{ fontSize: "0.9rem" }}>{currentModel || ZH.selectModel}</span>
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
                backgroundColor: currentModel === model.name ? "var(--bg-tertiary)" : "transparent",
                fontSize: "0.9rem",
              }}
            >
              {model.name} <span style={{ color: "#999", fontSize: "0.8em" }}>({formatBytes(model.size)})</span>
            </div>
          ))}
          {models.length === 0 && <div style={{ padding: "8px", color: "#999" }}>{ZH.noModels}</div>}
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
        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "6px" }}>{ZH.recTitle}</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <select
            value={selectedRecommended}
            onChange={(event) => setSelectedRecommended(event.target.value)}
            style={{
              flex: 1,
              padding: "6px",
              borderRadius: "4px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-primary)",
              color: "var(--text-primary)",
              fontSize: "0.9rem",
            }}
          >
            {groupedRecommended.map((group) => (
              <optgroup key={group.category} label={CATEGORY_LABELS[group.category]}>
                {group.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} {isInstalled(item.name, models) ? ZH.installed : ""}
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
            {ZH.pullSelected}
          </button>
        </div>

        {selectedRecommendedMeta && (
          <div style={{ marginTop: "6px", fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
            {selectedRecommendedMeta.summary} {selectedRecommendedMeta.approxSize}
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

      <div className="pull-model-form" style={{ display: "flex", gap: "8px" }}>
        <input
          type="text"
          placeholder={ZH.pullPlaceholder}
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          disabled={isPulling}
          style={{
            flex: 1,
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
          {isPulling ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
        </button>
      </div>

      {pullProgress && (
        <div className="pull-progress" style={{ marginTop: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          <div>{pullProgress.status}</div>
          {pullProgress.total && pullProgress.completed && (
            <div style={{ width: "100%", height: "4px", background: "#eee", marginTop: "4px", borderRadius: "2px" }}>
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

      {error && <div style={{ marginTop: "8px", fontSize: "0.8rem", color: "#dc3545" }}>{error}</div>}
    </div>
  );
};
