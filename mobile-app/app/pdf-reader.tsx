import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Pdf from "react-native-pdf";
import { WebView } from "react-native-webview";
import { MobilePdfAiPanel } from "../src/components/MobilePdfAiPanel";
import { PdfExplanationResult } from "../src/components/PdfExplanationResult";
import { ScreenShell } from "../src/components/ScreenShell";
import type { MobilePdfExplainSelectionResult } from "../src/contracts";
import {
  buildMobilePdfViewerUrl,
  explainMobilePdfSelection,
  normalizeBaseUrl,
  saveMobilePdfExplanationCard,
  selectFastestDesktopBaseUrl,
  translateMobilePdfPage,
  translateMobilePdfSelection,
} from "../src/lib/api";
import { ensurePdfCached, findCachedPdf } from "../src/lib/pdfCache";
import type { PdfSourceType } from "../src/lib/database";
import { useResponsiveLayout } from "../src/lib/responsiveLayout";
import { bootstrapSync } from "../src/lib/sync";
import { useSessionStore } from "../src/store/session";
import { palette, spacing } from "../src/theme";

export default function PdfReaderScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const windowSize = useWindowDimensions();
  const responsiveLayout = useResponsiveLayout();
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
  const initialPage = useMemo(() => {
    const parsed = Number(params.page);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [params.page]);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [readerInitialPage, setReaderInitialPage] = useState(initialPage);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [pageAspectRatio, setPageAspectRatio] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("正在准备 PDF...");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [readerMode, setReaderMode] = useState<ReaderMode>(() =>
    session ? "online" : "offline",
  );
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerBaseUrl, setViewerBaseUrl] = useState(
    session ? normalizeBaseUrl(session.baseUrl) : "",
  );
  const [onlineStatus, setOnlineStatus] = useState("正在连接桌面 AI 阅读器...");
  const [selectedText, setSelectedText] = useState("");
  const [selectedContext, setSelectedContext] = useState("");
  const [selectedPage, setSelectedPage] = useState(initialPage);
  const [aiPanel, setAiPanel] = useState<PdfAiPanelState>(EMPTY_AI_PANEL);
  const cacheTaskRef = useRef<{
    key: string;
    promise: ReturnType<typeof ensurePdfCached>;
  } | null>(null);
  const pageStateRef = useRef({
    page: initialPage,
    pageCount: null as number | null,
  });
  const previousLandscapeRef = useRef(responsiveLayout.isLandscape);
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
        ? buildMobilePdfViewerUrl(viewerBaseUrl, viewerSource)
        : null,
    [session, viewerBaseUrl, viewerSource],
  );
  const webViewSource = useMemo(
    () =>
      session && viewerUrl
        ? {
            uri: viewerUrl,
            headers: {
              Authorization: `Bearer ${session.deviceToken}`,
            },
          }
        : null,
    [session, viewerUrl],
  );
  const companionOrigin = useMemo(
    () => (viewerBaseUrl ? getOrigin(viewerBaseUrl) : null),
    [viewerBaseUrl],
  );

  const readerFrame = useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(0, containerSize.width - spacing.md * 2);
    const reservedHeight = responsiveLayout.isTabletLandscape
      ? 42
      : readerMode === "online"
        ? 142
        : 96;
    const maxHeight = Math.max(
      0,
      containerSize.height - spacing.sm * 2 - reservedHeight,
    );
    const aspectRatio = pageAspectRatio ?? 1 / 1.414;
    const heightFromWidth = maxWidth / aspectRatio;

    if (heightFromWidth <= maxHeight) {
      return { width: maxWidth, height: heightFromWidth };
    }

    return { width: maxHeight * aspectRatio, height: maxHeight };
  }, [
    containerSize.height,
    containerSize.width,
    pageAspectRatio,
    readerMode,
    responsiveLayout.isTabletLandscape,
    windowSize.height,
    windowSize.width,
  ]);

  useEffect(() => {
    if (previousLandscapeRef.current === responsiveLayout.isLandscape) return;
    previousLandscapeRef.current = responsiveLayout.isLandscape;
    // PDF.js 旋转后会重新排版文字层，旧选择坐标不再可靠。
    setSelectedText("");
    setSelectedContext("");
  }, [responsiveLayout.isLandscape]);

  const handleReaderLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((current) =>
      Math.abs(current.width - width) < 1 &&
      Math.abs(current.height - height) < 1
        ? current
        : { width, height },
    );
  };

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
      setPageAspectRatio(null);
      setCurrentPage(initialPage);
      setReaderInitialPage(initialPage);
      setSelectedPage(initialPage);
      setSelectedText("");
      setSelectedContext("");
      setAiPanel(EMPTY_AI_PANEL);
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

  const handlePdfLoadComplete = useCallback(
    (numberOfPages: number, size?: PdfPageSize) => {
      setPageCount((current) =>
        current === numberOfPages ? current : numberOfPages,
      );
      pageStateRef.current = {
        ...pageStateRef.current,
        pageCount: numberOfPages,
      };
      if (size?.width && size?.height) {
        const nextRatio = size.width / size.height;
        setPageAspectRatio((current) =>
          current && Math.abs(current - nextRatio) < 0.001
            ? current
            : nextRatio,
        );
      }
      setStatusText("");
    },
    [],
  );

  const handlePdfPageChanged = useCallback(
    (page: number, numberOfPages: number) => {
      const previous = pageStateRef.current;
      if (previous.page === page && previous.pageCount === numberOfPages) {
        return;
      }
      pageStateRef.current = { page, pageCount: numberOfPages };
      setCurrentPage((current) => (current === page ? current : page));
      setPageCount((current) =>
        current === numberOfPages ? current : numberOfPages,
      );
    },
    [],
  );

  const handlePdfError = useCallback((error: unknown) => {
    setErrorText(String(error));
  }, []);

  const fallBackToOffline = useCallback(
    (message: string) => {
      setReaderInitialPage(pageStateRef.current.page);
      setReaderMode("offline");
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

  const handleWebViewMessage = useCallback(
    (event: NativeSyntheticEvent<{ data: string }>) => {
      const message = parseViewerMessage(event.nativeEvent.data);
      if (!message) return;

      if (message.type === "ready") {
        setViewerReady(true);
        setOnlineStatus("");
        if (message.pageCount) {
          setPageCount(message.pageCount);
          pageStateRef.current.pageCount = message.pageCount;
        }
        return;
      }
      if (message.type === "page") {
        pageStateRef.current = {
          page: message.page,
          pageCount: message.pageCount ?? pageStateRef.current.pageCount,
        };
        setCurrentPage(message.page);
        setSelectedPage(message.page);
        if (message.pageCount) setPageCount(message.pageCount);
        return;
      }
      if (message.type === "selection") {
        setSelectedText(message.text);
        setSelectedContext(message.context ?? "");
        setSelectedPage(message.page);
        return;
      }
      if (message.type === "error") {
        fallBackToOffline(message.message || "桌面 AI 阅读器加载失败。");
      }
    },
    [fallBackToOffline],
  );

  const runAiRequest = useCallback(
    async (kind: PdfAiKind) => {
      if (!session || !sourceType || !sourceId) {
        setErrorText("当前未连接桌面端，AI 功能暂不可用。");
        return;
      }
      const text = selectedText.trim();
      if (kind !== "page" && !text) {
        setErrorText("请先点击阅读器中的“选字”，再按住文字拖动选择。");
        return;
      }
      if (kind === "selection" && text.length > 2400) {
        setErrorText("划词翻译最多支持 2400 个字符，请缩小选区后重试。");
        return;
      }
      if (kind === "explanation" && text.length > 120) {
        setErrorText("术语解释最多支持 120 个字符，请只选择需要解释的术语。");
        return;
      }

      const page = kind === "page" ? currentPage : selectedPage;
      setErrorText(null);
      setAiPanel({
        visible: true,
        kind,
        title:
          kind === "selection"
            ? "划词翻译"
            : kind === "explanation"
              ? `正在解释“${text}”`
              : `第 ${page} 页翻译`,
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
        if (kind === "selection") {
          const result = await translateMobilePdfSelection(
            session.baseUrl,
            session.deviceToken,
            { sourceType, sourceId, page, text },
          );
          setAiPanel((current) => ({
            ...current,
            content: result.translatedText,
            meta: `第 ${result.page} 页 · 模型 ${result.modelUsed}`,
            loading: false,
          }));
          return;
        }

        if (kind === "page") {
          const result = await translateMobilePdfPage(
            session.baseUrl,
            session.deviceToken,
            { sourceType, sourceId, page },
          );
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
          content: "",
          meta: null,
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

  const isOnlineReader =
    readerMode === "online" && Boolean(session && viewerUrl);

  useEffect(() => {
    if (!isOnlineReader || viewerReady) return;
    const timer = setTimeout(() => {
      fallBackToOffline("桌面 AI 阅读器加载超过 45 秒。");
    }, 45_000);
    return () => clearTimeout(timer);
  }, [fallBackToOffline, isOnlineReader, viewerReady, viewerUrl]);

  return (
    <ScreenShell
      title={title}
      subtitle={
        pageCount
          ? `第 ${currentPage} / ${pageCount} 页 · ${isOnlineReader ? "AI 阅读" : "离线阅读"}`
          : isOnlineReader
            ? "桌面 AI 阅读器"
            : "离线 PDF 阅读器"
      }
      scroll={false}
      contentStyle={styles.readerContent}
      maxContentWidth={responsiveLayout.width}
      safeAreaEdges={["top", "left", "right", "bottom"]}
      headerRight={
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>返回</Text>
        </Pressable>
      }
    >
      <View
        style={[
          styles.readerViewport,
          responsiveLayout.isTabletLandscape && styles.readerViewportLandscape,
        ]}
      >
        <View
          style={[
            styles.documentArea,
            responsiveLayout.isTabletLandscape && styles.documentAreaLandscape,
          ]}
          onLayout={handleReaderLayout}
        >
          <View
            style={[
              styles.modeBadge,
              isOnlineReader ? styles.modeBadgeOnline : styles.modeBadgeOffline,
            ]}
          >
            <View
              style={[
                styles.modeDot,
                isOnlineReader ? styles.modeDotOnline : styles.modeDotOffline,
              ]}
            />
            <Text style={styles.modeBadgeText}>
              {isOnlineReader ? "桌面 AI 已连接" : "离线阅读"}
            </Text>
          </View>
          <View style={[styles.readerPanel, readerFrame]}>
            {isOnlineReader && webViewSource ? (
              <WebView
                source={webViewSource}
                originWhitelist={
                  companionOrigin ? [`${companionOrigin}/*`] : []
                }
                onMessage={handleWebViewMessage}
                onLoadStart={() => {
                  setViewerReady(false);
                  setOnlineStatus("正在连接桌面 AI 阅读器...");
                }}
                onLoad={() => setOnlineStatus("正在加载 PDF 当前页...")}
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
                style={styles.webView}
              />
            ) : pdfSource ? (
              <StablePdfView
                source={pdfSource}
                initialPage={readerInitialPage}
                onLoadComplete={handlePdfLoadComplete}
                onPageChanged={handlePdfPageChanged}
                onError={handlePdfError}
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
              <View pointerEvents="none" style={styles.webLoadingOverlay}>
                <ActivityIndicator color={palette.primary} />
                <Text style={styles.statusText}>{onlineStatus}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View
          style={[
            styles.readerTools,
            responsiveLayout.isTabletLandscape && styles.readerToolsLandscape,
          ]}
        >
          {isOnlineReader ? (
            <View
              style={[
                styles.aiToolbar,
                responsiveLayout.isTabletLandscape && styles.aiToolbarLandscape,
              ]}
            >
              {selectedText ? (
                <View style={styles.selectionCopy}>
                  <Text style={styles.selectionLabel}>已选择</Text>
                  <Text numberOfLines={1} style={styles.selectionText}>
                    {selectedText}
                  </Text>
                </View>
              ) : (
                <Text style={styles.selectionHint}>
                  点击“选字”后直接拖动，松手后可翻译或解释
                </Text>
              )}
              <View
                style={[
                  styles.aiActions,
                  responsiveLayout.isTabletLandscape &&
                    styles.aiActionsLandscape,
                ]}
              >
                <AiActionButton
                  label="翻译选中"
                  disabled={!selectedText}
                  onPress={() => void runAiRequest("selection")}
                />
                <AiActionButton
                  label="解释术语"
                  disabled={!selectedText}
                  onPress={() => void runAiRequest("explanation")}
                />
                <AiActionButton
                  label="翻译本页"
                  emphasis
                  onPress={() => void runAiRequest("page")}
                />
              </View>
            </View>
          ) : (
            <View
              style={[
                styles.offlineNotice,
                responsiveLayout.isTabletLandscape &&
                  styles.offlineNoticeLandscape,
              ]}
            >
              <Text style={styles.offlineNoticeText}>
                {session
                  ? "AI 阅读器当前不可用；已保留阅读页码，连接恢复后可重新进入。"
                  : "连接桌面端后可使用划词翻译、术语解释和整页翻译。"}
              </Text>
              {session ? (
                <Pressable
                  style={styles.retryButton}
                  onPress={() => {
                    setErrorText(null);
                    setViewerReady(false);
                    setOnlineStatus("正在重新连接桌面 AI 阅读器...");
                    setReaderMode("online");
                  }}
                >
                  <Text style={styles.retryButtonText}>重新连接</Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
        </View>
      </View>
      <MobilePdfAiPanel
        visible={aiPanel.visible}
        title={aiPanel.title}
        content={aiPanel.content}
        meta={aiPanel.meta}
        loading={aiPanel.loading}
        error={aiPanel.error}
        loadingMessage={
          aiPanel.kind === "explanation"
            ? "桌面端正在结合页面上下文、外部资料与本地模型生成解释…"
            : undefined
        }
        resultBody={
          aiPanel.explanation ? (
            <PdfExplanationResult
              result={aiPanel.explanation}
              page={aiPanel.page}
            />
          ) : undefined
        }
        canSave={Boolean(aiPanel.explanation)}
        saving={aiPanel.saving}
        saved={aiPanel.saved}
        onSave={() => void saveExplanation()}
        onRetry={() => void runAiRequest(aiPanel.kind)}
        onClose={() => setAiPanel(EMPTY_AI_PANEL)}
      />
    </ScreenShell>
  );
}

function AiActionButton({
  label,
  disabled = false,
  emphasis = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  emphasis?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[
        styles.aiActionButton,
        emphasis && styles.aiActionButtonEmphasis,
        disabled && styles.aiActionButtonDisabled,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={[
          styles.aiActionButtonText,
          emphasis && styles.aiActionButtonTextEmphasis,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function isPdfSourceType(value: unknown): value is PdfSourceType {
  return value === "card" || value === "paper" || value === "workspacePdf";
}

type PdfSource = {
  uri: string;
};

type PdfPageSize = {
  width?: number;
  height?: number;
};

type ReaderMode = "online" | "offline";
type PdfAiKind = "selection" | "explanation" | "page";

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

type ViewerMessage =
  | { type: "ready"; pageCount?: number }
  | { type: "page"; page: number; pageCount?: number }
  | { type: "selection"; text: string; page: number; context?: string }
  | { type: "error"; message?: string };

function parseViewerMessage(value: string): ViewerMessage | null {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (raw.type === "ready") {
      return {
        type: "ready",
        pageCount: toPositiveNumber(raw.pageCount),
      };
    }
    if (
      raw.type === "page" ||
      raw.type === "pageChanged" ||
      raw.type === "page-change"
    ) {
      const page = toPositiveNumber(raw.page);
      return page
        ? { type: "page", page, pageCount: toPositiveNumber(raw.pageCount) }
        : null;
    }
    if (raw.type === "selection") {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      const context =
        typeof raw.context === "string"
          ? raw.context.trim().slice(0, 1400)
          : undefined;
      const page = toPositiveNumber(raw.page);
      return page ? { type: "selection", text, page, context } : null;
    }
    if (raw.type === "error") {
      return {
        type: "error",
        message: typeof raw.message === "string" ? raw.message : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function toPositiveNumber(value: unknown) {
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

const StablePdfView = memo(function StablePdfView({
  source,
  initialPage,
  onLoadComplete,
  onPageChanged,
  onError,
}: {
  source: PdfSource;
  initialPage: number;
  onLoadComplete: (numberOfPages: number, size?: PdfPageSize) => void;
  onPageChanged: (page: number, numberOfPages: number) => void;
  onError: (error: unknown) => void;
}) {
  return (
    <Pdf
      source={source}
      page={initialPage}
      enablePaging
      enableAnnotationRendering={false}
      spacing={0}
      fitPolicy={2}
      onLoadComplete={(
        numberOfPages: number,
        _path: string,
        size?: PdfPageSize,
      ) => {
        onLoadComplete(numberOfPages, size);
      }}
      onPageChanged={onPageChanged}
      onError={onError}
      style={styles.pdf}
    />
  );
});

const styles = StyleSheet.create({
  readerContent: {
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  readerViewport: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.cloud,
    paddingBottom: spacing.sm,
  },
  readerViewportLandscape: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
  },
  documentArea: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  documentAreaLandscape: {
    minWidth: 520,
  },
  readerTools: {
    width: "100%",
  },
  readerToolsLandscape: {
    width: 320,
    borderRadius: 18,
    overflow: "hidden",
    alignSelf: "center",
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 6,
    marginBottom: spacing.xs,
  },
  modeBadgeOnline: {
    backgroundColor: palette.primarySoft,
    borderColor: "#aad4d8",
  },
  modeBadgeOffline: {
    backgroundColor: palette.secondarySoft,
    borderColor: "#e8c99e",
  },
  modeDot: {
    width: 7,
    height: 7,
    borderRadius: 99,
  },
  modeDotOnline: {
    backgroundColor: palette.success,
  },
  modeDotOffline: {
    backgroundColor: palette.secondary,
  },
  modeBadgeText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: "800",
  },
  backButton: {
    borderRadius: 999,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backButtonText: {
    color: palette.primary,
    fontWeight: "800",
  },
  readerPanel: {
    overflow: "hidden",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#ffffff",
  },
  pdf: {
    flex: 1,
    width: "100%",
    height: "100%",
    backgroundColor: "#ffffff",
  },
  webView: {
    flex: 1,
    width: "100%",
    height: "100%",
    backgroundColor: "#ffffff",
  },
  webLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
  },
  aiToolbar: {
    width: "100%",
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.canvas,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  aiToolbarLandscape: {
    borderTopWidth: 0,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 18,
    padding: spacing.md,
  },
  selectionCopy: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  selectionLabel: {
    color: palette.primary,
    fontSize: 12,
    fontWeight: "800",
  },
  selectionText: {
    flex: 1,
    color: palette.slate,
    fontSize: 13,
  },
  selectionHint: {
    color: palette.slate,
    fontSize: 13,
    textAlign: "center",
  },
  aiActions: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  aiActionsLandscape: {
    flexDirection: "column",
  },
  aiActionButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xs,
  },
  aiActionButtonEmphasis: {
    borderColor: palette.primary,
    backgroundColor: palette.primary,
  },
  aiActionButtonDisabled: {
    opacity: 0.42,
  },
  aiActionButtonText: {
    color: palette.primary,
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
  },
  aiActionButtonTextEmphasis: {
    color: "#ffffff",
  },
  offlineNotice: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.secondarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  offlineNoticeLandscape: {
    borderTopWidth: 0,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 18,
    flexDirection: "column",
    alignItems: "stretch",
    padding: spacing.md,
  },
  offlineNoticeText: {
    flex: 1,
    color: palette.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  retryButton: {
    borderRadius: 999,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.secondary,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryButtonText: {
    color: palette.secondary,
    fontSize: 12,
    fontWeight: "800",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.lg,
  },
  statusText: {
    color: palette.slate,
    lineHeight: 22,
    textAlign: "center",
  },
  errorText: {
    color: palette.danger,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
});
