import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  MobileCitation,
  MobileChatMessage,
  MobileChatCommand,
  MobileChatPaperContext,
  MobileChatThread,
  MobileChatThreadSummary,
  MobileInnovationAnalysis,
  MobileInnovationIntent,
  MobilePaperRecord,
} from "../../src/contracts";
import { CapturePanel } from "../../src/components/CapturePanel";
import { HubSwitch } from "../../src/components/HubSwitch";
import { MobileMarkdown } from "../../src/components/MobileMarkdown";
import { ScreenShell } from "../../src/components/ScreenShell";
import {
  deleteChatThread,
  deleteMobileIdea,
  deleteMobileInnovationResult,
  detectInnovationIntent,
  fetchChatThread,
  fetchChatThreads,
  fetchMobilePapers,
  streamChatMessage,
} from "../../src/lib/api";
import { useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";
import {
  DEFAULT_PAPER_COMMAND_PROMPTS,
  resolveEmptyComposerRequest,
} from "../../src/lib/chatComposer";

type PendingInnovation = {
  message: string;
  intent: MobileInnovationIntent;
  conceptA: string;
  conceptB: string;
  command?: MobileChatCommand;
  paperContext?: MobileChatPaperContext;
};

const MOBILE_CHAT_COMMANDS: Array<{
  name: MobileChatCommand;
  title: string;
  description: string;
}> = [
  { name: "ask", title: "/ask", description: "针对所选论文直接问答" },
  { name: "method", title: "/method", description: "聚焦方法与技术路线" },
  { name: "exp", title: "/exp", description: "聚焦实验、消融与局限" },
  { name: "claim", title: "/claim", description: "提取核心论点与证据强弱" },
  { name: "brief", title: "/brief", description: "生成紧凑论文简报" },
  {
    name: "innovation",
    title: "/innovation",
    description: "分析 A+B 组合创新",
  },
];

function parseMobileSlashCommand(value: string) {
  const match = value.trim().match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const command = match[1].toLowerCase() as MobileChatCommand;
  if (!MOBILE_CHAT_COMMANDS.some((item) => item.name === command)) return null;
  return { command, content: (match[2] ?? "").trim() };
}

type ComposerSelection = { start: number; end: number };
type ComposerTrigger = {
  kind: "command" | "paper";
  start: number;
  end: number;
  query: string;
};

function activeComposerTrigger(
  value: string,
  selection: ComposerSelection,
): ComposerTrigger | null {
  if (selection.start !== selection.end) return null;
  const caret = Math.min(selection.end, value.length);
  const beforeCaret = value.slice(0, caret);
  const commandMatch = beforeCaret.match(/(^|\s)\/([a-zA-Z]*)$/);
  const paperMatch = beforeCaret.match(/(^|\s)@([^\n@]*)$/);
  const candidates: ComposerTrigger[] = [];
  if (commandMatch && commandMatch.index !== undefined) {
    candidates.push({
      kind: "command",
      start: commandMatch.index + commandMatch[1].length,
      end: caret,
      query: commandMatch[2] ?? "",
    });
  }
  if (paperMatch && paperMatch.index !== undefined) {
    candidates.push({
      kind: "paper",
      start: paperMatch.index + paperMatch[1].length,
      end: caret,
      query: paperMatch[2] ?? "",
    });
  }
  return candidates.sort((left, right) => right.start - left.start)[0] ?? null;
}

function commandToken(command: MobileChatCommand) {
  return `/${command}`;
}

function paperToken(paper: MobileChatPaperContext) {
  return `@「${paper.title}」`;
}

function replaceComposerRange(
  value: string,
  selection: ComposerSelection,
  replacement: string,
  trailingSpace = false,
) {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const leadingSpace = prefix && !/\s$/.test(prefix) ? " " : "";
  const tail = trailingSpace ? " " : "";
  const inserted = `${leadingSpace}${replacement}${tail}`;
  return {
    value: `${prefix}${inserted}${suffix}`,
    caret: prefix.length + inserted.length,
  };
}

function removeComposerToken(
  value: string,
  selection: ComposerSelection,
  token: string,
) {
  const index = value.indexOf(token);
  if (index < 0) return { value, selection };
  const end = index + token.length;
  const nextValue = `${value.slice(0, index)}${value.slice(end)}`;
  const shift = (position: number) =>
    position <= index ? position : Math.max(index, position - token.length);
  return {
    value: nextValue,
    selection: {
      start: shift(selection.start),
      end: shift(selection.end),
    },
  };
}

function stripStructuredComposerTokens(
  value: string,
  command: MobileChatCommand | null,
  paper: MobileChatPaperContext | null,
) {
  let content = value;
  if (command) content = content.replace(commandToken(command), "");
  if (paper) content = content.replace(paperToken(paper), "");
  return content.replace(/[ \t]{2,}/g, " ").trim();
}

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ view?: string }>();
  const activeView =
    params.view === "capture"
      ? "capture"
      : params.view === "innovation"
        ? "innovation"
        : "chat";
  const session = useSessionStore((state) => state.session);
  const [threads, setThreads] = useState<MobileChatThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<MobileChatThread | null>(
    null,
  );
  const [input, setInput] = useState("");
  const [innovationConceptA, setInnovationConceptA] = useState("");
  const [innovationConceptB, setInnovationConceptB] = useState("");
  const [useRetrieval, setUseRetrieval] = useState(true);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCheckingIntent, setIsCheckingIntent] = useState(false);
  const [pendingInnovation, setPendingInnovation] =
    useState<PendingInnovation | null>(null);
  const [selectedCommand, setSelectedCommand] =
    useState<MobileChatCommand | null>(null);
  const [selectedPaper, setSelectedPaper] =
    useState<MobileChatPaperContext | null>(null);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [isPaperMenuOpen, setIsPaperMenuOpen] = useState(false);
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>(
    { start: 0, end: 0 },
  );
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [deletingInnovationId, setDeletingInnovationId] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const activeThreadRef = useRef<MobileChatThread | null>(null);
  const streamingThreadIdRef = useRef<string | null>(null);
  const papersQuery = useQuery({
    queryKey: ["mobile-papers", session?.baseUrl, session?.deviceToken],
    enabled: Boolean(session),
    queryFn: () => {
      if (!session) throw new Error("尚未完成配对。");
      return fetchMobilePapers(session.baseUrl, session.deviceToken);
    },
    staleTime: 30_000,
  });
  const composerTrigger = useMemo(
    () => activeComposerTrigger(input, composerSelection),
    [composerSelection, input],
  );
  const visibleCommands = useMemo(() => {
    const slashDraft =
      composerTrigger?.kind === "command" ? composerTrigger.query : "";
    return MOBILE_CHAT_COMMANDS.filter((item) =>
      item.name.includes(slashDraft.toLowerCase()),
    );
  }, [composerTrigger]);
  const visiblePapers = useMemo(() => {
    const query =
      composerTrigger?.kind === "paper"
        ? composerTrigger.query.trim().toLowerCase()
        : "";
    return (papersQuery.data ?? [])
      .filter((paper) => !query || paper.title.toLowerCase().includes(query))
      .slice(0, 8);
  }, [composerTrigger, papersQuery.data]);
  const innovationMessages = useMemo(
    () =>
      (activeThread?.messages ?? [])
        .filter(
          (message) =>
            message.role === "assistant" && Boolean(message.innovationAnalysis),
        )
        .reverse(),
    [activeThread?.messages],
  );
  const directCommandHint = useMemo(() => {
    if (
      !selectedCommand ||
      !selectedPaper ||
      stripStructuredComposerTokens(input, selectedCommand, selectedPaper)
    ) {
      return null;
    }
    if (DEFAULT_PAPER_COMMAND_PROMPTS[selectedCommand]) {
      return `已选择 /${selectedCommand} 和 1 篇论文，可直接发送，也可补充侧重点。`;
    }
    if (selectedCommand === "ask") {
      return "请输入你想向这篇论文提问的问题。";
    }
    return null;
  }, [input, selectedCommand, selectedPaper]);

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
    setPendingInnovation(null);
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
    setComposerSelection({ start: 0, end: 0 });
    setPendingInnovation(null);
    setSelectedCommand(null);
    setSelectedPaper(null);
    setIsCommandMenuOpen(false);
    setIsPaperMenuOpen(false);
    setUseRetrieval(true);
    setError(null);
    setStreamStatus(null);
  };

  const switchHubView = (view: "chat" | "innovation" | "capture") => {
    setIsCommandMenuOpen(false);
    setIsPaperMenuOpen(false);
    router.setParams({ view });
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

  const confirmDeleteInnovationResult = (message: MobileChatMessage) => {
    if (!session || !activeThread || message.status === "streaming") return;
    Alert.alert(
      "删除分析记录？",
      "将删除本次创新提问和分析正文；桌面 Idea Map 中已经保存的创新点不会被删除。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除分析",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setDeletingInnovationId(message.messageId);
              setError(null);
              try {
                const thread = await deleteMobileInnovationResult(
                  session.baseUrl,
                  session.deviceToken,
                  activeThread.threadId,
                  message.messageId,
                );
                setActiveThread(thread);
                await loadThreads();
              } catch (nextError) {
                setError(String(nextError));
              } finally {
                setDeletingInnovationId(null);
              }
            })();
          },
        },
      ],
    );
  };

  const confirmDeleteIdea = (message: MobileChatMessage) => {
    if (!session || !activeThread || !message.ideaId) return;
    Alert.alert(
      "从 Idea Map 删除？",
      "只删除创新点节点及其论文关联边，不会删除来源论文、聊天分析正文或引用卡片。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除创新点",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setDeletingInnovationId(message.messageId);
              setError(null);
              try {
                await deleteMobileIdea(
                  session.baseUrl,
                  session.deviceToken,
                  message.ideaId!,
                );
                const thread = await fetchChatThread(
                  session.baseUrl,
                  session.deviceToken,
                  activeThread.threadId,
                );
                setActiveThread(thread);
              } catch (nextError) {
                setError(String(nextError));
              } finally {
                setDeletingInnovationId(null);
              }
            })();
          },
        },
      ],
    );
  };

  const applyComposerEdit = (value: string, caret: number) => {
    const nextSelection = { start: caret, end: caret };
    setInput(value);
    setComposerSelection(nextSelection);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({ selection: nextSelection });
    });
  };

  const insertComposerTrigger = (trigger: "/" | "@") => {
    const next = replaceComposerRange(input, composerSelection, trigger);
    applyComposerEdit(next.value, next.caret);
    setIsCommandMenuOpen(trigger === "/");
    setIsPaperMenuOpen(trigger === "@");
  };

  const chooseCommand = (command: MobileChatCommand) => {
    let workingValue = input;
    let workingSelection = composerSelection;
    if (selectedCommand) {
      const removed = removeComposerToken(
        workingValue,
        workingSelection,
        commandToken(selectedCommand),
      );
      workingValue = removed.value;
      workingSelection = removed.selection;
    }
    const trigger = activeComposerTrigger(workingValue, workingSelection);
    const replacementSelection =
      trigger?.kind === "command"
        ? { start: trigger.start, end: trigger.end }
        : workingSelection;
    const next = replaceComposerRange(
      workingValue,
      replacementSelection,
      commandToken(command),
      true,
    );
    setSelectedCommand(command);
    applyComposerEdit(next.value, next.caret);
    setIsCommandMenuOpen(false);
  };

  const choosePaper = (paper: MobilePaperRecord) => {
    const paperContext: MobileChatPaperContext = {
      sourceType: paper.sourceType,
      sourceId: paper.paperId,
      title: paper.title,
    };
    let workingValue = input;
    let workingSelection = composerSelection;
    if (selectedPaper) {
      const removed = removeComposerToken(
        workingValue,
        workingSelection,
        paperToken(selectedPaper),
      );
      workingValue = removed.value;
      workingSelection = removed.selection;
    }
    const trigger = activeComposerTrigger(workingValue, workingSelection);
    const replacementSelection =
      trigger?.kind === "paper"
        ? { start: trigger.start, end: trigger.end }
        : workingSelection;
    const next = replaceComposerRange(
      workingValue,
      replacementSelection,
      paperToken(paperContext),
      true,
    );
    setSelectedPaper(paperContext);
    applyComposerEdit(next.value, next.caret);
    setIsPaperMenuOpen(false);
  };

  const handleSend = async () => {
    if (
      !session ||
      !input.trim() ||
      isStreaming ||
      isCheckingIntent ||
      pendingInnovation
    )
      return;
    const visibleContent = stripStructuredComposerTokens(
      input,
      selectedCommand,
      selectedPaper,
    );
    const parsedCommand = selectedCommand
      ? null
      : parseMobileSlashCommand(visibleContent);
    const command = selectedCommand ?? parsedCommand?.command;
    let content = parsedCommand ? parsedCommand.content : visibleContent;
    const paperContext = selectedPaper ?? undefined;
    if (!content) {
      const resolved = resolveEmptyComposerRequest(command, paperContext);
      if (!resolved.content) {
        setError(resolved.error ?? "请输入问题。");
        return;
      }
      content = resolved.content;
    }
    setError(null);
    setIsCheckingIntent(true);
    setStreamStatus("正在识别是否需要 A+B 创新分析...");
    try {
      const intent = await detectInnovationIntent(
        session.baseUrl,
        session.deviceToken,
        { message: content },
      );
      const conceptA = intent.conceptA?.trim() || "";
      const conceptB = intent.conceptB?.trim() || "";
      if (intent.detected) {
        setInput("");
        setPendingInnovation({
          message: content,
          intent,
          conceptA,
          conceptB,
          command,
          paperContext,
        });
        setStreamStatus(null);
        return;
      }
    } catch {
      // 旧版桌面端可能没有创新意图接口，此时保持普通聊天可用。
    } finally {
      setIsCheckingIntent(false);
    }
    setStreamStatus(null);
    await sendChatMessage(content, undefined, command, paperContext);
  };

  const confirmInnovation = async () => {
    if (!pendingInnovation || isStreaming) return;
    const conceptA = pendingInnovation.conceptA.trim();
    const conceptB = pendingInnovation.conceptB.trim();
    if (!conceptA || !conceptB) {
      setError("概念 A 和概念 B 都不能为空。");
      return;
    }
    const current = pendingInnovation;
    setPendingInnovation(null);
    await sendChatMessage(
      current.message,
      {
        conceptA,
        conceptB,
        conceptAExpansion:
          conceptA === current.intent.conceptA?.trim()
            ? current.intent.conceptAExpansion?.trim() || undefined
            : undefined,
        conceptBExpansion:
          conceptB === current.intent.conceptB?.trim()
            ? current.intent.conceptBExpansion?.trim() || undefined
            : undefined,
      },
      current.command,
      current.paperContext,
    );
  };

  const cancelInnovation = async () => {
    if (!pendingInnovation || isStreaming) return;
    const content = pendingInnovation.message;
    setPendingInnovation(null);
    await sendChatMessage(
      content,
      undefined,
      pendingInnovation.command,
      pendingInnovation.paperContext,
    );
  };

  const sendChatMessage = async (
    content: string,
    innovationAnalysis?: MobileInnovationAnalysis,
    command?: MobileChatCommand,
    paperContext?: MobileChatPaperContext,
  ) => {
    if (!session || !content.trim() || isStreaming) return;
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    setInput("");
    setComposerSelection({ start: 0, end: 0 });
    setSelectedCommand(null);
    setSelectedPaper(null);
    setIsCommandMenuOpen(false);
    setIsPaperMenuOpen(false);
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
      command,
      paperContext,
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
        {
          message: content,
          useRetrieval,
          thinkingEnabled,
          ...(innovationAnalysis ? { innovationAnalysis } : {}),
          ...(command ? { command } : {}),
          ...(paperContext ? { paperContext } : {}),
        },
        (event) => {
          if (event.type === "sources") {
            const evidenceSides = new Set(
              event.citations.map((citation) => citation.label.charAt(0)),
            ).size;
            setStreamStatus(
              evidenceSides === 2
                ? "已找到两路论文证据，正在分析创新连接..."
                : evidenceSides === 1
                  ? "一侧缺少本地论文证据，正在按证据边界分析..."
                  : "未找到本地论文证据，正在基于通用知识分析...",
            );
            setActiveThread((previous) =>
              shouldApplyStreamingUpdate(previous, recoveryThreadId)
                ? attachAssistantSources(
                    previous,
                    event.citations,
                    event.innovationAnalysis,
                  )
                : previous,
            );
            return;
          }
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
          if (event.type === "idea") {
            if (event.error) {
              setStreamStatus(event.error);
            } else if (event.ideaId) {
              const ideaId = event.ideaId;
              setStreamStatus("创新分析已加入桌面 Idea Map");
              setActiveThread((previous) =>
                shouldApplyStreamingUpdate(previous, recoveryThreadId)
                  ? attachAssistantIdea(previous, ideaId)
                  : previous,
              );
            }
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

  const prepareInnovation = () => {
    const conceptA = innovationConceptA.trim();
    const conceptB = innovationConceptB.trim();
    if (!conceptA || !conceptB) {
      setError("请填写概念 A 和概念 B。");
      return;
    }
    setPendingInnovation({
      message: `能否在 ${conceptA} 上使用 ${conceptB} 进行创新分析？`,
      intent: {
        detected: true,
        conceptA,
        conceptB,
        conceptARole: "研究对象或问题",
        conceptBRole: "方法或技术",
      },
      conceptA,
      conceptB,
      command: "innovation",
    });
    setSelectedCommand("innovation");
    setInput("");
    switchHubView("chat");
  };

  return (
    <ScreenShell
      title={
        activeView === "chat"
          ? "聊天"
          : activeView === "innovation"
            ? "创新"
            : "采集"
      }
      subtitle={
        activeView === "chat"
          ? "把思路发回桌面端，由桌面模型结合知识库生成独立会话。"
          : activeView === "innovation"
            ? "组合两个研究概念，生成带本地论文证据的 A+B 创新分析。"
            : "把图片、URL 和备注发送到桌面端收件箱。"
      }
      scroll={false}
      contentStyle={styles.screenContent}
      headerRight={
        activeView === "chat" ? (
          <View style={styles.headerActions}>
            {activeThread?.threadId ? (
              <Pressable
                style={[styles.headerButton, styles.deleteHeaderButton]}
                onPress={() => void handleDeleteThread(activeThread.threadId)}
                disabled={
                  streamingThreadIdRef.current === activeThread.threadId
                }
              >
                <Text style={styles.headerButtonText}>删除</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.headerButton} onPress={startNewThread}>
              <Text style={styles.headerButtonText}>新会话</Text>
            </Pressable>
          </View>
        ) : null
      }
    >
      <HubSwitch
        value={activeView}
        options={[
          { value: "chat", label: "会话" },
          { value: "innovation", label: "创新" },
          { value: "capture", label: "采集" },
        ]}
        onChange={switchHubView}
      />
      {!session ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>请先完成桌面端配对。</Text>
        </View>
      ) : activeView === "capture" ? (
        <ScrollView
          style={styles.captureScroller}
          contentContainerStyle={styles.captureContent}
          keyboardShouldPersistTaps="handled"
        >
          <CapturePanel />
        </ScrollView>
      ) : activeView === "innovation" ? (
        <ScrollView
          style={styles.innovationScroller}
          contentContainerStyle={styles.innovationPage}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.innovationBuilder}>
            <View style={styles.innovationHeader}>
              <View style={styles.innovationBadge}>
                <Text style={styles.innovationBadgeText}>A+B</Text>
              </View>
              <View style={styles.innovationHeaderCopy}>
                <Text style={styles.innovationTitle}>生成组合创新分析</Text>
                <Text style={styles.innovationHint}>
                  桌面端会分别检索 A 与 B 的论文证据，并把有证据的创新点写入
                  Idea Map。
                </Text>
              </View>
            </View>
            <View style={styles.innovationBuilderFields}>
              <View style={styles.conceptField}>
                <Text style={styles.conceptLabel}>概念 A · 研究对象或问题</Text>
                <TextInput
                  value={innovationConceptA}
                  onChangeText={setInnovationConceptA}
                  placeholder="例如：阿尔茨海默病（AD）"
                  placeholderTextColor={palette.slate}
                  style={styles.conceptInput}
                />
              </View>
              <View style={styles.conceptField}>
                <Text style={styles.conceptLabel}>概念 B · 方法或技术</Text>
                <TextInput
                  value={innovationConceptB}
                  onChangeText={setInnovationConceptB}
                  placeholder="例如：图神经网络（GNN）"
                  placeholderTextColor={palette.slate}
                  style={styles.conceptInput}
                />
              </View>
            </View>
            <Pressable
              style={styles.innovationGenerateButton}
              onPress={prepareInnovation}
            >
              <Text style={styles.innovationGenerateButtonText}>
                确认概念并开始分析
              </Text>
            </Pressable>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>

          <View style={styles.innovationHistorySection}>
            <Text style={styles.innovationHistoryTitle}>
              当前会话的创新结果
            </Text>
            {innovationMessages.length ? (
              innovationMessages.map((message) => (
                <View
                  key={message.messageId}
                  style={styles.innovationHistoryCard}
                >
                  <Text style={styles.innovationHistoryConcepts}>
                    {message.innovationAnalysis?.conceptA} ×{" "}
                    {message.innovationAnalysis?.conceptB}
                  </Text>
                  <Text style={styles.mobileInnovationEvidenceStatus}>
                    {innovationEvidenceStatusLabel(
                      message.innovationAnalysis?.evidenceStatus,
                    )}
                    {message.ideaId ? " · 已加入桌面 Idea Map" : ""}
                  </Text>
                  <View style={styles.innovationHistoryActions}>
                    <Pressable
                      style={styles.innovationHistoryAction}
                      onPress={() => confirmDeleteInnovationResult(message)}
                      disabled={
                        deletingInnovationId === message.messageId ||
                        message.status === "streaming"
                      }
                    >
                      <Text style={styles.innovationHistoryActionText}>
                        删除分析
                      </Text>
                    </Pressable>
                    {message.ideaId ? (
                      <Pressable
                        style={[
                          styles.innovationHistoryAction,
                          styles.innovationHistoryActionDanger,
                        ]}
                        onPress={() => confirmDeleteIdea(message)}
                        disabled={deletingInnovationId === message.messageId}
                      >
                        <Text style={styles.innovationHistoryActionDangerText}>
                          从 Idea Map 删除
                        </Text>
                      </Pressable>
                    ) : null}
                    {deletingInnovationId === message.messageId ? (
                      <ActivityIndicator size="small" color={palette.primary} />
                    ) : null}
                  </View>
                  <MobileMarkdown
                    content={parseThinkingContent(message.content).answer}
                    compact
                  />
                </View>
              ))
            ) : (
              <View style={styles.innovationEmpty}>
                <Text style={styles.emptyText}>
                  当前会话还没有创新结果。填写两个概念即可开始。
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        <KeyboardAvoidingView
          style={styles.chatLayout}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 92 : 0}
        >
          <ScrollView
            horizontal
            style={styles.threadScroller}
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

          <ScrollView
            style={styles.messagesPanel}
            contentContainerStyle={styles.messagesContent}
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => {
              setIsCommandMenuOpen(false);
              setIsPaperMenuOpen(false);
            }}
          >
            {isStreaming || isCheckingIntent || streamStatus ? (
              <View style={styles.streamStatusCard}>
                {isStreaming || isCheckingIntent ? (
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

            {pendingInnovation ? (
              <View style={styles.innovationCard}>
                <View style={styles.innovationHeader}>
                  <View style={styles.innovationBadge}>
                    <Text style={styles.innovationBadgeText}>A+B</Text>
                  </View>
                  <View style={styles.innovationHeaderCopy}>
                    <Text style={styles.innovationTitle}>确认创新分析概念</Text>
                    <Text style={styles.innovationHint}>
                      桌面端将分别检索两个概念的论文，再分析可迁移机制与实验方案。
                    </Text>
                  </View>
                </View>
                <Text style={styles.innovationQuestion} numberOfLines={3}>
                  {pendingInnovation.message}
                </Text>
                <View style={styles.conceptRow}>
                  <View style={styles.conceptField}>
                    <Text style={styles.conceptLabel}>
                      概念 A
                      {pendingInnovation.intent.conceptARole
                        ? ` · ${pendingInnovation.intent.conceptARole}`
                        : ""}
                    </Text>
                    <TextInput
                      value={pendingInnovation.conceptA}
                      onChangeText={(conceptA) => {
                        setError(null);
                        setPendingInnovation((previous) =>
                          previous ? { ...previous, conceptA } : previous,
                        );
                      }}
                      placeholder="研究对象或问题"
                      placeholderTextColor={palette.slate}
                      style={styles.conceptInput}
                      editable={!isStreaming}
                    />
                    {pendingInnovation.intent.conceptAExpansion &&
                    pendingInnovation.conceptA.trim() ===
                      pendingInnovation.intent.conceptA?.trim() ? (
                      <Text style={styles.conceptExpansion}>
                        {pendingInnovation.intent.conceptAExpansion}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.conceptPlus}>
                    <Text style={styles.conceptPlusText}>+</Text>
                  </View>
                  <View style={styles.conceptField}>
                    <Text style={styles.conceptLabel}>
                      概念 B
                      {pendingInnovation.intent.conceptBRole
                        ? ` · ${pendingInnovation.intent.conceptBRole}`
                        : ""}
                    </Text>
                    <TextInput
                      value={pendingInnovation.conceptB}
                      onChangeText={(conceptB) => {
                        setError(null);
                        setPendingInnovation((previous) =>
                          previous ? { ...previous, conceptB } : previous,
                        );
                      }}
                      placeholder="方法或技术"
                      placeholderTextColor={palette.slate}
                      style={styles.conceptInput}
                      editable={!isStreaming}
                    />
                    {pendingInnovation.intent.conceptBExpansion &&
                    pendingInnovation.conceptB.trim() ===
                      pendingInnovation.intent.conceptB?.trim() ? (
                      <Text style={styles.conceptExpansion}>
                        {pendingInnovation.intent.conceptBExpansion}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {pendingInnovation.intent.ambiguityNote ? (
                  <Text style={styles.ambiguityNote}>
                    请确认：{pendingInnovation.intent.ambiguityNote}
                  </Text>
                ) : null}
                <View style={styles.innovationActions}>
                  <Pressable
                    style={styles.secondaryAction}
                    onPress={() => void cancelInnovation()}
                    disabled={isStreaming}
                  >
                    <Text style={styles.secondaryActionText}>
                      按普通聊天发送
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.primaryAction}
                    onPress={() => void confirmInnovation()}
                    disabled={isStreaming}
                  >
                    <Text style={styles.primaryActionText}>开始创新分析</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={styles.messageList}>
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
                  <MobileMessageContent
                    message={message}
                    onOpenCitation={(citation) =>
                      router.push({
                        pathname: "/pdf-reader",
                        params: {
                          sourceType: citation.sourceType,
                          sourceId: citation.paperId,
                          title: citation.title,
                          page: String(citation.pageStart || 1),
                        },
                      } as never)
                    }
                  />
                </View>
              ))}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          </ScrollView>

          <View style={styles.composerDock}>
            {isCommandMenuOpen ? (
              <ScrollView
                style={styles.composerMenu}
                contentContainerStyle={styles.composerMenuContent}
                keyboardShouldPersistTaps="always"
                nestedScrollEnabled
              >
                <Text style={styles.composerMenuTitle}>选择指令</Text>
                {visibleCommands.map((command) => (
                  <Pressable
                    key={command.name}
                    style={styles.composerMenuItem}
                    onPress={() => chooseCommand(command.name)}
                  >
                    <Text style={styles.composerMenuItemTitle}>
                      {command.title}
                    </Text>
                    <Text style={styles.composerMenuItemDescription}>
                      {command.description}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {!isCommandMenuOpen && isPaperMenuOpen ? (
              <ScrollView
                style={styles.composerMenu}
                contentContainerStyle={styles.composerMenuContent}
                keyboardShouldPersistTaps="always"
                nestedScrollEnabled
              >
                <Text style={styles.composerMenuTitle}>@ 选择论文</Text>
                {papersQuery.isLoading ? (
                  <ActivityIndicator color={palette.primary} />
                ) : visiblePapers.length ? (
                  visiblePapers.map((paper) => (
                    <Pressable
                      key={`${paper.sourceType}:${paper.paperId}`}
                      style={styles.composerMenuItem}
                      onPress={() => choosePaper(paper)}
                    >
                      <Text
                        style={styles.composerMenuItemTitle}
                        numberOfLines={2}
                      >
                        {paper.title}
                      </Text>
                      <Text style={styles.composerMenuItemDescription}>
                        {paper.sourceType === "paper"
                          ? "已索引论文"
                          : "工作区 PDF"}
                      </Text>
                    </Pressable>
                  ))
                ) : (
                  <Text style={styles.composerMenuEmpty}>没有匹配的论文。</Text>
                )}
              </ScrollView>
            ) : null}
            <View style={styles.composerToolbar}>
              <Pressable
                style={styles.composerToolButton}
                onPress={() => insertComposerTrigger("/")}
                disabled={isStreaming || isCheckingIntent}
              >
                <Text style={styles.composerToolButtonText}>/</Text>
              </Pressable>
              <Pressable
                style={styles.composerToolButton}
                onPress={() => insertComposerTrigger("@")}
                disabled={isStreaming || isCheckingIntent}
              >
                <Text style={styles.composerToolButtonText}>@</Text>
              </Pressable>
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
              <Pressable
                style={[
                  styles.thinkingToggle,
                  thinkingEnabled && styles.thinkingToggleActive,
                ]}
                onPress={() => setThinkingEnabled((previous) => !previous)}
                disabled={
                  isStreaming || isCheckingIntent || Boolean(pendingInnovation)
                }
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
            </View>
            {directCommandHint ? (
              <Text style={styles.composerDirectHint}>{directCommandHint}</Text>
            ) : null}
            <View style={styles.composer}>
              <TextInput
                ref={inputRef}
                value={input}
                onChangeText={(value) => {
                  setInput(value);
                  setError(null);
                  if (
                    selectedCommand &&
                    !value.includes(commandToken(selectedCommand))
                  ) {
                    setSelectedCommand(null);
                  }
                  if (
                    selectedPaper &&
                    !value.includes(paperToken(selectedPaper))
                  ) {
                    setSelectedPaper(null);
                  }
                  const trigger = activeComposerTrigger(
                    value,
                    composerSelection,
                  );
                  if (trigger?.kind === "command") {
                    setIsCommandMenuOpen(true);
                    setIsPaperMenuOpen(false);
                  } else if (trigger?.kind === "paper") {
                    setIsPaperMenuOpen(true);
                    setIsCommandMenuOpen(false);
                  }
                }}
                onSelectionChange={(event) =>
                  setComposerSelection(event.nativeEvent.selection)
                }
                placeholder="输入问题；用 / 选指令、@ 选论文"
                placeholderTextColor={palette.slate}
                multiline
                style={styles.input}
                editable={
                  !isStreaming && !isCheckingIntent && !pendingInnovation
                }
              />
              <Pressable
                style={[styles.sendButton, isStreaming && styles.stopButton]}
                onPress={() =>
                  isStreaming
                    ? handleStopStreaming()
                    : isCheckingIntent
                      ? undefined
                      : void handleSend()
                }
                disabled={isCheckingIntent || Boolean(pendingInnovation)}
              >
                <Text style={styles.sendButtonText}>
                  {isStreaming ? "停止" : isCheckingIntent ? "识别中" : "发送"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </ScreenShell>
  );
}

function attachAssistantSources(
  thread: MobileChatThread | null,
  citations: MobileCitation[],
  innovationAnalysis?: MobileInnovationAnalysis | null,
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return thread;
  messages[messages.length - 1] = {
    ...last,
    citations,
    innovationAnalysis: innovationAnalysis ?? last.innovationAnalysis,
  };
  return { ...thread, messages };
}

function attachAssistantIdea(
  thread: MobileChatThread | null,
  ideaId: string,
): MobileChatThread | null {
  if (!thread) return thread;
  const messages = thread.messages.slice();
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return thread;
  messages[messages.length - 1] = { ...last, ideaId };
  return { ...thread, messages };
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

function MobileMessageContent({
  message,
  onOpenCitation,
}: {
  message: MobileChatMessage;
  onOpenCitation: (citation: MobileCitation) => void;
}) {
  const [isReasoningExpanded, setIsReasoningExpanded] = useState(false);
  const parsed = useMemo(
    () => parseThinkingContent(message.content),
    [message.content],
  );
  const citations = message.citations ?? [];
  const innovationPoints = message.innovationAnalysis
    ? extractInnovationPoints(parsed.answer || message.content)
    : [];

  if (message.role === "user") {
    return (
      <View style={styles.messageContentStack}>
        {message.command || message.paperContext ? (
          <View style={styles.messageContextRow}>
            {message.command ? (
              <Text style={styles.messageContextBadge}>/{message.command}</Text>
            ) : null}
            {message.paperContext ? (
              <Text style={styles.messageContextBadge} numberOfLines={1}>
                @{message.paperContext.title}
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text style={styles.messageText}>{message.content}</Text>
      </View>
    );
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
      {message.innovationAnalysis ? (
        <View style={styles.mobileInnovationResult}>
          <View style={styles.mobileInnovationResultHeader}>
            <View style={styles.innovationBadge}>
              <Text style={styles.innovationBadgeText}>A+B</Text>
            </View>
            <View style={styles.innovationHeaderCopy}>
              <Text style={styles.mobileInnovationResultTitle}>
                {message.innovationAnalysis.conceptA} ×{" "}
                {message.innovationAnalysis.conceptB}
              </Text>
              <Text style={styles.mobileInnovationEvidenceStatus}>
                {innovationEvidenceStatusLabel(
                  message.innovationAnalysis.evidenceStatus,
                )}
              </Text>
            </View>
          </View>
          <Text style={styles.mobileInnovationSectionTitle}>创新点</Text>
          {innovationPoints.length ? (
            innovationPoints.map((point, index) => (
              <View
                key={`${message.messageId}:innovation:${index}`}
                style={styles.mobileInnovationPoint}
              >
                <Text style={styles.mobileInnovationPointIndex}>
                  {index + 1}
                </Text>
                <Text style={styles.mobileInnovationPointText}>{point}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.mobileInnovationPending}>
              {message.status === "streaming"
                ? "正在生成可验证的创新假设…"
                : "请查看上方完整分析中的“创新假设”部分。"}
            </Text>
          )}
        </View>
      ) : null}
      <MobileMarkdown content={answer || fallback} compact />
      {message.ideaId ? (
        <View style={styles.ideaSavedBadge}>
          <Text style={styles.ideaSavedBadgeText}>已加入桌面 Idea Map</Text>
        </View>
      ) : null}
      {citations.length ? (
        <View style={styles.citationsBlock}>
          <Text style={styles.citationsTitle}>本地论文证据</Text>
          {citations.map((citation, index) => (
            <Pressable
              key={`${citation.label}:${citation.paperId}:${citation.pageStart}:${index}`}
              style={styles.citationCard}
              onPress={() => onOpenCitation(citation)}
            >
              <View style={styles.citationHeader}>
                <Text style={styles.citationLabel}>
                  [{citation.label.replace(/^\[|\]$/g, "")}]
                </Text>
                <Text style={styles.citationPage}>
                  {formatCitationPages(citation.pageStart, citation.pageEnd)}
                </Text>
              </View>
              <Text style={styles.citationTitle} numberOfLines={2}>
                {citation.title || "未命名论文"}
              </Text>
              <Text style={styles.citationSnippet} numberOfLines={4}>
                {citationSnippetDisplay(citation)}
              </Text>
              <Text style={styles.citationOpenHint}>
                打开原文定位到证据页 →
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function extractInnovationPoints(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(
    /(?:^|\n)#{0,4}\s*(?:5[.、)]?\s*)?(?:2\s*[–-]\s*3\s*个)?创新假设[^\n]*\n([\s\S]*?)(?=\n#{0,4}\s*(?:6[.、)]?\s*)?最小可行实验|\n#{1,4}\s|$)/i,
  );
  if (!sectionMatch?.[1]) return [];
  const body = sectionMatch[1].trim();
  const listItems = body
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s/.test(line));
  if (listItems.length >= 2) return listItems.slice(0, 3);
  return body
    .split(/(?<=[。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function innovationEvidenceStatusLabel(
  status: MobileInnovationAnalysis["evidenceStatus"],
) {
  switch (status) {
    case "both":
      return "A/B 两侧均有本地论文证据";
    case "a_only":
      return "仅 A 侧有本地论文证据";
    case "b_only":
      return "仅 B 侧有本地论文证据";
    case "none":
      return "本次未使用本地论文证据";
    default:
      return "正在确认本地证据边界";
  }
}

function formatCitationPages(pageStart: number, pageEnd: number) {
  const start = Number.isFinite(pageStart) && pageStart > 0 ? pageStart : 1;
  const end = Number.isFinite(pageEnd) && pageEnd >= start ? pageEnd : start;
  return start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`;
}

function citationSnippetDisplay(citation: MobileCitation) {
  const raw = citation.snippet ?? "";
  const replacementCount = (raw.match(/�/g) ?? []).length;
  const mojibakeCount = (raw.match(/Ã|Â|â€|ï¿½/g) ?? []).length;
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (replacementCount >= 2 || mojibakeCount >= 2 || raw.includes("\u0000")) {
    return `该页 PDF 文本层质量较低，已隐藏乱码。点击打开第 ${Math.max(1, citation.pageStart || 1)} 页查看原文。`;
  }
  if (!cleaned) {
    return `未提取到可读证据片段，点击打开第 ${Math.max(1, citation.pageStart || 1)} 页查看原文。`;
  }
  return cleaned;
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
  screenContent: {
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  chatLayout: {
    flex: 1,
    minHeight: 0,
    gap: spacing.sm,
  },
  captureScroller: {
    flex: 1,
    minHeight: 0,
  },
  captureContent: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  innovationScroller: {
    flex: 1,
    minHeight: 0,
  },
  innovationPage: {
    gap: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  innovationBuilder: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#b7c9ee",
    backgroundColor: "#f7f9ff",
    padding: spacing.md,
    gap: spacing.md,
  },
  innovationBuilderFields: {
    gap: spacing.md,
  },
  innovationGenerateButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  innovationGenerateButtonText: {
    color: "#fff",
    fontWeight: "900",
  },
  innovationHistorySection: {
    gap: spacing.md,
  },
  innovationHistoryTitle: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: "900",
  },
  innovationHistoryCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    padding: spacing.md,
    gap: spacing.sm,
  },
  innovationHistoryConcepts: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: "900",
  },
  innovationHistoryActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  innovationHistoryAction: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.panel,
  },
  innovationHistoryActionDanger: {
    borderColor: "#d78a7d",
    backgroundColor: "#fff6f4",
  },
  innovationHistoryActionText: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: "800",
  },
  innovationHistoryActionDangerText: {
    color: "#a43f31",
    fontSize: 14,
    fontWeight: "900",
  },
  innovationEmpty: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    padding: spacing.lg,
  },
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
  threadScroller: {
    flexGrow: 0,
    flexShrink: 0,
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
  innovationCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#b7c9ee",
    backgroundColor: "#f7f9ff",
    padding: spacing.md,
    gap: spacing.md,
  },
  innovationHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  innovationBadge: {
    minWidth: 46,
    borderRadius: 14,
    backgroundColor: palette.primary,
    paddingHorizontal: 9,
    paddingVertical: 8,
    alignItems: "center",
  },
  innovationBadgeText: {
    color: "#fff",
    fontWeight: "900",
  },
  innovationHeaderCopy: {
    flex: 1,
    gap: 4,
  },
  innovationTitle: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: "900",
  },
  innovationHint: {
    color: palette.slate,
    lineHeight: 20,
  },
  innovationQuestion: {
    color: palette.ink,
    lineHeight: 21,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: spacing.sm,
  },
  conceptRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  conceptField: {
    flex: 1,
    gap: 6,
  },
  conceptLabel: {
    color: palette.slate,
    fontSize: 12,
    fontWeight: "800",
  },
  conceptInput: {
    borderRadius: 13,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: palette.ink,
    fontWeight: "800",
  },
  conceptExpansion: {
    color: palette.slate,
    fontSize: 12,
    lineHeight: 17,
  },
  conceptPlus: {
    paddingTop: 31,
  },
  conceptPlusText: {
    color: palette.primary,
    fontSize: 20,
    fontWeight: "900",
  },
  ambiguityNote: {
    color: "#8a5a16",
    lineHeight: 20,
    backgroundColor: "#fff6df",
    borderRadius: 12,
    padding: spacing.sm,
  },
  innovationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  secondaryAction: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryActionText: {
    color: palette.slate,
    fontWeight: "800",
  },
  primaryAction: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: palette.primary,
    paddingHorizontal: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  primaryActionText: {
    color: "#fff",
    fontWeight: "800",
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
    flex: 1,
    minHeight: 0,
  },
  messagesContent: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  messageList: {
    gap: spacing.md,
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
  messageContextRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  messageContextBadge: {
    maxWidth: "100%",
    borderRadius: 999,
    backgroundColor: "#dfeaff",
    color: palette.primary,
    fontSize: 12,
    fontWeight: "800",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  ideaSavedBadge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    backgroundColor: "#fff7d6",
    borderWidth: 1,
    borderColor: "#e7c65b",
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  ideaSavedBadgeText: {
    color: "#7a5a00",
    fontSize: 12,
    fontWeight: "800",
  },
  mobileInnovationResult: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d7bf68",
    backgroundColor: "#fffaf0",
    padding: spacing.md,
    gap: spacing.sm,
  },
  mobileInnovationResultHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  mobileInnovationResultTitle: {
    color: palette.ink,
    fontWeight: "900",
    fontSize: 16,
  },
  mobileInnovationEvidenceStatus: {
    color: palette.slate,
    fontSize: 12,
    marginTop: 2,
  },
  mobileInnovationSectionTitle: {
    color: "#755600",
    fontWeight: "900",
    fontSize: 13,
  },
  mobileInnovationPoint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  mobileInnovationPointIndex: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#e6bf3c",
    color: "#fff",
    textAlign: "center",
    lineHeight: 22,
    fontSize: 12,
    fontWeight: "900",
  },
  mobileInnovationPointText: {
    flex: 1,
    color: palette.ink,
    lineHeight: 20,
  },
  mobileInnovationPending: {
    color: palette.slate,
    lineHeight: 20,
  },
  citationsBlock: {
    borderTopWidth: 1,
    borderTopColor: palette.border,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  citationsTitle: {
    color: palette.slate,
    fontSize: 12,
    fontWeight: "900",
  },
  citationCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#cbd8ef",
    backgroundColor: "#f7f9ff",
    padding: spacing.sm,
    gap: 6,
  },
  citationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  citationLabel: {
    color: palette.primary,
    fontWeight: "900",
  },
  citationPage: {
    color: palette.slate,
    fontSize: 12,
    fontWeight: "700",
  },
  citationTitle: {
    color: palette.ink,
    fontWeight: "800",
    lineHeight: 20,
  },
  citationSnippet: {
    color: palette.slate,
    lineHeight: 19,
  },
  citationOpenHint: {
    color: palette.primary,
    fontSize: 12,
    fontWeight: "800",
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
  composerMenu: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    maxHeight: 360,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    overflow: "hidden",
    zIndex: 80,
    elevation: 24,
    shadowColor: "#17212d",
    shadowOffset: { width: 0, height: -5 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    marginBottom: spacing.sm,
  },
  composerMenuContent: {
    padding: spacing.sm,
    gap: spacing.xs,
  },
  composerMenuTitle: {
    color: palette.slate,
    fontSize: 12,
    fontWeight: "900",
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
  },
  composerMenuItem: {
    borderRadius: 12,
    backgroundColor: "#f5f7fb",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: 3,
  },
  composerMenuItemTitle: {
    color: palette.ink,
    fontWeight: "900",
  },
  composerMenuItemDescription: {
    color: palette.slate,
    fontSize: 12,
  },
  composerMenuEmpty: {
    color: palette.slate,
    padding: spacing.sm,
  },
  composerDock: {
    position: "relative",
    flexShrink: 0,
    zIndex: 50,
    elevation: 16,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.cloud,
    marginHorizontal: -spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  composerDirectHint: {
    color: palette.primary,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
    paddingHorizontal: spacing.sm,
  },
  composerToolButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  composerToolButtonText: {
    color: palette.primary,
    fontSize: 20,
    fontWeight: "900",
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
