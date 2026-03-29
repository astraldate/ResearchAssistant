import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Plus, RefreshCw, X } from "lucide-react";
import { LookupMode } from "./TermExplainPopover";

type StatusTone = "info" | "error";

interface CardLibraryProps {
  refreshToken: number;
  activeRoot?: string | null;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onSelectCard?: (detail: KnowledgeCardDetail & KnowledgeCardSummary) => void;
  onCardDeleted?: (cardPath: string) => void;
  onEditCard?: (detail: KnowledgeCardDetail & KnowledgeCardSummary) => void;
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

export const CardLibrary: React.FC<CardLibraryProps> = ({
  refreshToken,
  activeRoot,
  onStatus,
  onSelectCard,
  onCardDeleted,
  onEditCard,
}) => {
  const [cards, setCards] = useState<KnowledgeCardSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    card: KnowledgeCardSummary;
  } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<KnowledgeCardSummary | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

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

    const tagMatch = normalizedQuery.match(
      /^@(title|source|time|file)(?:=(.*))?$/i,
    );
    if (normalizedQuery.startsWith("@") && !tagMatch) return cards;

    return cards.filter((card) => {
      const pdfFileName = card.pdf_path?.split(/[\\/]/).pop() || "";
      const pdfFileLabel = pdfFileName || "none";
      const title = card.title || card.term;
      const sourceProvider = card.source_provider || "";
      const createdAt = card.created_at || "";

      if (tagMatch) {
        const tag = tagMatch[1].toLowerCase();
        const keyword = (tagMatch[2] ?? "").trim().toLowerCase();
        if (!keyword) return true;
        if (tag === "title") {
          return [title, card.term].join("\n").toLowerCase().includes(keyword);
        }
        if (tag === "source") {
          return sourceProvider.toLowerCase().includes(keyword);
        }
        if (tag === "time") {
          return createdAt.toLowerCase().includes(keyword);
        }
        if (tag === "file") {
          if (["none", "无", "null", "未提供"].includes(keyword)) {
            return !pdfFileName;
          }
          return pdfFileLabel.toLowerCase().includes(keyword);
        }
      }

      const haystack = [
        card.term,
        title,
        card.preview,
        sourceProvider,
        LOOKUP_MODE_LABELS[card.lookup_mode],
        pdfFileLabel,
        createdAt,
      ]
        .join("\n")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [cards, searchQuery]);

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

  const handleEditCard = async () => {
    if (!contextMenu?.card || !onEditCard) return;
    try {
      const detail = await invoke<KnowledgeCardDetail>("read_knowledge_card", {
        cardPath: contextMenu.card.path,
      });
      onEditCard({ ...contextMenu.card, ...detail });
    } catch (error) {
      onStatus(`打开知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setContextMenu(null);
    }
  };

  const handleCardContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    card: KnowledgeCardSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, card });
  };

  const openDeleteDialog = () => {
    if (!contextMenu?.card) return;
    setDeleteDialog(contextMenu.card);
    setContextMenu(null);
  };

  const handleRevealCard = async () => {
    if (!contextMenu?.card) return;
    try {
      await invoke("reveal_in_explorer", { path: contextMenu.card.path });
    } catch (error) {
      onStatus(`定位知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setContextMenu(null);
    }
  };

  const handleDeleteCard = async () => {
    if (!deleteDialog) return;
    const target = deleteDialog;
    try {
      await invoke("delete_knowledge_card", { cardPath: target.path });
      setCards((previous) => previous.filter((card) => card.id !== target.id));
      onCardDeleted?.(target.path);
      onStatus(`已删除知识卡片：${target.term}`, "info", false);
    } catch (error) {
      onStatus(`删除知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setDeleteDialog(null);
    }
  };

  const handleCreateCard = async () => {
    try {
      const created = await invoke<KnowledgeCardSummary>(
        "save_knowledge_card_from_explanation",
        {
          request: {
            term: "新建知识卡片",
            selected_text: "手动创建",
            plain_summary: "",
            source_title: "手动创建",
            source_url: null,
            source_provider: "manual",
            source_lang: "zh",
            source_extract: null,
            page_context_snippet: null,
            pdf_path: null,
            pdf_page: null,
            source_status: "model_only",
            model: "manual",
            lookup_mode: "popular_cn",
          },
        },
      );
      await loadCards();
      if (onEditCard) {
        const detail = await invoke<KnowledgeCardDetail>("read_knowledge_card", {
          cardPath: created.path,
        });
        onEditCard({ ...created, ...detail });
      }
      onStatus(`已创建知识卡片：${created.term}`, "info", false);
    } catch (error) {
      onStatus(`新建知识卡片失败：${String(error)}`, "error", true);
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
            onClick={() => void handleCreateCard()}
            title="新建知识卡片"
            aria-label="新建知识卡片"
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-button card-library-header-icon"
            onClick={() => void loadCards()}
            disabled={isLoading}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw size={16} className={isLoading ? "spin" : undefined} />
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
      <div className="card-library-search-hint">
        <span className="card-library-search-hint-label">可用参数</span>
        <span className="card-library-search-hint-text">
          @title=标题，@source=来源提供方，@time=时间，@file=来源文件或 none
        </span>
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
          <article
            key={card.id}
            className="card-item"
            onContextMenu={(event) => handleCardContextMenu(event, card)}
          >
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
              </div>
            </div>

            <div className="card-item-preview">
              {card.preview || "暂无摘要预览。"}
            </div>

            <div className="card-item-footnote">
              <span
                className="card-item-source"
                title={
                  card.pdf_path
                    ? card.pdf_path.split(/[\\/]/).pop()
                    : "无来源 PDF"
                }
              >
                {card.pdf_path
                  ? card.pdf_path.split(/[\\/]/).pop()
                  : "无来源 PDF"}
              </span>
              <span className="card-item-date">{card.created_at}</span>
            </div>
          </article>
        ))}
      </div>

      {contextMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="pdf-selection-context-menu card-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button type="button" onClick={() => void handleRevealCard()}>
              在文件夹中定位
            </button>
            <button type="button" onClick={() => void handleEditCard()}>
              编辑
            </button>
            <button type="button" onClick={openDeleteDialog}>
              删除
            </button>
          </div>,
          document.body,
        )}

      {deleteDialog && (
        <div
          className="file-tree-dialog-backdrop"
          onClick={() => setDeleteDialog(null)}
        >
          <div
            className="file-tree-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-tree-dialog-title">删除知识卡片</div>
            <div className="file-tree-dialog-copy">
              确认删除“{deleteDialog.term}”吗？
            </div>
            <div className="file-tree-dialog-actions">
              <button
                className="ghost-button"
                onClick={() => setDeleteDialog(null)}
              >
                取消
              </button>
              <button
                className="action-button danger"
                onClick={() => void handleDeleteCard()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
