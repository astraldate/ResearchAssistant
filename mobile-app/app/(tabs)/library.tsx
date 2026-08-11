import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CardTile } from "../../src/components/CardTile";
import { HubSwitch } from "../../src/components/HubSwitch";
import {
  KnowledgeEditorSheet,
  type KnowledgeEditorValue,
} from "../../src/components/KnowledgeEditorSheet";
import { MobileMarkdown } from "../../src/components/MobileMarkdown";
import { NoteTile } from "../../src/components/NoteTile";
import { ReviewPanel } from "../../src/components/ReviewPanel";
import { ScreenShell } from "../../src/components/ScreenShell";
import type { MobileCardRecord, MobileNoteRecord } from "../../src/contracts";
import {
  createMobileCard,
  createMobileNote,
  deleteMobileCard,
  deleteMobileNote,
  updateMobileCard,
  updateMobileNote,
} from "../../src/lib/api";
import {
  deleteLocalCard,
  deleteLocalNote,
  listCards,
  listDueReviewCards,
  listNotes,
} from "../../src/lib/database";
import { bootstrapSync } from "../../src/lib/sync";
import { useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

type KnowledgeView = "cards" | "notes" | "review";
type EditorState = {
  kind: "card" | "note";
  mode: "create" | "edit";
  id?: string;
  initialValue: KnowledgeEditorValue;
};

const SUBTITLES: Record<KnowledgeView, string> = {
  cards: "浏览桌面端同步到手机的知识卡片。",
  notes: "浏览桌面论文笔记，正文已移除桌面路径信息。",
  review: "离线记录复习评分，并在连接后同步回桌面端。",
};

export default function LibraryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ view?: string }>();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.session);
  const activeView: KnowledgeView =
    params.view === "notes" || params.view === "review" ? params.view : "cards";
  const [searchText, setSearchText] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const cardsQuery = useQuery({
    queryKey: ["cards", activeView === "cards" ? searchText : ""],
    queryFn: () => listCards(activeView === "cards" ? searchText : ""),
  });
  const notesQuery = useQuery({
    queryKey: ["notes", activeView === "notes" ? searchText : ""],
    queryFn: () => listNotes(activeView === "notes" ? searchText : ""),
  });
  const dueQuery = useQuery({
    queryKey: ["due-review-cards"],
    queryFn: () => listDueReviewCards(new Date().toISOString()),
  });

  const selectedCard =
    cardsQuery.data?.find((card) => card.id === selectedCardId) ?? null;
  const selectedNote =
    notesQuery.data?.find((note) => note.id === selectedNoteId) ?? null;

  const switchView = (view: KnowledgeView) => {
    setSearchText("");
    setSyncMessage(null);
    router.setParams({ view });
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setSyncMessage(null);
    try {
      const bootstrap = await bootstrapSync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cards"] }),
        queryClient.invalidateQueries({ queryKey: ["notes"] }),
        queryClient.invalidateQueries({ queryKey: ["due-review-cards"] }),
      ]);
      setSyncMessage(
        `已同步 ${bootstrap.cards.length} 张卡片、${bootstrap.notes?.length ?? 0} 篇笔记。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncMessage(`同步失败：${message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const executeDeleteCard = async (card: MobileCardRecord) => {
    if (!session) {
      setSyncMessage("连接桌面后才能删除知识卡片。");
      return;
    }
    setDeletingId(`card:${card.id}`);
    setSyncMessage(null);
    try {
      await deleteMobileCard(session.baseUrl, session.deviceToken, card.id);
      await deleteLocalCard(card.id);
      if (selectedCardId === card.id) setSelectedCardId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cards"] }),
        queryClient.invalidateQueries({ queryKey: ["due-review-cards"] }),
      ]);
      setSyncMessage(`已删除知识卡片“${card.title || card.term}”。`);
    } catch (error) {
      setSyncMessage(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setDeletingId(null);
    }
  };

  const executeDeleteNote = async (note: MobileNoteRecord) => {
    if (!session) {
      setSyncMessage("连接桌面后才能删除论文笔记。");
      return;
    }
    setDeletingId(`note:${note.id}`);
    setSyncMessage(null);
    try {
      await deleteMobileNote(session.baseUrl, session.deviceToken, note.id);
      await deleteLocalNote(note.id);
      if (selectedNoteId === note.id) setSelectedNoteId(null);
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
      setSyncMessage(`已删除论文笔记“${note.title}”。`);
    } catch (error) {
      setSyncMessage(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setDeletingId(null);
    }
  };

  const confirmDeleteCard = (card: MobileCardRecord) => {
    Alert.alert(
      "删除知识卡片",
      `删除“${card.title || card.term}”？该内容会同时从桌面端资料库删除，无法在手机端撤销。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => void executeDeleteCard(card),
        },
      ],
    );
  };

  const confirmDeleteNote = (note: MobileNoteRecord) => {
    Alert.alert(
      "删除论文笔记",
      `删除“${note.title}”？该内容会同时从桌面端笔记库删除，无法在手机端撤销。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => void executeDeleteNote(note),
        },
      ],
    );
  };

  const openCardPdf = (card: MobileCardRecord) => {
    if (!card.hasPdf) return;
    router.push({
      pathname: "/pdf-reader",
      params: {
        sourceType: "card",
        sourceId: card.id,
        title: card.title || card.term,
        page: card.pdfPage ? String(card.pdfPage) : undefined,
      },
    } as unknown as Href);
  };

  const openCreateEditor = (kind: "card" | "note") => {
    if (!session) {
      setSyncMessage("连接桌面后才能新建内容。");
      return;
    }
    setEditorError(null);
    setEditor({
      kind,
      mode: "create",
      initialValue: { term: "", title: "", markdown: "" },
    });
  };

  const openCardEditor = (card: MobileCardRecord) => {
    if (!session) {
      setSyncMessage("连接桌面后才能编辑知识卡片。");
      return;
    }
    setEditorError(null);
    setEditor({
      kind: "card",
      mode: "edit",
      id: card.id,
      initialValue: {
        term: card.term,
        title: card.title || card.term,
        markdown: markdownBodyForEditing(
          card.markdown,
          card.title || card.term,
        ),
      },
    });
  };

  const openNoteEditor = (note: MobileNoteRecord) => {
    if (!session) {
      setSyncMessage("连接桌面后才能编辑论文笔记。");
      return;
    }
    setEditorError(null);
    setEditor({
      kind: "note",
      mode: "edit",
      id: note.id,
      initialValue: {
        term: "",
        title: note.title,
        markdown: markdownBodyForEditing(note.markdown, note.title),
      },
    });
  };

  const saveEditor = async (value: KnowledgeEditorValue) => {
    if (!session || !editor) return;
    setIsSaving(true);
    setEditorError(null);
    try {
      if (editor.kind === "card") {
        const payload = {
          term: value.term.trim(),
          title: value.title.trim(),
          markdown: value.markdown.trim(),
        };
        const card =
          editor.mode === "create"
            ? await createMobileCard(
                session.baseUrl,
                session.deviceToken,
                payload,
              )
            : await updateMobileCard(
                session.baseUrl,
                session.deviceToken,
                editor.id!,
                payload,
              );
        setSelectedCardId(card.id);
        setSyncMessage(
          `${editor.mode === "create" ? "已新建" : "已更新"}知识卡片“${card.title || card.term}”。`,
        );
      } else {
        const payload = {
          title: value.title.trim(),
          markdown: value.markdown.trim(),
        };
        const note =
          editor.mode === "create"
            ? await createMobileNote(
                session.baseUrl,
                session.deviceToken,
                payload,
              )
            : await updateMobileNote(
                session.baseUrl,
                session.deviceToken,
                editor.id!,
                payload,
              );
        setSelectedNoteId(note.id);
        setSyncMessage(
          `${editor.mode === "create" ? "已新建" : "已更新"}论文笔记“${note.title}”。`,
        );
      }
      await bootstrapSync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cards"] }),
        queryClient.invalidateQueries({ queryKey: ["notes"] }),
        queryClient.invalidateQueries({ queryKey: ["due-review-cards"] }),
      ]);
      setEditor(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ScreenShell
      title="知识"
      subtitle={SUBTITLES[activeView]}
      scroll={false}
      contentStyle={styles.screenContent}
      headerRight={
        <Pressable
          style={[
            styles.headerButton,
            isRefreshing && styles.headerButtonDisabled,
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
      <HubSwitch
        value={activeView}
        options={[
          {
            value: "cards",
            label: "卡片",
            badge: cardsQuery.data?.length,
          },
          {
            value: "notes",
            label: "笔记",
            badge: notesQuery.data?.length,
          },
          {
            value: "review",
            label: "复习",
            badge: dueQuery.data?.length,
          },
        ]}
        onChange={switchView}
      />

      {activeView !== "review" ? (
        <View style={styles.libraryActions}>
          <Pressable
            style={styles.createButton}
            onPress={() =>
              openCreateEditor(activeView === "cards" ? "card" : "note")
            }
          >
            <Text style={styles.createButtonText}>
              + 新建{activeView === "cards" ? "卡片" : "笔记"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {activeView !== "review" ? (
        <TextInput
          value={searchText}
          onChangeText={setSearchText}
          placeholder={
            activeView === "cards"
              ? "搜索术语、标题或摘要"
              : "搜索笔记标题或摘要"
          }
          placeholderTextColor={palette.slate}
          style={styles.searchInput}
        />
      ) : null}
      {syncMessage ? (
        <Text
          style={[
            styles.syncMessage,
            syncMessage.includes("失败") && styles.errorMessage,
          ]}
        >
          {syncMessage}
        </Text>
      ) : null}

      <ScrollView
        style={styles.contentScroller}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {activeView === "cards" ? (
          cardsQuery.isLoading ? (
            <LoadingPanel />
          ) : cardsQuery.data?.length ? (
            <>
              {cardsQuery.data.map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  selected={selectedCard?.id === card.id}
                  deleting={deletingId === `card:${card.id}`}
                  onPress={() =>
                    setSelectedCardId((current) =>
                      current === card.id ? null : card.id,
                    )
                  }
                  onDelete={() => confirmDeleteCard(card)}
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
                        onPress={() => openCardPdf(selectedCard)}
                      >
                        <Text style={styles.openPdfButtonText}>打开 PDF</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={styles.editDetailButton}
                      onPress={() => openCardEditor(selectedCard)}
                    >
                      <Text style={styles.editDetailButtonText}>编辑</Text>
                    </Pressable>
                    <Pressable
                      style={styles.deleteDetailButton}
                      onPress={() => confirmDeleteCard(selectedCard)}
                    >
                      <Text style={styles.deleteDetailButtonText}>删除</Text>
                    </Pressable>
                  </View>
                  <MobileMarkdown content={selectedCard.markdown} />
                </View>
              ) : null}
            </>
          ) : (
            <EmptyPanel text="还没有知识卡片。连接桌面后执行同步，或在 PDF 中解释术语并保存。" />
          )
        ) : activeView === "notes" ? (
          notesQuery.isLoading ? (
            <LoadingPanel />
          ) : notesQuery.data?.length ? (
            <>
              {notesQuery.data.map((note) => (
                <NoteTile
                  key={note.id}
                  note={note}
                  selected={selectedNote?.id === note.id}
                  deleting={deletingId === `note:${note.id}`}
                  onPress={() =>
                    setSelectedNoteId((current) =>
                      current === note.id ? null : note.id,
                    )
                  }
                  onDelete={() => confirmDeleteNote(note)}
                />
              ))}
              {selectedNote ? (
                <View style={styles.detailPanel}>
                  <View style={styles.detailHeader}>
                    <Text style={styles.detailTitle}>{selectedNote.title}</Text>
                    <Pressable
                      style={styles.editDetailButton}
                      onPress={() => openNoteEditor(selectedNote)}
                    >
                      <Text style={styles.editDetailButtonText}>编辑</Text>
                    </Pressable>
                    <Pressable
                      style={styles.deleteDetailButton}
                      onPress={() => confirmDeleteNote(selectedNote)}
                    >
                      <Text style={styles.deleteDetailButtonText}>删除</Text>
                    </Pressable>
                  </View>
                  {selectedNote.sourcePaper ? (
                    <Text style={styles.noteSource}>
                      来源论文：{selectedNote.sourcePaper}
                    </Text>
                  ) : null}
                  <MobileMarkdown content={selectedNote.markdown} />
                </View>
              ) : null}
            </>
          ) : (
            <EmptyPanel text="还没有论文笔记。可在桌面端生成或新建笔记，然后回到这里同步。" />
          )
        ) : (
          <ReviewPanel onBrowseCards={() => switchView("cards")} />
        )}
      </ScrollView>
      <KnowledgeEditorSheet
        visible={Boolean(editor)}
        kind={editor?.kind ?? "card"}
        mode={editor?.mode ?? "create"}
        initialValue={
          editor?.initialValue ?? { term: "", title: "", markdown: "" }
        }
        saving={isSaving}
        error={editorError}
        onClose={() => setEditor(null)}
        onSave={(value) => void saveEditor(value)}
      />
    </ScreenShell>
  );
}

function LoadingPanel() {
  return (
    <View style={styles.emptyState}>
      <ActivityIndicator color={palette.primary} />
      <Text style={styles.emptyText}>正在读取本地同步数据...</Text>
    </View>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function markdownBodyForEditing(markdown: string, title: string) {
  const lines = markdown.replace(/\r\n/g, "\n").trim().split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (
    firstContentIndex >= 0 &&
    lines[firstContentIndex].trim().toLowerCase() ===
      `# ${title.trim()}`.toLowerCase()
  ) {
    lines.splice(firstContentIndex, 1);
  }
  return lines.join("\n").trim();
}

const styles = StyleSheet.create({
  screenContent: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerButtonDisabled: { opacity: 0.65 },
  headerButtonText: { color: "#fff", fontWeight: "700" },
  libraryActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  createButton: {
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: palette.primarySoft,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  createButtonText: { color: palette.primary, fontWeight: "900" },
  searchInput: {
    flexShrink: 0,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.ink,
  },
  syncMessage: { color: palette.slate, lineHeight: 20 },
  errorMessage: { color: palette.danger },
  contentScroller: { flex: 1, minHeight: 0 },
  content: { gap: spacing.md, paddingBottom: spacing.lg },
  detailPanel: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    padding: spacing.lg,
    gap: spacing.sm,
  },
  detailTitle: { flex: 1, color: palette.ink, fontSize: 18, fontWeight: "800" },
  detailHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    alignItems: "center",
  },
  openPdfButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  openPdfButtonText: { color: "#fff", fontWeight: "800" },
  editDetailButton: {
    borderRadius: 999,
    backgroundColor: palette.primarySoft,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  editDetailButtonText: { color: palette.primary, fontWeight: "800" },
  deleteDetailButton: {
    borderRadius: 999,
    backgroundColor: "#fff0ed",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  deleteDetailButtonText: { color: palette.danger, fontWeight: "800" },
  detailBody: { color: palette.slate, lineHeight: 24 },
  noteSource: { color: palette.primary, fontSize: 12, fontWeight: "700" },
  emptyState: {
    borderRadius: 22,
    padding: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.panel,
    minHeight: 180,
    gap: spacing.sm,
  },
  emptyText: { color: palette.slate, lineHeight: 22, textAlign: "center" },
});
