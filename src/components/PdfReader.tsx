import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Languages,
  List,
  LoaderCircle,
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
type SelectionOverlayMode = "preview" | "button" | "explain" | "translate";

interface PdfSelectionHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PdfSelectionHighlightGroup {
  page: number;
  rects: PdfSelectionHighlightRect[];
}

interface PdfAnnotationColorOption {
  key: string;
  label: string;
  value: string;
}

interface PdfAnnotationRectRatio {
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
}

interface PdfAnnotationHighlightGroup {
  page: number;
  rects: PdfAnnotationRectRatio[];
}

interface PdfHighlightAnnotation {
  id: string;
  type: "highlight";
  text: string;
  color: string;
  note: string;
  groups: PdfAnnotationHighlightGroup[];
  createdAt: string;
  updatedAt: string;
}

interface PdfPageAnnotationRenderGroup {
  annotationId: string;
  color: string;
  note: string;
  rects: PdfAnnotationRectRatio[];
  showNoteBadge: boolean;
}

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
  startPage: number;
  endPage: number;
  targetLeft: number;
  targetTop: number;
  popoverLeft: number;
  popoverTop: number;
  highlightGroups: PdfSelectionHighlightGroup[];
  overlay: SelectionOverlayMode;
}

interface AnnotationEditorState {
  mode: "create" | "edit";
  annotationId: string | null;
  left: number;
  top: number;
  color: string;
  note: string;
}

type PdfContextMenuState =
  | {
      x: number;
      y: number;
      mode: "selection";
    }
  | {
      x: number;
      y: number;
      mode: "annotation";
      annotationId: string;
    };

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

interface SelectionPointerState {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
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
  annotations: PdfPageAnnotationRenderGroup[];
  onSelectionStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSelectionCapture: (event?: React.MouseEvent<HTMLDivElement>) => void;
  onAnnotationNoteClick: (annotationId: string, anchorRect: DOMRect) => void;
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
const MAX_TRANSLATE_SELECTION_CHARS = 2400;
const MAX_EXPLAIN_SELECTION_CHARS = 120;
const PDF_SELECTION_MODE_KEY = "ra_pdf_selection_mode_v1";
const TRANSLATION_TOAST_EXIT_MS = 240;
const TRANSLATION_INFO_TOAST_MS = 1800;
const TRANSLATION_SUCCESS_TOAST_MS = 2400;
const TRANSLATION_ERROR_TOAST_MS = 3400;
const PDF_ANNOTATION_STORAGE_PREFIX = "ra_pdf_annotations_v1:";
const PDF_ANNOTATION_EDITOR_WIDTH = 300;
const PDF_ANNOTATION_EDITOR_HEIGHT = 236;
const PDF_ANNOTATION_COLORS: PdfAnnotationColorOption[] = [
  { key: "yellow", label: "黄色", value: "#ffd400" },
  { key: "red", label: "红色", value: "#ff6666" },
  { key: "green", label: "绿色", value: "#5fb236" },
  { key: "blue", label: "蓝色", value: "#2ea8e5" },
  { key: "purple", label: "紫色", value: "#a28ae5" },
  { key: "magenta", label: "洋红", value: "#e56eee" },
  { key: "orange", label: "橙色", value: "#f19837" },
  { key: "gray", label: "灰色", value: "#aaaaaa" },
];

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
const buildAnnotationStorageKey = (path: string) =>
  `${PDF_ANNOTATION_STORAGE_PREFIX}${path}`;
const buildPageTranslationCacheKey = (
  pdfPath: string,
  page: number,
  model: string,
) => `ra_pdf_translate_page_v2:${pdfPath}:${page}:${model}`;
type SelectionClientRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
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
const createPdfAnnotationId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `pdf-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const resolveSelectionTargetElement = (target: EventTarget | null) => {
  const candidate =
    target instanceof Text
      ? target.parentElement
      : target instanceof HTMLElement
        ? target
        : null;
  if (!candidate) {
    return null;
  }

  const textSpan = candidate.closest(".pdfjs-text-layer span");
  if (
    !textSpan ||
    textSpan.classList.contains("markedContent") ||
    !textSpan.textContent?.trim()
  ) {
    return null;
  }
  return textSpan;
};
const getSelectionRectCenterY = (rect: SelectionClientRect) =>
  rect.top + (rect.bottom - rect.top) / 2;
const getSelectionRectHeight = (rect: SelectionClientRect) =>
  rect.bottom - rect.top;
const getDistanceToRect = (x: number, y: number, rect: DOMRect) => {
  const dx =
    x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy =
    y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.hypot(dx, dy);
};
const getSelectionClientRects = (range: Range) =>
  Array.from(range.getClientRects())
    .filter((rect) => rect.width >= 1 && rect.height >= 1)
    .map(
      (rect): SelectionClientRect => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }),
    )
    .sort((leftRect, rightRect) =>
      leftRect.top === rightRect.top
        ? leftRect.left - rightRect.left
        : leftRect.top - rightRect.top,
    );
const isPdfAnnotationRectRatio = (
  value: unknown,
): value is PdfAnnotationRectRatio =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PdfAnnotationRectRatio).leftRatio === "number" &&
  typeof (value as PdfAnnotationRectRatio).topRatio === "number" &&
  typeof (value as PdfAnnotationRectRatio).widthRatio === "number" &&
  typeof (value as PdfAnnotationRectRatio).heightRatio === "number";
const isPdfAnnotationHighlightGroup = (
  value: unknown,
): value is PdfAnnotationHighlightGroup =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PdfAnnotationHighlightGroup).page === "number" &&
  Array.isArray((value as PdfAnnotationHighlightGroup).rects) &&
  (value as PdfAnnotationHighlightGroup).rects.every(isPdfAnnotationRectRatio);
const parseStoredPdfAnnotations = (raw: string | null) => {
  if (!raw) {
    return [] as PdfHighlightAnnotation[];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [] as PdfHighlightAnnotation[];
    }
    return parsed.filter(
      (annotation): annotation is PdfHighlightAnnotation =>
        typeof annotation === "object" &&
        annotation !== null &&
        typeof (annotation as PdfHighlightAnnotation).id === "string" &&
        typeof (annotation as PdfHighlightAnnotation).text === "string" &&
        typeof (annotation as PdfHighlightAnnotation).color === "string" &&
        typeof (annotation as PdfHighlightAnnotation).note === "string" &&
        Array.isArray((annotation as PdfHighlightAnnotation).groups) &&
        (annotation as PdfHighlightAnnotation).groups.every(
          isPdfAnnotationHighlightGroup,
        ),
    );
  } catch {
    return [] as PdfHighlightAnnotation[];
  }
};
const resolveFloatingPanelPosition = (
  anchorLeft: number,
  anchorTop: number,
  width: number,
  height: number,
) => {
  const left = clamp(
    anchorLeft,
    VIEWPORT_MARGIN_X,
    window.innerWidth - width - VIEWPORT_MARGIN_X,
  );
  const preferredTop = anchorTop;
  const top = clamp(
    preferredTop,
    VIEWPORT_MARGIN_TOP,
    window.innerHeight - height - VIEWPORT_MARGIN_X,
  );
  return { left, top };
};
const isSameSelectionRow = (
  currentRow: SelectionClientRect,
  nextRect: SelectionClientRect,
) => {
  const verticalOverlap =
    Math.min(currentRow.bottom, nextRect.bottom) -
    Math.max(currentRow.top, nextRect.top);
  const minHeight = Math.min(
    getSelectionRectHeight(currentRow),
    getSelectionRectHeight(nextRect),
  );
  if (verticalOverlap >= minHeight * 0.28) {
    return true;
  }

  return (
    Math.abs(
      getSelectionRectCenterY(currentRow) - getSelectionRectCenterY(nextRect),
    ) <=
    Math.max(
      6,
      Math.min(
        14,
        Math.max(
          getSelectionRectHeight(currentRow),
          getSelectionRectHeight(nextRect),
        ) * 0.6,
      ),
    )
  );
};
const getSelectionHighlightRectsFromClientRects = (
  rects: SelectionClientRect[],
): PdfSelectionHighlightRect[] => {
  if (rects.length === 0) {
    return [];
  }

  const mergedRows: SelectionClientRect[] = [];
  rects.forEach((rect) => {
    const currentRow = mergedRows[mergedRows.length - 1];
    if (!currentRow || !isSameSelectionRow(currentRow, rect)) {
      mergedRows.push({ ...rect });
      return;
    }

    currentRow.left = Math.min(currentRow.left, rect.left);
    currentRow.top = Math.min(currentRow.top, rect.top);
    currentRow.right = Math.max(currentRow.right, rect.right);
    currentRow.bottom = Math.max(currentRow.bottom, rect.bottom);
  });

  return mergedRows.map((rect) => ({
    left: Math.max(0, rect.left - 0.5),
    top: Math.max(0, rect.top - 0.5),
    width: rect.right - rect.left + 1,
    height: rect.bottom - rect.top + 1,
  }));
};
const getSelectableTextNodes = (textLayer: HTMLElement) => {
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes: Text[] = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof Text) {
      textNodes.push(currentNode);
    }
    currentNode = walker.nextNode();
  }
  return textNodes;
};

const getFirstSelectableTextNode = (element: Element) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const firstNode = walker.nextNode();
  return firstNode instanceof Text ? firstNode : null;
};

const resolveBoundaryPointInTextLayer = (
  textLayer: HTMLElement,
  container: Node,
  offset: number,
  preferEnd: boolean,
) => {
  const textNodes = getSelectableTextNodes(textLayer);
  if (textNodes.length === 0) {
    return null;
  }

  if (container instanceof Text && textLayer.contains(container)) {
    return {
      node: container,
      offset: clamp(offset, 0, container.textContent?.length ?? 0),
    };
  }

  const fallbackNode = preferEnd
    ? textNodes[textNodes.length - 1]
    : textNodes[0];
  return {
    node: fallbackNode,
    offset: preferEnd ? (fallbackNode.textContent?.length ?? 0) : 0,
  };
};
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

const ensureTextLayerEndOfContent = (textLayerElement: HTMLElement) => {
  let endOfContent =
    textLayerElement.querySelector<HTMLElement>(".endOfContent");
  if (!endOfContent) {
    endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    textLayerElement.append(endOfContent);
  }
  return endOfContent;
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

const SUSPICIOUS_MOJIBAKE_PATTERN = /[�]|(?:绔|璺|缂|鍒|脳|鈥|锟)/;

const normalizeOutlineTitle = (
  rawTitle: string | undefined,
  index: number,
): string => {
  const title = rawTitle?.replace(/\s+/g, " ").trim() ?? "";
  if (!title || SUSPICIOUS_MOJIBAKE_PATTERN.test(title)) {
    return `章节 ${index + 1}`;
  }
  return title;
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
          title: normalizeOutlineTitle(item.title, index),
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
  annotations,
  onSelectionStart,
  onSelectionCapture,
  onAnnotationNoteClick,
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
        ensureTextLayerEndOfContent(textLayerElement);
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
  const contentWidth = renderedPage.width || pageWidth;
  const contentHeight = renderedPage.height || estimatedHeight;

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
            width: `${contentWidth}px`,
            height: `${contentHeight}px`,
            transform:
              previewScale !== 1 ? `scale(${previewScale})` : undefined,
          }}
        >
          <canvas className="pdfjs-canvas" ref={canvasRef} />
          <div className="pdf-page-annotation-layer">
            {annotations.map((annotation) => {
              const lastRect = annotation.rects[annotation.rects.length - 1];
              const noteBadgeStyle = lastRect
                ? ({
                    left: `${clamp(
                      (lastRect.leftRatio + lastRect.widthRatio) *
                        contentWidth -
                        9,
                      8,
                      Math.max(8, contentWidth - 26),
                    )}px`,
                    top: `${Math.max(8, lastRect.topRatio * contentHeight - 20)}px`,
                    ["--annotation-color" as string]: annotation.color,
                  } satisfies React.CSSProperties)
                : undefined;

              return (
                <React.Fragment key={annotation.annotationId}>
                  {annotation.rects.map((rect, index) => (
                    <div
                      key={`${annotation.annotationId}:${index}`}
                      className="pdf-page-annotation-highlight"
                      style={
                        {
                          left: `${rect.leftRatio * contentWidth}px`,
                          top: `${rect.topRatio * contentHeight}px`,
                          width: `${rect.widthRatio * contentWidth}px`,
                          height: `${rect.heightRatio * contentHeight}px`,
                          ["--annotation-color" as string]: annotation.color,
                        } satisfies React.CSSProperties
                      }
                    />
                  ))}

                  {annotation.showNoteBadge && lastRect && noteBadgeStyle && (
                    <button
                      type="button"
                      className="pdf-annotation-note-badge"
                      style={noteBadgeStyle}
                      title="查看注释"
                      aria-label="查看注释"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) =>
                        onAnnotationNoteClick(
                          annotation.annotationId,
                          event.currentTarget.getBoundingClientRect(),
                        )
                      }
                    >
                      <FileText size={12} />
                    </button>
                  )}
                </React.Fragment>
              );
            })}
          </div>
          <div
            className="textLayer pdfjs-text-layer"
            ref={textLayerRef}
            onMouseDown={onSelectionStart}
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
  const [selection, setSelection] = useState<PdfSelectionState | null>(null);
  const [isSelectionTranslateMode, setIsSelectionTranslateMode] = useState(
    () => {
      if (typeof window === "undefined") return false;
      return (
        window.localStorage.getItem(PDF_SELECTION_MODE_KEY) === "translate"
      );
    },
  );
  const [annotations, setAnnotations] = useState<PdfHighlightAnnotation[]>([]);
  const [annotationEditor, setAnnotationEditor] =
    useState<AnnotationEditorState | null>(null);
  const [preferredAnnotationColor, setPreferredAnnotationColor] = useState(
    PDF_ANNOTATION_COLORS[0]?.value ?? "#ffd400",
  );
  const [contextMenu, setContextMenu] = useState<PdfContextMenuState | null>(
    null,
  );
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionOverlayRef = useRef<HTMLDivElement | null>(null);
  const isSelectionDraggingRef = useRef(false);
  const selectionRangeRef = useRef<Range[]>([]);
  const selectionPointerRef = useRef<SelectionPointerState | null>(null);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      PDF_SELECTION_MODE_KEY,
      isSelectionTranslateMode ? "translate" : "normal",
    );
  }, [isSelectionTranslateMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = parseStoredPdfAnnotations(
      window.localStorage.getItem(buildAnnotationStorageKey(activePdfPath)),
    );
    setAnnotations(stored);
    setAnnotationEditor(null);
  }, [activePdfPath]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storageKey = buildAnnotationStorageKey(activePdfPath);
    if (annotations.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(annotations));
  }, [activePdfPath, annotations]);

  const annotationsByPage = useMemo(() => {
    const groups = new Map<number, PdfPageAnnotationRenderGroup[]>();
    annotations.forEach((annotation) => {
      const lastPage =
        annotation.groups[annotation.groups.length - 1]?.page ?? null;
      annotation.groups.forEach((group) => {
        const pageGroups = groups.get(group.page) ?? [];
        pageGroups.push({
          annotationId: annotation.id,
          color: annotation.color,
          note: annotation.note,
          rects: group.rects,
          showNoteBadge:
            Boolean(annotation.note.trim()) &&
            lastPage !== null &&
            group.page === lastPage,
        });
        groups.set(group.page, pageGroups);
      });
    });
    return groups;
  }, [annotations]);

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

  const resolvePageFromViewportPoint = useCallback((x: number, y: number) => {
    let bestPage = currentPageRef.current;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [pageNumber, node] of pageRefs.current.entries()) {
      const rect = node.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return pageNumber;
      }

      const distance = getDistanceToRect(x, y, rect);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = pageNumber;
      }
    }

    return bestPage;
  }, []);

  const groupSelectionClientRectsByPage = useCallback(
    (rects: SelectionClientRect[]): PdfSelectionHighlightGroup[] => {
      const groupedRects = new Map<number, SelectionClientRect[]>();

      rects.forEach((rect) => {
        const centerX = rect.left + (rect.right - rect.left) / 2;
        const centerY = rect.top + (rect.bottom - rect.top) / 2;
        let bestPage = resolvePageFromViewportPoint(centerX, centerY);
        let bestOverlapArea = 0;

        for (const [pageNumber, pageNode] of pageRefs.current.entries()) {
          const pageRect = pageNode.getBoundingClientRect();
          const overlapWidth =
            Math.min(rect.right, pageRect.right) -
            Math.max(rect.left, pageRect.left);
          const overlapHeight =
            Math.min(rect.bottom, pageRect.bottom) -
            Math.max(rect.top, pageRect.top);
          const overlapArea =
            Math.max(0, overlapWidth) * Math.max(0, overlapHeight);

          if (overlapArea > bestOverlapArea) {
            bestOverlapArea = overlapArea;
            bestPage = pageNumber;
          }
        }

        const pageRects = groupedRects.get(bestPage) ?? [];
        pageRects.push(rect);
        groupedRects.set(bestPage, pageRects);
      });

      return Array.from(groupedRects.entries())
        .sort(([leftPage], [rightPage]) => leftPage - rightPage)
        .map(([page, pageRects]) => ({
          page,
          rects: getSelectionHighlightRectsFromClientRects(pageRects),
        }))
        .filter((group) => group.rects.length > 0);
    },
    [resolvePageFromViewportPoint],
  );

  const getActiveSelectionRanges = useCallback((rangeOverrides?: Range[]) => {
    if (rangeOverrides && rangeOverrides.length > 0) {
      return rangeOverrides.filter((range) => !range.collapsed);
    }

    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.rangeCount === 0) {
      return [];
    }

    return Array.from({ length: browserSelection.rangeCount }, (_, index) =>
      browserSelection.getRangeAt(index),
    ).filter((range) => !range.collapsed);
  }, []);

  const splitSelectionRangeByPage = useCallback((range: Range) => {
    if (range.collapsed) {
      return [];
    }

    const startPageNumber =
      resolvePageFromNode(range.startContainer) ?? currentPageRef.current;
    const endPageNumber =
      resolvePageFromNode(range.endContainer) ?? startPageNumber;
    if (startPageNumber === endPageNumber) {
      return [range.cloneRange()];
    }

    const pageRanges: Range[] = [];
    for (
      let pageNumber = Math.min(startPageNumber, endPageNumber);
      pageNumber <= Math.max(startPageNumber, endPageNumber);
      pageNumber += 1
    ) {
      const pageElement = pageRefs.current.get(pageNumber);
      const textLayer =
        pageElement?.querySelector<HTMLElement>(".pdfjs-text-layer") ?? null;
      if (!textLayer) {
        continue;
      }

      const textNodes = getSelectableTextNodes(textLayer);
      if (textNodes.length === 0) {
        continue;
      }

      const firstTextNode = textNodes[0];
      const lastTextNode = textNodes[textNodes.length - 1];
      const startBoundary =
        pageNumber === startPageNumber
          ? resolveBoundaryPointInTextLayer(
              textLayer,
              range.startContainer,
              range.startOffset,
              false,
            )
          : { node: firstTextNode, offset: 0 };
      const endBoundary =
        pageNumber === endPageNumber
          ? resolveBoundaryPointInTextLayer(
              textLayer,
              range.endContainer,
              range.endOffset,
              true,
            )
          : {
              node: lastTextNode,
              offset: lastTextNode.textContent?.length ?? 0,
            };

      if (!startBoundary || !endBoundary) {
        continue;
      }

      const pageRange = document.createRange();
      pageRange.setStart(startBoundary.node, startBoundary.offset);
      pageRange.setEnd(endBoundary.node, endBoundary.offset);
      if (!pageRange.collapsed) {
        pageRanges.push(pageRange);
      }
    }

    return pageRanges;
  }, []);

  const getStableSelectionRanges = useCallback(
    (rangeOverrides?: Range[]) =>
      getActiveSelectionRanges(rangeOverrides).flatMap((range) =>
        splitSelectionRangeByPage(range),
      ),
    [getActiveSelectionRanges, splitSelectionRangeByPage],
  );

  const buildSelectionState = useCallback(
    (
      overlay: SelectionOverlayMode,
      suppressTranslateLengthStatus = false,
      rangeOverrides?: Range[],
    ): PdfSelectionState | null => {
      if (viewerMode !== "pdfjs") return null;

      const ranges = getStableSelectionRanges(rangeOverrides);
      if (ranges.length === 0) {
        return null;
      }

      const startRange = ranges[0];
      const endRange = ranges[ranges.length - 1];
      const startPageNumber =
        resolvePageFromNode(startRange.startContainer) ??
        currentPageRef.current;
      const endPageNumber =
        resolvePageFromNode(endRange.endContainer) ?? startPageNumber;
      const startPageElement = pageRefs.current.get(startPageNumber);
      const endPageElement = pageRefs.current.get(endPageNumber);
      if (
        !startPageElement ||
        !endPageElement ||
        !startPageElement.contains(startRange.startContainer) ||
        !endPageElement.contains(endRange.endContainer)
      ) {
        return null;
      }

      const text = normalizeSelectedText(
        ranges.map((range) => range.toString()).join(" "),
      );
      const rawClientRects = ranges.flatMap((range) =>
        getSelectionClientRects(range),
      );
      const highlightGroups = groupSelectionClientRectsByPage(rawClientRects);
      if (!text || highlightGroups.length === 0) {
        return null;
      }

      if (
        overlay !== "preview" &&
        overlay === "translate" &&
        text.length > MAX_TRANSLATE_SELECTION_CHARS
      ) {
        if (!suppressTranslateLengthStatus) {
          onStatusRef.current(
            "选中文本过长，请使用“整页翻译”。",
            "info",
            false,
          );
        }
        return null;
      }

      const actionRect = rawClientRects[rawClientRects.length - 1];
      if (!actionRect) {
        return null;
      }

      const popoverWidth = Math.min(
        POPOVER_ESTIMATED_WIDTH,
        window.innerWidth - VIEWPORT_MARGIN_X * 2,
      );
      const selectionCenterX =
        actionRect.left + (actionRect.right - actionRect.left) / 2;
      const preferredPopoverLeft = selectionCenterX - popoverWidth / 2;
      const popoverLeft = clamp(
        preferredPopoverLeft,
        VIEWPORT_MARGIN_X,
        window.innerWidth - popoverWidth - VIEWPORT_MARGIN_X,
      );
      const canOpenBelow =
        actionRect.bottom + POPOVER_ANCHOR_GAP + POPOVER_ESTIMATED_HEIGHT <=
        window.innerHeight - VIEWPORT_MARGIN_X;
      const canOpenAbove =
        actionRect.top - POPOVER_ANCHOR_GAP - POPOVER_ESTIMATED_HEIGHT >=
        VIEWPORT_MARGIN_TOP;
      const popoverTop = canOpenBelow
        ? actionRect.bottom + POPOVER_ANCHOR_GAP
        : canOpenAbove
          ? actionRect.top - POPOVER_ESTIMATED_HEIGHT - POPOVER_ANCHOR_GAP
          : clamp(
              actionRect.bottom + 10,
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
            actionRect.bottom + 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          )
        : clamp(
            actionRect.top - FLOATING_BUTTON_HEIGHT - 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          );

      return {
        text,
        page: endPageNumber,
        startPage: startPageNumber,
        endPage: endPageNumber,
        targetLeft,
        targetTop,
        popoverLeft,
        popoverTop,
        highlightGroups,
        overlay,
      };
    },
    [getStableSelectionRanges, groupSelectionClientRectsByPage, viewerMode],
  );

  const cloneCurrentSelectionRanges = useCallback(() => {
    const ranges = getStableSelectionRanges();
    return ranges.map((range) => range.cloneRange());
  }, [getStableSelectionRanges]);

  const buildAnnotationFromSelection = useCallback(
    (color: string, note: string) => {
      if (!selection) {
        return null;
      }

      const groups = selection.highlightGroups
        .map((group) => {
          const pageShell = pageRefs.current.get(group.page);
          const pageContent =
            pageShell?.querySelector<HTMLElement>(".pdfjs-page-content") ??
            null;
          const pageRect = pageContent?.getBoundingClientRect();
          if (!pageRect || pageRect.width < 1 || pageRect.height < 1) {
            return null;
          }

          const rects = group.rects
            .map((rect) => ({
              leftRatio: clamp(
                (rect.left - pageRect.left) / pageRect.width,
                0,
                1,
              ),
              topRatio: clamp(
                (rect.top - pageRect.top) / pageRect.height,
                0,
                1,
              ),
              widthRatio: clamp(rect.width / pageRect.width, 0, 1),
              heightRatio: clamp(rect.height / pageRect.height, 0, 1),
            }))
            .filter(
              (rect) => rect.widthRatio > 0.001 && rect.heightRatio > 0.001,
            );

          if (rects.length === 0) {
            return null;
          }

          return {
            page: group.page,
            rects,
          } satisfies PdfAnnotationHighlightGroup;
        })
        .filter(
          (group): group is PdfAnnotationHighlightGroup => group !== null,
        );

      if (groups.length === 0) {
        return null;
      }

      const timestamp = new Date().toISOString();
      return {
        id: createPdfAnnotationId(),
        type: "highlight",
        text: selection.text,
        color,
        note: note.trim(),
        groups,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies PdfHighlightAnnotation;
    },
    [selection],
  );

  const buildSelectionStateFromAnnotation = useCallback(
    (
      annotation: PdfHighlightAnnotation,
      overlay: SelectionOverlayMode = "button",
    ): PdfSelectionState | null => {
      const highlightGroups = annotation.groups
        .map((group) => {
          const pageShell = pageRefs.current.get(group.page);
          const pageContent =
            pageShell?.querySelector<HTMLElement>(".pdfjs-page-content") ??
            null;
          const pageRect = pageContent?.getBoundingClientRect();
          if (!pageRect || pageRect.width < 1 || pageRect.height < 1) {
            return null;
          }

          const rects = group.rects
            .map((rect) => ({
              left: pageRect.left + rect.leftRatio * pageRect.width,
              top: pageRect.top + rect.topRatio * pageRect.height,
              width: rect.widthRatio * pageRect.width,
              height: rect.heightRatio * pageRect.height,
            }))
            .filter((rect) => rect.width > 1 && rect.height > 1);

          if (rects.length === 0) {
            return null;
          }

          return {
            page: group.page,
            rects,
          } satisfies PdfSelectionHighlightGroup;
        })
        .filter((group): group is PdfSelectionHighlightGroup => group !== null);

      if (highlightGroups.length === 0) {
        return null;
      }

      const lastGroup = highlightGroups[highlightGroups.length - 1];
      const actionRect = lastGroup.rects[lastGroup.rects.length - 1];
      if (!actionRect) {
        return null;
      }

      const popoverWidth = Math.min(
        POPOVER_ESTIMATED_WIDTH,
        window.innerWidth - VIEWPORT_MARGIN_X * 2,
      );
      const selectionCenterX = actionRect.left + actionRect.width / 2;
      const preferredPopoverLeft = selectionCenterX - popoverWidth / 2;
      const popoverLeft = clamp(
        preferredPopoverLeft,
        VIEWPORT_MARGIN_X,
        window.innerWidth - popoverWidth - VIEWPORT_MARGIN_X,
      );
      const actionRectBottom = actionRect.top + actionRect.height;
      const canOpenBelow =
        actionRectBottom + POPOVER_ANCHOR_GAP + POPOVER_ESTIMATED_HEIGHT <=
        window.innerHeight - VIEWPORT_MARGIN_X;
      const canOpenAbove =
        actionRect.top - POPOVER_ANCHOR_GAP - POPOVER_ESTIMATED_HEIGHT >=
        VIEWPORT_MARGIN_TOP;
      const popoverTop = canOpenBelow
        ? actionRectBottom + POPOVER_ANCHOR_GAP
        : canOpenAbove
          ? actionRect.top - POPOVER_ESTIMATED_HEIGHT - POPOVER_ANCHOR_GAP
          : clamp(
              actionRectBottom + 10,
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
            actionRectBottom + 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          )
        : clamp(
            actionRect.top - FLOATING_BUTTON_HEIGHT - 6,
            VIEWPORT_MARGIN_TOP,
            window.innerHeight - FLOATING_BUTTON_HEIGHT - VIEWPORT_MARGIN_X,
          );

      return {
        text: annotation.text,
        page: lastGroup.page,
        startPage: highlightGroups[0]?.page ?? lastGroup.page,
        endPage: lastGroup.page,
        targetLeft,
        targetTop,
        popoverLeft,
        popoverTop,
        highlightGroups,
        overlay,
      };
    },
    [],
  );

  const findAnnotationAtViewportPoint = useCallback(
    (clientX: number, clientY: number) => {
      for (let index = annotations.length - 1; index >= 0; index -= 1) {
        const annotation = annotations[index];
        for (const group of annotation.groups) {
          const pageShell = pageRefs.current.get(group.page);
          const pageContent =
            pageShell?.querySelector<HTMLElement>(".pdfjs-page-content") ??
            null;
          const pageRect = pageContent?.getBoundingClientRect();
          if (!pageRect) {
            continue;
          }

          for (const rect of group.rects) {
            const left = pageRect.left + rect.leftRatio * pageRect.width;
            const top = pageRect.top + rect.topRatio * pageRect.height;
            const width = rect.widthRatio * pageRect.width;
            const height = rect.heightRatio * pageRect.height;
            if (
              clientX >= left - 2 &&
              clientX <= left + width + 2 &&
              clientY >= top - 2 &&
              clientY <= top + height + 2
            ) {
              return annotation;
            }
          }
        }
      }

      return null;
    },
    [annotations],
  );

  const closeAnnotationEditor = useCallback(() => {
    setAnnotationEditor(null);
  }, []);

  const openAnnotationEditorForAnnotation = useCallback(
    (annotation: PdfHighlightAnnotation, anchorRect: DOMRect) => {
      const { left, top } = resolveFloatingPanelPosition(
        anchorRect.left -
          PDF_ANNOTATION_EDITOR_WIDTH / 2 +
          anchorRect.width / 2,
        anchorRect.bottom + 10,
        PDF_ANNOTATION_EDITOR_WIDTH,
        PDF_ANNOTATION_EDITOR_HEIGHT,
      );
      setAnnotationEditor({
        mode: "edit",
        annotationId: annotation.id,
        left,
        top,
        color: annotation.color,
        note: annotation.note,
      });
      setContextMenu(null);
      selectionRangeRef.current = [];
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    },
    [],
  );

  const openAnnotationEditorFromSelection = useCallback(() => {
    if (!selection) {
      return;
    }

    const { left, top } = resolveFloatingPanelPosition(
      selection.popoverLeft,
      selection.popoverTop,
      PDF_ANNOTATION_EDITOR_WIDTH,
      PDF_ANNOTATION_EDITOR_HEIGHT,
    );
    setAnnotationEditor({
      mode: "create",
      annotationId: null,
      left,
      top,
      color: preferredAnnotationColor,
      note: "",
    });
    setContextMenu(null);
  }, [preferredAnnotationColor, selection]);

  const handleApplyHighlight = useCallback(
    (color: string) => {
      const annotation = buildAnnotationFromSelection(color, "");
      if (!annotation) {
        return;
      }
      setAnnotations((previous) => [...previous, annotation]);
      setPreferredAnnotationColor(color);
      setContextMenu(null);
      selectionRangeRef.current = [];
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      onStatusRef.current("已添加突出显示。", "info", false);
    },
    [buildAnnotationFromSelection],
  );

  const handleAnnotationEditorSave = useCallback(() => {
    if (!annotationEditor) {
      return;
    }

    if (annotationEditor.mode === "edit" && annotationEditor.annotationId) {
      setAnnotations((previous) =>
        previous.map((annotation) =>
          annotation.id === annotationEditor.annotationId
            ? {
                ...annotation,
                color: annotationEditor.color,
                note: annotationEditor.note.trim(),
                updatedAt: new Date().toISOString(),
              }
            : annotation,
        ),
      );
      setPreferredAnnotationColor(annotationEditor.color);
      setAnnotationEditor(null);
      onStatusRef.current("已更新注释。", "info", false);
      return;
    }

    const annotation = buildAnnotationFromSelection(
      annotationEditor.color,
      annotationEditor.note,
    );
    if (!annotation) {
      return;
    }
    setAnnotations((previous) => [...previous, annotation]);
    setPreferredAnnotationColor(annotationEditor.color);
    setAnnotationEditor(null);
    setContextMenu(null);
    selectionRangeRef.current = [];
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    onStatusRef.current("已保存注释。", "info", false);
  }, [annotationEditor, buildAnnotationFromSelection]);

  const handleAnnotationNoteClick = useCallback(
    (annotationId: string, anchorRect: DOMRect) => {
      const annotation = annotations.find((item) => item.id === annotationId);
      if (!annotation) {
        return;
      }
      openAnnotationEditorForAnnotation(annotation, anchorRect);
    },
    [annotations, openAnnotationEditorForAnnotation],
  );

  const handleDeleteAnnotation = useCallback((annotationId: string) => {
    setAnnotations((previous) =>
      previous.filter((annotation) => annotation.id !== annotationId),
    );
    setContextMenu(null);
    setAnnotationEditor((previous) =>
      previous?.annotationId === annotationId ? null : previous,
    );
    onStatusRef.current("已删除突出显示。", "info", false);
  }, []);

  const handleDeleteAnnotationNote = useCallback((annotationId: string) => {
    setAnnotations((previous) =>
      previous.map((annotation) =>
        annotation.id === annotationId
          ? {
              ...annotation,
              note: "",
              updatedAt: new Date().toISOString(),
            }
          : annotation,
      ),
    );
    setContextMenu(null);
    setAnnotationEditor((previous) =>
      previous?.annotationId === annotationId
        ? { ...previous, note: "" }
        : previous,
    );
    onStatusRef.current("已删除注释。", "info", false);
  }, []);

  const handleContextEditAnnotation = useCallback(() => {
    if (contextMenu?.mode !== "annotation") {
      return;
    }
    const annotation = annotations.find(
      (item) => item.id === contextMenu.annotationId,
    );
    if (!annotation) {
      return;
    }
    const anchorRect = new DOMRect(contextMenu.x, contextMenu.y, 0, 0);
    openAnnotationEditorForAnnotation(annotation, anchorRect);
  }, [annotations, contextMenu, openAnnotationEditorForAnnotation]);

  const handleContextAnnotationCopy = useCallback(async () => {
    if (!selection?.text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selection.text);
      onStatusRef.current("已复制选中文本。", "info", false);
    } catch {
      onStatusRef.current("复制失败，请手动复制。", "error", false);
    }
    setContextMenu(null);
  }, [selection]);

  const handleContextAnnotationExplain = useCallback(() => {
    if (!selection) {
      return;
    }
    if (selection.text.length > MAX_EXPLAIN_SELECTION_CHARS) {
      onStatusRef.current(
        "解释功能适合术语或短语；长段内容请使用“翻译”。",
        "info",
        false,
      );
      setContextMenu(null);
      return;
    }
    setSelection((previous) =>
      previous ? { ...previous, overlay: "explain" } : previous,
    );
    setContextMenu(null);
  }, [selection]);

  const handleContextAnnotationTranslate = useCallback(() => {
    if (!selection) {
      return;
    }
    if (selection.text.length > MAX_TRANSLATE_SELECTION_CHARS) {
      onStatusRef.current("选中文本过长，请使用“整页翻译”。", "info", false);
      return;
    }
    setSelection((previous) =>
      previous ? { ...previous, overlay: "translate" } : previous,
    );
    setContextMenu(null);
  }, [selection]);

  const clampSelectionRangesToBlankLine = useCallback(
    (
      ranges: Range[],
      event?:
        | SelectionPointerState
        | React.MouseEvent<HTMLDivElement>
        | MouseEvent,
    ) => {
      if (!event || ranges.length === 0) return ranges;
      if (resolveSelectionTargetElement(event.target)) return ranges;

      const pageNumber = resolvePageFromViewportPoint(
        event.clientX,
        event.clientY,
      );
      const pageElement = pageRefs.current.get(pageNumber);
      const textLayer =
        pageElement?.querySelector<HTMLElement>(".pdfjs-text-layer") ?? null;
      if (!textLayer) return ranges;

      const spanCandidates = Array.from(
        textLayer.querySelectorAll<HTMLElement>("span"),
      )
        .filter(
          (span) =>
            !span.classList.contains("markedContent") &&
            span.textContent?.trim(),
        )
        .flatMap((span) => {
          const textNode = getFirstSelectableTextNode(span);
          if (!textNode) return [];
          return Array.from(span.getClientRects())
            .filter((rect) => rect.width >= 1 && rect.height >= 1)
            .map((rect) => ({ rect, textNode }));
        });

      if (spanCandidates.length === 0) return ranges;

      const verticalDistanceToRect = (rect: DOMRect) =>
        event.clientY < rect.top
          ? rect.top - event.clientY
          : event.clientY > rect.bottom
            ? event.clientY - rect.bottom
            : 0;

      const nearest = spanCandidates.reduce(
        (best, candidate) => {
          const candidateDistance = verticalDistanceToRect(candidate.rect);
          if (!best) {
            return { ...candidate, distance: candidateDistance };
          }
          if (candidateDistance < best.distance) {
            return { ...candidate, distance: candidateDistance };
          }
          if (
            Math.abs(candidateDistance - best.distance) < 0.5 &&
            Math.abs(
              getSelectionRectCenterY({
                left: candidate.rect.left,
                top: candidate.rect.top,
                right: candidate.rect.right,
                bottom: candidate.rect.bottom,
              }) - event.clientY,
            ) <
              Math.abs(
                getSelectionRectCenterY({
                  left: best.rect.left,
                  top: best.rect.top,
                  right: best.rect.right,
                  bottom: best.rect.bottom,
                }) - event.clientY,
              )
          ) {
            return { ...candidate, distance: candidateDistance };
          }
          return best;
        },
        null as ((typeof spanCandidates)[number] & { distance: number }) | null,
      );

      if (!nearest) return ranges;

      const referenceRect: SelectionClientRect = {
        left: nearest.rect.left,
        top: nearest.rect.top,
        right: nearest.rect.right,
        bottom: nearest.rect.bottom,
      };
      const sameRowCandidates = spanCandidates.filter((candidate) =>
        isSameSelectionRow(referenceRect, {
          left: candidate.rect.left,
          top: candidate.rect.top,
          right: candidate.rect.right,
          bottom: candidate.rect.bottom,
        }),
      );

      if (sameRowCandidates.length === 0) return ranges;

      const leftSideCandidates = sameRowCandidates
        .filter((candidate) => candidate.rect.left <= event.clientX + 1)
        .sort((left, right) => right.rect.right - left.rect.right);

      const boundaryCandidate =
        leftSideCandidates[0] ??
        sameRowCandidates.sort(
          (left, right) => left.rect.left - right.rect.left,
        )[0];
      if (!boundaryCandidate?.textNode) return ranges;

      const useRowStartBoundary = leftSideCandidates.length === 0;
      const boundaryOffset = useRowStartBoundary
        ? 0
        : (boundaryCandidate.textNode.textContent?.length ?? 0);

      const adjustedRanges = ranges.map((range) => range.cloneRange());
      const lastRangeIndex = adjustedRanges.length - 1;
      const candidateRange = adjustedRanges[lastRangeIndex].cloneRange();
      candidateRange.setEnd(boundaryCandidate.textNode, boundaryOffset);
      if (candidateRange.collapsed) {
        return ranges;
      }
      adjustedRanges[lastRangeIndex] = candidateRange;
      return adjustedRanges;
    },
    [resolvePageFromViewportPoint],
  );

  const clearActiveTextLayerSelections = useCallback(() => {
    const textLayers =
      stageRef.current?.querySelectorAll<HTMLElement>(".pdfjs-text-layer") ??
      [];
    textLayers.forEach((textLayer) => {
      const endOfContent = ensureTextLayerEndOfContent(textLayer);
      textLayer.append(endOfContent);
      endOfContent.style.top = "";
      endOfContent.classList.remove("active");
      textLayer.classList.remove("selecting");
    });
  }, []);

  const handleSelectionStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      if (!resolveSelectionTargetElement(event.target)) {
        event.preventDefault();
        isSelectionDraggingRef.current = false;
        selectionRangeRef.current = [];
        clearActiveTextLayerSelections();
        setSelection(null);
        return;
      }

      isSelectionDraggingRef.current = true;
      selectionPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
      const textLayer = event.currentTarget;
      const endOfContent = ensureTextLayerEndOfContent(textLayer);
      let adjustTop = event.target !== textLayer;
      adjustTop &&=
        getComputedStyle(endOfContent).getPropertyValue("-moz-user-select") !==
        "none";
      if (adjustTop) {
        const textLayerBounds = textLayer.getBoundingClientRect();
        const ratio = clamp(
          (event.clientY - textLayerBounds.top) /
            Math.max(textLayerBounds.height, 1),
          0,
          1,
        );
        endOfContent.style.top = `${(ratio * 100).toFixed(2)}%`;
      } else {
        endOfContent.style.top = "";
      }
      endOfContent.classList.add("active");
      textLayer.classList.add("selecting");
      selectionRangeRef.current = [];
      selectionPointerRef.current = null;
      setContextMenu(null);
      setAnnotationEditor(null);
      setSelection(null);
    },
    [clearActiveTextLayerSelections],
  );

  const handleSelectionCapture = useCallback(
    (event?: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
      if (event && "button" in event && event.button !== 0) return;
      if (viewerMode !== "pdfjs" || !isSelectionDraggingRef.current) return;
      const capturedRanges = clampSelectionRangesToBlankLine(
        cloneCurrentSelectionRanges(),
        selectionPointerRef.current ?? event,
      );
      clearActiveTextLayerSelections();
      isSelectionDraggingRef.current = false;
      selectionPointerRef.current = null;

      window.requestAnimationFrame(() => {
        const fallbackRanges =
          capturedRanges.length > 0
            ? capturedRanges
            : selectionRangeRef.current;
        const overlayMode: SelectionOverlayMode = isSelectionTranslateMode
          ? "translate"
          : "button";
        const nextSelection = buildSelectionState(
          overlayMode,
          false,
          fallbackRanges,
        );
        selectionRangeRef.current = nextSelection
          ? fallbackRanges.map((range) => range.cloneRange())
          : [];
        setSelection((previous) => nextSelection ?? previous);
      });
    },
    [
      buildSelectionState,
      clampSelectionRangesToBlankLine,
      clearActiveTextLayerSelections,
      cloneCurrentSelectionRanges,
      isSelectionTranslateMode,
      viewerMode,
    ],
  );

  const handlePdfContextMenu = (event: React.MouseEvent) => {
    if (viewerMode !== "pdfjs") return;

    const browserSelection = window.getSelection();
    const nativeText = normalizeSelectedText(
      browserSelection?.toString() ?? "",
    );
    event.preventDefault();

    const stableSelection =
      selection ??
      buildSelectionState("button", true, selectionRangeRef.current) ??
      (nativeText ? buildSelectionState("button", true) : null);
    const text = stableSelection?.text ?? nativeText;

    const overlayRect = selectionOverlayRef.current?.getBoundingClientRect();
    const baseLeft = overlayRect?.left ?? 0;
    const baseTop = overlayRect?.top ?? 0;
    const overlayWidth = overlayRect?.width ?? window.innerWidth;
    const overlayHeight = overlayRect?.height ?? window.innerHeight;
    const padding = 8;

    if (!text) {
      const annotation = findAnnotationAtViewportPoint(
        event.clientX,
        event.clientY,
      );
      if (!annotation) {
        return;
      }

      const nextSelection = buildSelectionStateFromAnnotation(
        annotation,
        "button",
      );
      const menuWidth = 188;
      const menuHeight = annotation.note.trim() ? 224 : 190;
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
      setSelection(nextSelection);
      setAnnotationEditor(null);
      setContextMenu({
        x: left,
        y: top,
        mode: "annotation",
        annotationId: annotation.id,
      });
      return;
    }

    if (stableSelection) {
      if (selectionRangeRef.current.length === 0) {
        selectionRangeRef.current = cloneCurrentSelectionRanges();
      }
      setSelection(stableSelection);
    }

    const menuWidth = 188;
    const menuHeight = 228;
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
    setContextMenu({ x: left, y: top, mode: "selection" });
  };

  const handleContextExplain = () => {
    if (!selection) return;
    if (selection.text.length > MAX_EXPLAIN_SELECTION_CHARS) {
      onStatusRef.current(
        "解释功能适合术语或短语；长段内容请使用“翻译”。",
        "info",
        false,
      );
      setContextMenu(null);
      return;
    }
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

  const handleContextAddNote = () => {
    openAnnotationEditorFromSelection();
  };

  const handleClosePopover = () => {
    selectionRangeRef.current = [];
    setSelection(null);
    setAnnotationEditor(null);
    window.getSelection()?.removeAllRanges();
  };

  useEffect(() => {
    if (viewerMode !== "pdfjs") return;

    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!isSelectionDraggingRef.current) return;
      selectionPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
    };

    const handleWindowMouseUp = (event: MouseEvent) => {
      if (!isSelectionDraggingRef.current) return;
      selectionPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
      handleSelectionCapture(event);
    };

    const handleWindowBlur = () => {
      clearActiveTextLayerSelections();
      isSelectionDraggingRef.current = false;
      selectionPointerRef.current = null;
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      clearActiveTextLayerSelections();
      selectionPointerRef.current = null;
    };
  }, [clearActiveTextLayerSelections, handleSelectionCapture, viewerMode]);

  useEffect(() => {
    if (viewerMode !== "pdfjs") return;

    let frameId: number | null = null;
    const handleSelectionChange = () => {
      if (!isSelectionDraggingRef.current) {
        return;
      }

      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const previewRanges = clampSelectionRangesToBlankLine(
          cloneCurrentSelectionRanges(),
          selectionPointerRef.current ?? undefined,
        );
        const nextSelection = buildSelectionState(
          "preview",
          true,
          previewRanges,
        );
        setSelection((previous) => {
          if (nextSelection) {
            selectionRangeRef.current = previewRanges.map((range) =>
              range.cloneRange(),
            );
            return nextSelection;
          }
          return previous?.overlay === "preview" ? null : previous;
        });
      });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    buildSelectionState,
    clampSelectionRangesToBlankLine,
    cloneCurrentSelectionRanges,
    viewerMode,
  ]);

  useEffect(() => {
    if (!selection) {
      setContextMenu(null);
      setAnnotationEditor((previous) =>
        previous?.mode === "create" ? null : previous,
      );
    }
  }, [selection]);

  useEffect(() => {
    if (viewerMode !== "pdfjs" || !selection) return;

    let frameId: number | null = null;
    const refreshSelectionPosition = () => {
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const nextSelection = buildSelectionState(
          selection.overlay,
          true,
          selectionRangeRef.current,
        );
        if (nextSelection) {
          setSelection(nextSelection);
        }
      });
    };

    window.addEventListener("scroll", refreshSelectionPosition, true);
    window.addEventListener("resize", refreshSelectionPosition);
    return () => {
      window.removeEventListener("scroll", refreshSelectionPosition, true);
      window.removeEventListener("resize", refreshSelectionPosition);
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [buildSelectionState, selection, viewerMode]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      // Keep non-primary clicks (e.g. right-click in chat) from clearing text
      // selection before the consumer's context-menu handler runs.
      if (event.button !== 0) {
        return;
      }

      const targetNode = event.target as Node | null;
      const targetElement =
        targetNode instanceof Element ? targetNode : targetNode?.parentElement;
      if (contextMenuRef.current?.contains(targetNode)) return;
      if (
        targetElement?.closest(
          ".term-popover, .pdf-selection-target, .pdf-selection-context-menu, .pdf-annotation-editor, .pdf-annotation-note-badge",
        )
      ) {
        return;
      }
      setContextMenu(null);
      setAnnotationEditor(null);

      if (resolveSelectionTargetElement(targetNode)) {
        return;
      }

      selectionRangeRef.current = [];
      clearActiveTextLayerSelections();
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    };
    const handleScroll = () => {
      setContextMenu(null);
      setAnnotationEditor(null);
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [clearActiveTextLayerSelections]);

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

  const popoverStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!selection) return undefined;
    return {
      position: "fixed",
      left: `${selection.popoverLeft}px`,
      top: `${selection.popoverTop}px`,
    };
  }, [selection]);

  const annotationEditorStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!annotationEditor) return undefined;
    return {
      position: "fixed",
      left: `${annotationEditor.left}px`,
      top: `${annotationEditor.top}px`,
    };
  }, [annotationEditor]);
  const contextMenuAnnotation = useMemo(() => {
    if (contextMenu?.mode !== "annotation") {
      return null;
    }
    return (
      annotations.find(
        (annotation) => annotation.id === contextMenu.annotationId,
      ) ?? null
    );
  }, [annotations, contextMenu]);

  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );
  const subtitleText = "整页翻译";
  const translatedPageNumber =
    pageTranslation.result?.page ?? pageTranslation.requestedPage;
  const selectionOverlay =
    viewerMode === "pdfjs" && typeof document !== "undefined"
      ? createPortal(
          <div className="pdf-selection-overlay" ref={selectionOverlayRef}>
            {selection?.highlightGroups.flatMap((group) =>
              group.rects.map((rect, index) => (
                <div
                  key={`${group.page}:${index}:${rect.left}:${rect.top}`}
                  className="pdf-selection-highlight"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              )),
            )}

            {contextMenu?.mode === "selection" && selection && (
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
                <div className="pdf-selection-context-divider" />
                <div className="pdf-selection-context-label">突出显示</div>
                <div className="pdf-selection-color-row">
                  {PDF_ANNOTATION_COLORS.map((color) => (
                    <button
                      key={color.key}
                      type="button"
                      className="pdf-selection-color-button"
                      title={color.label}
                      aria-label={`使用${color.label}突出显示`}
                      onClick={() => handleApplyHighlight(color.value)}
                      style={
                        {
                          ["--annotation-color" as string]: color.value,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </div>
                <button type="button" onClick={handleContextAddNote}>
                  注释
                </button>
              </div>
            )}

            {contextMenu?.mode === "annotation" && (
              <div
                ref={contextMenuRef}
                className="pdf-selection-context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                <button type="button" onClick={handleContextAnnotationCopy}>
                  复制
                </button>
                <button type="button" onClick={handleContextAnnotationExplain}>
                  解释
                </button>
                <button
                  type="button"
                  onClick={handleContextAnnotationTranslate}
                >
                  翻译
                </button>
                <div className="pdf-selection-context-divider" />
                <button type="button" onClick={handleContextEditAnnotation}>
                  {contextMenuAnnotation?.note.trim() ? "编辑注释" : "添加注释"}
                </button>
                {contextMenuAnnotation?.note.trim() && (
                  <button
                    type="button"
                    onClick={() =>
                      handleDeleteAnnotationNote(contextMenu.annotationId)
                    }
                  >
                    删除注释
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    handleDeleteAnnotation(contextMenu.annotationId)
                  }
                >
                  删除高亮
                </button>
              </div>
            )}

            {annotationEditor && (
              <div
                className="pdf-annotation-editor"
                style={annotationEditorStyle}
              >
                <div className="pdf-annotation-editor-header">
                  <div className="pdf-annotation-editor-title">
                    {annotationEditor.mode === "edit" ? "编辑注释" : "添加注释"}
                  </div>
                  <button
                    type="button"
                    className="ghost-icon-button"
                    aria-label="关闭注释编辑器"
                    onClick={closeAnnotationEditor}
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="pdf-selection-color-row pdf-selection-color-row-editor">
                  {PDF_ANNOTATION_COLORS.map((color) => (
                    <button
                      key={color.key}
                      type="button"
                      className={`pdf-selection-color-button ${annotationEditor.color === color.value ? "active" : ""}`}
                      title={color.label}
                      aria-label={`选择${color.label}`}
                      onClick={() =>
                        setAnnotationEditor((previous) =>
                          previous
                            ? { ...previous, color: color.value }
                            : previous,
                        )
                      }
                      style={
                        {
                          ["--annotation-color" as string]: color.value,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </div>

                <textarea
                  className="pdf-annotation-editor-input"
                  placeholder="写下这段内容的注释"
                  value={annotationEditor.note}
                  onChange={(event) =>
                    setAnnotationEditor((previous) =>
                      previous
                        ? { ...previous, note: event.target.value }
                        : previous,
                    )
                  }
                />

                <div className="pdf-annotation-editor-actions">
                  {annotationEditor.mode === "edit" &&
                  annotationEditor.annotationId ? (
                    <div className="pdf-annotation-editor-danger-actions">
                      {annotationEditor.note.trim() && (
                        <button
                          type="button"
                          className="danger"
                          onClick={() =>
                            handleDeleteAnnotationNote(
                              annotationEditor.annotationId as string,
                            )
                          }
                        >
                          删除注释
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          handleDeleteAnnotation(
                            annotationEditor.annotationId as string,
                          )
                        }
                      >
                        删除高亮
                      </button>
                    </div>
                  ) : (
                    <span />
                  )}
                  <button type="button" onClick={closeAnnotationEditor}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleAnnotationEditorSave}
                  >
                    保存
                  </button>
                </div>
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
          </div>,
          document.body,
        )
      : null;

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
              <div className="pdf-reader-toolbar-layout">
                <div className="pdf-toolbar-section pdf-toolbar-section-start">
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
                  <span className="pdf-toolbar-divider" aria-hidden="true" />
                  <button
                    className="action-button pdf-toolbar-icon-button"
                    onClick={zoomOut}
                    disabled={viewerMode !== "pdfjs" || zoomPercent <= MIN_ZOOM}
                    aria-label="缩小 PDF"
                    title="缩小"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <button
                    className="action-button pdf-toolbar-icon-button"
                    onClick={zoomIn}
                    disabled={viewerMode !== "pdfjs" || zoomPercent >= MAX_ZOOM}
                    aria-label="放大 PDF"
                    title="放大"
                  >
                    <ZoomIn size={14} />
                  </button>
                  <span className="pdf-toolbar-pill pdf-toolbar-zoom-pill">
                    {zoomPercent}%
                  </span>
                </div>

                <div className="pdf-toolbar-section pdf-toolbar-section-center">
                  <div className="pdf-toolbar-page-chip pdf-page-jump-group">
                    <input
                      className="pdf-page-input"
                      inputMode="numeric"
                      value={pageInputValue}
                      onChange={handlePageInputChange}
                      onFocus={handlePageInputFocus}
                      onBlur={handlePageInputBlur}
                      onKeyDown={handlePageInputKeyDown}
                      aria-label="跳转页码"
                    />
                    <span className="pdf-toolbar-text">
                      / {pageCount || "-"}
                    </span>
                  </div>
                </div>

                <div className="pdf-toolbar-section pdf-toolbar-section-end">
                  <button
                    type="button"
                    className={`action-button pdf-toolbar-icon-button pdf-selection-mode-button ${isSelectionTranslateMode ? "primary" : ""}`}
                    onClick={() =>
                      setIsSelectionTranslateMode((previous) => !previous)
                    }
                    disabled={viewerMode !== "pdfjs"}
                    aria-pressed={isSelectionTranslateMode}
                    aria-label={
                      isSelectionTranslateMode
                        ? "关闭划词翻译模式"
                        : "开启划词翻译模式"
                    }
                    title={
                      isSelectionTranslateMode
                        ? "划词翻译模式已开启：选中文本后直接翻译"
                        : "开启划词翻译模式"
                    }
                  >
                    <Languages size={14} />
                  </button>

                  <span className="pdf-toolbar-divider" aria-hidden="true" />

                  <label className="pdf-mode-control pdf-lookup-control">
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

                  <span className="pdf-toolbar-divider" aria-hidden="true" />

                  <button
                    type="button"
                    className="action-button pdf-toolbar-icon-button"
                    onClick={() => void handleTranslateCurrentPage()}
                    disabled={
                      viewerMode !== "pdfjs" ||
                      isLoading ||
                      isPageTranslationRunning
                    }
                    title={subtitleText}
                    aria-label={subtitleText}
                  >
                    <FileText size={14} />
                  </button>

                  {toolbarActions ? (
                    <>
                      <span
                        className="pdf-toolbar-divider"
                        aria-hidden="true"
                      />
                      <div className="pdf-toolbar-group pdf-toolbar-group-end">
                        {toolbarActions}
                      </div>
                    </>
                  ) : null}
                </div>
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
              <div className="pdf-outline-subtitle">跳转到对应页</div>
            </div>
            <button
              className="ghost-icon-button"
              onClick={() => setIsOutlineOpen(false)}
              aria-label="关闭目录"
            >
              ×
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
            className={`pdfjs-stage ${pageTranslation.open ? "has-page-translation" : ""}`}
          >
            <div
              className="pdfjs-pages-pane"
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
                    annotations={annotationsByPage.get(pageNumber) ?? []}
                    onSelectionStart={handleSelectionStart}
                    onSelectionCapture={handleSelectionCapture}
                    onAnnotationNoteClick={handleAnnotationNoteClick}
                    onPageRefChange={handlePageRefChange}
                    onPageMetricsChange={handlePageMetricsChange}
                    onRenderError={handlePdfRenderError}
                  />
                ))}
              </div>
            </div>

            {pageTranslation.open && (
              <aside className="pdf-page-translation-panel">
                <div className="pdf-page-translation-header">
                  <div>
                    <div className="pdf-page-translation-title">当前页译文</div>
                    <div className="pdf-page-translation-meta">
                      当前显示第 {translatedPageNumber ?? currentPage} 页译文
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
                      页...
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

        {selectionOverlay}
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
