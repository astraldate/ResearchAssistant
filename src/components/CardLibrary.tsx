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

export const CardLibrary: React.FC<CardLibraryProps> = ({ refreshToken, activeRoot, onStatus }) => {
  const [cards, setCards] = useState<KnowledgeCardSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [exportingCardId, setExportingCardId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadCards = useCallback(async () => {
    setIsLoading(true);
    try {
      const nextCards = await invoke<KnowledgeCardSummary[]>("list_knowledge_cards");
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

  return (
    <div className="card-library">
      <div className="main-view-header">
        <div>
          <div className="main-view-title">知识卡片库</div>
          <div className="main-view-subtitle">
            当前目录：{activeRoot || "未设置"}
            {cards.length > 0 ? ` · 共 ${cards.length} 张卡片` : ""}
            {searchQuery.trim() ? ` · 命中 ${filteredCards.length} 张` : ""}
          </div>
        </div>
        <div className="card-library-actions">
          <button className="action-button" onClick={() => void loadCards()} disabled={isLoading}>
            <RefreshCw size={14} className={isLoading ? "spin" : undefined} />
            刷新
          </button>
          <button className="action-button" onClick={() => void invoke("open_card_root_in_explorer")}>
            <FolderOpen size={14} />
            打开目录
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

      {cards.length === 0 && !isLoading && <div className="empty-placeholder">还没有知识卡片。先在 PDF 页面选词并保存一张卡片。</div>}
      {cards.length > 0 && filteredCards.length === 0 && !isLoading && (
        <div className="empty-placeholder">没有匹配“{searchQuery.trim()}”的卡片。可改搜术语、摘要关键词或来源名。</div>
      )}

      <div className="card-grid">
        {filteredCards.map((card) => (
          <article key={card.id} className="card-item">
            <div className="card-item-header">
              <div>
                <div className="card-item-title">{card.term}</div>
                <div className="card-item-meta">
                  <span>{LOOKUP_MODE_LABELS[card.lookup_mode]}</span>
                  <span>{card.source_provider || "模型"}</span>
                </div>
              </div>
              <div className="status-chip muted">{SOURCE_STATUS_LABELS[card.source_status] ?? card.source_status}</div>
            </div>

            <div className="card-item-preview">{card.preview || "暂无摘要预览。"}</div>

            <div className="card-item-footnote">
              <span>{card.created_at}</span>
              {card.pdf_path && (
                <span>
                  {card.pdf_path.split(/[\\/]/).pop()}
                  {typeof card.pdf_page === "number" ? ` · p.${card.pdf_page}` : ""}
                </span>
              )}
            </div>

            <div className="card-item-actions">
              <button className="action-button" onClick={() => void invoke("open_file", { path: card.path })}>
                <ExternalLink size={14} />
                打开 Markdown
              </button>
              <button className="action-button" onClick={() => void handleExportCard(card)} disabled={exportingCardId === card.id}>
                <Download size={14} />
                {exportingCardId === card.id ? "导出中" : "导出 Markdown"}
              </button>
              <button className="action-button" onClick={() => void invoke("reveal_in_explorer", { path: card.path })}>
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
