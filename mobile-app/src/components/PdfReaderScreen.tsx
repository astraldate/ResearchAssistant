import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ActivityIndicator,
  Clipboard,
  Modal,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Pdf, { type PdfRef, type TableContent } from "react-native-pdf";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type {
  MobilePdfExplainSelectionResult,
  MobilePdfTranslatePageResult,
  MobilePdfTranslateSelectionResult,
} from "../contracts";
import {
  buildMobilePdfViewerUrl,
  explainMobilePdfSelection,
  normalizeBaseUrl,
  saveMobilePdfExplanationCard,
  selectFastestDesktopBaseUrl,
  translateMobilePdfPage,
  translateMobilePdfSelection,
} from "../lib/api";
import type { PdfSourceType } from "../lib/database";
import { ensurePdfCached, findCachedPdf } from "../lib/pdfCache";
import {
  addMobilePdfViewerRevision,
  buildPageFallbackOutline,
  buildSelectionCacheKey,
  MOBILE_PDF_VIEWER_REVISION,
  normalizeNativeOutline,
  parsePdfViewerMessage,
  serializePdfViewerCommand,
  shouldUseControlledPdfSelection,
  type PdfOutlineEntry,
  type PdfViewerCommand,
  type PdfViewMode,
} from "../lib/pdfReaderCore";
import { useResponsiveLayout } from "../lib/responsiveLayout";
import { bootstrapSync } from "../lib/sync";
import { useSessionStore } from "../store/session";
import { palette, spacing } from "../theme";
import { MobilePdfResultDock } from "./MobilePdfResultDock";
import { PdfExplanationResult } from "./PdfExplanationResult";

type ReaderMode = "online" | "offline";
type PdfAiKind = "selection" | "explanation" | "page";
type ToolIconName = ComponentProps<typeof Ionicons>["name"];

interface SelectedPdfText {
  text: string;
  page: number;
  context: string;
}

interface PdfAiPanelState {
  visible: boolean;
  kind: PdfAiKind;
  title: string;
  content: string;
  meta: string | null;
  loading: boolean;
  error: string | null;
  explanation: MobilePdfExplainSelectionResult | null;
  selectedText: string;
  page: number;
  saving: boolean;
  saved: boolean;
}

interface AutoTranslationQueue {
  running: boolean;
  pending: SelectedPdfText | null;
  activeKey: string | null;
}

const EMPTY_AI_PANEL: PdfAiPanelState = {
  visible: false,
  kind: "selection",
  title: "AI 结果",
  content: "",
  meta: null,
  loading: false,
  error: null,
  explanation: null,
  selectedText: "",
  page: 1,
  saving: false,
  saved: false,
};

export default function PdfReaderScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const layout = useResponsiveLayout();
  const session = useSessionStore((state) => state.session);
  const params = useLocalSearchParams<{
    sourceType?: string;
    sourceId?: string;
    title?: string;
    page?: string;
  }>();
  const sourceType = isPdfSourceType(params.sourceType)
    ? params.sourceType
    : null;
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : "";
  const title = typeof params.title === "string" ? params.title : "PDF";
  const initialPage = useMemo(
    () => positiveInteger(params.page) ?? 1,
    [params.page],
  );

  const [localUri, setLocalUri] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [readerInitialPage, setReaderInitialPage] = useState(initialPage);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("正在准备 PDF...");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [readerMode, setReaderMode] = useState<ReaderMode>(() =>
    session ? "online" : "offline",
  );
  const [viewMode, setViewMode] = useState<PdfViewMode>("continuous");
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerProtocolVersion, setViewerProtocolVersion] = useState(1);
  const [viewerBaseUrl, setViewerBaseUrl] = useState(
    session ? normalizeBaseUrl(session.baseUrl) : "",
  );
  const [onlineStatus, setOnlineStatus] = useState("正在连接桌面 AI 阅读器...");
  const [selectedText, setSelectedText] = useState("");
  const [selectedContext, setSelectedContext] = useState("");
  const [selectedPage, setSelectedPage] = useState(initialPage);
  const [selectionTranslateMode, setSelectionTranslateMode] = useState(false);
  const [outlineEntries, setOutlineEntries] = useState<PdfOutlineEntry[]>([]);
  const [outlineVisible, setOutlineVisible] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [toolsVisible, setToolsVisible] = useState(true);
  const [aiPanel, setAiPanel] = useState<PdfAiPanelState>(EMPTY_AI_PANEL);
  const [resultCollapsed, setResultCollapsed] = useState(false);
  const [offlineScale, setOfflineScale] = useState(1);

  const webViewRef = useRef<WebView>(null);
  const nativePdfRef = useRef<PdfRef>(null);
  const cacheTaskRef = useRef<{
    key: string;
    promise: ReturnType<typeof ensurePdfCached>;
  } | null>(null);
  const pageStateRef = useRef({
    page: initialPage,
    pageCount: null as number | null,
  });
  const previousLandscapeRef = useRef(layout.isLandscape);
  const translationCacheRef = useRef(
    new Map<string, MobilePdfTranslateSelectionResult>(),
  );
  const autoQueueRef = useRef<AutoTranslationQueue>({
    running: false,
    pending: null,
    activeKey: null,
  });

  const pdfSource = useMemo(
    () => (localUri ? { uri: localUri } : null),
    [localUri],
  );
  const viewerSource = useMemo(
    () =>
      sourceType && sourceId
        ? { sourceType, sourceId, page: readerInitialPage }
        : null,
    [readerInitialPage, sourceId, sourceType],
  );
  const viewerUrl = useMemo(
    () =>
      session && viewerSource && viewerBaseUrl
        ? addMobilePdfViewerRevision(
            buildMobilePdfViewerUrl(viewerBaseUrl, viewerSource),
          )
        : null,
    [session, viewerBaseUrl, viewerSource],
  );
  const webViewSource = useMemo(
    () =>
      session && viewerUrl
        ? {
            uri: viewerUrl,
            headers: { Authorization: `Bearer ${session.deviceToken}` },
          }
        : null,
    [session, viewerUrl],
  );
  const companionOrigin = useMemo(
    () => (viewerBaseUrl ? getOrigin(viewerBaseUrl) : null),
    [viewerBaseUrl],
  );
  const isOnlineReader =
    readerMode === "online" && Boolean(session && viewerUrl);
  const displayedOutline = useMemo(
    () =>
      outlineEntries.length > 0
        ? outlineEntries
        : buildPageFallbackOutline(pageCount ?? 0),
    [outlineEntries, pageCount],
  );

  const sendViewerCommand = useCallback((command: PdfViewerCommand) => {
    webViewRef.current?.postMessage(serializePdfViewerCommand(command));
  }, []);

  useEffect(() => {
    if (previousLandscapeRef.current === layout.isLandscape) return;
    previousLandscapeRef.current = layout.isLandscape;
    setSelectedText("");
    setSelectedContext("");
    if (isOnlineReader && viewerProtocolVersion >= 2) {
      sendViewerCommand({ type: "clearSelection" });
      sendViewerCommand({ type: "resetFit" });
    }
  }, [
    isOnlineReader,
    layout.isLandscape,
    sendViewerCommand,
    viewerProtocolVersion,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function loadPdf() {
      if (!sourceType || !sourceId) {
        setErrorText("PDF 参数不完整。");
        setStatusText("");
        return;
      }
      setLocalUri(null);
      setPageCount(null);
      setOutlineEntries([]);
      setCurrentPage(initialPage);
      setReaderInitialPage(initialPage);
      setSelectedPage(initialPage);
      setSelectedText("");
      setSelectedContext("");
      setAiPanel(EMPTY_AI_PANEL);
      setResultCollapsed(false);
      pageStateRef.current = { page: initialPage, pageCount: null };
      setStatusText("正在检查本地缓存...");
      setErrorText(null);
      try {
        const cached = await findCachedPdf(sourceType, sourceId);
        if (cancelled) return;
        if (!cached) {
          setStatusText(session ? "" : "这份 PDF 尚未缓存，请先连接桌面端。");
          return;
        }
        const startPage = cached.pageHint ?? initialPage;
        setLocalUri(cached.localUri);
        setCurrentPage(startPage);
        setReaderInitialPage(startPage);
        setPageInput(String(startPage));
        pageStateRef.current = { page: startPage, pageCount: null };
        setStatusText("");
      } catch (error) {
        if (cancelled) return;
        setErrorText(error instanceof Error ? error.message : String(error));
        setStatusText("");
      }
    }
    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [initialPage, session, sourceId, sourceType]);

  const startPdfCaching = useCallback(
    (showStatus: boolean) => {
      if (!session || !sourceType || !sourceId || localUri) return;
      const key = `${sourceType}:${sourceId}`;
      if (cacheTaskRef.current?.key === key) return;
      if (showStatus) setStatusText("正在下载离线 PDF 缓存...");
      const promise = ensurePdfCached({
        sourceType,
        sourceId,
        title,
        pageHint: initialPage,
        baseUrl: viewerBaseUrl || session.baseUrl,
      });
      cacheTaskRef.current = { key, promise };
      void promise
        .then((cached) => {
          if (cacheTaskRef.current?.key !== key) return;
          const startPage = cached.pageHint ?? initialPage;
          setLocalUri(cached.localUri);
          if (readerMode === "offline") {
            setCurrentPage(startPage);
            setReaderInitialPage(startPage);
            pageStateRef.current = { page: startPage, pageCount: null };
          }
          setStatusText("");
        })
        .catch((error) => {
          if (cacheTaskRef.current?.key !== key) return;
          setErrorText(error instanceof Error ? error.message : String(error));
          setStatusText("");
        })
        .finally(() => {
          if (cacheTaskRef.current?.key === key) cacheTaskRef.current = null;
        });
    },
    [
      initialPage,
      localUri,
      readerMode,
      session,
      sourceId,
      sourceType,
      title,
      viewerBaseUrl,
    ],
  );

  useEffect(() => {
    if (!session || localUri) return;
    if (readerMode === "online" && !viewerReady) return;
    const timer = setTimeout(
      () => startPdfCaching(readerMode === "offline"),
      readerMode === "online" ? 5_000 : 0,
    );
    return () => clearTimeout(timer);
  }, [localUri, readerMode, session, startPdfCaching, viewerReady]);

  useEffect(() => {
    if (!session) {
      setReaderMode("offline");
      return;
    }
    setReaderMode("online");
    setViewerReady(false);
    setViewerProtocolVersion(1);
    setOnlineStatus("正在连接桌面 AI 阅读器...");
  }, [session, sourceId, sourceType]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const current = normalizeBaseUrl(session.baseUrl);
    setViewerBaseUrl(current);
    void selectFastestDesktopBaseUrl(current).then((fastest) => {
      if (!cancelled) setViewerBaseUrl(fastest);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    autoQueueRef.current = {
      running: false,
      pending: null,
      activeKey: null,
    };
    translationCacheRef.current.clear();
  }, [sourceId, sourceType]);

  const fallBackToOffline = useCallback(
    (message: string) => {
      setReaderInitialPage(pageStateRef.current.page);
      setReaderMode("offline");
      setViewerReady(false);
      setSelectionTranslateMode(false);
      setSelectedText("");
      setSelectedContext("");
      setErrorText(
        localUri
          ? `${message} 已切换到离线阅读。`
          : `${message} 正在等待本地 PDF 缓存。`,
      );
    },
    [localUri],
  );

  const showSelectionTranslation = useCallback(
    (selection: SelectedPdfText, result: MobilePdfTranslateSelectionResult) => {
      setAiPanel({
        visible: true,
        kind: "selection",
        title: "划词翻译",
        content: result.translatedText,
        meta: `第 ${result.page} 页 · 模型 ${result.modelUsed}`,
        loading: false,
        error: null,
        explanation: null,
        selectedText: selection.text,
        page: selection.page,
        saved: false,
        saving: false,
      });
    },
    [],
  );

  const enqueueAutoTranslation = useCallback(
    (selection: SelectedPdfText) => {
      if (!session || !sourceType || !sourceId || !selection.text.trim())
        return;
      const queue = autoQueueRef.current;
      queue.pending = selection;
      if (queue.running) return;
      queue.running = true;
      void (async () => {
        try {
          while (queue.pending) {
            const target = queue.pending;
            queue.pending = null;
            const key = buildSelectionCacheKey(target.page, target.text);
            queue.activeKey = key;
            const cached = translationCacheRef.current.get(key);
            setAiPanel({
              visible: true,
              kind: "selection",
              title: "划词翻译",
              content: cached?.translatedText ?? "",
              meta: cached
                ? `第 ${cached.page} 页 · 模型 ${cached.modelUsed}`
                : null,
              loading: !cached,
              error: null,
              explanation: null,
              selectedText: target.text,
              page: target.page,
              saving: false,
              saved: false,
            });
            if (cached) {
              showSelectionTranslation(target, cached);
              continue;
            }
            if (target.text.length > 2400) {
              setAiPanel((current) => ({
                ...current,
                loading: false,
                error: "划词翻译最多支持 2400 个字符，请缩小选区。",
              }));
              continue;
            }
            try {
              const result = await translateMobilePdfSelection(
                session.baseUrl,
                session.deviceToken,
                {
                  sourceType,
                  sourceId,
                  page: target.page,
                  text: target.text,
                },
              );
              translationCacheRef.current.set(key, result);
              if (queue.pending || queue.activeKey !== key) continue;
              showSelectionTranslation(target, result);
            } catch (error) {
              if (queue.pending || queue.activeKey !== key) continue;
              setAiPanel((current) => ({
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        } finally {
          queue.running = false;
          queue.activeKey = null;
          if (queue.pending) enqueueAutoTranslation(queue.pending);
        }
      })();
    },
    [session, showSelectionTranslation, sourceId, sourceType],
  );

  const handleWebViewMessage = useCallback(
    (event: NativeSyntheticEvent<{ data: string }>) => {
      const message = parsePdfViewerMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "ready") {
        const protocolVersion = message.protocolVersion ?? 1;
        setViewerReady(true);
        setViewerProtocolVersion(protocolVersion);
        setOnlineStatus("");
        if (message.pageCount) {
          setPageCount(message.pageCount);
          pageStateRef.current.pageCount = message.pageCount;
        }
        setOutlineEntries(message.outline);
        sendViewerCommand({ type: "hostReady" });
        if (
          shouldUseControlledPdfSelection(protocolVersion, message.capabilities)
        ) {
          sendViewerCommand({ type: "setViewMode", mode: viewMode });
          sendViewerCommand({
            type: "setSelectionMode",
            enabled: true,
          });
        } else {
          fallBackToOffline(
            "桌面 PDF 阅读器版本过旧，已切换离线阅读；请升级桌面端后重新连接。",
          );
        }
        return;
      }
      if (message.type === "page") {
        pageStateRef.current = {
          page: message.page,
          pageCount: message.pageCount ?? pageStateRef.current.pageCount,
        };
        setCurrentPage(message.page);
        setPageInput(String(message.page));
        if (message.pageCount) setPageCount(message.pageCount);
        return;
      }
      if (message.type === "selection") {
        if (!message.text && aiPanel.visible) {
          // WebView 因点击操作按钮失去焦点时会收到空 selection；
          // 在 AI 面板打开期间保留当前选区，避免选区栏/结果突然消失。
          return;
        }
        setSelectedText(message.text);
        setSelectedContext(message.context ?? "");
        setSelectedPage(message.page);
        if (!message.text) {
          const queue = autoQueueRef.current;
          queue.pending = null;
          queue.activeKey = null;
          setAiPanel((current) =>
            current.kind === "selection" && current.loading
              ? EMPTY_AI_PANEL
              : current,
          );
        }
        if (selectionTranslateMode && message.text) {
          enqueueAutoTranslation({
            text: message.text,
            page: message.page,
            context: message.context ?? "",
          });
        }
        return;
      }
      if (message.type === "viewMode") {
        setViewMode(message.mode);
        return;
      }
      if (message.type === "selectionMode") return;
      if (message.type === "interaction") {
        if (message.kind === "tap" || viewerReady) {
          setToolsVisible(message.kind === "tap");
        }
        return;
      }
      if (message.type === "error") {
        fallBackToOffline(message.message || "桌面 AI 阅读器加载失败。");
      }
    },
    [
      aiPanel.visible,
      enqueueAutoTranslation,
      fallBackToOffline,
      selectionTranslateMode,
      sendViewerCommand,
      viewMode,
      viewerReady,
    ],
  );

  const runAiRequest = useCallback(
    async (kind: PdfAiKind) => {
      if (!session || !sourceType || !sourceId) {
        setErrorText("当前未连接桌面端，AI 功能暂不可用。");
        return;
      }
      const text = selectedText.trim();
      if (kind !== "page" && !text) {
        setErrorText("请先在 PDF 中选择文字。");
        return;
      }
      if (kind === "selection") {
        enqueueAutoTranslation({
          text,
          page: selectedPage,
          context: selectedContext,
        });
        return;
      }
      if (kind === "explanation" && text.length > 120) {
        setErrorText("术语解释最多支持 120 个字符，请缩小选区。");
        return;
      }
      const page = kind === "page" ? currentPage : selectedPage;
      setErrorText(null);
      setResultCollapsed(false);
      setAiPanel({
        visible: true,
        kind,
        title:
          kind === "explanation" ? `正在解释“${text}”` : `第 ${page} 页翻译`,
        content: "",
        meta: null,
        loading: true,
        error: null,
        explanation: null,
        selectedText: text,
        page,
        saved: false,
        saving: false,
      });
      try {
        if (kind === "page") {
          const result: MobilePdfTranslatePageResult =
            await translateMobilePdfPage(session.baseUrl, session.deviceToken, {
              sourceType,
              sourceId,
              page,
            });
          setAiPanel((current) => ({
            ...current,
            content: result.translatedMarkdown,
            meta: `第 ${result.page} 页 · 原文 ${result.sourceTextLength} 字 · 模型 ${result.modelUsed}`,
            loading: false,
          }));
          return;
        }
        const result = await explainMobilePdfSelection(
          session.baseUrl,
          session.deviceToken,
          {
            sourceType,
            sourceId,
            page,
            term: text,
            context: selectedContext || undefined,
            lookupMode: "popular_cn",
          },
        );
        setAiPanel((current) => ({
          ...current,
          title: `解释：${result.term}`,
          loading: false,
          explanation: result,
        }));
      } catch (error) {
        setAiPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [
      currentPage,
      enqueueAutoTranslation,
      selectedContext,
      selectedPage,
      selectedText,
      session,
      sourceId,
      sourceType,
    ],
  );

  const saveExplanation = useCallback(async () => {
    if (
      !session ||
      !sourceType ||
      !sourceId ||
      !aiPanel.explanation ||
      aiPanel.saving ||
      aiPanel.saved
    ) {
      return;
    }
    setAiPanel((current) => ({ ...current, saving: true, error: null }));
    try {
      await saveMobilePdfExplanationCard(session.baseUrl, session.deviceToken, {
        sourceType,
        sourceId,
        page: aiPanel.page,
        selectedText: aiPanel.selectedText,
        explanation: aiPanel.explanation,
      });
      await bootstrapSync();
      setAiPanel((current) => ({ ...current, saving: false, saved: true }));
      await queryClient.invalidateQueries({ queryKey: ["cards"] });
      await queryClient.invalidateQueries({ queryKey: ["due-review-cards"] });
    } catch (error) {
      setAiPanel((current) => ({
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [aiPanel, queryClient, session, sourceId, sourceType]);

  const handlePdfLoadComplete = useCallback(
    (
      numberOfPages: number,
      _path: string,
      _size: { height: number; width: number },
      tableContents?: TableContent[],
    ) => {
      setPageCount(numberOfPages);
      pageStateRef.current.pageCount = numberOfPages;
      setOutlineEntries(normalizeNativeOutline(tableContents));
      setStatusText("");
    },
    [],
  );

  const handlePdfPageChanged = useCallback(
    (page: number, numberOfPages: number) => {
      const previous = pageStateRef.current;
      if (previous.page === page && previous.pageCount === numberOfPages)
        return;
      pageStateRef.current = { page, pageCount: numberOfPages };
      setCurrentPage(page);
      setPageInput(String(page));
      setPageCount(numberOfPages);
      if (previous.pageCount !== null && previous.page !== page) {
        setToolsVisible(false);
      }
    },
    [],
  );

  const jumpToPage = useCallback(
    (requested: number) => {
      const target = Math.max(1, Math.min(pageCount ?? requested, requested));
      setCurrentPage(target);
      setPageInput(String(target));
      pageStateRef.current.page = target;
      if (isOnlineReader && viewerProtocolVersion >= 2) {
        sendViewerCommand({ type: "goToPage", page: target });
      } else {
        nativePdfRef.current?.setPage(target);
      }
      setOutlineVisible(false);
      setMoreVisible(false);
    },
    [isOnlineReader, pageCount, sendViewerCommand, viewerProtocolVersion],
  );

  const toggleViewMode = useCallback(() => {
    const next: PdfViewMode =
      viewMode === "continuous" ? "single" : "continuous";
    if (isOnlineReader && viewerProtocolVersion < 2) {
      if (localUri) {
        setReaderInitialPage(currentPage);
        setReaderMode("offline");
        setViewMode(next);
        setErrorText("旧版桌面阅读器不支持连续模式，已切换到离线阅读。");
      } else {
        setErrorText("请先升级桌面端或等待 PDF 离线缓存完成。");
      }
      return;
    }
    setViewMode(next);
    if (isOnlineReader) {
      sendViewerCommand({ type: "setViewMode", mode: next });
    } else {
      requestAnimationFrame(() => nativePdfRef.current?.setPage(currentPage));
    }
  }, [
    currentPage,
    isOnlineReader,
    localUri,
    sendViewerCommand,
    viewMode,
    viewerProtocolVersion,
  ]);

  const toggleSelectionTranslateMode = useCallback(() => {
    if (!isOnlineReader || viewerProtocolVersion < 2) {
      setErrorText("划词翻译需要连接 1.1.15 或更新版本的桌面端。");
      return;
    }
    const next = !selectionTranslateMode;
    setSelectionTranslateMode(next);
    setToolsVisible(true);
    if (!next) {
      autoQueueRef.current.pending = null;
      sendViewerCommand({ type: "clearSelection" });
    } else if (selectedText.trim()) {
      enqueueAutoTranslation({
        text: selectedText,
        page: selectedPage,
        context: selectedContext,
      });
    }
  }, [
    enqueueAutoTranslation,
    isOnlineReader,
    selectedContext,
    selectedPage,
    selectedText,
    selectionTranslateMode,
    sendViewerCommand,
    viewerProtocolVersion,
  ]);

  const switchReaderMode = useCallback(() => {
    if (readerMode === "online") {
      if (!localUri) {
        setErrorText("PDF 离线缓存尚未完成。");
        return;
      }
      setReaderInitialPage(currentPage);
      setReaderMode("offline");
      setSelectionTranslateMode(false);
      setMoreVisible(false);
      return;
    }
    if (!session) {
      setErrorText("请先连接桌面端。");
      return;
    }
    setReaderInitialPage(currentPage);
    setViewerReady(false);
    setOnlineStatus("正在重新连接桌面 AI 阅读器...");
    setReaderMode("online");
    setMoreVisible(false);
  }, [currentPage, localUri, readerMode, session]);

  useEffect(() => {
    if (!isOnlineReader || viewerReady) return;
    const timer = setTimeout(() => {
      fallBackToOffline("桌面 AI 阅读器加载超过 45 秒。");
    }, 45_000);
    return () => clearTimeout(timer);
  }, [fallBackToOffline, isOnlineReader, viewerReady, viewerUrl]);

  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={["top", "left", "right", "bottom"]}
    >
      <View style={styles.readerRoot}>
        <View style={styles.readerBody}>
          <View style={styles.documentPane}>
            {isOnlineReader && webViewSource ? (
              <WebView
                key={`${MOBILE_PDF_VIEWER_REVISION}:${viewerUrl}`}
                ref={webViewRef}
                source={webViewSource}
                originWhitelist={
                  companionOrigin ? [`${companionOrigin}/*`] : []
                }
                onMessage={handleWebViewMessage}
                onLoadStart={() => {
                  setViewerReady(false);
                  setOnlineStatus("正在连接桌面 AI 阅读器...");
                }}
                onLoad={() => {
                  setOnlineStatus("正在加载 PDF...");
                  sendViewerCommand({ type: "hostReady" });
                }}
                onError={() => fallBackToOffline("无法连接桌面 AI 阅读器。")}
                onHttpError={(event: { nativeEvent: { statusCode: number } }) =>
                  fallBackToOffline(
                    `桌面 AI 阅读器返回 ${event.nativeEvent.statusCode}。`,
                  )
                }
                onShouldStartLoadWithRequest={(request: { url: string }) =>
                  isAllowedViewerNavigation(request.url, companionOrigin)
                }
                javaScriptEnabled
                nestedScrollEnabled
                textZoom={100}
                domStorageEnabled={false}
                cacheEnabled={false}
                incognito
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                javaScriptCanOpenWindowsAutomatically={false}
                setSupportMultipleWindows={false}
                style={styles.viewer}
              />
            ) : pdfSource ? (
              <StablePdfView
                ref={nativePdfRef}
                source={pdfSource}
                initialPage={readerInitialPage}
                viewMode={viewMode}
                scale={offlineScale}
                onLoadComplete={handlePdfLoadComplete}
                onPageChanged={handlePdfPageChanged}
                onScaleChanged={setOfflineScale}
                onSingleTap={() => setToolsVisible((current) => !current)}
                onError={(error) => setErrorText(String(error))}
              />
            ) : (
              <View style={styles.centerState}>
                {statusText ? (
                  <ActivityIndicator color={palette.primary} />
                ) : null}
                <Text style={styles.statusText}>{errorText || statusText}</Text>
              </View>
            )}

            {isOnlineReader && onlineStatus ? (
              <View pointerEvents="none" style={styles.loadingOverlay}>
                <ActivityIndicator color={palette.primary} />
                <Text style={styles.statusText}>{onlineStatus}</Text>
              </View>
            ) : null}

            <View
              pointerEvents={toolsVisible ? "auto" : "none"}
              style={[styles.topBar, !toolsVisible && styles.toolsHidden]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="返回"
                style={styles.circleButton}
                onPress={() => router.back()}
              >
                <Ionicons name="arrow-back" size={21} color={palette.ink} />
              </Pressable>
              <View style={styles.titleCopy}>
                <Text style={styles.readerTitle} numberOfLines={1}>
                  {title}
                </Text>
                <Text style={styles.readerSubtitle} numberOfLines={1}>
                  {isOnlineReader ? "桌面 AI 已连接" : "离线阅读"}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="跳转页码"
                style={styles.pagePill}
                onPress={() => setMoreVisible(true)}
              >
                <Text style={styles.pagePillText}>
                  {currentPage} / {pageCount ?? "?"}
                </Text>
              </Pressable>
            </View>

            {selectedText && !selectionTranslateMode && isOnlineReader ? (
              <View style={styles.selectionBar}>
                <Text style={styles.selectionBarText} numberOfLines={1}>
                  {selectedText}
                </Text>
                <SelectionAction
                  label="翻译"
                  onPress={() => void runAiRequest("selection")}
                />
                <SelectionAction
                  label="解释"
                  onPress={() => void runAiRequest("explanation")}
                />
                <SelectionAction
                  label="复制"
                  onPress={() => Clipboard.setString(selectedText)}
                />
              </View>
            ) : null}

            <View
              pointerEvents={toolsVisible ? "auto" : "none"}
              style={[styles.bottomTools, !toolsVisible && styles.toolsHidden]}
            >
              <ReaderToolButton
                icon="list-outline"
                label="目录"
                onPress={() => setOutlineVisible(true)}
              />
              <ReaderToolButton
                icon={
                  viewMode === "continuous"
                    ? "reader-outline"
                    : "albums-outline"
                }
                label={viewMode === "continuous" ? "连续" : "单页"}
                active={viewMode === "continuous"}
                onPress={toggleViewMode}
              />
              <ReaderToolButton
                icon="language-outline"
                label="划词翻译"
                active={selectionTranslateMode}
                disabled={!isOnlineReader || viewerProtocolVersion < 2}
                onPress={toggleSelectionTranslateMode}
              />
              <ReaderToolButton
                icon="document-text-outline"
                label="本页译文"
                disabled={!isOnlineReader}
                onPress={() => void runAiRequest("page")}
              />
              <ReaderToolButton
                icon="ellipsis-horizontal"
                label="更多"
                onPress={() => setMoreVisible(true)}
              />
            </View>

            {errorText ? (
              <Pressable
                style={styles.errorToast}
                onPress={() => setErrorText(null)}
              >
                <Text style={styles.errorToastText}>{errorText}</Text>
              </Pressable>
            ) : null}
          </View>

          <MobilePdfResultDock
            visible={aiPanel.visible}
            collapsed={resultCollapsed}
            title={aiPanel.title}
            content={aiPanel.content}
            meta={aiPanel.meta}
            loading={aiPanel.loading}
            error={aiPanel.error}
            selectedText={aiPanel.selectedText}
            canExplain={
              aiPanel.kind === "selection" && aiPanel.selectedText.length <= 120
            }
            canSave={Boolean(aiPanel.explanation)}
            saving={aiPanel.saving}
            saved={aiPanel.saved}
            resultBody={
              aiPanel.explanation ? (
                <PdfExplanationResult
                  result={aiPanel.explanation}
                  page={aiPanel.page}
                />
              ) : undefined
            }
            onToggleCollapsed={() => setResultCollapsed((current) => !current)}
            onClose={() => {
              setResultCollapsed(true);
              setAiPanel((current) => ({ ...current, visible: false }));
            }}
            onCopy={() => Clipboard.setString(aiPanel.selectedText)}
            onExplain={() => void runAiRequest("explanation")}
            onRetry={() => void runAiRequest(aiPanel.kind)}
            onSave={() => void saveExplanation()}
          />
        </View>
      </View>

      <OutlineDrawer
        visible={outlineVisible}
        entries={displayedOutline}
        currentPage={currentPage}
        onSelect={jumpToPage}
        onClose={() => setOutlineVisible(false)}
      />

      <ReaderMoreSheet
        visible={moreVisible}
        pageInput={pageInput}
        pageCount={pageCount}
        readerMode={readerMode}
        hasSession={Boolean(session)}
        hasOfflineFile={Boolean(localUri)}
        onPageInputChange={(value) =>
          setPageInput(value.replace(/[^0-9]/g, ""))
        }
        onJump={() => jumpToPage(positiveInteger(pageInput) ?? currentPage)}
        onResetFit={() => {
          setOfflineScale(1);
          if (isOnlineReader) sendViewerCommand({ type: "resetFit" });
          setMoreVisible(false);
        }}
        onSwitchMode={switchReaderMode}
        onClose={() => setMoreVisible(false)}
      />
    </SafeAreaView>
  );
}

const StablePdfView = memo(
  forwardRef<
    PdfRef,
    {
      source: { uri: string };
      initialPage: number;
      viewMode: PdfViewMode;
      scale: number;
      onLoadComplete: (
        numberOfPages: number,
        path: string,
        size: { height: number; width: number },
        tableContents?: TableContent[],
      ) => void;
      onPageChanged: (page: number, numberOfPages: number) => void;
      onScaleChanged: (scale: number) => void;
      onSingleTap: () => void;
      onError: (error: unknown) => void;
    }
  >(function StablePdfView(
    {
      source,
      initialPage,
      viewMode,
      scale,
      onLoadComplete,
      onPageChanged,
      onScaleChanged,
      onSingleTap,
      onError,
    },
    ref,
  ) {
    return (
      <Pdf
        ref={ref}
        source={source}
        page={initialPage}
        scale={scale}
        horizontal={false}
        enablePaging={viewMode === "single"}
        enableAnnotationRendering={false}
        enableDoubleTapZoom
        spacing={viewMode === "continuous" ? 10 : 0}
        fitPolicy={viewMode === "continuous" ? 0 : 2}
        onLoadComplete={onLoadComplete}
        onPageChanged={onPageChanged}
        onScaleChanged={onScaleChanged}
        onPageSingleTap={onSingleTap}
        onError={onError}
        style={styles.viewer}
      />
    );
  }),
);

function ReaderToolButton({
  icon,
  label,
  active = false,
  disabled = false,
  onPress,
}: {
  icon: ToolIconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      style={[
        styles.toolButton,
        active && styles.toolButtonActive,
        disabled && styles.toolButtonDisabled,
      ]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={20}
        color={active ? "#ffffff" : palette.ink}
      />
      <Text style={[styles.toolLabel, active && styles.toolLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SelectionAction({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.selectionAction} onPress={onPress}>
      <Text style={styles.selectionActionText}>{label}</Text>
    </Pressable>
  );
}

function OutlineDrawer({
  visible,
  entries,
  currentPage,
  onSelect,
  onClose,
}: {
  visible: boolean;
  entries: PdfOutlineEntry[];
  currentPage: number;
  onSelect: (page: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={onClose} />
        <SafeAreaView
          style={styles.outlineDrawer}
          edges={["top", "left", "bottom"]}
        >
          <DrawerHeader
            title="目录"
            subtitle="选择章节或页码跳转"
            onClose={onClose}
          />
          <ScrollView contentContainerStyle={styles.outlineList}>
            {entries.length > 0 ? (
              entries.map((entry, index) => (
                <Pressable
                  key={`${entry.page}:${entry.title}:${index}`}
                  style={[
                    styles.outlineItem,
                    entry.page === currentPage && styles.outlineItemActive,
                    { paddingLeft: spacing.md + Math.min(entry.depth, 5) * 14 },
                  ]}
                  onPress={() => onSelect(entry.page)}
                >
                  <Text
                    style={[
                      styles.outlineTitle,
                      entry.page === currentPage && styles.outlineTitleActive,
                    ]}
                    numberOfLines={2}
                  >
                    {entry.title}
                  </Text>
                  <Text style={styles.outlinePage}>{entry.page}</Text>
                </Pressable>
              ))
            ) : (
              <Text style={styles.emptyOutline}>正在读取目录…</Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function ReaderMoreSheet({
  visible,
  pageInput,
  pageCount,
  readerMode,
  hasSession,
  hasOfflineFile,
  onPageInputChange,
  onJump,
  onResetFit,
  onSwitchMode,
  onClose,
}: {
  visible: boolean;
  pageInput: string;
  pageCount: number | null;
  readerMode: ReaderMode;
  hasSession: boolean;
  hasOfflineFile: boolean;
  onPageInputChange: (value: string) => void;
  onJump: () => void;
  onResetFit: () => void;
  onSwitchMode: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.modalRoot, styles.moreModalRoot]}>
        <Pressable style={styles.modalBackdrop} onPress={onClose} />
        <SafeAreaView style={styles.moreSheet} edges={["bottom"]}>
          <DrawerHeader
            title="阅读工具"
            subtitle="跳页、适宽与阅读来源"
            onClose={onClose}
          />
          <View style={styles.jumpRow}>
            <TextInput
              value={pageInput}
              keyboardType="number-pad"
              selectTextOnFocus
              style={styles.pageInput}
              onChangeText={onPageInputChange}
              onSubmitEditing={onJump}
            />
            <Text style={styles.pageTotal}>/ {pageCount ?? "?"}</Text>
            <Pressable style={styles.primaryButton} onPress={onJump}>
              <Text style={styles.primaryButtonText}>跳转</Text>
            </Pressable>
          </View>
          <MoreAction
            icon="scan-outline"
            title="恢复适宽"
            subtitle="重置缩放并保留当前页"
            onPress={onResetFit}
          />
          <MoreAction
            icon={readerMode === "online" ? "download-outline" : "wifi-outline"}
            title={
              readerMode === "online" ? "切换离线阅读" : "连接桌面 AI 阅读器"
            }
            subtitle={
              readerMode === "online"
                ? hasOfflineFile
                  ? "使用设备缓存继续阅读"
                  : "离线缓存尚未完成"
                : hasSession
                  ? "恢复划词翻译与术语解释"
                  : "当前没有桌面连接"
            }
            disabled={readerMode === "online" ? !hasOfflineFile : !hasSession}
            onPress={onSwitchMode}
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function DrawerHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <View style={styles.drawerHeader}>
      <View>
        <Text style={styles.drawerTitle}>{title}</Text>
        <Text style={styles.drawerSubtitle}>{subtitle}</Text>
      </View>
      <Pressable style={styles.circleButton} onPress={onClose}>
        <Ionicons name="close" size={21} color={palette.ink} />
      </Pressable>
    </View>
  );
}

function MoreAction({
  icon,
  title,
  subtitle,
  disabled = false,
  onPress,
}: {
  icon: ToolIconName;
  title: string;
  subtitle: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.moreAction, disabled && styles.toolButtonDisabled]}
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons name={icon} size={21} color={palette.primary} />
      <View style={styles.moreActionCopy}>
        <Text style={styles.moreActionTitle}>{title}</Text>
        <Text style={styles.moreActionSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

function isPdfSourceType(value: unknown): value is PdfSourceType {
  return value === "card" || value === "paper" || value === "workspacePdf";
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function getOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isAllowedViewerNavigation(
  url: string,
  companionOrigin: string | null,
) {
  if (url === "about:blank") return true;
  if (!companionOrigin) return false;
  return getOrigin(url) === companionOrigin;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#dfe3e8" },
  readerRoot: { flex: 1 },
  readerBody: { flex: 1, flexDirection: "row" },
  documentPane: { flex: 1, minWidth: 0, backgroundColor: "#dfe3e8" },
  viewer: {
    flex: 1,
    width: "100%",
    height: "100%",
    backgroundColor: "#dfe3e8",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.lg,
  },
  statusText: { color: palette.slate, lineHeight: 22, textAlign: "center" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
  },
  topBar: {
    position: "absolute",
    zIndex: 30,
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(209, 213, 219, 0.9)",
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.16,
    shadowRadius: 9,
    elevation: 8,
  },
  toolsHidden: { opacity: 0, transform: [{ translateY: 10 }] },
  circleButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.panel,
  },
  titleCopy: { flex: 1, minWidth: 0 },
  readerTitle: { color: palette.ink, fontSize: 15, fontWeight: "900" },
  readerSubtitle: { color: palette.slate, fontSize: 11, marginTop: 1 },
  pagePill: {
    minHeight: 40,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: 20,
    backgroundColor: palette.primarySoft,
  },
  pagePillText: { color: palette.primary, fontSize: 12, fontWeight: "900" },
  bottomTools: {
    position: "absolute",
    zIndex: 32,
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
    minHeight: 58,
    flexDirection: "row",
    alignItems: "stretch",
    padding: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(209, 213, 219, 0.9)",
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 10,
  },
  toolButton: {
    flex: 1,
    minWidth: 52,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: 15,
  },
  toolButtonActive: { backgroundColor: palette.primary },
  toolButtonDisabled: { opacity: 0.38 },
  toolLabel: { color: palette.ink, fontSize: 10, fontWeight: "800" },
  toolLabelActive: { color: "#ffffff" },
  selectionBar: {
    position: "absolute",
    zIndex: 34,
    left: spacing.md,
    right: spacing.md,
    bottom: 76,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.97)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.17,
    shadowRadius: 8,
    elevation: 9,
  },
  selectionBarText: { flex: 1, color: palette.slate, fontSize: 12 },
  selectionAction: {
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    backgroundColor: palette.primarySoft,
  },
  selectionActionText: { color: palette.primary, fontWeight: "900" },
  errorToast: {
    position: "absolute",
    zIndex: 65,
    top: 70,
    left: spacing.md,
    right: spacing.md,
    padding: spacing.sm,
    borderRadius: 12,
    backgroundColor: "rgba(153, 27, 27, 0.94)",
  },
  errorToastText: {
    color: "#ffffff",
    lineHeight: 18,
    textAlign: "center",
  },
  modalRoot: { flex: 1, alignItems: "flex-start" },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(29, 36, 48, 0.42)",
  },
  outlineDrawer: {
    width: "86%",
    maxWidth: 380,
    height: "100%",
    backgroundColor: palette.canvas,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
    overflow: "hidden",
  },
  drawerHeader: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  drawerTitle: { color: palette.ink, fontSize: 20, fontWeight: "900" },
  drawerSubtitle: { color: palette.slate, fontSize: 12, marginTop: 2 },
  outlineList: { paddingVertical: spacing.sm },
  outlineItem: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
  },
  outlineItemActive: { backgroundColor: palette.primarySoft },
  outlineTitle: { flex: 1, color: palette.ink, lineHeight: 19 },
  outlineTitleActive: { color: palette.primary, fontWeight: "900" },
  outlinePage: {
    color: palette.slate,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  emptyOutline: {
    color: palette.slate,
    padding: spacing.lg,
    textAlign: "center",
  },
  moreModalRoot: { justifyContent: "flex-end", alignItems: "stretch" },
  moreSheet: {
    maxHeight: "72%",
    backgroundColor: palette.canvas,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: spacing.lg,
  },
  jumpRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  pageInput: {
    width: 86,
    minHeight: 48,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 12,
    backgroundColor: palette.panel,
    color: palette.ink,
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
  },
  pageTotal: { flex: 1, color: palette.slate, fontSize: 16 },
  primaryButton: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: 14,
    backgroundColor: palette.primary,
  },
  primaryButtonText: { color: "#ffffff", fontWeight: "900" },
  moreAction: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 16,
    backgroundColor: palette.panel,
  },
  moreActionCopy: { flex: 1 },
  moreActionTitle: { color: palette.ink, fontWeight: "900" },
  moreActionSubtitle: { color: palette.slate, fontSize: 12, marginTop: 2 },
});
