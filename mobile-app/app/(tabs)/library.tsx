import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CardTile } from "../../src/components/CardTile";
import { ScreenShell } from "../../src/components/ScreenShell";
import { listCards } from "../../src/lib/database";
import { bootstrapSync } from "../../src/lib/sync";
import { palette, spacing } from "../../src/theme";

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const cardsQuery = useQuery({
    queryKey: ["cards", searchText],
    queryFn: () => listCards(searchText),
  });

  const selectedCard =
    cardsQuery.data?.find((card) => card.id === selectedCardId) ??
    cardsQuery.data?.[0] ??
    null;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setSyncMessage(null);
    try {
      const bootstrap = await bootstrapSync();
      await queryClient.invalidateQueries({ queryKey: ["cards"] });
      await queryClient.invalidateQueries({ queryKey: ["due-review-cards"] });
      const refreshed = await cardsQuery.refetch();
      const nextCards = refreshed.data ?? [];
      if (
        selectedCardId &&
        !nextCards.some((card) => card.id === selectedCardId)
      ) {
        setSelectedCardId(nextCards[0]?.id ?? null);
      }
      setSyncMessage(`已同步 ${bootstrap.cards.length} 张卡片。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncMessage(`同步失败：${message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOpenPdf = () => {
    if (!selectedCard?.hasPdf) return;
    router.push({
      pathname: "/pdf-reader",
      params: {
        sourceType: "card",
        sourceId: selectedCard.id,
        title: selectedCard.title || selectedCard.term,
        page: selectedCard.pdfPage ? String(selectedCard.pdfPage) : undefined,
      },
    });
  };

  return (
    <ScreenShell
      title="卡片库"
      subtitle="浏览桌面端同步到手机本地的 Markdown 卡片，搜索只查本机缓存。"
      headerRight={
        <Pressable
          style={[
            styles.headerButton,
            isRefreshing ? styles.headerButtonDisabled : null,
          ]}
          onPress={() => void handleRefresh()}
          disabled={isRefreshing}
        >
          <Text style={styles.headerButtonText}>
            {isRefreshing ? "同步中" : "立即同步"}
          </Text>
        </Pressable>
      }
    >
      <TextInput
        value={searchText}
        onChangeText={setSearchText}
        placeholder="搜索术语、标题或摘要"
        placeholderTextColor={palette.slate}
        style={styles.searchInput}
      />
      {syncMessage ? (
        <Text style={styles.syncMessage}>{syncMessage}</Text>
      ) : null}

      {cardsQuery.isLoading ? (
        <View style={styles.emptyState}>
          <ActivityIndicator color={palette.primary} />
        </View>
      ) : cardsQuery.data?.length ? (
        <>
          {cardsQuery.data.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              selected={selectedCard?.id === card.id}
              onPress={() => setSelectedCardId(card.id)}
            />
          ))}
          {selectedCard ? (
            <View style={styles.detailPanel}>
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>
                  {selectedCard.title || selectedCard.term}
                </Text>
                {selectedCard.hasPdf ? (
                  <Pressable
                    style={styles.openPdfButton}
                    onPress={handleOpenPdf}
                  >
                    <Text style={styles.openPdfButtonText}>打开 PDF</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.detailBody}>{selectedCard.markdown}</Text>
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>
            当前没有可用卡片。先完成桌面端配对，并执行一次同步。
          </Text>
        </View>
      )}
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
    fontWeight: "700",
  },
  searchInput: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.ink,
  },
  syncMessage: {
    color: palette.slate,
    lineHeight: 22,
  },
  detailPanel: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    padding: spacing.lg,
    gap: spacing.sm,
  },
  detailTitle: {
    flex: 1,
    color: palette.ink,
    fontSize: 18,
    fontWeight: "800",
  },
  detailHeader: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  openPdfButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  openPdfButtonText: {
    color: "#fff",
    fontWeight: "800",
  },
  detailBody: {
    color: palette.slate,
    lineHeight: 24,
  },
  emptyState: {
    borderRadius: 22,
    padding: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.panel,
    minHeight: 180,
  },
  emptyText: {
    color: palette.slate,
    lineHeight: 22,
    textAlign: "center",
  },
});
