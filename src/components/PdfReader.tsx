import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, LoaderCircle, ZoomIn, ZoomOut } from "lucide-react";
import { GlobalWorkerOptions, getDocument, renderTextLayer } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayerRenderTask } from "pdfjs-dist";
import { LookupMode, TermExplainPopover } from "./TermExplainPopover";

type StatusTone = "info" | "error";
type ViewerMode = "pdfjs" | "compat";

interface PdfReaderProps {
  activePdfPath: string;
  currentModel: string;
  lookupMode: LookupMode;
  onLookupModeChange: (mode: LookupMode) => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onSaveCardSuccess: () => void;
  onPageChange?: (page: number) => void;
}

interface PdfSelectionState {
  text: string;
  page: number;
  targetLeft: number;
  targetTop: number;
  popoverLeft: number;
  popoverTop: number;
  showPopover: boolean;
}

interface RenderedPageState {
  width: number;
  height: number;
}

interface PdfPageCanvasProps {
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
  stageWidth: number;
  zoomPercent: number;
  onSelectionCapture: () => void;
  onPageRefChange: (pageNumber: number, node: HTMLDivElement | null) => void;
  onRenderError: (message: string) => void;
}

const LOOKUP_MODE_OPTIONS: Array<{ value: LookupMode; label: string }> = [
  { value: "popular_cn", label: "通俗百科" },
  { value: "cs_encyclopedia", label: "CS 百科" },
  { value: "bioinformatics", label: "生信百科" },
];

const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url).toString();
const PDF_LOAD_TIMEOUT_MS = 12000;
const MIN_STAGE_WIDTH = 320;
const ZOOM_STEP = 20;
const MIN_ZOOM = 60;
const MAX_ZOOM = 220;
const VIEWPORT_MARGIN_X = 16;
const VIEWPORT_MARGIN_TOP = 84;
const POPOVER_ESTIMATED_WIDTH = 420;
const POPOVER_ESTIMATED_HEIGHT = 560;
const FLOATING_BUTTON_WIDTH = 84;

GlobalWorkerOptions.workerSrc = workerUrl;

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;
const storageKey = (path: string) => `ra_pdf_page_v1:${path}`;
const normalizeSelectedText = (value: string) => value.replace(/\s+/g, " ").trim();

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const destroyLoadingTask = (task: PDFDocumentLoadingTask | null) => {
  if (!task) return;
  try {
    task.destroy();
  } catch {
    // Ignore cleanup errors from pdf.js internals.
  }
};

const destroyDocument = (document: PDFDocumentProxy | null) => {
  if (!document) return;
  void document.destroy().catch(() => undefined);
};

const cancelRenderTask = (task: RenderTask | null) => {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    // Ignore cancellation errors.
  }
};

const cancelTextLayerTask = (task: TextLayerRenderTask | null) => {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    // Ignore cancellation errors.
  }
};

const isCancelledRenderError = (error: unknown) => {
  const message = String(error).toLowerCase();
  return message.includes("rendering cancelled") || message.includes("textlayer task cancelled") || message.includes("abortexception");
};

const resolvePageFromNode = (node: Node | null): number | null => {
  let current: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (current) {
    if (current.dataset.pageNumber) {
      const pageNumber = Number(current.dataset.pageNumber);
      return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
    }
    current = current.parentElement;
  }
  return null;
};

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({
  pageNumber,
  pdfDocument,
  stageWidth,
  zoomPercent,
  onSelectionCapture,
  onPageRefChange,
  onRenderError,
}) => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerTaskRef = useRef<TextLayerRenderTask | null>(null);
  const [renderedPage, setRenderedPage] = useState<RenderedPageState>({ width: 0, height: 0 });

  useEffect(() => {
    onPageRefChange(pageNumber, shellRef.current);
    return () => onPageRefChange(pageNumber, null);
  }, [onPageRefChange, pageNumber]);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    const textLayerElement = textLayerRef.current;
    if (!canvasElement || !textLayerElement) {
      return;
    }

    let cancelled = false;
    const deviceScale = window.devicePixelRatio || 1;

    const renderPage = async () => {
      cancelRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
      cancelTextLayerTask(textLayerTaskRef.current);
      textLayerTaskRef.current = null;
      textLayerElement.replaceChildren();

      try {
        const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.max(MIN_STAGE_WIDTH, stageWidth - 28) / baseViewport.width;
        const effectiveScale = fitScale * (zoomPercent / 100);
        const viewport = page.getViewport({ scale: effectiveScale });

        setRenderedPage({ width: viewport.width, height: viewport.height });

        canvasElement.width = Math.floor(viewport.width * deviceScale);
        canvasElement.height = Math.floor(viewport.height * deviceScale);
        canvasElement.style.width = `${viewport.width}px`;
        canvasElement.style.height = `${viewport.height}px`;

        const context = canvasElement.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error(`第 ${pageNumber} 页无法创建 PDF 画布上下文。`);
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvasElement.width, canvasElement.height);

        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: deviceScale !== 1 ? [deviceScale, 0, 0, deviceScale, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (cancelled) return;

        textLayerElement.className = "textLayer pdfjs-text-layer";
        textLayerElement.style.width = `${viewport.width}px`;
        textLayerElement.style.height = `${viewport.height}px`;
        textLayerElement.style.setProperty("--scale-factor", `${effectiveScale}`);

        const textContent = await page.getTextContent();
        if (cancelled) return;
        const textLayerTask = renderTextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
          textDivs: [],
          textContentItemsStr: [],
        });
        textLayerTaskRef.current = textLayerTask;
        await textLayerTask.promise;
      } catch (error) {
        if (cancelled || isCancelledRenderError(error)) {
          return;
        }
        onRenderError(`第 ${pageNumber} 页渲染失败：${String(error)}`);
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      cancelRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
      cancelTextLayerTask(textLayerTaskRef.current);
      textLayerTaskRef.current = null;
    };
  }, [onRenderError, pageNumber, pdfDocument, stageWidth, zoomPercent]);

  return (
    <div
      ref={(node) => {
        shellRef.current = node;
        onPageRefChange(pageNumber, node);
      }}
      className="pdfjs-page-shell"
      data-page-number={pageNumber}
      style={{
        width: renderedPage.width ? `${renderedPage.width}px` : undefined,
        minHeight: renderedPage.height ? `${renderedPage.height}px` : "480px",
      }}
    >
      <canvas className="pdfjs-canvas" ref={canvasRef} />
      <div className="textLayer pdfjs-text-layer" ref={textLayerRef} onMouseUp={onSelectionCapture} />
    </div>
  );
};

export const PdfReader: React.FC<PdfReaderProps> = ({
  activePdfPath,
  currentModel,
  lookupMode,
  onLookupModeChange,
  onStatus,
  onSaveCardSuccess,
  onPageChange,
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const onStatusRef = useRef(onStatus);
  const onPageChangeRef = useRef(onPageChange);
  const currentPageRef = useRef(1);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfObjectUrlRef = useRef<string | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const initialPageRef = useRef(1);

  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [stageWidth, setStageWidth] = useState(MIN_STAGE_WIDTH);
  const [hasSelectableText, setHasSelectableText] = useState<boolean | null>(null);
  const [viewerMode, setViewerMode] = useState<ViewerMode>("pdfjs");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [selection, setSelection] = useState<PdfSelectionState | null>(null);

  useEffect(() => {
    onStatusRef.current = onStatus;
    onPageChangeRef.current = onPageChange;
  }, [onPageChange, onStatus]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey(activePdfPath));
    const nextPage = stored ? Number(stored) : 1;
    const restoredPage = Number.isFinite(nextPage) && nextPage > 0 ? nextPage : 1;
    initialPageRef.current = restoredPage;
    currentPageRef.current = restoredPage;
    setCurrentPage(restoredPage);
    setPageCount(0);
    setZoomPercent(100);
    setViewerMode("pdfjs");
    setViewerError(null);
    setSelection(null);
    pageRefs.current.clear();
  }, [activePdfPath]);

  useEffect(() => {
    const stageElement = stageRef.current;
    if (!stageElement) return;

    const updateWidth = () => {
      const nextWidth = Math.max(MIN_STAGE_WIDTH, Math.floor(stageElement.clientWidth || MIN_STAGE_WIDTH));
      setStageWidth((previous) => (previous === nextWidth ? previous : nextWidth));
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stageElement);
    return () => observer.disconnect();
  }, [viewerMode, activePdfPath, pageCount]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setPdfBytes(null);
    setPdfDocument(null);
    pdfDocumentRef.current = null;
    setSelection(null);

    if (pdfObjectUrlRef.current) {
      URL.revokeObjectURL(pdfObjectUrlRef.current);
      pdfObjectUrlRef.current = null;
    }
    setPdfObjectUrl(null);

    destroyLoadingTask(loadingTaskRef.current);
    loadingTaskRef.current = null;
    destroyDocument(pdfDocumentRef.current);
    pdfDocumentRef.current = null;

    void invoke<string>("read_file_base64", { path: activePdfPath })
      .then((base64) => {
        if (cancelled) return;
        const bytes = base64ToBytes(base64);
        setPdfBytes(bytes);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        pdfObjectUrlRef.current = objectUrl;
        setPdfObjectUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = `加载 PDF 失败：${String(error)}`;
        setViewerMode("compat");
        setViewerError(message);
        onStatusRef.current(message, "error", true);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activePdfPath]);

  useEffect(() => {
    return () => {
      if (pdfObjectUrlRef.current) {
        URL.revokeObjectURL(pdfObjectUrlRef.current);
        pdfObjectUrlRef.current = null;
      }
      destroyLoadingTask(loadingTaskRef.current);
      destroyDocument(pdfDocumentRef.current);
      pdfDocumentRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pdfBytes || viewerMode !== "pdfjs") return;

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      const message = "PDF 文档初始化超时，已切换为兼容模式。";
      setViewerMode("compat");
      setViewerError(message);
      setIsLoading(false);
      onStatusRef.current(message, "error", true);
    }, PDF_LOAD_TIMEOUT_MS);

    const loadingTask = getDocument({ data: pdfBytes });
    loadingTaskRef.current = loadingTask;
    setIsLoading(true);

    loadingTask.promise
      .then((document) => {
        if (cancelled) {
          destroyDocument(document);
          return;
        }
        window.clearTimeout(timeoutId);
        pdfDocumentRef.current = document;
        setPdfDocument(document);
        setPageCount(document.numPages);
        const safePage = Math.min(Math.max(initialPageRef.current, 1), document.numPages);
        currentPageRef.current = safePage;
        setCurrentPage(safePage);
        onPageChangeRef.current?.(safePage);
        setViewerError(null);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        const message = `PDF 文档初始化失败，已切换为兼容模式：${String(error)}`;
        setViewerMode("compat");
        setViewerError(message);
        setIsLoading(false);
        onStatusRef.current(message, "error", true);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      destroyLoadingTask(loadingTask);
    };
  }, [pdfBytes, viewerMode]);

  useEffect(() => {
    if (!activePdfPath || currentPage <= 0) return;
    let cancelled = false;
    setHasSelectableText(null);

    void invoke<string>("extract_pdf_page_text", { path: activePdfPath, page: currentPage })
      .then((text) => {
        if (cancelled) return;
        setHasSelectableText(text.trim().length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setHasSelectableText(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activePdfPath, currentPage]);

  const handlePageRefChange = useCallback((pageNumber: number, node: HTMLDivElement | null) => {
    if (node) {
      pageRefs.current.set(pageNumber, node);
    } else {
      pageRefs.current.delete(pageNumber);
    }
  }, []);

  const updateCurrentPageFromScroll = useCallback(() => {
    const stageElement = stageRef.current;
    if (!stageElement || pageRefs.current.size === 0) return;

    const stageRect = stageElement.getBoundingClientRect();
    let bestPage = currentPageRef.current;
    let bestRatio = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [pageNumber, node] of pageRefs.current.entries()) {
      const rect = node.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(rect.bottom, stageRect.bottom) - Math.max(rect.top, stageRect.top));
      const visibleRatio = overlap / Math.max(rect.height, 1);
      const distance = Math.abs(rect.top - stageRect.top);
      if (visibleRatio > bestRatio || (Math.abs(visibleRatio - bestRatio) < 0.001 && distance < bestDistance)) {
        bestRatio = visibleRatio;
        bestDistance = distance;
        bestPage = pageNumber;
      }
    }

    if (bestPage !== currentPageRef.current) {
      currentPageRef.current = bestPage;
      setCurrentPage(bestPage);
      localStorage.setItem(storageKey(activePdfPath), String(bestPage));
      onPageChangeRef.current?.(bestPage);
    }
  }, [activePdfPath]);

  const scrollToPage = useCallback(
    (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
      const stageElement = stageRef.current;
      const pageNode = pageRefs.current.get(pageNumber);
      if (!stageElement || !pageNode) return;

      stageElement.scrollTo({
        top: Math.max(0, pageNode.offsetTop - 16),
        behavior,
      });
      currentPageRef.current = pageNumber;
      setCurrentPage(pageNumber);
      localStorage.setItem(storageKey(activePdfPath), String(pageNumber));
      onPageChangeRef.current?.(pageNumber);
    },
    [activePdfPath],
  );

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !stageRef.current) return;

    const stageElement = stageRef.current;
    let ticking = false;

    const clearSelectionForNavigation = () => {
      window.getSelection()?.removeAllRanges();
      setSelection((previous) => (previous?.showPopover ? previous : null));
    };

    const handleScroll = () => {
      clearSelectionForNavigation();
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        updateCurrentPageFromScroll();
      });
    };

    const handleWindowResize = () => {
      clearSelectionForNavigation();
      updateCurrentPageFromScroll();
    };

    stageElement.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleWindowResize);
    const timer = window.setTimeout(updateCurrentPageFromScroll, 60);

    return () => {
      window.clearTimeout(timer);
      stageElement.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [activePdfPath, updateCurrentPageFromScroll, viewerMode]);

  useEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs") return;
    const targetPage = Math.min(Math.max(initialPageRef.current, 1), pageCount || 1);
    const timer = window.setTimeout(() => scrollToPage(targetPage, "auto"), 80);
    return () => window.clearTimeout(timer);
  }, [pageCount, pdfDocument, scrollToPage, viewerMode]);

  const handlePdfRenderError = useCallback((message: string) => {
    const fullMessage = `PDF 页面渲染失败，已切换为兼容模式：${message}`;
    setViewerMode("compat");
    setViewerError(fullMessage);
    onStatusRef.current(fullMessage, "error", true);
  }, []);

  const handleSelectionCapture = () => {
    if (viewerMode !== "pdfjs") return;

    window.requestAnimationFrame(() => {
      const browserSelection = window.getSelection();
      if (!browserSelection || browserSelection.rangeCount === 0 || browserSelection.isCollapsed) {
        setSelection((previous) => (previous?.showPopover ? previous : null));
        return;
      }

      const anchorNode = browserSelection.anchorNode;
      const focusNode = browserSelection.focusNode;
      if (!anchorNode || !focusNode) {
        return;
      }

      const pageNumber = resolvePageFromNode(anchorNode) ?? resolvePageFromNode(focusNode) ?? currentPageRef.current;
      const pageElement = pageRefs.current.get(pageNumber);
      if (!pageElement || !pageElement.contains(anchorNode) || !pageElement.contains(focusNode)) {
        return;
      }

      const text = normalizeSelectedText(browserSelection.toString());
      if (!text) {
        setSelection(null);
        return;
      }

      const range = browserSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }

      const popoverWidth = Math.min(POPOVER_ESTIMATED_WIDTH, window.innerWidth - VIEWPORT_MARGIN_X * 2);
      const preferredPopoverLeft = rect.right + 16 + popoverWidth <= window.innerWidth - VIEWPORT_MARGIN_X
        ? rect.right + 16
        : rect.left - popoverWidth - 16;
      const popoverLeft = clamp(preferredPopoverLeft, VIEWPORT_MARGIN_X, window.innerWidth - popoverWidth - VIEWPORT_MARGIN_X);
      const openAbove = rect.bottom + 12 + POPOVER_ESTIMATED_HEIGHT > window.innerHeight - VIEWPORT_MARGIN_X;
      const popoverTop = openAbove
        ? clamp(rect.top - POPOVER_ESTIMATED_HEIGHT - 12, VIEWPORT_MARGIN_TOP, window.innerHeight - 120)
        : clamp(rect.bottom + 12, VIEWPORT_MARGIN_TOP, window.innerHeight - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_MARGIN_X);
      const targetLeft = clamp(rect.right + 8, VIEWPORT_MARGIN_X, window.innerWidth - FLOATING_BUTTON_WIDTH - VIEWPORT_MARGIN_X);
      const targetTop = clamp(rect.top - 8, VIEWPORT_MARGIN_TOP, window.innerHeight - 48 - VIEWPORT_MARGIN_X);

      setSelection({
        text,
        page: pageNumber,
        targetLeft,
        targetTop,
        popoverLeft,
        popoverTop,
        showPopover: false,
      });
    });
  };

  const handleOpenPopover = () => {
    setSelection((previous) => (previous ? { ...previous, showPopover: true } : previous));
  };

  const handleClosePopover = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const zoomOut = () => {
    setZoomPercent((previous) => Math.max(MIN_ZOOM, previous - ZOOM_STEP));
  };

  const zoomIn = () => {
    setZoomPercent((previous) => Math.min(MAX_ZOOM, previous + ZOOM_STEP));
  };

  const selectionStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!selection) return undefined;
    return {
      position: "fixed",
      left: `${selection.targetLeft}px`,
      top: `${selection.targetTop}px`,
    };
  }, [selection]);

  const popoverStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!selection) return undefined;
    return {
      position: "fixed",
      left: `${selection.popoverLeft}px`,
      top: `${selection.popoverTop}px`,
    };
  }, [selection]);

  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, index) => index + 1), [pageCount]);

  return (
    <div className="pdf-reader-shell">
      <div className="pdf-reader-toolbar">
        <div className="pdf-reader-header-main">
          <div className="pdf-reader-title" title={getFileName(activePdfPath)}>
            {getFileName(activePdfPath)}
          </div>
          <div className="pdf-reader-subtitle">直接在页面上选中术语，点击“解释”即可生成说明与知识卡片。</div>
        </div>
        <div className="pdf-toolbar-actions">
          <div className="pdf-toolbar-group">
            <span className="pdf-toolbar-text">
              {currentPage} / {pageCount || "-"}
            </span>
          </div>
          <div className="pdf-toolbar-group">
            <button className="action-button" onClick={zoomOut} disabled={viewerMode !== "pdfjs" || zoomPercent <= MIN_ZOOM}>
              <ZoomOut size={14} />
            </button>
            <span className="pdf-toolbar-text">缩放 {zoomPercent}%</span>
            <button className="action-button" onClick={zoomIn} disabled={viewerMode !== "pdfjs" || zoomPercent >= MAX_ZOOM}>
              <ZoomIn size={14} />
            </button>
          </div>
          <label className="pdf-mode-control">
            <span>解释来源</span>
            <select value={lookupMode} onChange={(event) => onLookupModeChange(event.target.value as LookupMode)}>
              {LOOKUP_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="pdf-viewer-frame" ref={frameRef}>
        {isLoading && (
          <div className="pdf-viewer-loading">
            <LoaderCircle size={18} className="spin" />
            <span>正在加载 PDF...</span>
          </div>
        )}

        {viewerMode === "pdfjs" && !isLoading && (
          <div className="pdfjs-stage" ref={stageRef}>
            <div className="pdfjs-pages">
              {pageNumbers.map((pageNumber) => (
                <PdfPageCanvas
                  key={`${activePdfPath}:${pageNumber}:${zoomPercent}:${stageWidth}`}
                  pageNumber={pageNumber}
                  pdfDocument={pdfDocument as PDFDocumentProxy}
                  stageWidth={stageWidth}
                  zoomPercent={zoomPercent}
                  onSelectionCapture={handleSelectionCapture}
                  onPageRefChange={handlePageRefChange}
                  onRenderError={handlePdfRenderError}
                />
              ))}
            </div>
          </div>
        )}

        {viewerMode === "compat" && pdfObjectUrl && (
          <iframe className="pdf-compat-frame" title={getFileName(activePdfPath)} src={`${pdfObjectUrl}#page=${currentPage}`} />
        )}

        {viewerMode === "pdfjs" && (
          <div className="pdf-selection-overlay">
            {selection && !selection.showPopover && (
              <button className="pdf-selection-target" style={selectionStyle} onMouseDown={(event) => event.preventDefault()} onClick={handleOpenPopover}>
                解释
              </button>
            )}
            {selection && selection.showPopover && (
              <TermExplainPopover
                selectedText={selection.text}
                pdfPath={activePdfPath}
                page={selection.page}
                currentModel={currentModel}
                lookupMode={lookupMode}
                onClose={handleClosePopover}
                onSaveCardSuccess={onSaveCardSuccess}
                onStatus={onStatus}
                style={popoverStyle}
              />
            )}
          </div>
        )}
      </div>

      <div className="pdf-reader-footer">
        <span>当前页：{currentPage}</span>
        {viewerMode === "compat" ? (
          <span className="pdf-reader-warning">兼容模式已启用：可阅读 PDF，但暂不支持页面内直接选词解释。</span>
        ) : hasSelectableText === false ? (
          <span className="pdf-reader-warning">当前页不可直接选词，OCR 支持后可用。</span>
        ) : (
          <span className="pdf-reader-hint">连续滚动已启用。若没有出现“解释”按钮，请确认选中的是文字层，而不是扫描图片。</span>
        )}
      </div>

      {viewerError && (
        <div className="pdf-viewer-fallback-note">
          <AlertTriangle size={14} />
          <span>{viewerError}</span>
        </div>
      )}
    </div>
  );
};
