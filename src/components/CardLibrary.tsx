import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, ExternalLink, FolderOpen, RefreshCw, X } from "lucide-react";
import { LookupMode } from "./TermExplainPopover";
import { exportKnowledgeCardMarkdown } from "../utils/exportCard";

type StatusTone = "info" | "error";

interface CardLibraryProps {
  refreshToken: number;
  activeRoot?: string | null;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onSelectCard?: (detail: KnowledgeCardDetail & KnowledgeCardSummary) => void;
}

interface KnowledgeCardSummary {
  id: string;
  term: string;
  title: string;
  path: string;
  created_at: string;
  pdf_path?: string | null;
  pdf_page?: number | null;
  source_status: string;
  source_provider?: string | null;
  lookup_mode: LookupMode;
  preview: string;
}

interface KnowledgeCardDetail {
  markdown: string;
}

const LOOKUP_MODE_LABELS: Record<LookupMode, string> = {
  popular_cn: "通俗百科",
  cs_encyclopedia: "CS 百科",
  bioinformatics: "生信百科",
};

const SOURCE_STATUS_LABELS: Record<string, string> = {
  "source+model": "外部资料 + 模型总结",
  model_only: "仅模型总结",
  source_only: "仅外部资料",
};

const getSourceStatusTone = (sourceStatus: string) => {
  switch (sourceStatus) {
    case "source+model":
      return "status-hybrid";
    case "source_only":
      return "status-source";
    case "model_only":
    default:
      return "status-model";
  }
};

const getLookupModeTone = (mode: LookupMode) => `mode-${mode}`;

const getSourceProviderTone = (provider?: string | null) => {
  const normalized = provider?.toLowerCase() ?? "";
  if (
    !normalized ||
    normalized.includes("模型") ||
    normalized.includes("model") ||
    normalized.includes("ollama")
  ) {
    return "provider-model";
  }
  if (normalized.includes("wiki")) return "provider-wiki";
  if (normalized.includes("baidu")) return "provider-baidu";
  if (normalized.includes("pubmed") || normalized.includes("ncbi"))
    return "provider-pubmed";
  if (normalized.includes("cs") || normalized.includes("encyclopedia"))
    return "provider-cs";
  return "provider-generic";
};

export const CardLibrary: React.FC<CardLibraryProps> = ({
  refreshToken,
  activeRoot,
  onStatus,
  onSelectCard,
}) => {
  const [cards, setCards] = useState<KnowledgeCardSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [exportingCardId, setExportingCardId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadCards = useCallback(async () => {
    setIsLoading(true);
    try {
      const nextCards = await invoke<KnowledgeCardSummary[]>(
        "list_knowledge_cards",
      );
      setCards(nextCards);
    } catch (error) {
      onStatus(`加载知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setIsLoading(false);
    }
  }, [onStatus]);

  useEffect(() => {
    void loadCards();
  }, [loadCards, refreshToken]);

  const filteredCards = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return cards;

    return cards.filter((card) => {
      const pdfFileName = card.pdf_path?.split(/[\\/]/).pop() || "";
      const haystack = [
        card.term,
        card.title,
        card.preview,
        card.source_provider || "",
        LOOKUP_MODE_LABELS[card.lookup_mode],
        SOURCE_STATUS_LABELS[card.source_status] ?? card.source_status,
        pdfFileName,
      ]
        .join("\n")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [cards, searchQuery]);

  const handleExportCard = async (card: KnowledgeCardSummary) => {
    if (exportingCardId) return;
    setExportingCardId(card.id);
    try {
      const destination = await exportKnowledgeCardMarkdown(card.path);
      if (destination) {
        onStatus(`知识卡片已导出到：${destination}`, "info", false);
      }
    } catch (error) {
      onStatus(`导出知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setExportingCardId(null);
    }
  };

  const handleOpenCardDetail = async (card: KnowledgeCardSummary) => {
    if (!onSelectCard) return;
    try {
      const detail = await invoke<KnowledgeCardDetail>("read_knowledge_card", {
        cardPath: card.path,
      });
      onSelectCard({ ...card, ...detail });
    } catch (error) {
      onStatus(`打开知识卡片失败：${String(error)}`, "error", true);
    }
  };

  return (
    <div className="card-library">
      <div className="main-view-header card-library-header">
        <div className="main-view-meta">
          <div className="main-view-title">Knowledge Cards</div>
          <div className="main-view-subtitle" title={activeRoot || "未设置"}>
            当前目录：{activeRoot || "未设置"}
          </div>
        </div>
        <div className="card-library-actions">
          <button
            className="icon-button card-library-header-icon"
            onClick={() => void loadCards()}
            disabled={isLoading}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={16} className={isLoading ? "spin" : undefined} />
          </button>
          <button
            className="icon-button card-library-header-icon"
            onClick={() => void invoke("open_card_root_in_explorer")}
            title="打开目录"
            aria-label="打开目录"
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </div>

      <div className="card-library-search-row">
        <input
          className="card-library-search-input"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索术语、标题、摘要、来源或文件名"
        />
        {searchQuery.trim() && (
          <button className="action-button" onClick={() => setSearchQuery("")}>
            <X size={14} />
            清空
          </button>
        )}
      </div>

      {cards.length === 0 && !isLoading && (
        <div className="empty-placeholder">
          还没有知识卡片。先在 PDF 页面选词并保存一张卡片。
        </div>
      )}
      {cards.length > 0 && filteredCards.length === 0 && !isLoading && (
        <div className="empty-placeholder">
          没有匹配“{searchQuery.trim()}”的卡片。可改搜术语、摘要关键词或来源名。
        </div>
      )}

      <div className="card-grid">
        {filteredCards.map((card) => (
          <article key={card.id} className="card-item">
            <div className="card-item-topline">
              <div
                className={`status-chip ${getLookupModeTone(card.lookup_mode)}`}
              >
                {LOOKUP_MODE_LABELS[card.lookup_mode]}
              </div>
              <div
                className={`status-chip ${getSourceStatusTone(card.source_status)}`}
              >
                {SOURCE_STATUS_LABELS[card.source_status] ?? card.source_status}
              </div>
            </div>

            <div className="card-item-header">
              <div className="card-item-title-block">
                <button
                  type="button"
                  className="card-item-title card-item-title-button"
                  onClick={() => void handleOpenCardDetail(card)}
                  title="查看完整卡片内容"
                >
                  {card.term}
                </button>
                <div className="card-item-meta">
                  <span
                    className={`status-chip muted ${getSourceProviderTone(card.source_provider)}`}
                  >
                    {card.source_provider || "模型"}
                  </span>
                </div>
              </div>
            </div>

            <div className="card-item-preview">
              {card.preview || "暂无摘要预览。"}
            </div>

            <div className="card-item-footnote">
              <div className="card-item-footnote-main">
                <span>{card.created_at}</span>
                {card.pdf_path && (
                  <span className="card-item-fileline">
                    {card.pdf_path.split(/[\\/]/).pop()}
                  </span>
                )}
              </div>
              {card.pdf_path && typeof card.pdf_page === "number" && (
                <span className="card-page-chip">
                  PDF 页码
                  <strong>p.{card.pdf_page}</strong>
                </span>
              )}
            </div>

            <div className="card-item-actions">
              <button
                className="action-button"
                onClick={() => void invoke("open_file", { path: card.path })}
              >
                <ExternalLink size={14} />
                打开 Markdown
              </button>
              <button
                className="action-button"
                onClick={() => void handleExportCard(card)}
                disabled={exportingCardId === card.id}
              >
                <Download size={14} />
                {exportingCardId === card.id ? "导出中" : "导出 Markdown"}
              </button>
              <button
                className="action-button"
                onClick={() =>
                  void invoke("reveal_in_explorer", { path: card.path })
                }
              >
                <FolderOpen size={14} />
                显示位置
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
