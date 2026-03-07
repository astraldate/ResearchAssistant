import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookmarkPlus, Download, ExternalLink, LoaderCircle, X } from "lucide-react";
import { exportKnowledgeCardMarkdown } from "../utils/exportCard";

export type LookupMode = "popular_cn" | "cs_encyclopedia" | "bioinformatics";

type StatusTone = "info" | "error";

interface ExplainResult {
  term: string;
  plain_summary: string;
  source_title?: string | null;
  source_url?: string | null;
  source_provider?: string | null;
  source_lang?: string | null;
  source_extract?: string | null;
  page_context_snippet?: string | null;
  source_status: string;
  generated_at: string;
  lookup_mode: LookupMode;
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

interface TermExplainPopoverProps {
  selectedText: string;
  pdfPath: string;
  page: number;
  currentModel: string;
  lookupMode: LookupMode;
  style?: React.CSSProperties;
  onClose: () => void;
  onSaveCardSuccess: () => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
}

const MAX_TERM_LENGTH = 120;
const POPOVER_MARGIN = 16;
const POPOVER_TOP_SAFE = 84;
const FALLBACK_POPOVER_WIDTH = 420;
const FALLBACK_POPOVER_HEIGHT = 560;

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

const buildCacheKey = (lookupMode: LookupMode, pdfPath: string, page: number, selectedText: string) =>
  `ra_term_explain_cache_v2:${lookupMode}:${pdfPath}:${page}:${selectedText}`;

const normalizeSelection = (value: string) => value.replace(/\s+/g, " ").trim();
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const parseStylePosition = (
  value: React.CSSProperties["left"] | React.CSSProperties["top"],
  fallback: number,
) => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

export const TermExplainPopover: React.FC<TermExplainPopoverProps> = ({
  selectedText,
  pdfPath,
  page,
  currentModel,
  lookupMode,
  style,
  onClose,
  onSaveCardSuccess,
  onStatus,
}) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
  const [phase, setPhase] = useState<"loading" | "success" | "error">("loading");
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [savedCard, setSavedCard] = useState<KnowledgeCardSummary | null>(null);
  const [position, setPosition] = useState(() => ({
    left: parseStylePosition(style?.left, POPOVER_MARGIN),
    top: parseStylePosition(style?.top, POPOVER_TOP_SAFE),
  }));

  const normalizedText = useMemo(() => normalizeSelection(selectedText), [selectedText]);
  const validationError = useMemo(() => {
    if (!normalizedText) return "请选择术语或短语。";
    if (normalizedText.length > MAX_TERM_LENGTH) return "请选择术语或短语，而不是整段句子。";
    if (!/[\p{L}\p{N}]/u.test(normalizedText)) return "所选内容缺少有效词语。";
    return null;
  }, [normalizedText]);

  const clampPosition = useCallback((left: number, top: number) => {
    const rect = popoverRef.current?.getBoundingClientRect();
    const width = rect?.width ?? FALLBACK_POPOVER_WIDTH;
    const height = rect?.height ?? FALLBACK_POPOVER_HEIGHT;
    return {
      left: clamp(left, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, window.innerWidth - width - POPOVER_MARGIN)),
      top: clamp(top, POPOVER_TOP_SAFE, Math.max(POPOVER_TOP_SAFE, window.innerHeight - height - POPOVER_MARGIN)),
    };
  }, []);

  useEffect(() => {
    setPosition(
      clampPosition(
        parseStylePosition(style?.left, POPOVER_MARGIN),
        parseStylePosition(style?.top, POPOVER_TOP_SAFE),
      ),
    );
  }, [clampPosition, page, pdfPath, selectedText, style?.left, style?.top]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      setPosition(
        clampPosition(
          dragState.left + (event.clientX - dragState.startX),
          dragState.top + (event.clientY - dragState.startY),
        ),
      );
    };

    const handleMouseUp = () => {
      dragStateRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clampPosition, isDragging]);

  useEffect(() => {
    const handleResize = () => {
      setPosition((previous) => clampPosition(previous.left, previous.top));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampPosition]);

  useEffect(() => {
    if (validationError) {
      setPhase("error");
      setError(validationError);
      return;
    }

    const cacheKey = buildCacheKey(lookupMode, pdfPath, page, normalizedText);
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as ExplainResult;
        setResult(parsed);
        setPhase("success");
        return;
      } catch {
        sessionStorage.removeItem(cacheKey);
      }
    }

    let cancelled = false;
    setPhase("loading");
    setError(null);
    setResult(null);
    setSavedCard(null);

    void invoke<ExplainResult>("explain_pdf_selection", {
      request: {
        term: normalizedText,
        pdf_path: pdfPath,
        page,
        model: currentModel,
        mode: lookupMode,
      },
    })
      .then((payload) => {
        if (cancelled) return;
        sessionStorage.setItem(cacheKey, JSON.stringify(payload));
        setResult(payload);
        setPhase("success");
      })
      .catch((invokeError) => {
        if (cancelled) return;
        setError(String(invokeError));
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [currentModel, lookupMode, normalizedText, page, pdfPath, validationError]);

  const handleSaveCard = async () => {
    if (!result || isSaving) return;
    setIsSaving(true);
    try {
      const card = await invoke<KnowledgeCardSummary>("save_knowledge_card_from_explanation", {
        request: {
          term: result.term,
          selected_text: normalizedText,
          plain_summary: result.plain_summary,
          source_title: result.source_title ?? null,
          source_url: result.source_url ?? null,
          source_provider: result.source_provider ?? null,
          source_lang: result.source_lang ?? null,
          source_extract: result.source_extract ?? null,
          page_context_snippet: result.page_context_snippet ?? null,
          pdf_path: pdfPath,
          pdf_page: page,
          source_status: result.source_status,
          model: currentModel,
          lookup_mode: lookupMode,
        },
      });
      setSavedCard(card);
      onSaveCardSuccess();
      onStatus(`已保存知识卡片：${card.term}`, "info", false);
    } catch (invokeError) {
      onStatus(`保存知识卡片失败：${String(invokeError)}`, "error", true);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportCard = async () => {
    if (!savedCard || isExporting) return;
    setIsExporting(true);
    try {
      const destination = await exportKnowledgeCardMarkdown(savedCard.path);
      if (destination) {
        onStatus(`知识卡片已导出到：${destination}`, "info", false);
      }
    } catch (invokeError) {
      onStatus(`导出知识卡片失败：${String(invokeError)}`, "error", true);
    } finally {
      setIsExporting(false);
    }
  };

  const handleHeaderMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top,
    };
    setIsDragging(true);
  };

  const mergedStyle: React.CSSProperties = {
    ...style,
    left: `${position.left}px`,
    top: `${position.top}px`,
  };

  return (
    <div
      ref={popoverRef}
      className={`term-popover ${isDragging ? "dragging" : ""}`}
      style={mergedStyle}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="term-popover-header" onMouseDown={handleHeaderMouseDown}>
        <div>
          <div className="term-popover-title">{normalizedText || "术语解释"}</div>
          <div className="term-popover-subtitle">模式：{LOOKUP_MODE_LABELS[lookupMode]} · 可拖动</div>
        </div>
        <button className="ghost-icon-button" onClick={onClose} aria-label="关闭术语解释">
          <X size={14} />
        </button>
      </div>

      {phase === "loading" && (
        <div className="term-popover-state">
          <LoaderCircle size={16} className="spin" />
          <span>正在获取解释与参考资料...</span>
        </div>
      )}

      {phase === "error" && <div className="term-popover-error">{error}</div>}

      {phase === "success" && result && (
        <div className="term-popover-content">
          <div className="status-chip">{SOURCE_STATUS_LABELS[result.source_status] ?? result.source_status}</div>
          <div className="term-section">
            <div className="term-section-label">通俗解释</div>
            <div className="term-section-body">{result.plain_summary}</div>
          </div>
          <div className="term-section">
            <div className="term-section-label">参考资料摘要</div>
            <div className="term-section-body">{result.source_extract || "未命中外部资料，已退回模型总结。"}</div>
          </div>
          <div className="term-section-meta">
            <span>来源：{result.source_provider || "模型"}</span>
            {result.source_lang && <span>语言：{result.source_lang}</span>}
          </div>
          {result.source_title && <div className="term-source-title">{result.source_title}</div>}
          {result.source_url && (
            <a className="term-source-link" href={result.source_url} target="_blank" rel="noreferrer">
              查看来源
              <ExternalLink size={12} />
            </a>
          )}
          <div className="term-popover-actions">
            <button className="action-button primary" onClick={() => void handleSaveCard()} disabled={isSaving || !!savedCard}>
              {isSaving ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  保存中
                </>
              ) : savedCard ? (
                <>
                  <BookmarkPlus size={14} />
                  已保存
                </>
              ) : (
                <>
                  <BookmarkPlus size={14} />
                  保存为知识卡片
                </>
              )}
            </button>
            {savedCard && (
              <button className="action-button" onClick={() => void handleExportCard()} disabled={isExporting}>
                {isExporting ? (
                  <>
                    <LoaderCircle size={14} className="spin" />
                    导出中
                  </>
                ) : (
                  <>
                    <Download size={14} />
                    导出 Markdown
                  </>
                )}
              </button>
            )}
            <button className="action-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
