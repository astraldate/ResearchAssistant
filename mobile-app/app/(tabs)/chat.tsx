import { useEffect, useMemo, useRef, useState } from "react";
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
  deleteChatThread,
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
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const activeThreadRef = useRef<MobileChatThread | null>(null);
  const streamingThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeThreadIdRef.current = activeThread?.threadId || null;
    activeThreadRef.current = activeThread;
  }, [activeThread]);

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
    setStreamStatus(null);
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
    setError(null);
    setStreamStatus(null);
  };

  const handleDeleteThread = async (threadId: string) => {
    if (!session || streamingThreadIdRef.current === threadId) return;
    setError(null);
    try {
      await deleteChatThread(session.baseUrl, session.deviceToken, threadId);
      setThreads((previous) =>
        previous.filter((thread) => thread.threadId !== threadId),
      );
      if (activeThread?.threadId === threadId) {
        setActiveThread(null);
        setUseRetrieval(true);
      }
      await loadThreads();
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleSend = async () => {
    if (!session || !input.trim() || isStreaming) return;
    const content = input.trim();
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    setInput("");
    setError(null);
    setStreamStatus("正在连接桌面端...");
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

    let recoveryThreadId = activeThread?.threadId || "";
    try {
      await streamChatMessage(
        session.baseUrl,
        session.deviceToken,
        recoveryThreadId || null,
        { message: content, useRetrieval, thinkingEnabled },
        (event) => {
          if (event.type === "thread") {
            recoveryThreadId = event.thread.threadId;
            streamingThreadIdRef.current = event.thread.threadId;
            setThreads((previous) =>
              upsertThreadSummary(previous, event.thread),
            );
            if (
              !activeThreadIdRef.current ||
              activeThreadIdRef.current === event.thread.threadId
            ) {
              setActiveThread(event.thread);
            }
            setStreamStatus(
              useRetrieval
                ? "桌面端已接收，准备检索知识库上下文..."
                : "桌面端已接收，准备调用模型...",
            );
            return;
          }
          if (event.type === "queued") {
            setStreamStatus("模型队列中，等待桌面端空闲...");
            setActiveThread((previous) =>
              shouldApplyStreamingUpdate(previous, recoveryThreadId)
                ? appendAssistantDelta(
                    previous,
                    useRetrieval
                      ? "正在排队，随后会检索上下文并生成回答...\n\n"
                      : "正在排队，随后会直接生成回答...\n\n",
                    "streaming",
                  )
                : previous,
            );
            return;
          }
          if (event.type === "status") {
            setStreamStatus(event.status);
            return;
          }
          if (event.type === "delta") {
            setStreamStatus(
              event.phase === "thinking"
                ? "模型正在思考..."
                : "正在流式输出回答...",
            );
            setActiveThread((previous) =>
              shouldApplyStreamingUpdate(previous, recoveryThreadId)
                ? appendAssistantDelta(
                    previous,
                    event.delta,
                    "streaming",
                    event.phase,
                  )
                : previous,
            );
            return;
          }
          if (event.type === "error") {
            setError(event.error);
            setStreamStatus("生成失败");
            setActiveThread((previous) =>
              shouldApplyStreamingUpdate(previous, recoveryThreadId)
                ? markLastAssistant(previous, event.error)
                : previous,
            );
          }
          if (event.type === "done") {
            setStreamStatus(null);
            setActiveThread((previous) =>
              shouldApplyStreamingUpdate(previous, recoveryThreadId)
                ? markLastAssistantComplete(previous)
                : previous,
            );
          }
        },
        abortController.signal,
      );
      setUseRetrieval(false);
      await loadThreads();
    } catch (nextError) {
      const message = String(nextError);
      if (
        nextError instanceof Error &&
        (nextError.name === "AbortError" || abortController.signal.aborted)
      ) {
        setError(null);
        setStreamStatus("已停止本次生成");
        setActiveThread((previous) =>
          markLastAssistantInterrupted(previous, "已停止本次生成。"),
        );
        if (recoveryThreadId) {
          await loadThreads();
        }
        return;
      }
      if (recoveryThreadId) {
        const recovered = await recoverThreadAfterStreamDrop(
          session.baseUrl,
          session.deviceToken,
          recoveryThreadId,
        );
        if (recovered) {
          if (
            shouldApplyStreamingUpdate(
              activeThreadRef.current,
              recoveryThreadId,
            )
          ) {
            setActiveThread(recovered);
          }
          setUseRetrieval(false);
          await loadThreads();
          const lastAssistant = [...recovered.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          if (lastAssistant?.status === "complete") {
            setError(null);
            setStreamStatus(null);
          } else {
            setError(
              "移动端流连接中断，桌面端仍可能继续生成；已刷新当前会话。",
            );
            setStreamStatus("已从桌面端刷新会话");
          }
          return;
        }
      }
      setError(message);
      setStreamStatus("生成中断");
      setActiveThread((previous) => markLastAssistant(previous, message));
    } finally {
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
      }
      if (streamingThreadIdRef.current === recoveryThreadId) {
        streamingThreadIdRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  const handleStopStreaming = () => {
    streamAbortRef.current?.abort();
    setStreamStatus("正在停止...");
    setActiveThread((previous) =>
      markLastAssistantInterrupted(previous, "正在停止本次生成..."),
    );
  };

  return (
    <ScreenShell
      title="聊天"
      subtitle="把思路发回桌面端，由桌面模型结合知识库生成独立会话。"
      headerRight={
        <View style={styles.headerActions}>
          {activeThread?.threadId ? (
            <Pressable
              style={[styles.headerButton, styles.deleteHeaderButton]}
              onPress={() => void handleDeleteThread(activeThread.threadId)}
              disabled={streamingThreadIdRef.current === activeThread.threadId}
            >
              <Text style={styles.headerButtonText}>删除</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.headerButton} onPress={startNewThread}>
            <Text style={styles.headerButtonText}>新会话</Text>
          </Pressable>
        </View>
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
                <View style={styles.threadChipTop}>
                  <Text style={styles.threadTitle} numberOfLines={1}>
                    {thread.title || "移动端会话"}
                  </Text>
                  <Pressable
                    style={styles.threadDeleteButton}
                    onPress={(event) => {
                      event.stopPropagation();
                      void handleDeleteThread(thread.threadId);
                    }}
                    disabled={streamingThreadIdRef.current === thread.threadId}
                  >
                    <Text style={styles.threadDeleteText}>×</Text>
                  </Pressable>
                </View>
                <Text style={styles.threadMeta}>{thread.messageCount} 条</Text>
              </Pressable>
            ))}
          </ScrollView>

          {isStreaming || streamStatus ? (
            <View style={styles.streamStatusCard}>
              {isStreaming ? (
                <ActivityIndicator color={palette.primary} />
              ) : null}
              <View style={styles.streamStatusCopy}>
                <Text style={styles.streamStatusTitle}>
                  {streamStatus || "正在等待桌面端..."}
                </Text>
                <Text style={styles.streamStatusHint}>
                  如果长时间停在这里，请确认桌面端已经重启到最新版，且 Ollama
                  没有被上一条生成卡住。
                </Text>
              </View>
              {isStreaming ? (
                <Pressable
                  style={styles.stopInlineButton}
                  onPress={handleStopStreaming}
                >
                  <Text style={styles.stopInlineButtonText}>停止</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

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
                <MobileMessageContent message={message} />
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
                styles.thinkingToggle,
                thinkingEnabled && styles.thinkingToggleActive,
              ]}
              onPress={() => setThinkingEnabled((previous) => !previous)}
              disabled={isStreaming}
            >
              <Text
                style={[
                  styles.thinkingToggleText,
                  thinkingEnabled && styles.thinkingToggleTextActive,
                ]}
              >
                思考
              </Text>
            </Pressable>
            <Pressable
              style={[styles.sendButton, isStreaming && styles.stopButton]}
              onPress={() =>
                isStreaming ? handleStopStreaming() : void handleSend()
              }
            >
              <Text style={styles.sendButtonText}>
                {isStreaming ? "停止" : "发送"}
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

function shouldApplyStreamingUpdate(
  thread: MobileChatThread | null,
  streamingThreadId: string,
) {
  if (!thread) return false;
  if (!streamingThreadId) return true;
  return !thread.threadId || thread.threadId === streamingThreadId;
}

function upsertThreadSummary(
  threads: MobileChatThreadSummary[],
  thread: MobileChatThread,
) {
  const summary: MobileChatThreadSummary = {
    threadId: thread.threadId,
    title: thread.title,
    updatedAt: thread.updatedAt,
    model: thread.model,
    messageCount: thread.messages.length,
    status: thread.status,
    lastMessagePreview:
      [...thread.messages].reverse().find((message) => message.content.trim())
        ?.content ?? "",
    lastError: thread.lastError,
  };
  const next = threads.filter((item) => item.threadId !== thread.threadId);
  return [summary, ...next];
}

function markLastAssistantInterrupted(
  thread: MobileChatThread | null,
  fallback: string,
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content: last.content || fallback,
      status: "interrupted",
    };
  }
  return { ...thread, messages, status: "idle", lastError: null };
}

async function recoverThreadAfterStreamDrop(
  baseUrl: string,
  token: string,
  threadId: string,
) {
  for (const delayMs of [300, 1200, 3000]) {
    await delay(delayMs);
    try {
      const thread = await fetchChatThread(baseUrl, token, threadId);
      const lastAssistant = [...thread.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant?.content.trim() || thread.status !== "streaming") {
        return thread;
      }
    } catch {
      // Keep the original stream error if recovery cannot reach the desktop.
    }
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function MobileMessageContent({ message }: { message: MobileChatMessage }) {
  const [isReasoningExpanded, setIsReasoningExpanded] = useState(false);
  const parsed = useMemo(
    () => parseThinkingContent(message.content),
    [message.content],
  );

  if (message.role === "user") {
    return <Text style={styles.messageText}>{message.content}</Text>;
  }

  const answer = parsed.answer.trim();
  const reasoning = parsed.reasoning.trim();
  const fallback = formatAssistantFallback(message, answer, reasoning);

  return (
    <View style={styles.messageContentStack}>
      {reasoning ? (
        <View style={styles.reasoningBlock}>
          <Pressable
            style={styles.reasoningToggle}
            onPress={() => setIsReasoningExpanded((previous) => !previous)}
          >
            <Text style={styles.reasoningToggleText}>
              {isReasoningExpanded ? "隐藏思路" : "显示思路"}
            </Text>
            <Text style={styles.reasoningToggleIcon}>
              {isReasoningExpanded ? "⌃" : "⌄"}
            </Text>
          </Pressable>
          {isReasoningExpanded ? (
            <Text style={styles.reasoningText}>{reasoning}</Text>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.messageText}>{answer || fallback}</Text>
    </View>
  );
}

function formatAssistantFallback(
  message: MobileChatMessage,
  answer: string,
  reasoning: string,
) {
  if (answer) return answer;
  if (reasoning) {
    return message.status === "streaming"
      ? "正在思考，等待答案输出..."
      : "已完成思考，但没有生成可显示的答案。";
  }
  return (
    message.content ||
    (message.status === "streaming"
      ? "已发送到桌面端，正在等待第一段响应..."
      : "")
  );
}

function parseThinkingContent(content: string) {
  const openMatch = content.match(/<think>/i);
  if (!openMatch || openMatch.index == null) {
    return { reasoning: "", answer: content };
  }
  const openStart = openMatch.index;
  const thinkStart = openStart + openMatch[0].length;
  const before = content.slice(0, openStart).trim();
  const afterOpen = content.slice(thinkStart);
  const closeMatch = afterOpen.match(/<\/think>/i);
  if (!closeMatch || closeMatch.index == null) {
    return { reasoning: afterOpen.trim(), answer: before };
  }
  const reasoning = afterOpen.slice(0, closeMatch.index).trim();
  const answer = [
    before,
    afterOpen.slice(closeMatch.index + closeMatch[0].length).trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { reasoning, answer };
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
  headerActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  headerButton: {
    borderRadius: 999,
    backgroundColor: palette.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deleteHeaderButton: {
    backgroundColor: palette.danger,
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
  threadChipTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  threadChipActive: {
    borderColor: palette.primary,
    backgroundColor: "#eef4ff",
  },
  threadTitle: {
    flex: 1,
    color: palette.ink,
    fontWeight: "800",
  },
  threadDeleteButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f7ded9",
  },
  threadDeleteText: {
    color: palette.danger,
    fontSize: 18,
    fontWeight: "900",
    lineHeight: 20,
  },
  threadMeta: {
    color: palette.slate,
    marginTop: 4,
  },
  streamStatusCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.primarySoft,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  streamStatusCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  streamStatusTitle: {
    color: palette.ink,
    fontWeight: "800",
  },
  streamStatusHint: {
    color: palette.slate,
    lineHeight: 20,
  },
  stopInlineButton: {
    borderRadius: 14,
    backgroundColor: palette.danger,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stopInlineButtonText: {
    color: "#fff",
    fontWeight: "800",
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
  messageContentStack: {
    gap: spacing.sm,
  },
  reasoningBlock: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#f8fafc",
    overflow: "hidden",
  },
  reasoningToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reasoningToggleText: {
    color: palette.slate,
    fontWeight: "800",
  },
  reasoningToggleIcon: {
    color: palette.slate,
    fontSize: 18,
    lineHeight: 18,
    fontWeight: "900",
  },
  reasoningText: {
    borderTopWidth: 1,
    borderTopColor: palette.border,
    color: palette.slate,
    lineHeight: 20,
    padding: spacing.sm,
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
  thinkingToggle: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: palette.panel,
  },
  thinkingToggleActive: {
    borderColor: palette.primary,
    backgroundColor: "#eef4ff",
  },
  thinkingToggleText: {
    color: palette.slate,
    fontWeight: "800",
  },
  thinkingToggleTextActive: {
    color: palette.primary,
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
  stopButton: {
    backgroundColor: palette.danger,
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
