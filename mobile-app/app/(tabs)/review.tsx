import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ReviewRating } from "../../src/contracts";
import { ReviewDeckCard } from "../../src/components/ReviewDeckCard";
import { ScreenShell } from "../../src/components/ScreenShell";
import { listDueReviewCards } from "../../src/lib/database";
import { queueLocalReview } from "../../src/lib/sync";
import { palette, spacing } from "../../src/theme";

const REVIEW_LABELS: Record<ReviewRating, string> = {
  again: "重来",
  hard: "困难",
  good: "良好",
  easy: "简单",
};

const REVIEW_STYLES: Record<ReviewRating, { backgroundColor: string }> = {
  again: { backgroundColor: "#f8ded8" },
  hard: { backgroundColor: "#f8ead6" },
  good: { backgroundColor: "#ddf0e5" },
  easy: { backgroundColor: "#d8eff2" },
};

export default function ReviewScreen() {
  const [revealed, setRevealed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dueQuery = useQuery({
    queryKey: ["due-review-cards"],
    queryFn: () => listDueReviewCards(new Date().toISOString()),
  });
  const currentItem = dueQuery.data?.[0] ?? null;

  const handleRate = async (rating: ReviewRating) => {
    if (!currentItem) return;
    setIsSubmitting(true);
    try {
      await queueLocalReview(currentItem.card.id, rating);
      setRevealed(false);
      await dueQuery.refetch();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScreenShell title="今日复习" subtitle="手机端先离线记录评分，再把复习事件同步回桌面端。">
      {dueQuery.isLoading ? (
        <View style={styles.centerPanel}>
          <ActivityIndicator color={palette.primary} />
        </View>
      ) : currentItem ? (
        <>
          <ReviewDeckCard card={currentItem.card} revealed={revealed} onReveal={() => setRevealed(true)} />
          {revealed ? (
            <View style={styles.ratingRow}>
              {(["again", "hard", "good", "easy"] as const).map((rating) => (
                <Pressable
                  key={rating}
                  onPress={() => void handleRate(rating)}
                  disabled={isSubmitting}
                  style={[styles.ratingButton, REVIEW_STYLES[rating]]}
                >
                  <Text style={styles.ratingButtonText}>{REVIEW_LABELS[rating]}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Text style={styles.counterText}>剩余待复习：{dueQuery.data?.length ?? 0}</Text>
        </>
      ) : (
        <View style={styles.centerPanel}>
          <Text style={styles.doneTitle}>今天清空了</Text>
          <Text style={styles.doneText}>当前本地没有到期卡片。回到桌面端新增卡片，或稍后再同步一次。</Text>
        </View>
      )}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  centerPanel: {
    minHeight: 300,
    borderRadius: 24,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  ratingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  ratingButton: {
    flex: 1,
    minWidth: 130,
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: "center",
  },
  ratingButtonText: {
    color: palette.ink,
    fontWeight: "800",
  },
  counterText: {
    color: palette.slate,
    textAlign: "center",
  },
  doneTitle: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: "800",
  },
  doneText: {
    color: palette.slate,
    textAlign: "center",
    lineHeight: 22,
  },
});
