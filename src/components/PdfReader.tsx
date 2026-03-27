import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  List,
  LoaderCircle,
  MoveHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { GlobalWorkerOptions, getDocument, renderTextLayer } from "pdfjs-dist";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayerRenderTask,
} from "pdfjs-dist";
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
  ensureAiReady?: () => Promise<string>;
  translationModel: string;
  ensureTranslationReady?: () => Promise<string>;
  isFocused?: boolean;
  requestedPage?: number;
  requestedAnchorText?: string;
  requestedAnchorKey?: string;
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
  model_used: string;
}

interface PageTranslationState {
  open: boolean;
  phase: "idle" | "loading" | "success" | "error";
  result: TranslatePdfPageResult | null;
  error: string | null;
  requestedPage: number | null;
}

interface TranslationToast {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
  leaving: boolean;
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
  pageWidth: number;
  estimatedHeight: number;
  shouldRender: boolean;
  onSelectionCapture: () => void;
  onPageRefChange: (pageNumber: number, node: HTMLDivElement | null) => void;
  onPageMetricsChange: (pageNumber: number, aspectRatio: number) => void;
  onRenderError: (message: string) => void;
}

const LOOKUP_MODE_OPTIONS: Array<{ value: LookupMode; label: string }> = [
  { value: "popular_cn", label: "通俗百科" },
  { value: "cs_encyclopedia", label: "CS 百科" },
  { value: "bioinformatics", label: "生信百科" },
];

const workerUrl = new URL(
  "pdfjs-dist/build/pdf.worker.min.js",
  import.meta.url,
).toString();
const PDF_LOAD_TIMEOUT_MS = 12000;
const MIN_STAGE_WIDTH = 320;
const ZOOM_STEP = 20;
const MIN_ZOOM = 60;
const MAX_ZOOM = 220;
const TRACKPAD_ZOOM_SENSITIVITY = 0.08;
const TOOLBAR_AUTO_HIDE_DELAY_MS = 1100;
const DEFAULT_PAGE_ASPECT_RATIO = 1.414;
const PAGE_RENDER_OVERSCAN = 2;
const PAGE_RENDER_BUFFER_MULTIPLIER = 1.5;
const VIEWPORT_MARGIN_X = 16;
const VIEWPORT_MARGIN_TOP = 84;
const POPOVER_ESTIMATED_WIDTH = 420;
const POPOVER_ESTIMATED_HEIGHT = 560;
const FLOATING_BUTTON_WIDTH = 84;
const FLOATING_BUTTON_HEIGHT = 36;
const POPOVER_ANCHOR_GAP = 14;
const TOOL_MODE_STORAGE_KEY = "ra_pdf_reader_tool_mode_v1";
const MAX_TRANSLATE_SELECTION_CHARS = 2400;
const TRANSLATION_TOAST_EXIT_MS = 240;
const TRANSLATION_INFO_TOAST_MS = 1800;
const TRANSLATION_SUCCESS_TOAST_MS = 2400;
const TRANSLATION_ERROR_TOAST_MS = 3400;

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
const buildPageTranslationCacheKey = (
  pdfPath: string,
  page: number,
  model: string,
) => `ra_pdf_translate_page_v2:${pdfPath}:${page}:${model}`;
const normalizeSelectedText = (value: string) =>
  value.replace(/\s+/g, " ").trim();
const normalizeAnchorText = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .trim();
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);
const readStoredToolMode = (): ReaderToolMode =>
  localStorage.getItem(TOOL_MODE_STORAGE_KEY) === "translate"
    ? "translate"
    : "explain";
const formatPdfRenderError = (message: string) => {
  if (/ToUnicode CMap/i.test(message)) {
    return "PDF 内嵌字体映射异常，已切换到兼容预览。这个文件的划词解释和整页翻译可能不可用。";
  }
  return `PDF 页面渲染失败，已切换为兼容模式：${message}`;
};

const buildSelectionTranslationCacheKey = (
  pdfPath: string,
  page: number,
  text: string,
) => `ra_pdf_translate_selection_v2:${pdfPath}:${page}:${text}`;

const splitPageTextIntoSegments = (pageText: string) => {
  const normalized = pageText.replace(/\r\n/g, "\n");
  const primary = normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (primary.length > 0) {
    return primary.flatMap((block) => {
      if (block.length <= 900) return [block];
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > 900 && current) {
          chunks.push(current);
          current = line;
        } else {
          current = next;
        }
      }
      if (current) chunks.push(current);
      return chunks;
    });
  }

  const fallback = normalized.trim();
  return fallback ? [fallback] : [];
};

const findSelectionSegmentIndex = (
  segments: string[],
  selectedText: string,
) => {
  if (!selectedText) return -1;
  const lowerSelected = selectedText.toLowerCase();
  return segments.findIndex(
    (segment) =>
      segment.includes(selectedText) ||
      segment.toLowerCase().includes(lowerSelected),
  );
};

const extractAnchorNeedle = (snippet: string) => {
  const normalized = normalizeAnchorText(snippet);
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter((token) => token.length >= 3);
  return tokens.slice(0, 10).join(" ").trim();
};

const resolveOutlinePageNumber = async (
  pdfDocument: PDFDocumentProxy,
  destination: unknown,
): Promise<number | null> => {
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
      return (
        (await pdfDocument.getPageIndex(
          target as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
        )) + 1
      );
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
      const children = item.items?.length
        ? await flattenOutlineEntries(pdfDocument, item.items, depth + 1, id)
        : [];
      const pageNumber = await resolveOutlinePageNumber(pdfDocument, item.dest);

      return [
        {
          id,
          title: item.title?.trim() || `绔犺妭 ${index + 1}`,
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

const isCancelledRenderError = (error: unknown) => {
  const message = String(error).toLowerCase();
  return (
    message.includes("rendering cancelled") ||
    message.includes("textlayer task cancelled") ||
    message.includes("abortexception")
  );
};

const resolvePageFromNode = (node: Node | null): number | null => {
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
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
  pageWidth,
  estimatedHeight,
  shouldRender,
  onSelectionCapture,
  onPageRefChange,
  onPageMetricsChange,
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
  const [renderedPage, setRenderedPage] = useState<RenderedPageState>({
    width: 0,
    height: 0,
  });
  const [previewScale, setPreviewScale] = useState(1);

  useEffect(() => {
    onPageRefChange(pageNumber, shellRef.current);
    return () => onPageRefChange(pageNumber, null);
  }, [onPageRefChange, pageNumber]);

  useLayoutEffect(() => {
    const previous = previousViewportMetricsRef.current;
    if (
      renderedPageRef.current.width <= 0 ||
      renderedPageRef.current.height <= 0
    ) {
      previousViewportMetricsRef.current = { zoomPercent, stageWidth };
      return;
    }

    const previousStageBasis = Math.max(
      MIN_STAGE_WIDTH,
      previous.stageWidth - 28,
    );
    const nextStageBasis = Math.max(MIN_STAGE_WIDTH, stageWidth - 28);
    const previousScaleFactor =
      previousStageBasis * Math.max(previous.zoomPercent, 1);
    const nextScaleFactor = nextStageBasis * Math.max(zoomPercent, 1);
    const nextPreviewScale =
      previousScaleFactor > 0 ? nextScaleFactor / previousScaleFactor : 1;

    setPreviewScale(
      Math.abs(nextPreviewScale - 1) > 0.001 ? nextPreviewScale : 1,
    );
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
    const deviceScale = window.devicePixelRatio || 1;

    const renderPage = async () => {
      cancelRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
      cancelTextLayerTask(textLayerTaskRef.current);
      textLayerTaskRef.current = null;

      try {
        const page: PDFPageProxy = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale =
          Math.max(MIN_STAGE_WIDTH, stageWidth - 28) / baseViewport.width;
        const effectiveScale = fitScale * (zoomPercent / 100);
        const viewport = page.getViewport({ scale: effectiveScale });
        onPageMetricsChange(
          pageNumber,
          viewport.height / Math.max(viewport.width, 1),
        );

        const previousRenderedPage = renderedPageRef.current;
        const hasPreviousRender =
          previousRenderedPage.width > 0 && previousRenderedPage.height > 0;
        if (!hasPreviousRender) {
          renderedPageRef.current = {
            width: viewport.width,
            height: viewport.height,
          };
          setRenderedPage({ width: viewport.width, height: viewport.height });
          setPreviewScale(1);
        }

        const nextCanvas = document.createElement("canvas");
        nextCanvas.width = Math.floor(viewport.width * deviceScale);
        nextCanvas.height = Math.floor(viewport.height * deviceScale);

        const context = nextCanvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error(`第 ${pageNumber} 页无法创建 PDF 画布上下文。`);
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, nextCanvas.width, nextCanvas.height);

        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform:
            deviceScale !== 1
              ? [deviceScale, 0, 0, deviceScale, 0, 0]
              : undefined,
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (cancelled) return;

        const nextTextLayer = document.createElement("div");
        nextTextLayer.className = "textLayer pdfjs-text-layer";
        nextTextLayer.style.width = `${viewport.width}px`;
        nextTextLayer.style.height = `${viewport.height}px`;
        nextTextLayer.style.setProperty("--scale-factor", `${effectiveScale}`);

        const textContent = await page.getTextContent();
        if (cancelled) return;
        const textLayerTask = renderTextLayer({
          textContentSource: textContent,
          container: nextTextLayer,
          viewport,
          textDivs: [],
          textContentItemsStr: [],
        });
        textLayerTaskRef.current = textLayerTask;
        await textLayerTask.promise;
        if (cancelled) return;

        canvasElement.width = nextCanvas.width;
        canvasElement.height = nextCanvas.height;
        canvasElement.style.width = `${viewport.width}px`;
        canvasElement.style.height = `${viewport.height}px`;

        const visibleContext = canvasElement.getContext("2d", { alpha: false });
        if (!visibleContext) {
          throw new Error(`第 ${pageNumber} 页无法更新 PDF 画布上下文。`);
        }
        visibleContext.setTransform(1, 0, 0, 1, 0, 0);
        visibleContext.clearRect(
          0,
          0,
          canvasElement.width,
          canvasElement.height,
        );
        visibleContext.drawImage(nextCanvas, 0, 0);

        textLayerElement.className = nextTextLayer.className;
        textLayerElement.style.width = nextTextLayer.style.width;
        textLayerElement.style.height = nextTextLayer.style.height;
        textLayerElement.style.setProperty(
          "--scale-factor",
          `${effectiveScale}`,
        );
        textLayerElement.replaceChildren(
          ...Array.from(nextTextLayer.childNodes),
        );
        renderedPageRef.current = {
          width: viewport.width,
          height: viewport.height,
        };
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
    };
  }, [
    onPageMetricsChange,
    onRenderError,
    pageNumber,
    pdfDocument,
    shouldRender,
    stageWidth,
    zoomPercent,
  ]);

  const shellWidth =
    renderedPage.width > 0 ? renderedPage.width * previewScale : pageWidth;
  const shellHeight =
    renderedPage.height > 0
      ? renderedPage.height * previewScale
      : estimatedHeight;

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
            width: renderedPage.width
              ? `${renderedPage.width}px`
              : `${pageWidth}px`,
            height: renderedPage.height
              ? `${renderedPage.height}px`
              : `${estimatedHeight}px`,
            transform:
              previewScale !== 1 ? `scale(${previewScale})` : undefined,
          }}
        >
          <canvas className="pdfjs-canvas" ref={canvasRef} />
          <div
            className="textLayer pdfjs-text-layer"
            ref={textLayerRef}
            onMouseUp={onSelectionCapture}
          />
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
  ensureAiReady,
  translationModel,
  ensureTranslationReady,
  isFocused = false,
  requestedPage,
  requestedAnchorText,
  requestedAnchorKey,
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
  const pageTranslationInFlightRef = useRef(false);
  const pageTranslationRequestTokenRef = useRef(0);
  const translationToastIdRef = useRef(0);
  const translationToastTimersRef = useRef<
    Map<number, { hide: number; remove: number }>
  >(new Map());
  const pageTextCacheRef = useRef<Map<string, string>>(new Map());
  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  const latestPrefetchTokenRef = useRef(0);
  const lastAnchorRequestKeyRef = useRef<string | null>(null);
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
  const [readerToolMode, setReaderToolMode] = useState<ReaderToolMode>(() =>
    readStoredToolMode(),
  );
  const [selection, setSelection] = useState<PdfSelectionState | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionOverlayRef = useRef<HTMLDivElement | null>(null);
  const [pageInputValue, setPageInputValue] = useState("1");
  const [outlineEntries, setOutlineEntries] = useState<PdfOutlineEntry[]>([]);
  const [isOutlineLoading, setIsOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const [pageAspectRatios, setPageAspectRatios] = useState<
    Record<number, number>
  >({});
  const [renderWindow, setRenderWindow] = useState({ start: 1, end: 3 });
  const [isToolbarAutoHidden, setIsToolbarAutoHidden] = useState(false);
  const [isPageTranslationRunning, setIsPageTranslationRunning] =
    useState(false);
  const [translationToasts, setTranslationToasts] = useState<
    TranslationToast[]
  >([]);
  const [pageTranslation, setPageTranslation] = useState<PageTranslationState>(
    EMPTY_PAGE_TRANSLATION_STATE,
  );

  useEffect(() => {
    onStatusRef.current = onStatus;
    onPageChangeRef.current = onPageChange;
  }, [onPageChange, onStatus]);

  const getCachedPageText = useCallback(
    async (pdfPath: string, page: number) => {
      const cacheKey = `${pdfPath}:${page}`;
      const cached = pageTextCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const extracted = await invoke<string>("extract_pdf_page_text", {
        path: pdfPath,
        page,
      });
      pageTextCacheRef.current.set(cacheKey, extracted);
      return extracted;
    },
    [],
  );

  const locateAnchorOnPage = useCallback(
    async (pageNumber: number, snippet: string) => {
      const stageElement = stageRef.current;
      const pageElement = pageRefs.current.get(pageNumber);
      if (!stageElement || !pageElement || !snippet.trim()) return false;

      const anchorNeedle = extractAnchorNeedle(snippet);
      if (!anchorNeedle) return false;

      const textLayer = pageElement.querySelector(
        ".pdfjs-text-layer",
      ) as HTMLDivElement | null;
      if (textLayer) {
        const spans = Array.from(textLayer.querySelectorAll("span")).filter(
          (span) => normalizeAnchorText(span.textContent || "").length > 0,
        );
        for (let index = 0; index < spans.length; index += 1) {
          let combined = "";
          for (
            let windowSize = 0;
            windowSize < 8 && index + windowSize < spans.length;
            windowSize += 1
          ) {
            combined =
              `${combined} ${normalizeAnchorText(spans[index + windowSize].textContent || "")}`.trim();
            if (
              combined.includes(anchorNeedle) ||
              anchorNeedle.includes(
                combined.slice(
                  0,
                  Math.min(combined.length, anchorNeedle.length),
                ),
              )
            ) {
              const target = spans[index] as HTMLElement;
              const top =
                pageElement.offsetTop +
                target.offsetTop -
                Math.max(48, stageElement.clientHeight * 0.18);
              stageElement.scrollTo({
                top: Math.max(0, top),
                behavior: "auto",
              });
              return true;
            }
          }
        }
      }

      try {
        const pageText = await getCachedPageText(activePdfPath, pageNumber);
        const segments = splitPageTextIntoSegments(pageText);
        const selectedIndex = findSelectionSegmentIndex(segments, snippet);
        if (selectedIndex === -1 || segments.length === 0) return false;
        const ratio = selectedIndex / Math.max(segments.length, 1);
        const top =
          pageElement.offsetTop +
          pageElement.clientHeight * ratio -
          Math.max(48, stageElement.clientHeight * 0.18);
        stageElement.scrollTo({
          top: Math.max(0, top),
          behavior: "auto",
        });
        return true;
      } catch {
        return false;
      }
    },
    [activePdfPath, getCachedPageText],
  );

  const handleSelectionTranslateResolved = useCallback(
    async (
      selectedText: string,
      page: number,
      payload: { model_used: string },
    ) => {
      const normalizedSelection = normalizeSelectedText(selectedText);
      if (!normalizedSelection || !activePdfPath) return;

      const prefetchToken = Date.now();
      latestPrefetchTokenRef.current = prefetchToken;

      try {
        const pageText = await getCachedPageText(activePdfPath, page);
        if (latestPrefetchTokenRef.current !== prefetchToken) return;

        const segments = splitPageTextIntoSegments(pageText);
        const selectedIndex = findSelectionSegmentIndex(
          segments,
          normalizedSelection,
        );
        if (selectedIndex === -1) return;

        const candidates = [selectedIndex - 1, selectedIndex + 1]
          .filter((index) => index >= 0 && index < segments.length)
          .map((index) => normalizeSelectedText(segments[index]))
          .filter(
            (text) =>
              text &&
              text !== normalizedSelection &&
              text.length <= MAX_TRANSLATE_SELECTION_CHARS,
          );

        for (const candidateText of candidates) {
          if (latestPrefetchTokenRef.current !== prefetchToken) return;
          const cacheKey = buildSelectionTranslationCacheKey(
            activePdfPath,
            page,
            candidateText,
          );
          if (sessionStorage.getItem(cacheKey)) continue;
          if (prefetchInFlightRef.current.has(cacheKey)) continue;

          prefetchInFlightRef.current.add(cacheKey);
          void invoke<{
            original_text: string;
            translated_text: string;
            page: number;
            generated_at: string;
            model_used: string;
          }>("translate_pdf_selection", {
            request: {
              text: candidateText,
              pdf_path: activePdfPath,
              page,
              model: payload.model_used || translationModel,
            },
          })
            .then((result) => {
              sessionStorage.setItem(cacheKey, JSON.stringify(result));
            })
            .catch(() => {
              // Silent prefetch: ignore background failures.
            })
            .finally(() => {
              prefetchInFlightRef.current.delete(cacheKey);
            });
        }
      } catch {
        // Silent prefetch: ignore background failures.
      }
    },
    [activePdfPath, getCachedPageText, translationModel],
  );

  useEffect(() => {
    localStorage.setItem(TOOL_MODE_STORAGE_KEY, readerToolMode);
  }, [readerToolMode]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    latestPrefetchTokenRef.current = Date.now();
    prefetchInFlightRef.current.clear();
    pageTextCacheRef.current.clear();
  }, [activePdfPath]);

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

  const clearTranslationToastTimers = useCallback((id?: number) => {
    const timerMap = translationToastTimersRef.current;
    if (typeof id === "number") {
      const timers = timerMap.get(id);
      if (timers) {
        window.clearTimeout(timers.hide);
        window.clearTimeout(timers.remove);
        timerMap.delete(id);
      }
      return;
    }

    timerMap.forEach((timers) => {
      window.clearTimeout(timers.hide);
      window.clearTimeout(timers.remove);
    });
    timerMap.clear();
  }, []);

  const pushTranslationToast = useCallback(
    (
      message: string,
      tone: TranslationToast["tone"],
      duration = tone === "error"
        ? TRANSLATION_ERROR_TOAST_MS
        : tone === "success"
          ? TRANSLATION_SUCCESS_TOAST_MS
          : TRANSLATION_INFO_TOAST_MS,
    ) => {
      const id = translationToastIdRef.current + 1;
      translationToastIdRef.current = id;

      setTranslationToasts((previous) => [
        ...previous,
        { id, message, tone, leaving: false },
      ]);

      const hide = window.setTimeout(() => {
        setTranslationToasts((previous) =>
          previous.map((toast) =>
            toast.id === id ? { ...toast, leaving: true } : toast,
          ),
        );
      }, duration);

      const remove = window.setTimeout(() => {
        clearTranslationToastTimers(id);
        setTranslationToasts((previous) =>
          previous.filter((toast) => toast.id !== id),
        );
      }, duration + TRANSLATION_TOAST_EXIT_MS);

      translationToastTimersRef.current.set(id, { hide, remove });
    },
    [clearTranslationToastTimers],
  );

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
    const restoredPage =
      Number.isFinite(nextPage) && nextPage > 0 ? nextPage : 1;
    initialPageRef.current = restoredPage;
    currentPageRef.current = restoredPage;
    setCurrentPage(restoredPage);
    setPageCount(0);
    setZoomPercent(100);
    setViewerMode("pdfjs");
    setViewerError(null);
    setSelection(null);
    setPageInputValue(String(restoredPage));
    setOutlineEntries([]);
    setIsOutlineLoading(false);
    setOutlineError(null);
    setIsOutlineOpen(false);
    setPageAspectRatios({});
    setRenderWindow({ start: 1, end: 3 });
    setIsToolbarAutoHidden(false);
    pageTranslationInFlightRef.current = false;
    pageTranslationRequestTokenRef.current += 1;
    setIsPageTranslationRunning(false);
    clearTranslationToastTimers();
    setTranslationToasts([]);
    setPageTranslation(EMPTY_PAGE_TRANSLATION_STATE);
    clearToolbarHideTimer();
    pageRefs.current.clear();
  }, [activePdfPath, clearToolbarHideTimer, clearTranslationToastTimers]);

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
        const objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
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
  useEffect(
    () => () => clearTranslationToastTimers(),
    [clearTranslationToastTimers],
  );

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
        const safePage = Math.min(
          Math.max(initialPageRef.current, 1),
          document.numPages,
        );
        currentPageRef.current = safePage;
        setCurrentPage(safePage);
        setRenderWindow({
          start: Math.max(1, safePage - PAGE_RENDER_OVERSCAN),
          end: Math.min(document.numPages, safePage + PAGE_RENDER_OVERSCAN),
        });
        setPageInputValue(String(safePage));
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

  const handlePageRefChange = useCallback(
    (pageNumber: number, node: HTMLDivElement | null) => {
      if (node) {
        pageRefs.current.set(pageNumber, node);
      } else {
        pageRefs.current.delete(pageNumber);
      }
    },
    [],
  );

  const handlePageMetricsChange = useCallback(
    (pageNumber: number, aspectRatio: number) => {
      setPageAspectRatios((previous) => {
        if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
          return previous;
        }
        if (Math.abs((previous[pageNumber] ?? 0) - aspectRatio) < 0.001) {
          return previous;
        }
        return { ...previous, [pageNumber]: aspectRatio };
      });
    },
    [],
  );

  const targetPageWidth = useMemo(
    () => Math.max(MIN_STAGE_WIDTH, stageWidth - 28) * (zoomPercent / 100),
    [stageWidth, zoomPercent],
  );
  const fallbackAspectRatio = useMemo(() => {
    const activeAspectRatio =
      pageAspectRatios[currentPageRef.current] ??
      pageAspectRatios[currentPage] ??
      pageAspectRatios[initialPageRef.current] ??
      pageAspectRatios[1];
    if (typeof activeAspectRatio === "number" && activeAspectRatio > 0) {
      return activeAspectRatio;
    }

    const firstKnownAspectRatio = Object.values(pageAspectRatios).find(
      (value) => Number.isFinite(value) && value > 0,
    );
    return firstKnownAspectRatio ?? DEFAULT_PAGE_ASPECT_RATIO;
  }, [currentPage, pageAspectRatios]);

  const captureViewportAnchor = useCallback(
    (anchorClientX?: number, anchorClientY?: number) => {
      const stageElement = stageRef.current;
      if (!stageElement) return;

      const stageRect = stageElement.getBoundingClientRect();
      const offsetX = clamp(
        (anchorClientX ?? stageRect.left + stageElement.clientWidth / 2) -
          stageRect.left,
        0,
        Math.max(stageElement.clientWidth, 1),
      );
      const offsetY = clamp(
        (anchorClientY ?? stageRect.top + stageElement.clientHeight / 2) -
          stageRect.top,
        0,
        Math.max(stageElement.clientHeight, 1),
      );
      const anchorX = stageRect.left + offsetX;
      const anchorY = stageRect.top + offsetY;

      let bestPageNumber = currentPageRef.current;
      let bestNode = pageRefs.current.get(bestPageNumber) ?? null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const [pageNumber, node] of pageRefs.current.entries()) {
        const rect = node.getBoundingClientRect();
        const containsPoint = anchorY >= rect.top && anchorY <= rect.bottom;
        if (containsPoint) {
          bestPageNumber = pageNumber;
          bestNode = node;
          bestDistance = 0;
          break;
        }

        const distance = Math.min(
          Math.abs(anchorY - rect.top),
          Math.abs(anchorY - rect.bottom),
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPageNumber = pageNumber;
          bestNode = node;
        }
      }

      if (!bestNode) return;

      const pageRect = bestNode.getBoundingClientRect();
      const scrollHeight = Math.max(
        stageElement.scrollHeight,
        stageElement.clientHeight,
        1,
      );
      const scrollWidth = Math.max(
        stageElement.scrollWidth,
        stageElement.clientWidth,
        1,
      );
      viewportAnchorRef.current = {
        pageNumber: bestPageNumber,
        offsetX,
        offsetY,
        pageRatioX: clamp(
          (anchorX - pageRect.left) / Math.max(pageRect.width, 1),
          0,
          1,
        ),
        pageRatioY: clamp(
          (anchorY - pageRect.top) / Math.max(pageRect.height, 1),
          0,
          1,
        ),
        fallbackTopRatio: (stageElement.scrollTop + offsetY) / scrollHeight,
        fallbackLeftRatio: (stageElement.scrollLeft + offsetX) / scrollWidth,
      };
    },
    [],
  );

  useEffect(() => {
    const stageElement = stageRef.current;
    if (!stageElement) return;

    const updateWidth = () => {
      const nextWidth = Math.max(
        MIN_STAGE_WIDTH,
        Math.floor(stageElement.clientWidth || MIN_STAGE_WIDTH),
      );
      setStageWidth((previous) => {
        if (previous === nextWidth) return previous;
        captureViewportAnchor();
        return nextWidth;
      });
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stageElement);
    return () => observer.disconnect();
  }, [activePdfPath, captureViewportAnchor, pageCount, viewerMode]);

  const normalizePageNumber = useCallback(
    (pageNumber: number) => {
      if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return 1;
      }
      const normalized = Math.round(pageNumber);
      return pageCount > 0 ? clamp(normalized, 1, pageCount) : normalized;
    },
    [pageCount],
  );

  const commitPageState = useCallback(
    (pageNumber: number) => {
      const safePage = normalizePageNumber(pageNumber);
      currentPageRef.current = safePage;
      setCurrentPage(safePage);
      localStorage.setItem(storageKey(activePdfPath), String(safePage));
      onPageChangeRef.current?.(safePage);
      return safePage;
    },
    [activePdfPath, normalizePageNumber],
  );

  const updateCurrentPageFromScroll = useCallback(() => {
    const stageElement = stageRef.current;
    if (!stageElement || pageRefs.current.size === 0) return;

    const stageRect = stageElement.getBoundingClientRect();
    let bestPage = currentPageRef.current;
    let bestRatio = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [pageNumber, node] of pageRefs.current.entries()) {
      const rect = node.getBoundingClientRect();
      const overlap = Math.max(
        0,
        Math.min(rect.bottom, stageRect.bottom) -
          Math.max(rect.top, stageRect.top),
      );
      const visibleRatio = overlap / Math.max(rect.height, 1);
      const distance = Math.abs(rect.top - stageRect.top);
      if (
        visibleRatio > bestRatio ||
        (Math.abs(visibleRatio - bestRatio) < 0.001 && distance < bestDistance)
      ) {
        bestRatio = visibleRatio;
        bestDistance = distance;
        bestPage = pageNumber;
      }
    }

    if (bestPage !== currentPageRef.current) {
      commitPageState(bestPage);
    }
  }, [commitPageState]);

  const updateRenderWindow = useCallback(() => {
    const stageElement = stageRef.current;
    if (!stageElement || pageCount <= 0) {
      return;
    }

    const buffer = Math.max(
      stageElement.clientHeight * PAGE_RENDER_BUFFER_MULTIPLIER,
      1200,
    );
    const thresholdTop = Math.max(0, stageElement.scrollTop - buffer);
    const thresholdBottom =
      stageElement.scrollTop + stageElement.clientHeight + buffer;

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
    const nextStart = Math.max(
      1,
      (firstVisiblePage ?? fallbackPage) - PAGE_RENDER_OVERSCAN,
    );
    const nextEnd = Math.min(
      pageCount,
      (lastVisiblePage ?? fallbackPage) + PAGE_RENDER_OVERSCAN,
    );

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
        const nextEnd = Math.min(
          pageCount || safePage,
          safePage + PAGE_RENDER_OVERSCAN,
        );
        if (previous.start === nextStart && previous.end === nextEnd) {
          return previous;
        }
        return { start: nextStart, end: nextEnd };
      });

      stageElement.scrollTo({
        top: Math.max(0, pageNode.offsetTop - 16),
        behavior,
      });
      return true;
    },
    [commitPageState, pageCount],
  );

  const goToPage = useCallback(
    (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
      if (viewerMode === "pdfjs") {
        scrollToPage(pageNumber, behavior);
        return;
      }
      commitPageState(pageNumber);
    },
    [commitPageState, scrollToPage, viewerMode],
  );

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !stageRef.current) return;

    const stageElement = stageRef.current;
    let ticking = false;

    const clearSelectionForNavigation = () => {
      window.getSelection()?.removeAllRanges();
      setSelection((previous) =>
        previous && previous.overlay !== "button" ? previous : null,
      );
    };

    const handleScroll = () => {
      clearSelectionForNavigation();
      revealToolbar();
      scheduleToolbarAutoHide();
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
  }, [
    activePdfPath,
    revealToolbar,
    scheduleToolbarAutoHide,
    updateCurrentPageFromScroll,
    updateRenderWindow,
    viewerMode,
  ]);

  useEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs") return;
    const targetPage = Math.min(
      Math.max(initialPageRef.current, 1),
      pageCount || 1,
    );
    const timer = window.setTimeout(() => {
      scrollToPage(targetPage, "auto");
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pageCount, pdfDocument, scrollToPage, viewerMode]);

  useEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs") {
      setOutlineEntries([]);
      setIsOutlineLoading(false);
      setOutlineError(null);
      return;
    }

    let cancelled = false;
    setIsOutlineLoading(true);
    setOutlineError(null);

    void pdfDocument
      .getOutline()
      .then(async (outline) => {
        if (cancelled) return;
        if (!outline?.length) {
          setOutlineEntries([]);
          return;
        }
        const nextEntries = await flattenOutlineEntries(
          pdfDocument,
          outline as PdfOutlineItem[],
        );
        if (cancelled) return;
        setOutlineEntries(nextEntries);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOutlineEntries([]);
        setOutlineError(`目录读取失败：${String(error)}`);
      })
      .finally(() => {
        if (cancelled) return;
        setIsOutlineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pdfDocument, viewerMode]);

  useLayoutEffect(() => {
    if (viewerMode !== "pdfjs" || pageCount <= 0) return;
    const frameId = window.requestAnimationFrame(updateRenderWindow);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    activePdfPath,
    pageCount,
    stageWidth,
    updateRenderWindow,
    viewerMode,
    zoomPercent,
  ]);

  useEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs" || pageCount <= 0) return;
    if (viewportAnchorRef.current) return;
    const targetPage = clamp(currentPageRef.current, 1, pageCount);
    const timer = window.setTimeout(() => {
      scrollToPage(targetPage, "auto");
    }, 90);
    return () => window.clearTimeout(timer);
  }, [isFocused, pageCount, pdfDocument, scrollToPage, viewerMode]);

  useLayoutEffect(() => {
    if (!pdfDocument || viewerMode !== "pdfjs" || !viewportAnchorRef.current)
      return;

    const stageElement = stageRef.current;
    const anchor = viewportAnchorRef.current;
    if (!stageElement || !anchor) return;

    const pageNode = pageRefs.current.get(anchor.pageNumber);
    const nextTop = pageNode
      ? clamp(
          pageNode.offsetTop +
            pageNode.offsetHeight * anchor.pageRatioY -
            anchor.offsetY,
          0,
          Math.max(0, stageElement.scrollHeight - stageElement.clientHeight),
        )
      : clamp(
          anchor.fallbackTopRatio * stageElement.scrollHeight - anchor.offsetY,
          0,
          Math.max(0, stageElement.scrollHeight - stageElement.clientHeight),
        );
    const nextLeft = pageNode
      ? clamp(
          pageNode.offsetLeft +
            pageNode.offsetWidth * anchor.pageRatioX -
            anchor.offsetX,
          0,
          Math.max(0, stageElement.scrollWidth - stageElement.clientWidth),
        )
      : clamp(
          anchor.fallbackLeftRatio * stageElement.scrollWidth - anchor.offsetX,
          0,
          Math.max(0, stageElement.scrollWidth - stageElement.clientWidth),
        );

    stageElement.scrollTo({ top: nextTop, left: nextLeft, behavior: "auto" });
    viewportAnchorRef.current = null;
    updateCurrentPageFromScroll();
  }, [
    pageCount,
    pdfDocument,
    stageWidth,
    updateCurrentPageFromScroll,
    viewerMode,
    zoomPercent,
  ]);

  useEffect(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [isFocused]);

  useEffect(() => {
    if (isPageInputFocusedRef.current) return;
    setPageInputValue(String(Math.max(1, currentPage)));
  }, [currentPage]);

  useEffect(() => {
    if (!requestedPage || requestedPage <= 0) return;
    if (requestedPage === currentPageRef.current) return;

    if (viewerMode === "pdfjs") {
      if (!pdfDocument || pageCount <= 0) return;
      const safePage = clamp(requestedPage, 1, pageCount);
      const timer = window.setTimeout(() => {
        scrollToPage(safePage, "auto");
      }, 60);
      return () => window.clearTimeout(timer);
    }

    commitPageState(requestedPage);
  }, [
    commitPageState,
    pageCount,
    pdfDocument,
    requestedPage,
    scrollToPage,
    viewerMode,
  ]);

  useEffect(() => {
    if (!requestedAnchorKey || !requestedAnchorText?.trim()) return;
    if (lastAnchorRequestKeyRef.current === requestedAnchorKey) return;
    if (viewerMode !== "pdfjs" || !pdfDocument || pageCount <= 0) return;
    const safePage = clamp(
      requestedPage || currentPageRef.current || 1,
      1,
      pageCount,
    );
    lastAnchorRequestKeyRef.current = requestedAnchorKey;
    const timer = window.setTimeout(() => {
      void locateAnchorOnPage(safePage, requestedAnchorText);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    locateAnchorOnPage,
    pageCount,
    pdfDocument,
    requestedAnchorKey,
    requestedAnchorText,
    requestedPage,
    viewerMode,
  ]);

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
      if (
        !browserSelection ||
        browserSelection.rangeCount === 0 ||
        browserSelection.isCollapsed
      ) {
        setSelection((previous) =>
          previous && previous.overlay !== "button" ? previous : null,
        );
        return;
      }

      const anchorNode = browserSelection.anchorNode;
      const focusNode = browserSelection.focusNode;
      if (!anchorNode || !focusNode) return;

      const pageNumber =
        resolvePageFromNode(anchorNode) ??
        resolvePageFromNode(focusNode) ??
        currentPageRef.current;
      const pageElement = pageRefs.current.get(pageNumber);
      if (
        !pageElement ||
        !pageElement.contains(anchorNode) ||
        !pageElement.contains(focusNode)
      )
        return;

      const text = normalizeSelectedText(browserSelection.toString());
      if (!text) {
        setSelection(null);
        return;
      }

      if (
        readerToolMode === "translate" &&
        text.length > MAX_TRANSLATE_SELECTION_CHARS
      ) {
        setSelection(null);
        onStatusRef.current("选中文本过长，请使用“整页翻译”。", "info", false);
        return;
      }

      const range = browserSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }

      const popoverWidth = Math.min(
        POPOVER_ESTIMATED_WIDTH,
        window.innerWidth - VIEWPORT_MARGIN_X * 2,
      );
      const selectionCenterX = rect.left + rect.width / 2;
      const preferredPopoverLeft = selectionCenterX - popoverWidth / 2;
      const popoverLeft = clamp(
        preferredPopoverLeft,
        VIEWPORT_MARGIN_X,
        window.innerWidth - popoverWidth - VIEWPORT_MARGIN_X,
      );
      const canOpenBelow =
        rect.bottom + POPOVER_ANCHOR_GAP + POPOVER_ESTIMATED_HEIGHT <=
        window.innerHeight - VIEWPORT_MARGIN_X;
      const canOpenAbove =
        rect.top - POPOVER_ANCHOR_GAP - POPOVER_ESTIMATED_HEIGHT >=
        VIEWPORT_MARGIN_TOP;
      const popoverTop = canOpenBelow
        ? rect.bottom + POPOVER_ANCHOR_GAP
        : canOpenAbove
          ? rect.top - POPOVER_ESTIMATED_HEIGHT - POPOVER_ANCHOR_GAP
          : clamp(
              rect.bottom + 10,
              VIEWPORT_MARGIN_TOP,
              window.innerHeight - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_MARGIN_X,
            );
      const targetLeft = clamp(
        selectionCenterX - FLOATING_BUTTON_WIDTH / 2,
        VIEWPORT_MARGIN_X,
        window.innerWidth - FLOATING_BUTTON_WIDTH - VIEWPORT_MARGIN_X,
      );
      const targetTop = canOpenBelow
        ? clamp(
            rect.bottom + 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          )
        : clamp(
            rect.top - FLOATING_BUTTON_HEIGHT - 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          );

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

  const handlePdfContextMenu = (event: React.MouseEvent) => {
    if (viewerMode !== "pdfjs") return;

    const browserSelection = window.getSelection();
    const text = normalizeSelectedText(browserSelection?.toString() ?? "");
    if (!text) return;

    event.preventDefault();

    if (!selection || selection.text !== text) {
      handleSelectionCapture();
    }

    const overlayRect = selectionOverlayRef.current?.getBoundingClientRect();
    const baseLeft = overlayRect?.left ?? 0;
    const baseTop = overlayRect?.top ?? 0;
    const overlayWidth = overlayRect?.width ?? window.innerWidth;
    const overlayHeight = overlayRect?.height ?? window.innerHeight;

    const menuWidth = 140;
    const menuHeight = 120;
    const padding = 8;

    const left = clamp(
      event.clientX - baseLeft,
      padding,
      Math.max(padding, overlayWidth - menuWidth - padding),
    );
    const top = clamp(
      event.clientY - baseTop,
      padding,
      Math.max(padding, overlayHeight - menuHeight - padding),
    );
    setContextMenu({ x: left, y: top });
  };

  const handleContextExplain = () => {
    if (!selection) return;
    setSelection((previous) =>
      previous ? { ...previous, overlay: "explain" } : previous,
    );
    setContextMenu(null);
  };
  const handleContextTranslate = () => {
    if (!selection) return;
    if (selection.text.length > MAX_TRANSLATE_SELECTION_CHARS) {
      onStatusRef.current("选中文本过长，请使用“整页翻译”。", "info", false);
      return;
    }
    setSelection((previous) =>
      previous ? { ...previous, overlay: "translate" } : previous,
    );
    setContextMenu(null);
  };

  const handleContextCopy = async () => {
    if (!selection?.text) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      onStatusRef.current("已复制选中文本。", "info", false);
    } catch {
      onStatusRef.current("复制失败，请手动复制。", "error", false);
    }
    setContextMenu(null);
  };

  const handleOpenExplainPopover = () => {
    setSelection((previous) =>
      previous ? { ...previous, overlay: "explain" } : previous,
    );
  };

  const handleClosePopover = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  useEffect(() => {
    if (!selection) {
      setContextMenu(null);
    }
  }, [selection]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const handleScroll = () => setContextMenu(null);

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, []);

  const handleClosePageTranslation = useCallback(() => {
    setPageTranslation(EMPTY_PAGE_TRANSLATION_STATE);
  }, []);

  const handleTranslateCurrentPage = useCallback(async () => {
    if (viewerMode !== "pdfjs") return;
    const model = ensureTranslationReady
      ? await ensureTranslationReady()
      : translationModel;
    if (!model) {
      onStatusRef.current(
        "当前没有可用模型，暂时无法执行整页翻译。",
        "error",
        true,
      );
      return;
    }

    pageTranslationInFlightRef.current = true;
    setIsPageTranslationRunning(true);
    const requestToken = pageTranslationRequestTokenRef.current + 1;
    pageTranslationRequestTokenRef.current = requestToken;

    try {
      const model = ensureAiReady ? await ensureAiReady() : currentModel;
      if (pageTranslationRequestTokenRef.current !== requestToken) return;
      if (!model) {
        pushTranslationToast(
          "当前没有可用模型，暂时无法执行整页翻译。",
          "error",
        );
        return;
      }

      const page = normalizePageNumber(currentPageRef.current);
      const cacheKey = buildPageTranslationCacheKey(activePdfPath, page, model);
      const cached = sessionStorage.getItem(cacheKey);

      setSelection(null);
      window.getSelection()?.removeAllRanges();

      if (cached) {
        try {
          const parsed = JSON.parse(cached) as TranslatePdfPageResult;
          if (pageTranslationRequestTokenRef.current !== requestToken) return;
          setPageTranslation({
            open: true,
            phase: "success",
            result: parsed,
            error: null,
            requestedPage: page,
          });
          pushTranslationToast(`已显示第 ${page} 页译文。`, "success", 2000);
          return;
        } catch {
          sessionStorage.removeItem(cacheKey);
        }
      }

      setPageTranslation({
        open: true,
        phase: "loading",
        result: null,
        error: null,
        requestedPage: page,
      });
      pushTranslationToast(`正在翻译第 ${page} 页...`, "info");

      const result = await invoke<TranslatePdfPageResult>(
        "translate_pdf_page",
        {
          request: {
            pdf_path: activePdfPath,
            page,
            model,
          },
        },
      );
      if (pageTranslationRequestTokenRef.current !== requestToken) return;

      sessionStorage.setItem(cacheKey, JSON.stringify(result));
      setPageTranslation({
        open: true,
        phase: "success",
        result,
        error: null,
        requestedPage: page,
      });
      if (result.source_text_length === 0) {
        pushTranslationToast("当前页没有可翻译文本，OCR 后可重试。", "error");
      } else {
        pushTranslationToast(`第 ${page} 页翻译完成。`, "success");
      }
    } catch (error) {
      if (pageTranslationRequestTokenRef.current !== requestToken) return;
      const message = String(error);
      setPageTranslation({
        open: true,
        phase: "error",
        result: null,
        error: message,
        requestedPage: normalizePageNumber(currentPageRef.current),
      });
      pushTranslationToast(`整页翻译失败：${message}`, "error");
    } finally {
      if (pageTranslationRequestTokenRef.current === requestToken) {
        pageTranslationInFlightRef.current = false;
        setIsPageTranslationRunning(false);
      }
    }
  }, [
    activePdfPath,
    ensureTranslationReady,
    normalizePageNumber,
    translationModel,
    viewerMode,
  ]);

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

  const handlePageInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
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

  const handleToolbarBlurCapture = (
    event: React.FocusEvent<HTMLDivElement>,
  ) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    scheduleToolbarAutoHide(260);
  };

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !stageRef.current) return;

    const stageElement = stageRef.current;
    const isStageEvent = (target: EventTarget | null) =>
      target instanceof Node ? stageElement.contains(target) : false;

    const clearSelectionForZoom = () => {
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    };

    const handleWheelZoom = (event: WheelEvent) => {
      if (!isStageEvent(event.target) && !stageElement.matches(":hover"))
        return;

      const nativeWheelEvent = event as WheelEvent & { deltaZ?: number };
      const isPinchLike =
        event.ctrlKey ||
        event.metaKey ||
        (typeof nativeWheelEvent.deltaZ === "number" &&
          nativeWheelEvent.deltaZ !== 0);
      if (!isPinchLike) return;
      event.preventDefault();

      const nextDelta = clamp(
        -event.deltaY * TRACKPAD_ZOOM_SENSITIVITY,
        -18,
        18,
      );
      if (Math.abs(nextDelta) < 0.25) return;

      clearSelectionForZoom();
      captureViewportAnchor(event.clientX, event.clientY);
      setZoomPercent((previous) =>
        clamp(Math.round(previous + nextDelta), MIN_ZOOM, MAX_ZOOM),
      );
    };

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as Event & {
        scale?: number;
        preventDefault: () => void;
      };
      if (!isStageEvent(gestureEvent.target) && !stageElement.matches(":hover"))
        return;
      gestureEvent.preventDefault();
      clearSelectionForZoom();
      captureViewportAnchor(
        "clientX" in gestureEvent && typeof gestureEvent.clientX === "number"
          ? gestureEvent.clientX
          : undefined,
        "clientY" in gestureEvent && typeof gestureEvent.clientY === "number"
          ? gestureEvent.clientY
          : undefined,
      );
      gestureZoomStartRef.current = zoomPercentRef.current;
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as Event & {
        scale?: number;
        preventDefault: () => void;
      };
      if (!isStageEvent(gestureEvent.target) && !stageElement.matches(":hover"))
        return;
      if (
        gestureZoomStartRef.current == null ||
        typeof gestureEvent.scale !== "number"
      )
        return;
      gestureEvent.preventDefault();
      clearSelectionForZoom();
      setZoomPercent(
        clamp(
          Math.round(gestureZoomStartRef.current * gestureEvent.scale),
          MIN_ZOOM,
          MAX_ZOOM,
        ),
      );
    };

    const handleGestureEnd = () => {
      gestureZoomStartRef.current = null;
    };

    window.addEventListener("wheel", handleWheelZoom, {
      passive: false,
      capture: true,
    });
    window.addEventListener(
      "gesturestart",
      handleGestureStart as EventListener,
      { passive: false, capture: true },
    );
    window.addEventListener(
      "gesturechange",
      handleGestureChange as EventListener,
      { passive: false, capture: true },
    );
    window.addEventListener("gestureend", handleGestureEnd as EventListener, {
      capture: true,
    });

    return () => {
      window.removeEventListener("wheel", handleWheelZoom, true);
      window.removeEventListener(
        "gesturestart",
        handleGestureStart as EventListener,
        true,
      );
      window.removeEventListener(
        "gesturechange",
        handleGestureChange as EventListener,
        true,
      );
      window.removeEventListener(
        "gestureend",
        handleGestureEnd as EventListener,
        true,
      );
    };
  }, [captureViewportAnchor, viewerMode]);

  const handlePageInputKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
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

  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );
  const subtitleText =
    readerToolMode === "translate"
      ? "翻译模式下，选中文本会直接弹出译文；较长内容请使用“整页翻译”。"
      : "解释模式下，选中术语后点击“解释”即可生成说明与知识卡片。";
  const translatedPageNumber =
    pageTranslation.result?.page ?? pageTranslation.requestedPage;

  return (
    <div className="pdf-reader-shell">
      {translationToasts.length > 0 && (
        <div className="pdf-translation-toast-stack" aria-live="polite">
          {translationToasts.map((toast) => (
            <div
              key={toast.id}
              className={`pdf-translation-toast ${toast.tone} ${toast.leaving ? "leaving" : ""}`}
              role="status"
            >
              <div className="pdf-translation-toast-icon" aria-hidden="true">
                {toast.tone === "success" ? (
                  <CheckCircle2 size={16} />
                ) : toast.tone === "error" ? (
                  <AlertTriangle size={16} />
                ) : (
                  <LoaderCircle size={16} className="spin" />
                )}
              </div>
              <div className="pdf-translation-toast-text">{toast.message}</div>
            </div>
          ))}
        </div>
      )}

      <div className="pdf-viewer-frame">
        {!isToolbarCollapsed ? (
          <div
            className="pdf-toolbar-reveal-zone"
            onMouseEnter={handleToolbarMouseEnter}
            aria-hidden="true"
          />
        ) : null}

        <div
          className={`pdf-reader-toolbar-shell ${isToolbarCollapsed ? "collapsed" : ""} ${isToolbarAutoHidden ? "auto-hidden" : ""}`}
        >
          <div
            className="pdf-reader-toolbar"
            role="toolbar"
            aria-label="PDF 工具栏"
            onMouseEnter={handleToolbarMouseEnter}
            onMouseLeave={handleToolbarMouseLeave}
            onFocusCapture={handleToolbarFocusCapture}
            onBlurCapture={handleToolbarBlurCapture}
          >
            <div className="pdf-reader-toolbar-scroll">
              <div className="pdf-reader-toolbar-inner">
                <div className="pdf-toolbar-group">
                  <button
                    className={`action-button pdf-toolbar-icon-button ${isOutlineOpen ? "primary" : ""}`}
                    onClick={() => setIsOutlineOpen((previous) => !previous)}
                    disabled={viewerMode !== "pdfjs"}
                    aria-label={isOutlineOpen ? "收起目录" : "打开目录"}
                    aria-expanded={isOutlineOpen}
                    aria-controls="pdf-outline-drawer"
                    title={isOutlineOpen ? "收起目录" : "打开目录"}
                  >
                    <List size={14} />
                  </button>
                </div>

                <div className="pdf-toolbar-group pdf-page-jump-group">
                  <input
                    className="pdf-page-input"
                    inputMode="numeric"
                    value={pageInputValue}
                    onChange={handlePageInputChange}
                    onFocus={handlePageInputFocus}
                    onBlur={handlePageInputBlur}
                    onKeyDown={handlePageInputKeyDown}
                    aria-label="璺宠浆椤电爜"
                  />
                  <span className="pdf-toolbar-text">/ {pageCount || "-"}</span>
                </div>

                <div className="pdf-toolbar-group">
                  <button
                    className="action-button pdf-toolbar-icon-button"
                    onClick={zoomOut}
                    disabled={viewerMode !== "pdfjs" || zoomPercent <= MIN_ZOOM}
                    aria-label="缂╁皬 PDF"
                    title="缂╁皬"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <span className="pdf-toolbar-pill">{zoomPercent}%</span>
                  <button
                    className="action-button pdf-toolbar-icon-button"
                    onClick={zoomIn}
                    disabled={viewerMode !== "pdfjs" || zoomPercent >= MAX_ZOOM}
                    aria-label="放大 PDF"
                    title="放大"
                  >
                    <ZoomIn size={14} />
                  </button>
                </div>

                <label className="pdf-mode-control">
                  <select
                    value={lookupMode}
                    onChange={(event) =>
                      onLookupModeChange(event.target.value as LookupMode)
                    }
                    aria-label="选择术语解释来源"
                  >
                    {LOOKUP_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="pdf-toolbar-group" role="group">
                  <button
                    type="button"
                    className={`action-button ${readerToolMode === "translate" ? "primary" : ""}`}
                    onClick={() =>
                      setReaderToolMode((prev) =>
                        prev === "translate" ? "explain" : "translate",
                      )
                    }
                    disabled={viewerMode !== "pdfjs"}
                    title="选中文本后直接打开翻译"
                  >
                    翻译模式
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    onClick={() => void handleTranslateCurrentPage()}
                    disabled={
                      viewerMode !== "pdfjs" ||
                      isLoading ||
                      isPageTranslationRunning
                    }
                    title={subtitleText}
                  >
                    整页翻译
                  </button>
                </div>

                {toolbarActions ? (
                  <div className="pdf-toolbar-group pdf-toolbar-group-end">
                    {toolbarActions}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <button
          className={`pdf-outline-backdrop ${isOutlineOpen ? "visible" : ""}`}
          onClick={() => setIsOutlineOpen(false)}
          aria-label="关闭目录抽屉"
          tabIndex={isOutlineOpen ? 0 : -1}
        />
        <aside
          id="pdf-outline-drawer"
          className={`pdf-outline-drawer ${isOutlineOpen ? "open" : ""}`}
          aria-hidden={!isOutlineOpen}
        >
          <div className="pdf-outline-header">
            <div>
              <div className="pdf-outline-title">目录</div>
              <div className="pdf-outline-subtitle">璺宠浆鍒板搴旈〉</div>
            </div>
            <button
              className="ghost-icon-button"
              onClick={() => setIsOutlineOpen(false)}
              aria-label="关闭目录"
            >
              脳
            </button>
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
              <div className="pdf-outline-state pdf-outline-state-error">
                {outlineError}
              </div>
            ) : outlineEntries.length === 0 ? (
              <div className="pdf-outline-state">这个 PDF 没有可用目录。</div>
            ) : (
              <div
                className="pdf-outline-list"
                role="tree"
                aria-label="PDF 目录"
              >
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
                      {entry.hasChildren ? (
                        <span className="pdf-outline-branch-indicator">·</span>
                      ) : null}
                    </span>
                    <span className="pdf-outline-item-page">
                      {entry.pageNumber ? `P${entry.pageNumber}` : "无页码"}
                    </span>
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
          <div
            className="pdfjs-stage"
            ref={stageRef}
            onContextMenu={handlePdfContextMenu}
          >
            <div className="pdfjs-pages">
              {pageNumbers.map((pageNumber) => (
                <PdfPageCanvas
                  key={`${activePdfPath}:${pageNumber}`}
                  pageNumber={pageNumber}
                  pdfDocument={pdfDocument as PDFDocumentProxy}
                  stageWidth={stageWidth}
                  zoomPercent={zoomPercent}
                  pageWidth={targetPageWidth}
                  estimatedHeight={
                    targetPageWidth *
                    (pageAspectRatios[pageNumber] ?? fallbackAspectRatio)
                  }
                  shouldRender={
                    pageNumber >= renderWindow.start &&
                    pageNumber <= renderWindow.end
                  }
                  onSelectionCapture={handleSelectionCapture}
                  onPageRefChange={handlePageRefChange}
                  onPageMetricsChange={handlePageMetricsChange}
                  onRenderError={handlePdfRenderError}
                />
              ))}
            </div>

            {pageTranslation.open && (
              <aside className="pdf-page-translation-panel">
                <div className="pdf-page-translation-header">
                  <div>
                    <div className="pdf-page-translation-title">当前页译文</div>
                    <div className="pdf-page-translation-meta">
                      当前显示的是第 {translatedPageNumber ?? currentPage}{" "}
                      椤佃瘧鏂?
                    </div>
                  </div>
                  <button
                    className="ghost-icon-button"
                    onClick={handleClosePageTranslation}
                    aria-label="关闭译文面板"
                  >
                    <X size={14} />
                  </button>
                </div>

                {pageTranslation.phase === "loading" && (
                  <div className="pdf-page-translation-state">
                    <LoaderCircle size={16} className="spin" />
                    <span>
                      正在翻译第 {pageTranslation.requestedPage ?? currentPage}{" "}
                      椤?..
                    </span>
                  </div>
                )}

                {pageTranslation.phase === "error" && (
                  <div className="term-popover-error">
                    {pageTranslation.error}
                  </div>
                )}

                {pageTranslation.phase === "success" &&
                  pageTranslation.result && (
                    <div className="pdf-page-translation-content">
                      <MarkdownRenderer
                        content={pageTranslation.result.translated_markdown}
                      />
                      <div className="term-popover-subtitle">
                        翻译模型：{pageTranslation.result.model_used}
                      </div>
                    </div>
                  )}
              </aside>
            )}
          </div>
        )}

        {viewerMode === "compat" &&
          !isLoading &&
          (pdfObjectUrl ? (
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
          ))}

        {viewerMode === "pdfjs" && (
          <div className="pdf-selection-overlay" ref={selectionOverlayRef}>
            {contextMenu && selection && (
              <div
                ref={contextMenuRef}
                className="pdf-selection-context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onMouseDown={(event) => event.preventDefault()}
              >
                <button type="button" onClick={handleContextCopy}>
                  复制
                </button>
                <button type="button" onClick={handleContextExplain}>
                  解释
                </button>
                <button type="button" onClick={handleContextTranslate}>
                  翻译
                </button>
              </div>
            )}

            {selection && selection.overlay === "explain" && (
              <TermExplainPopover
                selectedText={selection.text}
                pdfPath={activePdfPath}
                page={selection.page}
                currentModel={currentModel}
                ensureAiReady={ensureAiReady}
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
                translationModel={translationModel}
                ensureTranslationReady={ensureTranslationReady}
                onTranslateSuccess={handleSelectionTranslateResolved}
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
