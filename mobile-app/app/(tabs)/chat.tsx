import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  MobileChatMessage,
  MobileChatThread,
  MobileChatThreadSummary,
} from "../../src/contracts";
import { ScreenShell } from "../../src/components/ScreenShell";
import {
  fetchChatThread,
  fetchChatThreads,
  streamChatMessage,
} from "../../src/lib/api";
import { useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

export default function ChatScreen() {
  const session = useSessionStore((state) => state.session);
  const [threads, setThreads] = useState<MobileChatThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<MobileChatThread | null>(
    null,
  );
  const [input, setInput] = useState("");
  const [useRetrieval, setUseRetrieval] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = async () => {
    if (!session) return;
    setIsLoading(true);
    try {
      const nextThreads = await fetchChatThreads(
        session.baseUrl,
        session.deviceToken,
      );
      setThreads(nextThreads);
      if (!activeThread && nextThreads[0]) {
        const thread = await fetchChatThread(
          session.baseUrl,
          session.deviceToken,
          nextThreads[0].threadId,
        );
        setActiveThread(thread);
        setUseRetrieval(false);
      }
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.baseUrl, session?.deviceToken]);

  const openThread = async (threadId: string) => {
    if (!session) return;
    setError(null);
    const thread = await fetchChatThread(
      session.baseUrl,
      session.deviceToken,
      threadId,
    );
    setActiveThread(thread);
    setUseRetrieval(false);
  };

  const startNewThread = () => {
    setActiveThread(null);
    setInput("");
    setUseRetrieval(true);
  };

  const handleSend = async () => {
    if (!session || !input.trim() || isStreaming) return;
    const content = input.trim();
    setInput("");
    setError(null);
    setIsStreaming(true);

    const optimisticUser: MobileChatMessage = {
      messageId: `${Date.now()}-user`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      source: "mobile",
      status: "complete",
    };
    const optimisticAssistant: MobileChatMessage = {
      messageId: `${Date.now()}-assistant`,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      source: "desktop",
      status: "streaming",
    };

    setActiveThread((previous) =>
      previous
        ? {
            ...previous,
            messages: [
              ...previous.messages,
              optimisticUser,
              optimisticAssistant,
            ],
          }
        : {
            threadId: "",
            title: content.slice(0, 32) || "移动端会话",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            model: "",
            status: "streaming",
            messages: [optimisticUser, optimisticAssistant],
            lastError: null,
          },
    );

    try {
      await streamChatMessage(
        session.baseUrl,
        session.deviceToken,
        activeThread?.threadId || null,
        { message: content, useRetrieval },
        (event) => {
          if (event.type === "thread") {
            setActiveThread(event.thread);
            return;
          }
          if (event.type === "queued") {
            setActiveThread((previous) =>
              appendAssistantDelta(
                previous,
                "正在排队并准备检索上下文...\n\n",
                "streaming",
              ),
            );
            return;
          }
          if (event.type === "delta") {
            setActiveThread((previous) =>
              appendAssistantDelta(
                previous,
                event.delta,
                "streaming",
                event.phase,
              ),
            );
            return;
          }
          if (event.type === "error") {
            setError(event.error);
            setActiveThread((previous) =>
              markLastAssistant(previous, event.error),
            );
          }
          if (event.type === "done") {
            setActiveThread((previous) => markLastAssistantComplete(previous));
          }
        },
      );
      setUseRetrieval(false);
      await loadThreads();
    } catch (nextError) {
      const message = String(nextError);
      setError(message);
      setActiveThread((previous) => markLastAssistant(previous, message));
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <ScreenShell
      title="聊天"
      subtitle="把思路发回桌面端，由桌面模型结合知识库生成独立会话。"
      headerRight={
        <Pressable style={styles.headerButton} onPress={startNewThread}>
          <Text style={styles.headerButtonText}>新会话</Text>
        </Pressable>
      }
    >
      {!session ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>请先完成桌面端配对。</Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.threadRail}
          >
            {isLoading ? <ActivityIndicator color={palette.primary} /> : null}
            {threads.map((thread) => (
              <Pressable
                key={thread.threadId}
                style={[
                  styles.threadChip,
                  activeThread?.threadId === thread.threadId &&
                    styles.threadChipActive,
                ]}
                onPress={() => void openThread(thread.threadId)}
              >
                <Text style={styles.threadTitle} numberOfLines={1}>
                  {thread.title || "移动端会话"}
                </Text>
                <Text style={styles.threadMeta}>{thread.messageCount} 条</Text>
              </Pressable>
            ))}
          </ScrollView>

          <ScrollView
            style={styles.messagesPanel}
            contentContainerStyle={styles.messagesContent}
          >
            {activeThread?.messages.map((message) => (
              <View
                key={message.messageId}
                style={[
                  styles.messageBubble,
                  message.role === "user"
                    ? styles.userBubble
                    : styles.assistantBubble,
                ]}
              >
                <Text style={styles.messageRole}>
                  {message.role === "user" ? "我" : "桌面模型"}
                </Text>
                <Text style={styles.messageText}>
                  {formatMessageForDisplay(message)}
                </Text>
              </View>
            ))}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.composer}>
            <Pressable
              style={[
                styles.retrievalToggle,
                useRetrieval && styles.retrievalToggleActive,
              ]}
              onPress={() => setUseRetrieval((previous) => !previous)}
            >
              <Text
                style={[
                  styles.retrievalToggleText,
                  useRetrieval && styles.retrievalToggleTextActive,
                ]}
              >
                检索
              </Text>
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="输入问题或思路"
              placeholderTextColor={palette.slate}
              multiline
              style={styles.input}
            />
            <Pressable
              style={[
                styles.sendButton,
                isStreaming && styles.sendButtonDisabled,
              ]}
              onPress={() => void handleSend()}
              disabled={isStreaming}
            >
              <Text style={styles.sendButtonText}>
                {isStreaming ? "生成" : "发送"}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </ScreenShell>
  );
}

function markLastAssistant(
  thread: MobileChatThread | null,
  error: string,
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content: last.content || `生成中断：${error}`,
      status: "interrupted",
    };
  }
  return { ...thread, messages, status: "error", lastError: error };
}

function formatMessageForDisplay(message: MobileChatMessage) {
  if (message.role === "user") return message.content;
  const answer = stripThinkingBlock(message.content).trim();
  if (answer) return answer;
  if (message.content.includes("<think>")) {
    return message.status === "streaming"
      ? "正在思考，等待答案输出..."
      : "已完成思考，但没有生成可显示的答案。";
  }
  return message.content || (message.status === "streaming" ? "生成中..." : "");
}

function stripThinkingBlock(content: string) {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function appendAssistantDelta(
  thread: MobileChatThread | null,
  delta: string,
  status: MobileChatMessage["status"],
  phase?: "thinking" | "answer",
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return thread;
  const previousContent = last.content;
  const nextDelta =
    phase === "thinking"
      ? formatThinkingDelta(previousContent, delta)
      : closeOpenThinkingBlock(previousContent, delta);
  messages[messages.length - 1] = {
    ...last,
    content: `${previousContent}${nextDelta}`,
    status,
  };
  return { ...thread, messages };
}

function formatThinkingDelta(previousContent: string, delta: string) {
  if (!previousContent.includes("<think>")) {
    return `<think>\n${delta}`;
  }
  return delta;
}

function closeOpenThinkingBlock(previousContent: string, delta = "") {
  if (
    previousContent.includes("<think>") &&
    !previousContent.includes("</think>")
  ) {
    return `\n</think>\n\n${delta}`;
  }
  return delta;
}

function markLastAssistantComplete(
  thread: MobileChatThread | null,
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content:
        last.content.includes("<think>") && !last.content.includes("</think>")
          ? `${last.content}\n</think>\n\n`
          : last.content,
      status: "complete",
    };
  }
  return { ...thread, messages, status: "idle", lastError: null };
}

const styles = StyleSheet.create({
  headerButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  threadRail: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  threadChip: {
    width: 150,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    padding: spacing.md,
  },
  threadChipActive: {
    borderColor: palette.primary,
    backgroundColor: "#eef4ff",
  },
  threadTitle: {
    color: palette.ink,
    fontWeight: "800",
  },
  threadMeta: {
    color: palette.slate,
    marginTop: 4,
  },
  messagesPanel: {
    minHeight: 360,
  },
  messagesContent: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  messageBubble: {
    borderRadius: 18,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  userBubble: {
    backgroundColor: "#eef4ff",
  },
  assistantBubble: {
    backgroundColor: "#fffefb",
  },
  messageRole: {
    color: palette.slate,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  messageText: {
    color: palette.ink,
    lineHeight: 22,
  },
  errorText: {
    color: "#b42318",
    lineHeight: 20,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  retrievalToggle: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: palette.panel,
  },
  retrievalToggleActive: {
    borderColor: palette.primary,
    backgroundColor: palette.primary,
  },
  retrievalToggleText: {
    color: palette.slate,
    fontWeight: "800",
  },
  retrievalToggleTextActive: {
    color: "#fff",
  },
  input: {
    flex: 1,
    maxHeight: 120,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.ink,
  },
  sendButton: {
    borderRadius: 16,
    backgroundColor: palette.primary,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
  sendButtonText: {
    color: "#fff",
    fontWeight: "800",
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
