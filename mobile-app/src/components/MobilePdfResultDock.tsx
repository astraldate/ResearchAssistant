import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useResponsiveLayout } from "../lib/responsiveLayout";
import { palette, spacing } from "../theme";
import { MobileMarkdown } from "./MobileMarkdown";

interface MobilePdfResultDockProps {
  visible: boolean;
  collapsed: boolean;
  title: string;
  content: string;
  meta?: string | null;
  loading?: boolean;
  error?: string | null;
  resultBody?: ReactNode;
  selectedText?: string;
  canExplain?: boolean;
  canSave?: boolean;
  saving?: boolean;
  saved?: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
  onExplain?: () => void;
  onCopy?: () => void;
  onRetry?: () => void;
  onSave?: () => void;
}

export function MobilePdfResultDock({
  visible,
  collapsed,
  title,
  content,
  meta,
  loading = false,
  error,
  resultBody,
  selectedText,
  canExplain = false,
  canSave = false,
  saving = false,
  saved = false,
  onToggleCollapsed,
  onClose,
  onExplain,
  onCopy,
  onRetry,
  onSave,
}: MobilePdfResultDockProps) {
  const layout = useResponsiveLayout();
  if (!visible) return null;

  if (collapsed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="展开译文"
        style={[
          styles.collapsed,
          layout.isTabletLandscape
            ? styles.collapsedSide
            : styles.collapsedBottom,
        ]}
        onPress={onToggleCollapsed}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text style={styles.collapsedText}>译</Text>
        )}
      </Pressable>
    );
  }

  return (
    <View
      style={[
        styles.root,
        layout.isTabletLandscape ? styles.rootSide : styles.rootBottom,
      ]}
    >
      <View style={styles.handleRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>桌面端 AI</Text>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Pressable style={styles.headerButton} onPress={onToggleCollapsed}>
          <Text style={styles.headerButtonText}>收起</Text>
        </Pressable>
        <Pressable style={styles.headerButton} onPress={onClose}>
          <Text style={styles.headerButtonText}>关闭</Text>
        </Pressable>
      </View>

      {selectedText ? (
        <View style={styles.selectionRow}>
          <Text style={styles.selectionText} numberOfLines={1}>
            {selectedText}
          </Text>
          {onCopy ? (
            <Pressable style={styles.inlineButton} onPress={onCopy}>
              <Text style={styles.inlineButtonText}>复制</Text>
            </Pressable>
          ) : null}
          {canExplain && onExplain ? (
            <Pressable style={styles.inlineButton} onPress={onExplain}>
              <Text style={styles.inlineButtonText}>解释</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={palette.primary} />
            <Text style={styles.loadingText}>桌面端正在处理，请稍候…</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {error && onRetry ? (
          <Pressable style={styles.retryButton} onPress={onRetry}>
            <Text style={styles.retryButtonText}>重试</Text>
          </Pressable>
        ) : null}
        {!loading && !error && resultBody ? resultBody : null}
        {!loading && !error && !resultBody && content ? (
          <MobileMarkdown content={content} />
        ) : null}
        {meta && !loading ? <Text style={styles.metaText}>{meta}</Text> : null}
      </ScrollView>

      {canSave && !loading && !error && onSave ? (
        <Pressable
          style={[
            styles.saveButton,
            (saving || saved) && styles.saveButtonDisabled,
          ]}
          disabled={saving || saved}
          onPress={onSave}
        >
          {saving ? <ActivityIndicator size="small" color="#ffffff" /> : null}
          <Text style={styles.saveButtonText}>
            {saved ? "已保存到知识卡片" : "保存知识卡片"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    zIndex: 40,
    backgroundColor: palette.canvas,
    borderColor: palette.border,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 18,
  },
  rootSide: {
    width: 380,
    maxWidth: "38%",
    height: "100%",
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  rootBottom: {
    position: "absolute",
    left: spacing.sm,
    right: spacing.sm,
    bottom: 70,
    maxHeight: "46%",
    minHeight: 190,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
  },
  collapsed: {
    zIndex: 42,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.primary,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 12,
  },
  collapsedSide: {
    alignSelf: "center",
    marginHorizontal: spacing.sm,
  },
  collapsedBottom: {
    position: "absolute",
    right: spacing.md,
    bottom: 76,
  },
  collapsedText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "900",
  },
  handleRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  headerCopy: { flex: 1 },
  eyebrow: {
    color: palette.primary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  title: { color: palette.ink, fontSize: 16, fontWeight: "900" },
  headerButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  headerButtonText: { color: palette.slate, fontWeight: "800" },
  selectionRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  selectionText: { flex: 1, color: palette.slate, fontSize: 12 },
  inlineButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: 10,
    backgroundColor: palette.primarySoft,
  },
  inlineButtonText: { color: palette.primary, fontWeight: "800" },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.md, gap: spacing.md },
  loadingState: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  loadingText: { color: palette.slate },
  errorText: { color: palette.danger, lineHeight: 22 },
  retryButton: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  retryButtonText: { color: palette.primary, fontWeight: "900" },
  metaText: {
    color: palette.slate,
    fontSize: 12,
    lineHeight: 18,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  saveButton: {
    minHeight: 48,
    margin: spacing.md,
    marginTop: 0,
    borderRadius: 14,
    backgroundColor: palette.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  saveButtonDisabled: { opacity: 0.68 },
  saveButtonText: { color: "#ffffff", fontWeight: "900" },
});
