import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, LoaderCircle, ZoomIn, ZoomOut } from "lucide-react";
import { GlobalWorkerOptions, getDocument, renderTextLayer } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayerRenderTask } from "pdfjs-dist";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PdfTranslatePopover } from "./PdfTranslatePopover";
import { LookupMode, TermExplainPopover } from "./TermExplainPopover";

type StatusTone = "info" | "error";
type ViewerMode = "pdfjs" | "compat";
type ReaderToolMode = "explain" | "translate";
type SelectionOverlayMode = "button" | "explain" | "translate";

interface PdfReaderProps {
  activePdfPath: string;
  currentModel: string;
  isFocused?: boolean;
  requestedPage?: number;
  toolbarActions?: React.ReactNode;
  isToolbarCollapsed?: boolean;
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
  overlay: SelectionOverlayMode;
}

interface TranslatePdfPageResult {
  page: number;
  translated_markdown: string;
  source_text_length: number;
  generated_at: string;
}

interface PageTranslationState {
  open: boolean;
  phase: "idle" | "loading" | "success" | "error";
  result: TranslatePdfPageResult | null;
  error: string | null;
  requestedPage: number | null;
}

interface RenderedPageState {
  width: number;
  height: number;
}

interface ViewportAnchorState {
  pageNumber: number;
  offsetX: number;
  offsetY: number;
  pageRatioX: number;
  pageRatioY: number;
  fallbackTopRatio: number;
  fallbackLeftRatio: number;
}

interface PdfOutlineItem {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
}

interface PdfOutlineEntry {
  id: string;
  title: string;
  pageNumber: number | null;
  depth: number;
  hasChildren: boolean;
}

interface PdfPageCanvasProps {
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
  stageWidth: number;
  zoomPercent: number;
  enableTextLayer: boolean;
  onSelectionCapture: () => void;
  onPageRefChange: (pageNumber: number, node: HTMLDivElement | null) => void;
  onPageAspectReady: (pageNumber: number, aspectRatio: number) => void;
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
const MAX_RENDER_DPR = 1.5;
const LOW_QUALITY_SCALE = 0.45;
const VIEWPORT_MARGIN_X = 16;
const VIEWPORT_MARGIN_TOP = 84;
const POPOVER_ESTIMATED_WIDTH = 420;
const POPOVER_ESTIMATED_HEIGHT = 560;
const FLOATING_BUTTON_WIDTH = 84;
const PAGE_ASPECT_FALLBACK = Math.sqrt(2);
const RENDER_WINDOW_RADIUS = 3;

GlobalWorkerOptions.workerSrc = workerUrl;

const EMPTY_PAGE_TRANSLATION_STATE: PageTranslationState = {
  open: false,
  phase: "idle",
  result: null,
  error: null,
  requestedPage: null,
};

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
const buildPageTranslationCacheKey = (pdfPath: string, page: number, model: string) =>
  `ra_pdf_translate_page_v2:${pdfPath}:${page}:${model}`;
const normalizeSelectedText = (value: string) => value.replace(/\s+/g, " ").trim();
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const readStoredToolMode = (): ReaderToolMode => (localStorage.getItem(TOOL_MODE_STORAGE_KEY) === "translate" ? "translate" : "explain");
const formatPdfRenderError = (message: string) => {
  if (/ToUnicode CMap/i.test(message)) {
    return "PDF 内嵌字体映射异常，已切换到兼容预览。这个文件的划词解释和整页翻译可能不可用。";
  }
  return `PDF 页面渲染失败，已切换为兼容模式：${message}`;
};

const resolveOutlinePageNumber = async (pdfDocument: PDFDocumentProxy, destination: unknown): Promise<number | null> => {
  let resolvedDestination = destination;
  if (typeof resolvedDestination === "string") {
    resolvedDestination = await pdfDocument.getDestination(resolvedDestination);
  }

  if (!Array.isArray(resolvedDestination) || resolvedDestination.length === 0) {
    return null;
  }

  const target = resolvedDestination[0];
  if (typeof target === "number") {
    return target + 1;
  }

  if (target && typeof target === "object") {
    try {
      return (await pdfDocument.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
    } catch {
      return null;
    }
  }

  return null;
};

const flattenOutlineEntries = async (
  pdfDocument: PDFDocumentProxy,
  items: PdfOutlineItem[],
  depth = 0,
  prefix = "outline",
): Promise<PdfOutlineEntry[]> => {
  const flattened = await Promise.all(
    items.map(async (item, index) => {
      const id = `${prefix}-${depth}-${index}`;
      const children = item.items?.length ? await flattenOutlineEntries(pdfDocument, item.items, depth + 1, id) : [];
      const pageNumber = await resolveOutlinePageNumber(pdfDocument, item.dest);

      return [
        {
          id,
          title: item.title?.trim() || `章节 ${index + 1}`,
          pageNumber,
          depth,
          hasChildren: children.length > 0,
        },
        ...children,
      ];
    }),
  );

  return flattened.flat();
};

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

const scheduleWhenIdle = (task: () => void) => {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    const idleApi = window as Window & {
      requestIdleCallback: (cb: IdleRequestCallback) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleId = idleApi.requestIdleCallback(() => task());
    return () => idleApi.cancelIdleCallback?.(idleId);
  }
  const timer = globalThis.setTimeout(task, 40);
  return () => globalThis.clearTimeout(timer);
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
  enableTextLayer,
  onSelectionCapture,
  onPageRefChange,
  onPageAspectReady,
  onRenderError,
}) => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerTaskRef = useRef<TextLayerRenderTask | null>(null);
  const renderedPageRef = useRef<RenderedPageState>({ width: 0, height: 0 });
  const previousViewportMetricsRef = useRef({
    zoomPercent,
    stageWidth,
  });
  const [renderedPage, setRenderedPage] = useState<RenderedPageState>({ width: 0, height: 0 });
  const [previewScale, setPreviewScale] = useState(1);

  useEffect(() => {
    onPageRefChange(pageNumber, shellRef.current);
    return () => onPageRefChange(pageNumber, null);
  }, [onPageRefChange, pageNumber]);

  useLayoutEffect(() => {
    const previous = previousViewportMetricsRef.current;
    if (renderedPageRef.current.width <= 0 || renderedPageRef.current.height <= 0) {
      previousViewportMetricsRef.current = { zoomPercent, stageWidth };
      return;
    }

    const previousStageBasis = Math.max(MIN_STAGE_WIDTH, previous.stageWidth - 28);
    const nextStageBasis = Math.max(MIN_STAGE_WIDTH, stageWidth - 28);
    const previousScaleFactor = previousStageBasis * Math.max(previous.zoomPercent, 1);
    const nextScaleFactor = nextStageBasis * Math.max(zoomPercent, 1);
    const nextPreviewScale = previousScaleFactor > 0 ? nextScaleFactor / previousScaleFactor : 1;

    setPreviewScale(Math.abs(nextPreviewScale - 1) > 0.001 ? nextPreviewScale : 1);
    previousViewportMetricsRef.current = { zoomPercent, stageWidth };
  }, [stageWidth, zoomPercent]);

  useEffect(() => {
    if (!shouldRender) {
      return;
    }

    const canvasElement = canvasRef.current;
    const textLayerElement = textLayerRef.current;
    if (!canvasElement || !textLayerElement) return;

    let cancelled = false;
    const deviceScale = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
    let cancelIdleUpgrade: (() => void) | null = null;

    const renderPage = async () => {
      cancelRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
      cancelTextLayerTask(textLayerTaskRef.current);
      textLayerTaskRef.current = null;
      textLayerElement.replaceChildren();
      if (cancelIdleUpgrade) {
        cancelIdleUpgrade();
        cancelIdleUpgrade = null;
      }

      try {
        const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.max(MIN_STAGE_WIDTH, stageWidth - 28) / baseViewport.width;
        const effectiveScale = fitScale * (zoomPercent / 100);
        const viewport = page.getViewport({ scale: effectiveScale });
        const aspectRatio = baseViewport.height / Math.max(baseViewport.width, 1);

        setRenderedPage({ width: viewport.width, height: viewport.height });
        onPageAspectReady(pageNumber, aspectRatio);

        canvasElement.style.width = `${viewport.width}px`;
        canvasElement.style.height = `${viewport.height}px`;

        const lowScale = Math.max(LOW_QUALITY_SCALE, 0.2);
        canvasElement.width = Math.floor(viewport.width * deviceScale * lowScale);
        canvasElement.height = Math.floor(viewport.height * deviceScale * lowScale);
        const context = canvasElement.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error(`第 ${pageNumber} 页无法创建 PDF 画布上下文。`);
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvasElement.width, canvasElement.height);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvasElement.width, canvasElement.height);

        const fastTask = page.render({
          canvasContext: context,
          viewport,
          transform: deviceScale * lowScale !== 1 ? [deviceScale * lowScale, 0, 0, deviceScale * lowScale, 0, 0] : undefined,
        });
        renderTaskRef.current = fastTask;
        await fastTask.promise;
        if (cancelled) return;

        cancelIdleUpgrade = scheduleWhenIdle(async () => {
          if (cancelled) return;
          try {
            canvasElement.width = Math.floor(viewport.width * deviceScale);
            canvasElement.height = Math.floor(viewport.height * deviceScale);
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvasElement.width, canvasElement.height);
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvasElement.width, canvasElement.height);

            const sharpTask = page.render({
              canvasContext: context,
              viewport,
              transform: deviceScale !== 1 ? [deviceScale, 0, 0, deviceScale, 0, 0] : undefined,
            });
            renderTaskRef.current = sharpTask;
            await sharpTask.promise;
            if (cancelled) return;

            if (!enableTextLayer) {
              textLayerElement.replaceChildren();
              textLayerElement.style.width = `${viewport.width}px`;
              textLayerElement.style.height = `${viewport.height}px`;
              return;
            }

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
            if (cancelled || isCancelledRenderError(error)) return;
            onRenderError(`第 ${pageNumber} 页渲染失败：${String(error)}`);
          }
        });
      } catch (error) {
        if (cancelled || isCancelledRenderError(error)) {
          return;
        }
        visibleContext.setTransform(1, 0, 0, 1, 0, 0);
        visibleContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
        visibleContext.drawImage(nextCanvas, 0, 0);

        textLayerElement.className = nextTextLayer.className;
        textLayerElement.style.width = nextTextLayer.style.width;
        textLayerElement.style.height = nextTextLayer.style.height;
        textLayerElement.style.setProperty("--scale-factor", `${effectiveScale}`);
        textLayerElement.replaceChildren(...Array.from(nextTextLayer.childNodes));
        renderedPageRef.current = { width: viewport.width, height: viewport.height };
        setRenderedPage({ width: viewport.width, height: viewport.height });
        setPreviewScale(1);
      } catch (error) {
        if (cancelled || isCancelledRenderError(error)) return;
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
      if (cancelIdleUpgrade) {
        cancelIdleUpgrade();
        cancelIdleUpgrade = null;
      }
    };
  }, [enableTextLayer, onPageAspectReady, onRenderError, pageNumber, pdfDocument, stageWidth, zoomPercent]);

  return (
    <div
      ref={(node) => {
        shellRef.current = node;
        onPageRefChange(pageNumber, node);
      }}
      className="pdfjs-page-shell"
      data-page-number={pageNumber}
      style={{
        width: `${shellWidth}px`,
        minHeight: `${Math.max(shellHeight, 480)}px`,
      }}
    >
      {shouldRender ? (
        <div
          className="pdfjs-page-content"
          style={{
            width: renderedPage.width ? `${renderedPage.width}px` : `${pageWidth}px`,
            height: renderedPage.height ? `${renderedPage.height}px` : `${estimatedHeight}px`,
            transform: previewScale !== 1 ? `scale(${previewScale})` : undefined,
          }}
        >
          <canvas className="pdfjs-canvas" ref={canvasRef} />
          <div className="textLayer pdfjs-text-layer" ref={textLayerRef} onMouseUp={onSelectionCapture} />
        </div>
      ) : (
        <div
          className="pdfjs-page-placeholder"
          aria-hidden="true"
          style={{
            width: `${pageWidth}px`,
            height: `${Math.max(estimatedHeight, 480)}px`,
          }}
        />
      )}
    </div>
  );
};

export const PdfReader: React.FC<PdfReaderProps> = ({
  activePdfPath,
  currentModel,
  isFocused = false,
  requestedPage,
  toolbarActions,
  isToolbarCollapsed = false,
  lookupMode,
  onLookupModeChange,
  onStatus,
  onSaveCardSuccess,
  onPageChange,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfObjectUrlRef = useRef<string | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const currentPageRef = useRef(1);
  const initialPageRef = useRef(1);
  const isPageInputFocusedRef = useRef(false);
  const zoomPercentRef = useRef(100);
  const viewportAnchorRef = useRef<ViewportAnchorState | null>(null);
  const gestureZoomStartRef = useRef<number | null>(null);
  const toolbarHideTimerRef = useRef<number | null>(null);
  const onStatusRef = useRef(onStatus);
  const onPageChangeRef = useRef(onPageChange);

  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [stageWidth, setStageWidth] = useState(MIN_STAGE_WIDTH);
  const [viewerMode, setViewerMode] = useState<ViewerMode>("pdfjs");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [readerToolMode, setReaderToolMode] = useState<ReaderToolMode>(() => readStoredToolMode());
  const [selection, setSelection] = useState<PdfSelectionState | null>(null);
  const [pageAspectMap, setPageAspectMap] = useState<Record<number, number>>({});
  const [defaultAspectRatio, setDefaultAspectRatio] = useState(PAGE_ASPECT_FALLBACK);
  const [renderCenterPage, setRenderCenterPage] = useState(1);

  useEffect(() => {
    onStatusRef.current = onStatus;
    onPageChangeRef.current = onPageChange;
  }, [onPageChange, onStatus]);

  useEffect(() => {
    localStorage.setItem(TOOL_MODE_STORAGE_KEY, readerToolMode);
  }, [readerToolMode]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    zoomPercentRef.current = zoomPercent;
  }, [zoomPercent]);

  const clearToolbarHideTimer = useCallback(() => {
    if (toolbarHideTimerRef.current != null) {
      window.clearTimeout(toolbarHideTimerRef.current);
      toolbarHideTimerRef.current = null;
    }
  }, []);

  const revealToolbar = useCallback(() => {
    clearToolbarHideTimer();
    setIsToolbarAutoHidden(false);
  }, [clearToolbarHideTimer]);

  const scheduleToolbarAutoHide = useCallback(
    (delay = TOOLBAR_AUTO_HIDE_DELAY_MS) => {
      clearToolbarHideTimer();
      if (isToolbarCollapsed || isOutlineOpen || viewerMode !== "pdfjs") {
        setIsToolbarAutoHidden(false);
        return;
      }

      toolbarHideTimerRef.current = window.setTimeout(() => {
        setIsToolbarAutoHidden(true);
        toolbarHideTimerRef.current = null;
      }, delay);
    },
    [clearToolbarHideTimer, isOutlineOpen, isToolbarCollapsed, viewerMode],
  );

  useEffect(() => {
    const stored = localStorage.getItem(storageKey(activePdfPath));
    const nextPage = stored ? Number(stored) : 1;
    const restoredPage = Number.isFinite(nextPage) && nextPage > 0 ? nextPage : 1;
    initialPageRef.current = restoredPage;
    currentPageRef.current = restoredPage;
    setCurrentPage(restoredPage);
    setRenderCenterPage(restoredPage);
    setPageCount(0);
    setZoomPercent(100);
    setViewerMode("pdfjs");
    setViewerError(null);
    setSelection(null);
    setPageAspectMap({});
    setDefaultAspectRatio(PAGE_ASPECT_FALLBACK);
    pageRefs.current.clear();
  }, [activePdfPath, clearToolbarHideTimer]);

  useEffect(() => {
    let cancelled = false;
    const previousObjectUrl = pdfObjectUrlRef.current;
    const previousLoadingTask = loadingTaskRef.current;
    const previousDocument = pdfDocumentRef.current;

    setIsLoading(true);
    setPdfBytes(null);
    setPdfDocument(null);
    setSelection(null);

    if (previousObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
    }
    pdfObjectUrlRef.current = null;
    setPdfObjectUrl(null);

    destroyLoadingTask(previousLoadingTask);
    loadingTaskRef.current = null;
    destroyDocument(previousDocument);
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

  useEffect(() => () => clearToolbarHideTimer(), [clearToolbarHideTimer]);

  useEffect(() => {
    if (isToolbarCollapsed || isOutlineOpen || viewerMode !== "pdfjs") {
      revealToolbar();
    }
  }, [isOutlineOpen, isToolbarCollapsed, revealToolbar, viewerMode]);

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
        setRenderCenterPage(safePage);
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
  }, [activePdfPath, pdfBytes, viewerMode]);

  const handlePageRefChange = useCallback((pageNumber: number, node: HTMLDivElement | null) => {
    if (node) {
      pageRefs.current.set(pageNumber, node);
    } else {
      pageRefs.current.delete(pageNumber);
    }
  }, []);

  const handlePageAspectReady = useCallback((pageNumber: number, aspectRatio: number) => {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    setPageAspectMap((previous) => {
      if (previous[pageNumber] === aspectRatio) return previous;
      return { ...previous, [pageNumber]: aspectRatio };
    });
    setDefaultAspectRatio((previous) => (previous === PAGE_ASPECT_FALLBACK ? aspectRatio : previous));
  }, []);

  const updateCurrentPageFromScroll = useCallback(() => {
    const stageElement = stageRef.current;
    if (!stageElement || pageRefs.current.size === 0) return;

    const anchorLine = stageElement.scrollTop + stageElement.clientHeight * 0.35;
    let bestPage = currentPageRef.current;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [pageNumber, node] of pageRefs.current.entries()) {
      const top = node.offsetTop;
      const bottom = top + Math.max(node.offsetHeight, 1);
      if (anchorLine >= top && anchorLine <= bottom) {
        bestPage = pageNumber;
        bestDistance = 0;
        break;
      }
      const distance = Math.min(Math.abs(anchorLine - top), Math.abs(anchorLine - bottom));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = pageNumber;
      }
    }

    if (bestPage !== currentPageRef.current) {
      currentPageRef.current = bestPage;
      setCurrentPage(bestPage);
      setRenderCenterPage(bestPage);
      localStorage.setItem(storageKey(activePdfPath), String(bestPage));
      onPageChangeRef.current?.(bestPage);
    }
  }, [commitPageState]);

  const updateRenderWindow = useCallback(() => {
    const stageElement = stageRef.current;
    if (!stageElement || pageCount <= 0) {
      return;
    }

    const buffer = Math.max(stageElement.clientHeight * PAGE_RENDER_BUFFER_MULTIPLIER, 1200);
    const thresholdTop = Math.max(0, stageElement.scrollTop - buffer);
    const thresholdBottom = stageElement.scrollTop + stageElement.clientHeight + buffer;

    let firstVisiblePage: number | null = null;
    let lastVisiblePage: number | null = null;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const node = pageRefs.current.get(pageNumber);
      if (!node) continue;

      const top = node.offsetTop;
      const bottom = top + Math.max(node.offsetHeight, 1);
      if (bottom >= thresholdTop && firstVisiblePage == null) {
        firstVisiblePage = pageNumber;
      }
      if (top <= thresholdBottom) {
        lastVisiblePage = pageNumber;
        continue;
      }
      if (lastVisiblePage != null) {
        break;
      }
    }

    const fallbackPage = clamp(currentPageRef.current || 1, 1, pageCount);
    const nextStart = Math.max(1, (firstVisiblePage ?? fallbackPage) - PAGE_RENDER_OVERSCAN);
    const nextEnd = Math.min(pageCount, (lastVisiblePage ?? fallbackPage) + PAGE_RENDER_OVERSCAN);

    setRenderWindow((previous) => {
      if (previous.start === nextStart && previous.end === nextEnd) {
        return previous;
      }
      return { start: nextStart, end: nextEnd };
    });
  }, [pageCount]);

  const scrollToPage = useCallback(
    (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
      const safePage = commitPageState(pageNumber);
      const stageElement = stageRef.current;
      const pageNode = pageRefs.current.get(safePage);
      if (!stageElement || !pageNode) {
        return false;
      }

      setRenderWindow((previous) => {
        const nextStart = Math.max(1, safePage - PAGE_RENDER_OVERSCAN);
        const nextEnd = Math.min(pageCount || safePage, safePage + PAGE_RENDER_OVERSCAN);
        if (previous.start === nextStart && previous.end === nextEnd) {
          return previous;
        }
        return { start: nextStart, end: nextEnd };
      });

      stageElement.scrollTo({
        top: Math.max(0, pageNode.offsetTop - 16),
        behavior,
      });
      currentPageRef.current = pageNumber;
      setCurrentPage(pageNumber);
      setRenderCenterPage(pageNumber);
      localStorage.setItem(storageKey(activePdfPath), String(pageNumber));
      onPageChangeRef.current?.(pageNumber);
    },
    [commitPageState, scrollToPage, viewerMode],
  );

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !stageRef.current) return;

    const stageElement = stageRef.current;
    let ticking = false;

    const clearSelectionForNavigation = () => {
      window.getSelection()?.removeAllRanges();
      setSelection((previous) => (previous && previous.overlay !== "button" ? previous : null));
    };

    const handleScroll = () => {
      clearSelectionForNavigation();
      const estimatedHeight = Math.max(480, Math.round((Math.max(MIN_STAGE_WIDTH, stageWidth - 28) * zoomPercent / 100) * defaultAspectRatio)) + 20;
      const roughPage = clamp(
        Math.floor(stageElement.scrollTop / Math.max(estimatedHeight, 1)) + 1,
        1,
        Math.max(pageCount, 1),
      );
      setRenderCenterPage((previous) => (previous === roughPage ? previous : roughPage));
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        updateCurrentPageFromScroll();
        updateRenderWindow();
      });
    };

    const handleWindowResize = () => {
      clearSelectionForNavigation();
      revealToolbar();
      scheduleToolbarAutoHide(1600);
      updateCurrentPageFromScroll();
      updateRenderWindow();
    };

    stageElement.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleWindowResize);
    const timer = window.setTimeout(() => {
      updateCurrentPageFromScroll();
      updateRenderWindow();
    }, 60);

    return () => {
      window.clearTimeout(timer);
      stageElement.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [activePdfPath, defaultAspectRatio, pageCount, stageWidth, updateCurrentPageFromScroll, viewerMode, zoomPercent]);

  useEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs") return;
    const targetPage = Math.min(Math.max(initialPageRef.current, 1), pageCount || 1);
    const timer = window.setTimeout(() => {
      scrollToPage(targetPage, "auto");
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pageCount, pdfDocument, scrollToPage, viewerMode]);

  useEffect(() => {
    if (pageCount <= 0) return;
    setRenderCenterPage((previous) => clamp(previous, 1, pageCount));
  }, [pageCount]);

  const handlePdfRenderError = useCallback((message: string) => {
    const fullMessage = formatPdfRenderError(message);
    setViewerMode("compat");
    setViewerError(fullMessage);
    onStatusRef.current(fullMessage, "error", true);
  }, []);

  const handleSelectionCapture = () => {
    if (viewerMode !== "pdfjs") return;

    window.requestAnimationFrame(() => {
      const browserSelection = window.getSelection();
      if (!browserSelection || browserSelection.rangeCount === 0 || browserSelection.isCollapsed) {
        setSelection((previous) => (previous && previous.overlay !== "button" ? previous : null));
        return;
      }

      const anchorNode = browserSelection.anchorNode;
      const focusNode = browserSelection.focusNode;
      if (!anchorNode || !focusNode) return;

      const pageNumber = resolvePageFromNode(anchorNode) ?? resolvePageFromNode(focusNode) ?? currentPageRef.current;
      const pageElement = pageRefs.current.get(pageNumber);
      if (!pageElement || !pageElement.contains(anchorNode) || !pageElement.contains(focusNode)) return;

      const text = normalizeSelectedText(browserSelection.toString());
      if (!text) {
        setSelection(null);
        return;
      }

      if (readerToolMode === "translate" && text.length > MAX_TRANSLATE_SELECTION_CHARS) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        onStatusRef.current("选中文本过长，请使用“整页翻译”", "info", false);
        return;
      }

      const range = browserSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }

      const popoverWidth = Math.min(POPOVER_ESTIMATED_WIDTH, window.innerWidth - VIEWPORT_MARGIN_X * 2);
      const selectionCenterX = rect.left + rect.width / 2;
      const preferredPopoverLeft = selectionCenterX - popoverWidth / 2;
      const popoverLeft = clamp(preferredPopoverLeft, VIEWPORT_MARGIN_X, window.innerWidth - popoverWidth - VIEWPORT_MARGIN_X);
      const canOpenBelow = rect.bottom + POPOVER_ANCHOR_GAP + POPOVER_ESTIMATED_HEIGHT <= window.innerHeight - VIEWPORT_MARGIN_X;
      const canOpenAbove = rect.top - POPOVER_ANCHOR_GAP - POPOVER_ESTIMATED_HEIGHT >= VIEWPORT_MARGIN_TOP;
      const popoverTop = canOpenBelow
        ? rect.bottom + POPOVER_ANCHOR_GAP
        : canOpenAbove
          ? rect.top - POPOVER_ESTIMATED_HEIGHT - POPOVER_ANCHOR_GAP
          : clamp(rect.bottom + 10, VIEWPORT_MARGIN_TOP, window.innerHeight - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_MARGIN_X);
      const targetLeft = clamp(selectionCenterX - FLOATING_BUTTON_WIDTH / 2, VIEWPORT_MARGIN_X, window.innerWidth - FLOATING_BUTTON_WIDTH - VIEWPORT_MARGIN_X);
      const targetTop = canOpenBelow
        ? clamp(rect.bottom + 6, VIEWPORT_MARGIN_TOP, window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X)
        : clamp(rect.top - FLOATING_BUTTON_HEIGHT - 6, VIEWPORT_MARGIN_TOP, window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X);

      setSelection({
        text,
        page: pageNumber,
        targetLeft,
        targetTop,
        popoverLeft,
        popoverTop,
        overlay: readerToolMode === "translate" ? "translate" : "button",
      });
    });
  };

  const handleOpenExplainPopover = () => {
    setSelection((previous) => (previous ? { ...previous, overlay: "explain" } : previous));
  };

  const handleClosePopover = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const zoomOut = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    captureViewportAnchor();
    setZoomPercent((previous) => Math.max(MIN_ZOOM, previous - ZOOM_STEP));
  };

  const zoomIn = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    captureViewportAnchor();
    setZoomPercent((previous) => Math.min(MAX_ZOOM, previous + ZOOM_STEP));
  };

  const fitToWidth = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    captureViewportAnchor();
    setZoomPercent(100);
  };

  const handlePageInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const normalized = event.target.value.replace(/[^\d]/g, "");
    setPageInputValue(normalized);
  };

  const handlePageInputCommit = () => {
    isPageInputFocusedRef.current = false;
    if (!pageInputValue.trim()) {
      setPageInputValue(String(Math.max(1, currentPageRef.current)));
      return;
    }

    const nextPage = Number(pageInputValue);
    if (!Number.isFinite(nextPage) || nextPage < 1) {
      setPageInputValue(String(Math.max(1, currentPageRef.current)));
      return;
    }

    const safePage = normalizePageNumber(nextPage);
    setPageInputValue(String(safePage));
    goToPage(safePage, "auto");
  };

  const handlePageInputFocus = () => {
    isPageInputFocusedRef.current = true;
    revealToolbar();
  };

  const handlePageInputBlur = () => {
    isPageInputFocusedRef.current = false;
    setPageInputValue(String(Math.max(1, currentPageRef.current)));
  };

  const handleSelectOutlineEntry = useCallback(
    (pageNumber: number | null) => {
      if (typeof pageNumber !== "number" || pageNumber < 1) {
        return;
      }
      goToPage(pageNumber, "auto");
      setIsOutlineOpen(false);
    },
    [goToPage],
  );

  const handleToolbarMouseEnter = () => {
    revealToolbar();
  };

  const handleToolbarMouseLeave = () => {
    scheduleToolbarAutoHide(260);
  };

  const handleToolbarFocusCapture = () => {
    revealToolbar();
  };

  const handleToolbarBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    scheduleToolbarAutoHide(260);
  };

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !stageRef.current) return;

    const stageElement = stageRef.current;
    const isStageEvent = (target: EventTarget | null) => (target instanceof Node ? stageElement.contains(target) : false);

    const clearSelectionForZoom = () => {
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    };

    const handleWheelZoom = (event: WheelEvent) => {
      if (!isStageEvent(event.target) && !stageElement.matches(":hover")) return;

      const nativeWheelEvent = event as WheelEvent & { deltaZ?: number };
      const isPinchLike = event.ctrlKey || event.metaKey || (typeof nativeWheelEvent.deltaZ === "number" && nativeWheelEvent.deltaZ !== 0);
      if (!isPinchLike) return;
      event.preventDefault();

      const nextDelta = clamp(-event.deltaY * TRACKPAD_ZOOM_SENSITIVITY, -18, 18);
      if (Math.abs(nextDelta) < 0.25) return;

      clearSelectionForZoom();
      captureViewportAnchor(event.clientX, event.clientY);
      setZoomPercent((previous) => clamp(Math.round(previous + nextDelta), MIN_ZOOM, MAX_ZOOM));
    };

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as Event & { scale?: number; preventDefault: () => void };
      if (!isStageEvent(gestureEvent.target) && !stageElement.matches(":hover")) return;
      gestureEvent.preventDefault();
      clearSelectionForZoom();
      captureViewportAnchor(
        "clientX" in gestureEvent && typeof gestureEvent.clientX === "number" ? gestureEvent.clientX : undefined,
        "clientY" in gestureEvent && typeof gestureEvent.clientY === "number" ? gestureEvent.clientY : undefined,
      );
      gestureZoomStartRef.current = zoomPercentRef.current;
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as Event & { scale?: number; preventDefault: () => void };
      if (!isStageEvent(gestureEvent.target) && !stageElement.matches(":hover")) return;
      if (gestureZoomStartRef.current == null || typeof gestureEvent.scale !== "number") return;
      gestureEvent.preventDefault();
      clearSelectionForZoom();
      setZoomPercent(clamp(Math.round(gestureZoomStartRef.current * gestureEvent.scale), MIN_ZOOM, MAX_ZOOM));
    };

    const handleGestureEnd = () => {
      gestureZoomStartRef.current = null;
    };

    window.addEventListener("wheel", handleWheelZoom, { passive: false, capture: true });
    window.addEventListener("gesturestart", handleGestureStart as EventListener, { passive: false, capture: true });
    window.addEventListener("gesturechange", handleGestureChange as EventListener, { passive: false, capture: true });
    window.addEventListener("gestureend", handleGestureEnd as EventListener, { capture: true });

    return () => {
      window.removeEventListener("wheel", handleWheelZoom, true);
      window.removeEventListener("gesturestart", handleGestureStart as EventListener, true);
      window.removeEventListener("gesturechange", handleGestureChange as EventListener, true);
      window.removeEventListener("gestureend", handleGestureEnd as EventListener, true);
    };
  }, [captureViewportAnchor, viewerMode]);

  const handlePageInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      handlePageInputCommit();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      isPageInputFocusedRef.current = false;
      setPageInputValue(String(Math.max(1, currentPageRef.current)));
      event.currentTarget.blur();
    }
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
  const visibleStart = Math.max(1, renderCenterPage - RENDER_WINDOW_RADIUS);
  const visibleEnd = Math.min(pageCount, renderCenterPage + RENDER_WINDOW_RADIUS);
  const renderedPageWidth = Math.max(MIN_STAGE_WIDTH, stageWidth - 28) * (zoomPercent / 100);

  const estimatedHeightForPage = useCallback(
    (pageNumber: number) => {
      const aspectRatio = pageAspectMap[pageNumber] ?? defaultAspectRatio;
      return Math.max(480, Math.round(renderedPageWidth * aspectRatio));
    },
    [defaultAspectRatio, pageAspectMap, renderedPageWidth],
  );

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

          <div className="pdf-outline-body">
            {isOutlineLoading ? (
              <div className="pdf-outline-state">
                <div className="loading-dots compact" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <span>正在读取目录...</span>
              </div>
            ) : outlineError ? (
              <div className="pdf-outline-state pdf-outline-state-error">{outlineError}</div>
            ) : outlineEntries.length === 0 ? (
              <div className="pdf-outline-state">这个 PDF 没有可用目录。</div>
            ) : (
              <div className="pdf-outline-list" role="tree" aria-label="PDF 目录">
                {outlineEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`pdf-outline-item ${entry.pageNumber === currentPage ? "active" : ""}`}
                    style={{ paddingLeft: `${16 + entry.depth * 18}px` }}
                    onClick={() => handleSelectOutlineEntry(entry.pageNumber)}
                    disabled={entry.pageNumber == null}
                    role="treeitem"
                    aria-level={entry.depth + 1}
                  >
                    <span className="pdf-outline-item-title">
                      {entry.title}
                      {entry.hasChildren ? <span className="pdf-outline-branch-indicator">·</span> : null}
                    </span>
                    <span className="pdf-outline-item-page">{entry.pageNumber ? `P${entry.pageNumber}` : "无页码"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

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
                pageNumber >= visibleStart && pageNumber <= visibleEnd ? (
                  <PdfPageCanvas
                    key={`${activePdfPath}:${pageNumber}:${zoomPercent}:${stageWidth}`}
                    pageNumber={pageNumber}
                  pdfDocument={pdfDocument as PDFDocumentProxy}
                  stageWidth={stageWidth}
                  zoomPercent={zoomPercent}
                  enableTextLayer={pageNumber === currentPage}
                  onSelectionCapture={handleSelectionCapture}
                  onPageRefChange={handlePageRefChange}
                  onPageAspectReady={handlePageAspectReady}
                    onRenderError={handlePdfRenderError}
                  />
                ) : (
                  <div
                    key={`${activePdfPath}:${pageNumber}:placeholder:${zoomPercent}:${stageWidth}`}
                    ref={(node) => handlePageRefChange(pageNumber, node)}
                    className="pdfjs-page-shell pdfjs-page-placeholder"
                    data-page-number={pageNumber}
                    style={{
                      width: `${renderedPageWidth}px`,
                      minHeight: `${estimatedHeightForPage(pageNumber)}px`,
                    }}
                  />
                )
              ))}
            </div>

            {pageTranslation.open && (
              <aside className="pdf-page-translation-panel">
                <div className="pdf-page-translation-header">
                  <div>
                    <div className="pdf-page-translation-title">当前页译文</div>
                    <div className="pdf-page-translation-meta">当前显示的是第 {translatedPageNumber ?? currentPage} 页译文</div>
                  </div>
                  <button className="ghost-icon-button" onClick={handleClosePageTranslation} aria-label="关闭译文面板">
                    <X size={14} />
                  </button>
                </div>

                {pageTranslation.phase === "loading" && (
                  <div className="pdf-page-translation-state">
                    <LoaderCircle size={16} className="spin" />
                    <span>正在翻译第 {pageTranslation.requestedPage ?? currentPage} 页...</span>
                  </div>
                )}

                {pageTranslation.phase === "error" && <div className="term-popover-error">{pageTranslation.error}</div>}

                {pageTranslation.phase === "success" && pageTranslation.result && (
                  <div className="pdf-page-translation-content">
                    <MarkdownRenderer content={pageTranslation.result.translated_markdown} />
                  </div>
                )}
              </aside>
            )}
          </div>
        )}

        {viewerMode === "compat" && !isLoading && (
          pdfObjectUrl ? (
            <iframe
              className="pdf-compat-frame"
              src={pdfObjectUrl}
              title={`PDF 兼容预览：${getFileName(activePdfPath)}`}
            />
          ) : (
            <div className="pdf-viewer-loading pdf-viewer-error-state">
              <AlertTriangle size={16} />
              <span>{viewerError || "无法加载 PDF 兼容预览。"}</span>
            </div>
          )
        )}

        {viewerMode === "pdfjs" && (
          <div className="pdf-selection-overlay">
            {selection && selection.overlay === "button" && (
              <button
                className="pdf-selection-target"
                style={selectionStyle}
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleOpenExplainPopover}
              >
                解释
              </button>
            )}

            {selection && selection.overlay === "explain" && (
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

            {selection && selection.overlay === "translate" && (
              <PdfTranslatePopover
                selectedText={selection.text}
                pdfPath={activePdfPath}
                page={selection.page}
                currentModel={currentModel}
                onClose={handleClosePopover}
                onStatus={onStatus}
                style={popoverStyle}
              />
            )}
          </div>
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
