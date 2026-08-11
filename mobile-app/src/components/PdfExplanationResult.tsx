import type { MobilePdfExplainSelectionResult } from "../contracts";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { palette, spacing } from "../theme";
import { MobileMarkdown } from "./MobileMarkdown";

const STATUS_LABELS: Record<string, string> = {
  "source+model": "模型 + 百科资料",
  model_only: "仅模型解释",
  source_only: "百科降级结果",
};

const LOOKUP_LABELS: Record<string, string> = {
  popular_cn: "通俗百科",
  cs_encyclopedia: "CS 百科",
  bioinformatics: "生信百科",
};

export function PdfExplanationResult({
  result,
  page,
}: {
  result: MobilePdfExplainSelectionResult;
  page: number;
}) {
  const sourceOnly = result.sourceStatus === "source_only";
  const modelOnly = result.sourceStatus === "model_only";
  const primaryTitle = sourceOnly
    ? "百科资料摘要"
    : result.sourceStatus === "source+model"
      ? "AI 综合解释"
      : "模型解释";
  const primaryContent = sourceOnly
    ? result.sourceExtract || result.plainSummary
    : result.plainSummary;
  const showReference = Boolean(result.sourceExtract) && !sourceOnly;

  return (
    <View style={styles.root}>
      <View
        style={[styles.statusBanner, sourceOnly && styles.statusBannerWarning]}
      >
        <Text style={styles.statusText}>
          {STATUS_LABELS[result.sourceStatus] ?? "桌面端 AI 解释"}
        </Text>
        <Text style={styles.statusHint}>
          {sourceOnly
            ? "模型本次未能完成解释，已显示可用百科资料。"
            : modelOnly
              ? "本次未使用外部百科资料，结果来自模型与可用页面上下文。"
              : "模型解释与外部资料分开呈现，页面上下文仅作为原文证据。"}
        </Text>
      </View>

      <ExplanationSection title={primaryTitle}>
        <MobileMarkdown content={primaryContent} />
      </ExplanationSection>

      {showReference ? (
        <ExplanationSection title="百科 / 权威资料">
          <Text style={styles.sourceTitle}>
            {[result.sourceProvider, result.sourceTitle]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <MobileMarkdown content={result.sourceExtract ?? ""} />
        </ExplanationSection>
      ) : modelOnly ? (
        <Text style={styles.boundaryText}>本次未使用外部百科资料。</Text>
      ) : null}

      <ExplanationSection title={`页面上下文 · 第 ${page} 页`} quote>
        <Text style={styles.contextText}>
          {result.pageContextSnippet ||
            "本页未提取到可用文字上下文，本次解释未引用页面片段。"}
        </Text>
      </ExplanationSection>

      <View style={styles.generationMeta}>
        <Text style={styles.metaTitle}>生成信息</Text>
        <Text style={styles.metaText}>
          {[
            result.modelUsed ? `模型：${result.modelUsed}` : null,
            `资料模式：${LOOKUP_LABELS[result.lookupMode] ?? result.lookupMode}`,
            result.generatedAt ? `时间：${result.generatedAt}` : null,
          ]
            .filter(Boolean)
            .join("\n")}
        </Text>
      </View>
    </View>
  );
}

function ExplanationSection({
  title,
  quote = false,
  children,
}: {
  title: string;
  quote?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.section, quote && styles.quoteSection]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  statusBanner: {
    borderRadius: 14,
    backgroundColor: palette.primarySoft,
    padding: spacing.md,
    gap: spacing.xs,
  },
  statusBannerWarning: { backgroundColor: palette.secondarySoft },
  statusText: { color: palette.primary, fontSize: 14, fontWeight: "900" },
  statusHint: { color: palette.slate, lineHeight: 20 },
  section: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    padding: spacing.md,
    gap: spacing.sm,
  },
  quoteSection: {
    borderLeftWidth: 4,
    borderLeftColor: palette.primary,
    backgroundColor: palette.mist,
  },
  sectionTitle: { color: palette.ink, fontSize: 16, fontWeight: "900" },
  sourceTitle: { color: palette.primary, fontWeight: "800", lineHeight: 20 },
  boundaryText: { color: palette.slate, fontSize: 13, lineHeight: 20 },
  contextText: { color: palette.slate, lineHeight: 22 },
  generationMeta: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    paddingTop: spacing.md,
    gap: spacing.xs,
  },
  metaTitle: { color: palette.ink, fontWeight: "800" },
  metaText: { color: palette.slate, fontSize: 12, lineHeight: 18 },
});
