import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileCardRecord } from "../contracts";
import { MobileMarkdown } from "./MobileMarkdown";
import { palette, spacing } from "../theme";

interface ReviewDeckCardProps {
  card: MobileCardRecord;
  revealed: boolean;
  onReveal: () => void;
}

export function ReviewDeckCard({
  card,
  revealed,
  onReveal,
}: ReviewDeckCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{revealed ? "背面" : "正面"}</Text>
        <Text style={styles.smallMeta}>
          {card.sourceProvider || "Research Assistant"}
        </Text>
      </View>
      <Text style={styles.headline}>
        {revealed ? card.title || card.term : card.term || card.title}
      </Text>
      {revealed ? (
        <MobileMarkdown content={card.markdown} compact />
      ) : (
        <Text style={styles.body}>
          先回忆术语含义，再展开查看正文摘要和来源。
        </Text>
      )}
      {!revealed ? (
        <Pressable onPress={onReveal} style={styles.revealButton}>
          <Text style={styles.revealText}>显示答案</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 28,
    padding: spacing.lg,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    gap: spacing.md,
    minHeight: 320,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    color: palette.primary,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  smallMeta: {
    color: palette.slate,
    fontSize: 12,
  },
  headline: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 30,
  },
  body: {
    flex: 1,
    color: palette.slate,
    fontSize: 16,
    lineHeight: 24,
  },
  revealButton: {
    alignSelf: "flex-start",
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  revealText: {
    color: "#fff",
    fontWeight: "700",
  },
});
