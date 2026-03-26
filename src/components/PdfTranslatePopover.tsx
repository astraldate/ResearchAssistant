import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, X } from "lucide-react";

type StatusTone = "info" | "error";

interface TranslatePdfSelectionResult {
  original_text: string;
  translated_text: string;
  page: number;
  generated_at: string;
  model_used: string;
}

interface PdfTranslatePopoverProps {
  selectedText: string;
  pdfPath: string;
  page: number;
  translationModel: string;
  ensureTranslationReady?: () => Promise<string>;
  style?: React.CSSProperties;
  onClose: () => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onTranslateSuccess?: (
    selectedText: string,
    page: number,
    payload: TranslatePdfSelectionResult,
  ) => void;
}

const POPOVER_MARGIN = 16;
const POPOVER_TOP_SAFE = 84;
const FALLBACK_POPOVER_WIDTH = 420;
const FALLBACK_POPOVER_HEIGHT = 420;

const buildCacheKey = (pdfPath: string, page: number, text: string) =>
  `ra_pdf_translate_selection_v2:${pdfPath}:${page}:${text}`;

const normalizeSelection = (value: string) => value.replace(/\s+/g, " ").trim();
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

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

export const PdfTranslatePopover: React.FC<PdfTranslatePopoverProps> = ({
  selectedText,
  pdfPath,
  page,
  translationModel,
  ensureTranslationReady,
  style,
  onClose,
  onStatus,
  onTranslateSuccess,
}) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);
  const [phase, setPhase] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [result, setResult] = useState<TranslatePdfSelectionResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState(() => ({
    left: parseStylePosition(style?.left, POPOVER_MARGIN),
    top: parseStylePosition(style?.top, POPOVER_TOP_SAFE),
  }));

  const normalizedText = useMemo(
    () => normalizeSelection(selectedText),
    [selectedText],
  );

  const clampPosition = useCallback((left: number, top: number) => {
    const rect = popoverRef.current?.getBoundingClientRect();
    const width = rect?.width ?? FALLBACK_POPOVER_WIDTH;
    const height = rect?.height ?? FALLBACK_POPOVER_HEIGHT;
    return {
      left: clamp(
        left,
        POPOVER_MARGIN,
        Math.max(POPOVER_MARGIN, window.innerWidth - width - POPOVER_MARGIN),
      ),
      top: clamp(
        top,
        POPOVER_TOP_SAFE,
        Math.max(
          POPOVER_TOP_SAFE,
          window.innerHeight - height - POPOVER_MARGIN,
        ),
      ),
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
    if (!normalizedText) {
      setPhase("error");
      setError("没有可翻译的文本。请重新选中内容。");
      return;
    }

    const cacheKey = buildCacheKey(pdfPath, page, normalizedText);
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as TranslatePdfSelectionResult;
        setResult(parsed);
        setPhase("success");
        onTranslateSuccess?.(normalizedText, page, parsed);
        return;
      } catch {
        sessionStorage.removeItem(cacheKey);
      }
    }

    let cancelled = false;
    setPhase("loading");
    setError(null);
    setResult(null);

    void (async () => {
      try {
        const model = ensureTranslationReady
          ? await ensureTranslationReady()
          : translationModel;
        const payload = await invoke<TranslatePdfSelectionResult>(
          "translate_pdf_selection",
          {
            request: {
              text: normalizedText,
              pdf_path: pdfPath,
              page,
              model,
            },
          },
        );
        if (cancelled) return;
        sessionStorage.setItem(cacheKey, JSON.stringify(payload));
        setResult(payload);
        setPhase("success");
        onTranslateSuccess?.(normalizedText, page, payload);
      } catch (invokeError) {
        if (cancelled) return;
        const message = String(invokeError);
        setError(message);
        setPhase("error");
        onStatus(`划词翻译失败：${message}`, "error", true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ensureTranslationReady,
    normalizedText,
    onStatus,
    page,
    pdfPath,
    translationModel,
    onTranslateSuccess,
  ]);

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
      className={`term-popover pdf-translate-popover ${isDragging ? "dragging" : ""}`}
      style={mergedStyle}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="term-popover-header" onMouseDown={handleHeaderMouseDown}>
        <div>
          <div className="term-popover-title">翻译</div>
          <div className="term-popover-subtitle">当前页：{page} · 可拖动</div>
        </div>
        <button
          className="ghost-icon-button"
          onClick={onClose}
          aria-label="关闭翻译浮窗"
        >
          <X size={14} />
        </button>
      </div>

      {phase === "loading" && (
        <div className="term-popover-state">
          <LoaderCircle size={16} className="spin" />
          <span>正在翻译所选文本...</span>
        </div>
      )}

      {phase === "error" && <div className="term-popover-error">{error}</div>}

      {phase === "success" && result && (
        <div className="term-popover-content">
          <div className="term-section">
            <div className="term-section-label">原文</div>
            <div className="term-section-body">{result.original_text}</div>
          </div>
          <div className="term-section">
            <div className="term-section-label">译文</div>
            <div className="term-section-body">{result.translated_text}</div>
          </div>
          <div className="term-popover-subtitle">
            翻译模型：{result.model_used || translationModel}
          </div>
          <div className="term-popover-actions">
            <button className="action-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
