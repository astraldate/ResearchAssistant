import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { MobileMarkdown } from "./MobileMarkdown";
import { palette, spacing } from "../theme";

interface MobilePdfAiPanelProps {
  visible: boolean;
  title: string;
  content: string;
  meta?: string | null;
  loading?: boolean;
  error?: string | null;
  canSave?: boolean;
  saving?: boolean;
  saved?: boolean;
  onClose: () => void;
  onSave?: () => void;
  footer?: ReactNode;
  resultBody?: ReactNode;
  loadingMessage?: string;
  onRetry?: () => void;
}

export function MobilePdfAiPanel({
  visible,
  title,
  content,
  meta,
  loading = false,
  error,
  canSave = false,
  saving = false,
  saved = false,
  onClose,
  onSave,
  footer,
  resultBody,
  loadingMessage,
  onRetry,
}: MobilePdfAiPanelProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭 AI 结果"
          style={styles.backdrop}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>桌面端 AI</Text>
              <Text style={styles.title}>{title}</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeButtonText}>关闭</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator
          >
            {loading ? (
              <View style={styles.loadingState}>
                <ActivityIndicator color={palette.primary} />
                <Text style={styles.loadingText}>
                  {loadingMessage || "桌面端正在分析，请稍候…"}
                </Text>
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
            {meta && !loading ? (
              <Text style={styles.metaText}>{meta}</Text>
            ) : null}
            {footer}
          </ScrollView>

          {canSave && !loading && !error ? (
            <Pressable
              style={[
                styles.saveButton,
                (saving || saved) && styles.saveButtonDisabled,
              ]}
              disabled={saving || saved}
              onPress={onSave}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : null}
              <Text style={styles.saveButtonText}>
                {saved ? "已保存到知识卡片" : "保存知识卡片"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(29, 36, 48, 0.42)",
  },
  sheet: {
    maxHeight: "78%",
    minHeight: 260,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: palette.canvas,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 16,
  },
  handle: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 99,
    backgroundColor: palette.border,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    color: palette.primary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  title: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: "800",
  },
  closeButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  closeButtonText: {
    color: palette.slate,
    fontWeight: "700",
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  loadingState: {
    minHeight: 130,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  loadingText: {
    color: palette.slate,
  },
  errorText: {
    color: palette.danger,
    lineHeight: 22,
  },
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
    borderRadius: 14,
    backgroundColor: palette.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  saveButtonDisabled: {
    opacity: 0.68,
  },
  saveButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
});
