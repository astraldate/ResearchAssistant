import type { ReactNode } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { palette, spacing } from "../theme";

interface MobileMarkdownProps {
  content: string;
  compact?: boolean;
  selectable?: boolean;
}

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "rule" };

export function MobileMarkdown({
  content,
  compact = false,
  selectable = true,
}: MobileMarkdownProps) {
  const blocks = parseBlocks(content);
  return (
    <View style={[styles.root, compact && styles.rootCompact]}>
      {blocks.map((block, index) => {
        const key = `${block.type}:${index}`;
        if (block.type === "heading") {
          return (
            <Text
              key={key}
              selectable={selectable}
              style={[
                styles.text,
                styles.heading,
                block.level === 1
                  ? styles.heading1
                  : block.level === 2
                    ? styles.heading2
                    : styles.heading3,
                compact && styles.compactText,
              ]}
            >
              {renderInline(block.text, key)}
            </Text>
          );
        }
        if (block.type === "quote") {
          return (
            <View key={key} style={styles.quote}>
              <Text
                selectable={selectable}
                style={[
                  styles.text,
                  styles.quoteText,
                  compact && styles.compactText,
                ]}
              >
                {renderInline(block.text, key)}
              </Text>
            </View>
          );
        }
        if (block.type === "list") {
          return (
            <View key={key} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`${key}:${itemIndex}`} style={styles.listRow}>
                  <Text style={[styles.marker, compact && styles.compactText]}>
                    {block.ordered ? `${itemIndex + 1}.` : "•"}
                  </Text>
                  <Text
                    selectable={selectable}
                    style={[
                      styles.text,
                      styles.listText,
                      compact && styles.compactText,
                    ]}
                  >
                    {renderInline(item, `${key}:${itemIndex}`)}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === "code") {
          return (
            <ScrollView key={key} horizontal style={styles.codeBlock}>
              <Text selectable={selectable} style={styles.codeBlockText}>
                {block.text}
              </Text>
            </ScrollView>
          );
        }
        if (block.type === "rule") {
          return <View key={key} style={styles.rule} />;
        }
        return (
          <Text
            key={key}
            selectable={selectable}
            style={[styles.text, compact && styles.compactText]}
          >
            {renderInline(block.text, key)}
          </Text>
        );
      })}
    </View>
  );
}

function parseBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      if (code) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: Math.min(3, heading[1].length),
        text: heading[2].replace(/\s+#+\s*$/, ""),
      });
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", text: quote[1] });
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const key = `${keyPrefix}:inline:${match.index}`;
    if (match[2] && match[3]) {
      const url = match[3];
      nodes.push(
        <Text
          key={key}
          style={styles.link}
          onPress={() => confirmOpenLink(url)}
        >
          {match[2]}
        </Text>,
      );
    } else if (match[4]) {
      nodes.push(
        <Text key={key} style={styles.inlineCode}>
          {match[4]}
        </Text>,
      );
    } else if (match[5] || match[6]) {
      nodes.push(
        <Text key={key} style={styles.bold}>
          {match[5] ?? match[6]}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={key} style={styles.italic}>
          {match[7] ?? match[8]}
        </Text>,
      );
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function confirmOpenLink(url: string) {
  Alert.alert("打开外部链接？", url, [
    { text: "取消", style: "cancel" },
    { text: "打开", onPress: () => void Linking.openURL(url) },
  ]);
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  rootCompact: { gap: spacing.xs },
  text: { color: palette.ink, fontSize: 16, lineHeight: 26 },
  compactText: { fontSize: 15, lineHeight: 23 },
  heading: { color: palette.ink, fontWeight: "800", marginTop: spacing.xs },
  heading1: { fontSize: 22, lineHeight: 29 },
  heading2: { fontSize: 19, lineHeight: 26 },
  heading3: { fontSize: 17, lineHeight: 24 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: palette.primary,
    backgroundColor: palette.primarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  quoteText: { color: palette.slate },
  list: { gap: spacing.xs },
  listRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  marker: {
    width: 22,
    color: palette.primary,
    fontSize: 16,
    lineHeight: 26,
    fontWeight: "700",
  },
  listText: { flex: 1 },
  codeBlock: { flexGrow: 0, borderRadius: 10, backgroundColor: palette.mist },
  codeBlockText: {
    color: palette.ink,
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
    padding: spacing.md,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.border,
    marginVertical: spacing.xs,
  },
  bold: { fontWeight: "800" },
  italic: { fontStyle: "italic" },
  inlineCode: {
    fontFamily: "monospace",
    color: palette.danger,
    backgroundColor: palette.mist,
  },
  link: {
    color: palette.primary,
    textDecorationLine: "underline",
    fontWeight: "700",
  },
});
