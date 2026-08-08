import { useLocalSearchParams, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Pdf from "react-native-pdf";
import { ScreenShell } from "../src/components/ScreenShell";
import { ensurePdfCached } from "../src/lib/pdfCache";
import type { PdfSourceType } from "../src/lib/database";
import { palette, spacing } from "../src/theme";

export default function PdfReaderScreen() {
  const router = useRouter();
  const windowSize = useWindowDimensions();
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
  const pageStateRef = useRef({
    page: initialPage,
    pageCount: null as number | null,
  });
  const pdfSource = useMemo(
    () => (localUri ? { uri: localUri } : null),
    [localUri],
  );

  const readerFrame = useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(0, containerSize.width - spacing.md * 2);
    const maxHeight = Math.max(0, containerSize.height - spacing.sm * 2);
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
    windowSize.height,
    windowSize.width,
  ]);

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
      pageStateRef.current = { page: initialPage, pageCount: null };
      setStatusText("正在检查本地缓存...");
      setErrorText(null);
      try {
        const cached = await ensurePdfCached({
          sourceType,
          sourceId,
          title,
          pageHint: initialPage,
        });
        if (cancelled) return;
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
  }, [initialPage, sourceId, sourceType, title]);

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

  return (
    <ScreenShell
      title={title}
      subtitle={
        pageCount ? `第 ${currentPage} / ${pageCount} 页` : "PDF 阅读器"
      }
      scroll={false}
      contentStyle={styles.readerContent}
      headerRight={
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>返回</Text>
        </Pressable>
      }
    >
      <View style={styles.readerViewport} onLayout={handleReaderLayout}>
        <View style={[styles.readerPanel, readerFrame]}>
          {pdfSource ? (
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
        </View>
        {errorText && localUri ? (
          <Text style={styles.errorText}>{errorText}</Text>
        ) : null}
      </View>
    </ScreenShell>
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
      onLoadComplete={(numberOfPages, _path, size) => {
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
