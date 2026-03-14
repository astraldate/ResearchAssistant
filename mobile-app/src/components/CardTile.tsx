import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileCardRecord } from "../contracts";
import { palette, spacing } from "../theme";

interface CardTileProps {
  card: MobileCardRecord;
  selected?: boolean;
  onPress?: () => void;
}

export function CardTile({ card, selected = false, onPress }: CardTileProps) {
  return (
    <Pressable onPress={onPress} style={[styles.card, selected && styles.selected]}>
      <View style={styles.row}>
        <Text style={styles.term}>{card.term || card.title}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{card.lookupMode}</Text>
        </View>
      </View>
      <Text style={styles.preview} numberOfLines={selected ? undefined : 4}>
        {card.preview || card.markdown}
      </Text>
      <Text style={styles.meta}>
        {card.sourceProvider || "本地卡片"} · {card.createdAt.slice(0, 10)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  selected: {
    borderColor: palette.primary,
    backgroundColor: "#f8fffe",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.sm,
    alignItems: "center",
  },
  term: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: palette.ink,
  },
  badge: {
    borderRadius: 999,
    backgroundColor: palette.secondarySoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: palette.secondary,
  },
  preview: {
    color: palette.slate,
    lineHeight: 22,
  },
  meta: {
    color: palette.slate,
    fontSize: 12,
  },
});
