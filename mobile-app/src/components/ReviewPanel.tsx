import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ReviewRating } from "../contracts";
import { listDueReviewCards } from "../lib/database";
import { queueLocalReview } from "../lib/sync";
import { palette, spacing } from "../theme";
import { ReviewDeckCard } from "./ReviewDeckCard";

const REVIEW_LABELS: Record<ReviewRating, string> = {
  again: "重来",
  hard: "困难",
  good: "良好",
  easy: "简单",
};

const REVIEW_COLORS: Record<ReviewRating, string> = {
  again: "#f8ded8",
  hard: "#f8ead6",
  good: "#ddf0e5",
  easy: "#d8eff2",
};

export function ReviewPanel({ onBrowseCards }: { onBrowseCards?: () => void }) {
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

  if (dueQuery.isLoading) {
    return (
      <View style={styles.centerPanel}>
        <ActivityIndicator color={palette.primary} />
      </View>
    );
  }

  if (!currentItem) {
    return (
      <View style={styles.centerPanel}>
        <Text style={styles.doneTitle}>今日复习已完成</Text>
        <Text style={styles.doneText}>当前没有到期卡片。</Text>
        {onBrowseCards ? (
          <Pressable style={styles.browseButton} onPress={onBrowseCards}>
            <Text style={styles.browseButtonText}>浏览知识卡片</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      <ReviewDeckCard
        card={currentItem.card}
        revealed={revealed}
        onReveal={() => setRevealed(true)}
      />
      {revealed ? (
        <View style={styles.ratingRow}>
          {(["again", "hard", "good", "easy"] as const).map((rating) => (
            <Pressable
              key={rating}
              onPress={() => void handleRate(rating)}
              disabled={isSubmitting}
              style={[
                styles.ratingButton,
                { backgroundColor: REVIEW_COLORS[rating] },
              ]}
            >
              <Text style={styles.ratingButtonText}>
                {REVIEW_LABELS[rating]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={styles.counterText}>
        剩余待复习：{dueQuery.data?.length ?? 0}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
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
  ratingRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  ratingButton: {
    flex: 1,
    minWidth: 130,
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: "center",
  },
  ratingButtonText: { color: palette.ink, fontWeight: "800" },
  counterText: { color: palette.slate, textAlign: "center" },
  doneTitle: { color: palette.ink, fontSize: 24, fontWeight: "800" },
  doneText: { color: palette.slate, textAlign: "center", lineHeight: 22 },
  browseButton: {
    marginTop: spacing.sm,
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  browseButtonText: { color: "#fff", fontWeight: "800" },
});
