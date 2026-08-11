import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileNoteRecord } from "../contracts";
import { palette, spacing } from "../theme";

interface NoteTileProps {
  note: MobileNoteRecord;
  selected?: boolean;
  deleting?: boolean;
  onPress?: () => void;
  onDelete?: () => void;
}

export function NoteTile({
  note,
  selected = false,
  deleting = false,
  onPress,
  onDelete,
}: NoteTileProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.card, selected && styles.selected]}
    >
      <View style={styles.header}>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={2}>
            {note.title}
          </Text>
          {note.sourcePaper ? (
            <Text style={styles.source} numberOfLines={1}>
              来源：{note.sourcePaper}
            </Text>
          ) : null}
        </View>
        {onDelete ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`删除论文笔记 ${note.title}`}
            disabled={deleting}
            onPress={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            style={[styles.deleteButton, deleting && styles.deleteDisabled]}
          >
            <Ionicons name="trash-outline" size={20} color={palette.danger} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.preview} numberOfLines={selected ? undefined : 3}>
        {note.preview || note.markdown}
      </Text>
      <Text style={styles.meta}>{note.createdAt.slice(0, 10)}</Text>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  copy: { flex: 1, gap: 4 },
  title: { color: palette.ink, fontSize: 17, fontWeight: "800" },
  source: { color: palette.slate, fontSize: 12 },
  preview: { color: palette.slate, lineHeight: 22 },
  meta: { color: palette.slate, fontSize: 12 },
  deleteButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff0ed",
  },
  deleteDisabled: { opacity: 0.5 },
});
