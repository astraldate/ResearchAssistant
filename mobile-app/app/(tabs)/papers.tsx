import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ScreenShell } from "../../src/components/ScreenShell";
import { fetchMobilePapers } from "../../src/lib/api";
import { useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

export default function PapersScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const papersQuery = useQuery({
    queryKey: ["mobile-papers", session?.baseUrl, session?.deviceToken],
    enabled: Boolean(session),
    refetchInterval: session ? 10000 : false,
    queryFn: () => {
      if (!session) throw new Error("尚未完成配对。");
      return fetchMobilePapers(session.baseUrl, session.deviceToken);
    },
  });

  const handleRefresh = async () => {
    if (!session) return;
    setIsRefreshing(true);
    setRefreshMessage(null);
    try {
      const result = await papersQuery.refetch();
      if (result.error) {
        throw result.error;
      }
      setRefreshMessage(`已刷新 ${result.data?.length ?? 0} 篇论文。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRefreshMessage(`刷新失败：${message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOpenPdf = (paper: {
    paperId: string;
    title: string;
    hasPdf: boolean;
    sourceType: "paper" | "workspacePdf";
  }) => {
    if (!paper.hasPdf) return;
    router.push({
      pathname: "/pdf-reader",
      params: {
        sourceType: paper.sourceType,
        sourceId: paper.paperId,
        title: paper.title,
      },
    });
  };

  return (
    <ScreenShell
      title="论文"
      subtitle="从桌面端 Research Memory 打开已索引的 PDF。"
      headerRight={
        <Pressable
          style={[
            styles.headerButton,
            !session || isRefreshing ? styles.headerButtonDisabled : null,
          ]}
          onPress={() => void handleRefresh()}
          disabled={!session || isRefreshing}
        >
          <Text style={styles.headerButtonText}>
            {isRefreshing ? "刷新中" : "刷新"}
          </Text>
        </Pressable>
      }
    >
      {refreshMessage ? (
        <Text style={styles.refreshMessage}>{refreshMessage}</Text>
      ) : null}
      {!session ? (
        <View style={styles.centerPanel}>
          <Text style={styles.emptyText}>请先完成桌面端配对。</Text>
        </View>
      ) : papersQuery.isLoading ? (
        <View style={styles.centerPanel}>
          <ActivityIndicator color={palette.primary} />
        </View>
      ) : papersQuery.data?.length ? (
        papersQuery.data.map((paper) => (
          <View key={paper.paperId} style={styles.paperCard}>
            <View style={styles.paperText}>
              <Text style={styles.paperTitle}>{paper.title}</Text>
              <Text style={styles.paperMeta}>
                {paper.paperType || "paper"} 路 {paper.updatedAt.slice(0, 10)}
              </Text>
            </View>
            <Pressable
              style={[
                styles.openButton,
                !paper.hasPdf ? styles.openButtonDisabled : null,
              ]}
              onPress={() => handleOpenPdf(paper)}
              disabled={!paper.hasPdf}
            >
              <Text style={styles.openButtonText}>
                {paper.hasPdf ? "打开" : "无 PDF"}
              </Text>
            </Pressable>
          </View>
        ))
      ) : (
        <View style={styles.centerPanel}>
          <Text style={styles.emptyText}>桌面端还没有可用论文记录。</Text>
        </View>
      )}
      {papersQuery.error ? (
        <Text style={styles.errorText}>
          {papersQuery.error instanceof Error
            ? papersQuery.error.message
            : String(papersQuery.error)}
        </Text>
      ) : null}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  headerButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerButtonDisabled: {
    opacity: 0.65,
  },
  headerButtonText: {
    color: "#fff",
    fontWeight: "800",
  },
  refreshMessage: {
    color: palette.slate,
    lineHeight: 22,
  },
  centerPanel: {
    minHeight: 220,
    borderRadius: 22,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  paperCard: {
    borderRadius: 22,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  paperText: {
    flex: 1,
    gap: spacing.xs,
  },
  paperTitle: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 22,
  },
  paperMeta: {
    color: palette.slate,
    fontSize: 12,
  },
  openButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 72,
    alignItems: "center",
  },
  openButtonDisabled: {
    backgroundColor: palette.border,
  },
  openButtonText: {
    color: "#fff",
    fontWeight: "800",
  },
  emptyText: {
    color: palette.slate,
    textAlign: "center",
    lineHeight: 22,
  },
  errorText: {
    color: palette.danger,
    lineHeight: 22,
  },
});
