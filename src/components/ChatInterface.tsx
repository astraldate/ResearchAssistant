import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  History,
  ImagePlus,
  Monitor,
  Send,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { ModelSelector } from "./ModelSelector";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ContextMenuPortal } from "./ContextMenuPortal";

type StatusTone = "info" | "error";

interface Message {
  id: string;
  role: "user" | "ai";
  content: string;
  timestamp: number;
  kind?: "markdown" | "draft_result_card";
  draftResult?: PaperDraftResult;
}

interface DocumentResult {
  id: string;
  path: string;
  content: string;
}

interface CitationItem {
  id: string;
  path: string;
  page: number;
  snippet: string;
  createdAt: number;
}

interface NoteItem {
  id: string;
  text: string;
  createdAt: number;
}

interface ResearchPaperOption {
  paperId: string;
  title: string;
  path: string;
  parseStatus: string;
  chunkCount: number;
  candidateCount: number;
}

interface KnowledgeCardSummary {
  id: string;
  term: string;
  title: string;
  path: string;
  created_at: string;
  pdf_path?: string | null;
  pdf_page?: number | null;
  source_status: string;
  source_provider?: string | null;
  lookup_mode: "popular_cn" | "cs_encyclopedia" | "bioinformatics";
  preview: string;
}

interface InferenceSettings {
  mode: "single_mm" | "dual_pipeline";
  thinking_enabled: boolean;
}

interface SessionPayload {
  messages: Message[];
  inputValue: string;
  imagePath: string | null;
  pdfPage: number;
  citationDraft: string;
  citations: CitationItem[];
  notes: NoteItem[];
  restrictToActivePaper?: boolean;
}

interface SelectionMenuState {
  text: string;
  x: number;
  y: number;
}

type SlashCommandName =
  | "brief"
  | "ask"
  | "method"
  | "exp"
  | "claim"
  | "note"
  | "review";

interface ParsedSlashCommand {
  name: SlashCommandName;
  scopePaper: string | null;
  userInstruction: string;
}

const buildBriefProgressContent = (message: string) => `_${message}_`;
const buildDraftCardFallbackContent = (draft: PaperDraftResult) =>
  [
    draft.kind === "note_draft" ? "已生成笔记草稿" : "已生成 review 草稿",
    "",
    `**${draft.title}**`,
    "",
    draft.previewText,
    "",
    `路径：\`${draft.path}\``,
  ].join("\n");

interface ChatStreamEvent {
  request_id?: string;
  requestId?: string;
  phase: "thinking" | "answer" | "done";
  reasoning: string;
  answer: string;
}

interface MobileChatThreadProgressEvent {
  threadId: string;
  messageId: string;
  status?: string | null;
  reasoning: string;
  answer: string;
}

interface BriefProgressEvent {
  request_id?: string;
  requestId?: string;
  phase: "locating" | "retrieving" | "generating" | "done";
  message: string;
}

interface PaperDraftResult {
  kind: "note_draft" | "review_draft";
  title: string;
  path: string;
  openTarget: string;
  previewText: string;
  content: string;
}

interface MobileChatThreadSummary {
  threadId: string;
  title: string;
  updatedAt: string;
  model: string;
  status: "idle" | "streaming" | "error";
  lastMessagePreview: string;
  messageCount: number;
  lastError?: string | null;
}

interface MobileChatThread {
  threadId: string;
  title: string;
  updatedAt: string;
  model: string;
  status: "idle" | "streaming" | "error";
  messages: Array<{
    messageId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;
}

interface ChatInterfaceProps {
  currentModel?: string;
  ensureAiReady?: () => Promise<string>;
  activeFilePath?: string | null;
  pdfPage?: number;
  onPdfPageChange?: (page: number) => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onCardSaved: () => void;
  showSupportPanels?: boolean;
  onModelChange?: (model: string) => void;
}

const SESSION_KEY = "ra_chat_session_v3";
const CHAT_SCOPE_KEY = "ra_chat_scope_current_paper_v1";

const DEFAULT_MESSAGES: Message[] = [
  {
    id: "welcome-message",
    role: "ai",
    content:
      "你好，我是科研助手。\n\n你可以导入资料、建立本地知识库、在 PDF 页面选词解释并沉淀知识卡片，也可以继续使用对话和 Markdown 导出功能。",
    timestamp: Date.now(),
  },
];

const TOOL_BUTTON_STYLE: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  background: "var(--bg-primary)",
  borderRadius: 8,
  padding: "4px 8px",
  fontSize: "0.72rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;
const isPdfFile = (path: string) => /\.pdf$/i.test(path);
const buildDocSnippet = (content: string, limit = 220) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
};

const parsePaperScopedQuestion = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^@paper\s+(.+?)(?:\r?\n+|$)([\s\S]*)/i);
  if (!match) {
    return {
      cleanQuestion: trimmed,
      scopePaper: null as string | null,
    };
  }
  const scopePaper = match[1].trim();
  const remainder = (match[2] ?? "").trim();
  return {
    cleanQuestion: remainder || trimmed,
    scopePaper: scopePaper || null,
  };
};

const extractActiveMentionQuery = (value: string, cursor: number | null) => {
  const effectiveCursor = cursor ?? value.length;
  const beforeCursor = value.slice(0, effectiveCursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\n@]*)$/);
  if (!match) return null;
  return match[1] ?? "";
};

const SUPPORTED_SLASH_COMMANDS: Array<{
  name: SlashCommandName;
  title: string;
  description: string;
}> = [
  {
    name: "ask",
    title: "⚡ /ask",
    description: "对当前文献做定向问答",
  },
  {
    name: "method",
    title: "⚡ /method",
    description: "只看方法设计与技术路线",
  },
  {
    name: "exp",
    title: "⚡ /exp",
    description: "只看实验、对比、消融与局限",
  },
  {
    name: "claim",
    title: "⚡ /claim",
    description: "提取论文核心论点与证据强弱",
  },
  {
    name: "note",
    title: "⚡ /note",
    description: "生成并保存笔记草稿",
  },
  {
    name: "review",
    title: "⚡ /review",
    description: "生成并保存 review 草稿",
  },
  {
    name: "brief",
    title: "⚡ /brief",
    description: "生成当前文献的核心 Markdown 简报 (基于图谱与摘要)",
  },
];

const parseSlashCommand = (value: string): ParsedSlashCommand | null => {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!SUPPORTED_SLASH_COMMANDS.some((command) => command.name === name)) {
    return null;
  }
  const rawBody = (match[2] ?? "").trim();
  const inlinePaperMatch = rawBody.match(
    /^@paper\s+(.+?)(?:\r?\n+|$)([\s\S]*)/i,
  );
  if (inlinePaperMatch) {
    const scopePaper = inlinePaperMatch[1].trim();
    const remainder = (inlinePaperMatch[2] ?? "").trim();
    return {
      name: name as SlashCommandName,
      scopePaper: scopePaper || null,
      userInstruction: remainder,
    };
  }
  return {
    name: name as SlashCommandName,
    scopePaper: null,
    userInstruction: rawBody,
  };
};

const extractSlashCommandDraft = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/([a-zA-Z]*)$/);
  if (!match) return null;
  return match[1].toLowerCase();
};

const extractUnsupportedSlashCommand = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s|$)/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (SUPPORTED_SLASH_COMMANDS.some((command) => command.name === name)) {
    return null;
  }
  return name;
};

const buildStreamingContent = (reasoning: string, answer: string) => {
  const sanitizeStreamingText = (value: string) =>
    [
      "<|endoftext|>",
      "<|im_start|>",
      "<|im_end|>",
      "<|assistant|>",
      "<|user|>",
      "<|system|>",
    ]
      .reduce((cleaned, marker) => cleaned.split(marker).join(""), value)
      .trim();

  const trimmedReasoning = sanitizeStreamingText(reasoning);
  const trimmedAnswer = sanitizeStreamingText(answer);

  if (trimmedReasoning && trimmedAnswer) {
    return `<think>\n${trimmedReasoning}\n</think>\n\n${trimmedAnswer}`;
  }
  if (trimmedReasoning) {
    return `<think>\n${trimmedReasoning}\n</think>`;
  }
  return trimmedAnswer;
};

const readSession = (): SessionPayload | null => {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionPayload;
  } catch {
    return null;
  }
};

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  currentModel,
  ensureAiReady,
  activeFilePath,
  pdfPage = 1,
  onPdfPageChange,
  onStatus,
  onCardSaved,
  showSupportPanels = true,
  onModelChange,
}) => {
  const [messages, setMessages] = useState<Message[]>(DEFAULT_MESSAGES);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [citationDraft, setCitationDraft] = useState("");
  const [citations, setCitations] = useState<CitationItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<DocumentResult[]>(
    [],
  );
  const [lastKnowledgeQuery, setLastKnowledgeQuery] = useState("");
  const [isKnowledgeSearching, setIsKnowledgeSearching] = useState(false);
  const [restrictToActivePaper, setRestrictToActivePaper] = useState(() => {
    return localStorage.getItem(CHAT_SCOPE_KEY) === "1";
  });
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [isThinkingToggleLoading, setIsThinkingToggleLoading] = useState(false);
  const [paperOptions, setPaperOptions] = useState<ResearchPaperOption[]>([]);
  const [isPaperOptionsLoaded, setIsPaperOptionsLoaded] = useState(false);
  const [paperMentionQuery, setPaperMentionQuery] = useState("");
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [paperMentionMenuRect, setPaperMentionMenuRect] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [slashCommandMenuRect, setSlashCommandMenuRect] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(
    null,
  );
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(
    null,
  );
  const [isSessionHydrated, setIsSessionHydrated] = useState(false);
  const [isChatSelectionMode, setIsChatSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [isSavingChatCard, setIsSavingChatCard] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [mobileThreadSummaries, setMobileThreadSummaries] = useState<
    MobileChatThreadSummary[]
  >([]);
  const [activeMobileThreadId, setActiveMobileThreadId] = useState<
    string | null
  >(null);
  const [isMobileThreadListOpen, setIsMobileThreadListOpen] = useState(false);

  const messagesListRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const adjustInputHeight = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const maxHeight = 220;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(24, nextHeight)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);
  const activeStreamRef = useRef<{
    requestId: string;
    messageId: string;
  } | null>(null);
  const activeBriefRef = useRef<{
    requestId: string;
    messageId: string;
  } | null>(null);
  const activeMobileThreadIdRef = useRef<string | null>(null);
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());
  const shouldAutoScrollRef = useRef(true);
  const activePdfPath =
    activeFilePath && isPdfFile(activeFilePath) ? activeFilePath : null;
  const selectedMessageIdSet = useMemo(
    () => new Set(selectedMessageIds),
    [selectedMessageIds],
  );
  const lastAiMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "ai") {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);
  const persistSession = useCallback(
    (payload?: SessionPayload) => {
      if (activeMobileThreadId) return;
      const nextPayload: SessionPayload = payload ?? {
        messages,
        inputValue,
        imagePath,
        pdfPage,
        citationDraft,
        citations,
        notes,
        restrictToActivePaper,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(nextPayload));
    },
    [
      activeMobileThreadId,
      citationDraft,
      citations,
      imagePath,
      inputValue,
      messages,
      notes,
      pdfPage,
      restrictToActivePaper,
    ],
  );

  useEffect(() => {
    const stored = readSession();
    if (stored) {
      setMessages(stored.messages?.length ? stored.messages : DEFAULT_MESSAGES);
      setInputValue(stored.inputValue || "");
      setImagePath(stored.imagePath || null);
      setCitationDraft(stored.citationDraft || "");
      setCitations(Array.isArray(stored.citations) ? stored.citations : []);
      setNotes(Array.isArray(stored.notes) ? stored.notes : []);
      setRestrictToActivePaper(Boolean(stored.restrictToActivePaper));
      const restoredPage =
        stored.pdfPage && stored.pdfPage > 0 ? stored.pdfPage : 1;
      onPdfPageChange?.(restoredPage);
    }
    setIsSessionHydrated(true);
  }, [onPdfPageChange]);

  useEffect(() => {
    if (!isSessionHydrated) return;
    persistSession();
  }, [isSessionHydrated, persistSession]);

  useEffect(() => {
    if (restrictToActivePaper) {
      localStorage.setItem(CHAT_SCOPE_KEY, "1");
    } else {
      localStorage.removeItem(CHAT_SCOPE_KEY);
    }
  }, [restrictToActivePaper]);

  useEffect(() => {
    let cancelled = false;
    invoke<InferenceSettings>("get_inference_settings")
      .then((settings) => {
        if (cancelled) return;
        setThinkingEnabled(settings.thinking_enabled !== false);
      })
      .catch(() => {
        if (cancelled) return;
        setThinkingEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messagesEndRef.current?.scrollIntoView({
      behavior: isLoading ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, isLoading]);

  useEffect(() => {
    adjustInputHeight();
  }, [adjustInputHeight, inputValue]);

  const handleMessagesScroll = () => {
    const element = messagesListRef.current;
    if (!element) return;
    const distanceToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldAutoScrollRef.current = distanceToBottom <= 80;
  };

  useEffect(() => {
    const mentionQuery = extractActiveMentionQuery(
      inputValue,
      inputRef.current?.selectionStart ?? null,
    );
    setPaperMentionQuery(mentionQuery ?? "");
    setSelectedMentionIndex(0);
  }, [inputValue]);

  useEffect(() => {
    const rawShouldShowMentionList =
      paperMentionQuery !== "" ||
      extractActiveMentionQuery(
        inputValue,
        inputRef.current?.selectionStart ?? null,
      ) !== null;
    if (!rawShouldShowMentionList || !inputRef.current) {
      setPaperMentionMenuRect(null);
      return;
    }
    const updateRect = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPaperMentionMenuRect({
        left: rect.left,
        top: rect.top - 10,
        width: rect.width,
      });
    };
    updateRect();
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [inputValue, paperMentionQuery]);

  useEffect(() => {
    if (paperMentionQuery === "" && !inputValue.includes("@")) return;
    if (isPaperOptionsLoaded) return;
    let cancelled = false;
    invoke<ResearchPaperOption[]>("list_research_papers")
      .then((records) => {
        if (cancelled) return;
        setPaperOptions(records);
        setIsPaperOptionsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPaperOptions([]);
        setIsPaperOptionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [inputValue, isPaperOptionsLoaded, paperMentionQuery]);

  useEffect(() => {
    activeMobileThreadIdRef.current = activeMobileThreadId;
  }, [activeMobileThreadId]);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    listen<ChatStreamEvent>("chat-stream", (event) => {
      const activeStream = activeStreamRef.current;
      const eventRequestId =
        event.payload.request_id ?? event.payload.requestId;
      if (!activeStream || activeStream.requestId !== eventRequestId) {
        return;
      }

      setMessages((previous) =>
        previous.map((message) =>
          message.id === activeStream.messageId
            ? {
                ...message,
                content: buildStreamingContent(
                  event.payload.reasoning,
                  event.payload.answer,
                ),
              }
            : message,
        ),
      );
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    listen<MobileChatThreadProgressEvent>(
      "mobile-chat-thread-progress",
      (event) => {
        const activeId = activeMobileThreadIdRef.current;
        if (!activeId || event.payload.threadId !== activeId) {
          return;
        }
        const content = event.payload.status
          ? `_${event.payload.status}_`
          : buildStreamingContent(
              event.payload.reasoning,
              event.payload.answer,
            );
        setMessages((previous) =>
          previous.map((message) =>
            message.id === event.payload.messageId
              ? { ...message, content, timestamp: Date.now() }
              : message,
          ),
        );
      },
    ).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      unlistenFn?.();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    listen<BriefProgressEvent>("brief-progress", (event) => {
      const activeBrief = activeBriefRef.current;
      const eventRequestId =
        event.payload.request_id ?? event.payload.requestId;
      if (!activeBrief || activeBrief.requestId !== eventRequestId) {
        return;
      }
      if (event.payload.phase === "done") {
        return;
      }

      setMessages((previous) =>
        previous.map((message) =>
          message.id === activeBrief.messageId &&
          message.content.startsWith("_正在")
            ? {
                ...message,
                content: buildBriefProgressContent(event.payload.message),
              }
            : message,
        ),
      );
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  const loadMobileThreads = useCallback(async () => {
    try {
      const threads = await invoke<MobileChatThreadSummary[]>(
        "list_mobile_chat_threads",
      );
      setMobileThreadSummaries(threads);
    } catch {
      setMobileThreadSummaries([]);
    }
  }, []);

  const openMobileThread = useCallback(
    async (threadId: string) => {
      try {
        const thread = await invoke<MobileChatThread>(
          "read_mobile_chat_thread",
          { threadId },
        );
        setActiveMobileThreadId(thread.threadId);
        setMessages(
          thread.messages.length
            ? thread.messages.map((message) => ({
                id: message.messageId,
                role: message.role === "assistant" ? "ai" : "user",
                content: message.content,
                timestamp: Date.parse(message.createdAt) || Date.now(),
              }))
            : DEFAULT_MESSAGES,
        );
        setInputValue("");
        setIsMobileThreadListOpen(false);
      } catch (error) {
        onStatus(`打开移动端会话失败：${String(error)}`, "error", true);
      }
    },
    [onStatus],
  );

  const openLocalDesktopSession = useCallback(() => {
    const stored = readSession();
    setActiveMobileThreadId(null);
    setIsMobileThreadListOpen(false);
    if (stored) {
      setMessages(stored.messages?.length ? stored.messages : DEFAULT_MESSAGES);
      setInputValue(stored.inputValue || "");
      setImagePath(stored.imagePath || null);
      setCitationDraft(stored.citationDraft || "");
      setCitations(Array.isArray(stored.citations) ? stored.citations : []);
      setNotes(Array.isArray(stored.notes) ? stored.notes : []);
      setRestrictToActivePaper(Boolean(stored.restrictToActivePaper));
      onPdfPageChange?.(
        stored.pdfPage && stored.pdfPage > 0 ? stored.pdfPage : 1,
      );
      return;
    }
    setMessages(DEFAULT_MESSAGES);
    setInputValue("");
    setImagePath(null);
    setCitationDraft("");
    setCitations([]);
    setNotes([]);
  }, [onPdfPageChange]);

  const deleteMobileThread = useCallback(
    async (threadId: string) => {
      try {
        await invoke("delete_mobile_chat_thread", { threadId });
        setMobileThreadSummaries((previous) =>
          previous.filter((thread) => thread.threadId !== threadId),
        );
        if (activeMobileThreadId === threadId) {
          openLocalDesktopSession();
        }
        await loadMobileThreads();
        onStatus("已删除移动端会话。", "info", false);
      } catch (error) {
        onStatus(`删除移动端会话失败：${String(error)}`, "error", true);
      }
    },
    [
      activeMobileThreadId,
      loadMobileThreads,
      onStatus,
      openLocalDesktopSession,
    ],
  );

  useEffect(() => {
    void loadMobileThreads();
  }, [loadMobileThreads]);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<MobileChatThreadSummary>("mobile-chat-thread-updated", (event) => {
      void loadMobileThreads();
      const activeId = activeMobileThreadId;
      if (activeId && event.payload.threadId === activeId) {
        void openMobileThread(activeId);
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      unlistenFn?.();
    };
  }, [activeMobileThreadId, loadMobileThreads, openMobileThread]);

  const handlePickImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] },
        ],
      });
      if (selected && typeof selected === "string") {
        setImagePath(selected);
      }
    } catch (error) {
      onStatus(`选择图片失败：${String(error)}`, "error", true);
    }
  };

  const handleChatContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text) {
      setSelectionMenu(null);
      return;
    }
    setSelectionMenu({
      text,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const closeSelectionMenu = () => {
    setSelectionMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const clearChatSelection = () => {
    setIsChatSelectionMode(false);
    setSelectedMessageIds([]);
  };

  const toggleMessageSelection = (messageId: string) => {
    setSelectedMessageIds((previous) =>
      previous.includes(messageId)
        ? previous.filter((id) => id !== messageId)
        : [...previous, messageId],
    );
  };

  const buildSelectedDialogue = useCallback(() => {
    const selectedMessages = messages.filter((message) =>
      selectedMessageIdSet.has(message.id),
    );
    if (!selectedMessages.length) {
      return { selectedMessages, dialogue: "", snippet: "" };
    }
    const toBlockquote = (content: string) =>
      content
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    const dialogueBlocks = selectedMessages.map((message) => {
      const role = message.role === "user" ? "用户" : "AI";
      if (message.role === "user") {
        return [`### ${role}`, "", toBlockquote(message.content)].join("\n");
      }
      return `### ${role}\n\n${message.content}`;
    });
    const dialogue = dialogueBlocks.join("\n\n");
    const snippet = selectedMessages
      .map((message) => message.content)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return { selectedMessages, dialogue, snippet };
  }, [messages, selectedMessageIdSet]);

  const handleSaveChatSelectionCard = async () => {
    if (isSavingChatCard) return;
    const { selectedMessages, dialogue, snippet } = buildSelectedDialogue();
    if (!selectedMessages.length) {
      onStatus("请先选择要保存的聊天记录。", "error", true);
      return;
    }
    setIsSavingChatCard(true);
    try {
      const card = await invoke<KnowledgeCardSummary>(
        "save_knowledge_card_from_explanation",
        {
          request: {
            term: "新建知识卡片",
            selected_text: snippet || "聊天记录",
            plain_summary: dialogue,
            source_title: "聊天记录",
            source_url: null,
            source_provider: "chat",
            source_lang: "zh",
            source_extract: null,
            page_context_snippet: null,
            pdf_path: null,
            pdf_page: null,
            source_status: "model_only",
            model: currentModel || "chat",
            lookup_mode: "popular_cn",
          },
        },
      );
      onCardSaved();
      onStatus(`已保存知识卡片：${card.term}`, "info", false);
      clearChatSelection();
    } catch (error) {
      onStatus(`保存知识卡片失败：${String(error)}`, "error", true);
    } finally {
      setIsSavingChatCard(false);
    }
  };

  const handleExplainSelection = () => {
    if (!selectionMenu) return;
    const prompt = `请用中文解释下面这个概念，并结合当前研究语境：\n${selectionMenu.text}`;
    setInputValue((previous) =>
      previous.trim() ? `${previous}\n\n${prompt}` : prompt,
    );
    closeSelectionMenu();
  };

  const handleExpandRetrievalSelection = async () => {
    if (!selectionMenu) return;
    const query = selectionMenu.text;
    closeSelectionMenu();

    try {
      const docs = await invoke<DocumentResult[]>("query_knowledge_base", {
        query,
      });
      const summary =
        docs.length === 0
          ? "未检索到相关内容。"
          : docs
              .map((doc, index) => {
                const snippet = buildDocSnippet(doc.content, 180);
                return `${index + 1}. ${getFileName(doc.path)}\n${snippet}`;
              })
              .join("\n\n");

      setMessages((previous) => [
        ...previous,
        {
          id: `${Date.now()}-retrieval`,
          role: "ai",
          content: `### 扩展检索结果\n\n${summary}`,
          timestamp: Date.now(),
        },
      ]);
    } catch (error) {
      onStatus(`扩展检索失败：${String(error)}`, "error", true);
    }
  };

  const handleAddNoteFromSelection = () => {
    if (!selectionMenu) return;
    setNotes((previous) => [
      {
        id: `${Date.now()}-note`,
        text: selectionMenu.text,
        createdAt: Date.now(),
      },
      ...previous,
    ]);
    closeSelectionMenu();
  };

  const handleAddCitation = () => {
    if (!activePdfPath || !citationDraft.trim()) return;
    const snippet = citationDraft.trim();
    const nextCitation: CitationItem = {
      id: `${Date.now()}-citation`,
      path: activePdfPath,
      page: Math.max(1, pdfPage),
      snippet,
      createdAt: Date.now(),
    };
    setCitations((previous) => [nextCitation, ...previous]);
    setInputValue((previous) => {
      const citationLine = `[引用:${getFileName(activePdfPath)} p.${nextCitation.page}] ${snippet}`;
      return previous.trim() ? `${previous}\n${citationLine}` : citationLine;
    });
    setCitationDraft("");
  };

  const handleKnowledgeSearch = useCallback(
    async (overrideQuery?: string) => {
      const query = (overrideQuery ?? knowledgeQuery).trim();
      if (!query) {
        setKnowledgeResults([]);
        setLastKnowledgeQuery("");
        return;
      }

      const { cleanQuestion, scopePaper } = parsePaperScopedQuestion(query);
      const scopePath =
        !scopePaper && restrictToActivePaper && activeFilePath
          ? activeFilePath
          : undefined;
      const effectiveQuery = cleanQuestion || query;

      setIsKnowledgeSearching(true);
      setLastKnowledgeQuery(query);
      try {
        const docs = await invoke<DocumentResult[]>("query_knowledge_base", {
          query: effectiveQuery,
          scopePath,
          scopePaper: scopePaper ?? undefined,
        });
        setKnowledgeResults(docs);
      } catch (error) {
        onStatus(`知识库搜索失败：${String(error)}`, "error", true);
      } finally {
        setIsKnowledgeSearching(false);
      }
    },
    [activeFilePath, knowledgeQuery, onStatus, restrictToActivePaper],
  );

  const handleKnowledgeSearchKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void handleKnowledgeSearch();
    }
  };

  const handleInsertKnowledgeResult = (doc: DocumentResult) => {
    const line = `[知识库:${getFileName(doc.path)}] ${buildDocSnippet(doc.content, 180)}`;
    setInputValue((previous) =>
      previous.trim() ? `${previous}\n${line}` : line,
    );
  };

  const handleSendMessage = async () => {
    const question = inputValue.trim();
    if (!question) return;
    const { cleanQuestion, scopePaper } = parsePaperScopedQuestion(question);
    const effectiveQuestion = cleanQuestion || question;
    const slashCommand = parseSlashCommand(effectiveQuestion);
    const effectiveScopePaper = slashCommand?.scopePaper ?? scopePaper;
    const unsupportedSlashCommand =
      extractUnsupportedSlashCommand(effectiveQuestion);
    const scopePath =
      !effectiveScopePaper && restrictToActivePaper && activeFilePath
        ? activeFilePath
        : undefined;
    const startedAt = Date.now();
    const assistantMessageId = `${startedAt}-ai`;
    const requestId = `${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
    cancelledRequestIdsRef.current.delete(requestId);

    if (unsupportedSlashCommand) {
      const supportedNames = SUPPORTED_SLASH_COMMANDS.map(
        (command) => `\`/${command.name}\``,
      ).join("、");
      setMessages((previous) => [
        ...previous,
        {
          id: `${startedAt}-user`,
          role: "user",
          content: question,
          timestamp: startedAt,
        },
        {
          id: assistantMessageId,
          role: "ai",
          content: `暂不支持该指令：\`/${unsupportedSlashCommand}\`\n\n当前可用指令：${supportedNames}`,
          timestamp: startedAt,
        },
      ]);
      setInputValue("");
      onStatus(`暂不支持 /${unsupportedSlashCommand}。`, "error", true);
      return;
    }

    clearChatSelection();
    setMessages((previous) => [
      ...previous,
      {
        id: `${startedAt}-user`,
        role: "user",
        content: imagePath
          ? `${question}\n\n[图片: ${getFileName(imagePath)}]`
          : question,
        timestamp: startedAt,
      },
      {
        id: assistantMessageId,
        role: "ai",
        content:
          slashCommand?.name === "brief"
            ? buildBriefProgressContent("正在准备核心简报...")
            : slashCommand?.name === "note"
              ? "_正在生成笔记草稿..._"
              : slashCommand?.name === "review"
                ? "_正在生成 review 草稿..._"
                : slashCommand
                  ? `_${slashCommand.name === "method" ? "正在聚焦方法设计..." : slashCommand.name === "exp" ? "正在聚焦实验与局限..." : slashCommand.name === "claim" ? "正在提取核心论点..." : "正在检索论文证据..."}_`
                  : "_正在连接模型，等待首段输出..._",
        timestamp: startedAt,
      },
    ]);
    setInputValue("");
    setIsLoading(true);
    shouldAutoScrollRef.current = true;
    activeStreamRef.current =
      slashCommand?.name === "note" || slashCommand?.name === "review"
        ? null
        : {
            requestId,
            messageId: assistantMessageId,
          };
    activeBriefRef.current =
      slashCommand?.name === "brief"
        ? {
            requestId,
            messageId: assistantMessageId,
          }
        : null;

    try {
      const activeModel = ensureAiReady
        ? await ensureAiReady()
        : currentModel || "qwen3.5:9b";
      if (slashCommand?.name === "brief") {
        const response = await invoke<string>("generate_brief_report", {
          request: {
            requestId,
            scopePaper: effectiveScopePaper ?? undefined,
            paperPath: scopePath,
            activePdfPath: activePdfPath ?? undefined,
            userInstruction: slashCommand.userInstruction || undefined,
            model: activeModel,
          },
        });
        if (cancelledRequestIdsRef.current.has(requestId)) {
          return;
        }

        setMessages((previous) => [
          ...previous.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: response, timestamp: Date.now() }
              : message,
          ),
        ]);
        setImagePath(null);
        return;
      }
      if (
        slashCommand?.name === "ask" ||
        slashCommand?.name === "method" ||
        slashCommand?.name === "exp" ||
        slashCommand?.name === "claim"
      ) {
        const response = await invoke<string>("run_paper_command", {
          request: {
            requestId,
            commandType: slashCommand.name,
            scopePaper: effectiveScopePaper ?? undefined,
            paperPath: scopePath,
            activePdfPath: activePdfPath ?? undefined,
            userInstruction: slashCommand.userInstruction || undefined,
            model: activeModel,
          },
        });
        if (cancelledRequestIdsRef.current.has(requestId)) {
          return;
        }
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: response,
                  kind: "markdown",
                  timestamp: Date.now(),
                }
              : message,
          ),
        );
        setImagePath(null);
        return;
      }
      if (slashCommand?.name === "note" || slashCommand?.name === "review") {
        const draft = await invoke<PaperDraftResult>(
          slashCommand.name === "note"
            ? "create_paper_note_draft"
            : "create_paper_review_draft",
          {
            request: {
              commandType: slashCommand.name,
              scopePaper: effectiveScopePaper ?? undefined,
              paperPath: scopePath,
              activePdfPath: activePdfPath ?? undefined,
              userInstruction: slashCommand.userInstruction || undefined,
              model: activeModel,
            },
          },
        );
        if (cancelledRequestIdsRef.current.has(requestId)) {
          return;
        }
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: buildDraftCardFallbackContent(draft),
                  kind: "draft_result_card",
                  draftResult: draft,
                  timestamp: Date.now(),
                }
              : message,
          ),
        );
        onStatus(
          draft.kind === "note_draft"
            ? "已生成笔记草稿。"
            : "已生成 review 草稿。",
          "info",
          false,
        );
        onCardSaved();
        setImagePath(null);
        return;
      }
      let context = "";
      if (!activeMobileThreadId) {
        try {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: "_正在检索知识库上下文..._",
                    timestamp: Date.now(),
                  }
                : message,
            ),
          );
          const docs = await invoke<DocumentResult[]>("query_knowledge_base", {
            query: effectiveQuestion,
            scopePath,
            scopePaper: effectiveScopePaper ?? undefined,
          });
          context = docs.map((doc) => doc.content).join("\n\n");
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: context.trim()
                      ? "_已完成检索，正在等待模型首段输出..._"
                      : "_未检索到可用上下文，正在直接调用模型..._",
                    timestamp: Date.now(),
                  }
                : message,
            ),
          );
        } catch {
          context = "";
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: "_检索暂不可用，正在直接调用模型..._",
                    timestamp: Date.now(),
                  }
                : message,
            ),
          );
        }
      }

      const response = await invoke<string>("chat_with_llm", {
        query: effectiveQuestion,
        context,
        model: activeModel,
        imagePath,
        requestId,
      });
      if (cancelledRequestIdsRef.current.has(requestId)) {
        return;
      }

      setMessages((previous) => [
        ...previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: response, timestamp: Date.now() }
            : message,
        ),
      ]);
      if (activeMobileThreadId) {
        void invoke("append_mobile_chat_thread_turn", {
          threadId: activeMobileThreadId,
          userContent: effectiveQuestion,
          assistantContent: response,
          model: activeModel,
        }).then(() => loadMobileThreads());
      }
      setImagePath(null);
    } catch (error) {
      if (cancelledRequestIdsRef.current.has(requestId)) {
        return;
      }
      setMessages((previous) => [
        ...previous.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: `回答失败：${String(error)}\n\n请确认 Ollama 已启动，并且模型可用。`,
                timestamp: Date.now(),
              }
            : message,
        ),
      ]);
    } finally {
      if (
        activeStreamRef.current?.requestId === requestId ||
        activeBriefRef.current?.requestId === requestId
      ) {
        activeStreamRef.current = null;
        activeBriefRef.current = null;
        setIsLoading(false);
      }
      cancelledRequestIdsRef.current.delete(requestId);
    }
  };

  const handleClearSession = () => {
    setMessages(DEFAULT_MESSAGES);
    setActiveMobileThreadId(null);
    setInputValue("");
    setImagePath(null);
    setCitationDraft("");
    setCitations([]);
    setNotes([]);
    clearChatSelection();
    setRestrictToActivePaper(false);
    onPdfPageChange?.(1);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CHAT_SCOPE_KEY);
    onStatus("已清空当前会话。", "info", false);
  };

  const buildMarkdownDraft = useCallback(() => {
    const generatedAt = new Date().toLocaleString();
    const dialogue = messages.map((message, index) => {
      const role = message.role === "user" ? "用户" : "AI";
      return `### ${index + 1}. ${role}\n\n${message.content}`;
    });

    const citationSection = citations.length
      ? citations.map(
          (citation, index) =>
            `- [${index + 1}] ${getFileName(citation.path)} p.${citation.page}\n  ${citation.snippet}`,
        )
      : ["- 无"];

    const noteSection = notes.length
      ? notes.map((note, index) => `- [${index + 1}] ${note.text}`)
      : ["- 无"];

    return [
      "# 综述草稿",
      "",
      `生成时间：${generatedAt}`,
      `模型：${currentModel || "未设置"}`,
      "",
      "## 对话纪要",
      "",
      ...dialogue,
      "",
      "## 引用清单",
      "",
      ...citationSection,
      "",
      "## 研究笔记",
      "",
      ...noteSection,
      "",
    ].join("\n");
  }, [citations, currentModel, messages, notes]);

  const handleExportMarkdown = async () => {
    try {
      const dateTag = new Date().toISOString().slice(0, 10);
      const destination = await save({
        defaultPath: `review-draft-${dateTag}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!destination || typeof destination !== "string") return;
      await invoke("write_text_file", {
        path: destination,
        content: buildMarkdownDraft(),
      });
      onStatus(`Markdown 已导出到：${destination}`, "info", false);
    } catch (error) {
      onStatus(`导出 Markdown 失败：${String(error)}`, "error", true);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldShowSlashCommandList) {
      const trimmedCommandBody = parsedScope.cleanQuestion.trim();
      if (event.key === "Enter" && !event.shiftKey) {
        if (
          !SUPPORTED_SLASH_COMMANDS.some(
            (command) => trimmedCommandBody === `/${command.name}`,
          )
        ) {
          event.preventDefault();
          const firstCommand = filteredSlashCommands[0];
          if (firstCommand) {
            applySlashCommand(firstCommand.name);
          }
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashValue(parsedScope.cleanQuestion.trim());
        return;
      }
    }
    if (shouldShowPaperMentionList && filteredPaperOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIndex((current) =>
          Math.min(current + 1, filteredPaperOptions.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const selected = filteredPaperOptions[selectedMentionIndex];
        if (selected) {
          event.preventDefault();
          applyPaperMention(selected);
          return;
        }
      }
      if (event.key === "Escape") {
        setPaperMentionQuery("");
        return;
      }
    }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  };

  const handleInsertNote = (note: NoteItem) => {
    setInputValue((previous) =>
      previous.trim() ? `${previous}\n${note.text}` : note.text,
    );
  };

  const handleStartNewNote = () => {
    setEditingNoteId(null);
    setNoteDraft("");
  };

  const handleStartEditNote = (note: NoteItem) => {
    setEditingNoteId(note.id);
    setNoteDraft(note.text);
  };

  const handleCancelNoteEdit = () => {
    setEditingNoteId(null);
    setNoteDraft("");
  };

  const handleSaveNoteDraft = () => {
    const text = noteDraft.trim();
    if (!text) {
      onStatus("笔记内容不能为空。", "error", false);
      return;
    }

    if (editingNoteId) {
      setNotes((previous) =>
        previous.map((note) =>
          note.id === editingNoteId ? { ...note, text } : note,
        ),
      );
      onStatus("笔记已更新。", "info", false);
    } else {
      setNotes((previous) => [
        {
          id: `${Date.now()}-note`,
          text,
          createdAt: Date.now(),
        },
        ...previous,
      ]);
      onStatus("笔记已创建。", "info", false);
    }

    setEditingNoteId(null);
    setNoteDraft("");
  };

  const handleOpenDraftResult = async (draft: PaperDraftResult) => {
    try {
      await invoke("open_file", { path: draft.openTarget });
    } catch (error) {
      onStatus(`打开草稿失败：${String(error)}`, "error", true);
    }
  };

  const handleCopyDraftPath = async (draft: PaperDraftResult) => {
    try {
      await navigator.clipboard.writeText(draft.path);
      onStatus("已复制草稿路径。", "info", false);
    } catch (error) {
      onStatus(`复制草稿路径失败：${String(error)}`, "error", true);
    }
  };

  const handleDeleteNote = (noteId: string) => {
    setNotes((previous) => previous.filter((note) => note.id !== noteId));
    if (editingNoteId === noteId) {
      handleCancelNoteEdit();
    }
  };

  const handleToggleThinking = async () => {
    const nextValue = !thinkingEnabled;
    setIsThinkingToggleLoading(true);
    try {
      const settings = await invoke<InferenceSettings>("set_thinking_enabled", {
        thinkingEnabled: nextValue,
      });
      setThinkingEnabled(settings.thinking_enabled !== false);
      onStatus(
        settings.thinking_enabled !== false
          ? "已开启思考模式。"
          : "已关闭思考模式。",
        "info",
        false,
      );
    } catch (error) {
      onStatus(`切换思考模式失败：${String(error)}`, "error", true);
    } finally {
      setIsThinkingToggleLoading(false);
    }
  };

  const handleAbortCurrentConversation = () => {
    const activeRequest =
      activeBriefRef.current?.requestId ?? activeStreamRef.current?.requestId;
    const activeMessageId =
      activeBriefRef.current?.messageId ?? activeStreamRef.current?.messageId;
    if (!activeRequest || !activeMessageId) return;

    cancelledRequestIdsRef.current.add(activeRequest);
    activeStreamRef.current = null;
    activeBriefRef.current = null;
    setIsLoading(false);
    setMessages((previous) =>
      previous.map((message) =>
        message.id === activeMessageId
          ? {
              ...message,
              content: "已中止当前对话。",
              timestamp: Date.now(),
            }
          : message,
      ),
    );
    onStatus("已中止当前对话。", "info", false);
  };

  const activeFileLabel = useMemo(
    () => (activeFilePath ? getFileName(activeFilePath) : "未选中文件"),
    [activeFilePath],
  );
  const activeMobileThreadSummary = useMemo(
    () =>
      activeMobileThreadId
        ? mobileThreadSummaries.find(
            (thread) => thread.threadId === activeMobileThreadId,
          ) || null
        : null,
    [activeMobileThreadId, mobileThreadSummaries],
  );
  const activeSessionTitle = activeMobileThreadId
    ? activeMobileThreadSummary?.title || "移动端会话"
    : "本地桌面会话";
  const activeSessionMeta = activeMobileThreadId
    ? `${activeMobileThreadSummary?.messageCount ?? messages.length} 条消息 · 后续轮次默认仅使用历史上下文`
    : `当前文件：${activeFileLabel}`;
  const parsedScope = useMemo(
    () => parsePaperScopedQuestion(inputValue),
    [inputValue],
  );
  const activeChatScopeLabel = parsedScope.scopePaper
    ? `@paper ${parsedScope.scopePaper}`
    : restrictToActivePaper && activeFilePath
      ? `当前文献：${getFileName(activeFilePath)}`
      : null;
  const filteredPaperOptions = useMemo(() => {
    const query = paperMentionQuery.trim().toLowerCase();
    const base = paperOptions.filter((paper) => paper.chunkCount > 0);
    if (!query) {
      return base.slice(0, 8);
    }
    return base
      .filter((paper) => {
        const title = paper.title.toLowerCase();
        const path = paper.path.toLowerCase();
        return title.includes(query) || path.includes(query);
      })
      .slice(0, 8);
  }, [paperMentionQuery, paperOptions]);
  const shouldShowPaperMentionList =
    paperMentionQuery !== "" ||
    extractActiveMentionQuery(
      inputValue,
      inputRef.current?.selectionStart ?? null,
    ) !== null;
  const slashCommandDraft = useMemo(
    () => extractSlashCommandDraft(parsedScope.cleanQuestion),
    [parsedScope.cleanQuestion],
  );
  const filteredSlashCommands = useMemo(() => {
    if (slashCommandDraft === null) return [];
    return SUPPORTED_SLASH_COMMANDS.filter((command) =>
      command.name.includes(slashCommandDraft),
    );
  }, [slashCommandDraft]);
  const shouldShowSlashCommandList =
    isInputFocused &&
    filteredSlashCommands.length > 0 &&
    parsedScope.cleanQuestion.trim() !== dismissedSlashValue;

  useEffect(() => {
    if (!shouldShowSlashCommandList || !inputRef.current) {
      setSlashCommandMenuRect(null);
      return;
    }
    const updateRect = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSlashCommandMenuRect({
        left: rect.left,
        top: rect.top - 10,
        width: rect.width,
      });
    };
    updateRect();
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [shouldShowSlashCommandList]);

  const applyPaperMention = useCallback(
    (paper: ResearchPaperOption) => {
      const textarea = inputRef.current;
      const cursor = textarea?.selectionStart ?? inputValue.length;
      const beforeCursor = inputValue.slice(0, cursor);
      const afterCursor = inputValue.slice(cursor);
      const match = beforeCursor.match(/(?:^|\s)@([^\n@]*)$/);
      if (!match || match.index == null) {
        setInputValue(`@paper ${paper.title}\n${inputValue}`.trim());
        return;
      }
      const mentionStart = match.index + (match[0].startsWith(" ") ? 1 : 0);
      const prefix = inputValue.slice(0, mentionStart);
      const suffix = afterCursor.replace(/^\s*/, "");
      const nextValue = `${prefix}@paper ${paper.title}\n${suffix}`.trimStart();
      setInputValue(nextValue);
      window.setTimeout(() => {
        const node = inputRef.current;
        if (!node) return;
        const nextCursor = `${prefix}@paper ${paper.title}\n`.length;
        node.focus();
        node.setSelectionRange(nextCursor, nextCursor);
      }, 0);
      setPaperMentionQuery("");
    },
    [inputValue],
  );
  const applySlashCommand = useCallback(
    (name: SlashCommandName) => {
      const prefix = parsedScope.scopePaper
        ? `@paper ${parsedScope.scopePaper}\n`
        : "";
      const nextValue = `${prefix}/${name}`;
      setInputValue(nextValue);
      setDismissedSlashValue(null);
      window.setTimeout(() => {
        const node = inputRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextValue.length, nextValue.length);
      }, 0);
    },
    [parsedScope.scopePaper],
  );

  const renderAssistantMessage = (message: Message) => {
    if (message.kind === "draft_result_card" && message.draftResult) {
      const draft = message.draftResult;
      return (
        <div className="chat-draft-result-card">
          <div className="chat-draft-result-status">
            {draft.kind === "note_draft"
              ? "已生成笔记草稿"
              : "已生成 review 草稿"}
          </div>
          <div className="chat-draft-result-title">{draft.title}</div>
          <div className="chat-draft-result-preview">{draft.previewText}</div>
          <div className="chat-draft-result-path" title={draft.path}>
            {draft.path}
          </div>
          <div className="chat-draft-result-actions">
            <button
              type="button"
              style={TOOL_BUTTON_STYLE}
              onClick={() => void handleOpenDraftResult(draft)}
            >
              点击查看/编辑
            </button>
            <button
              type="button"
              style={TOOL_BUTTON_STYLE}
              onClick={() => void handleCopyDraftPath(draft)}
            >
              复制路径
            </button>
          </div>
        </div>
      );
    }

    return (
      <MarkdownRenderer
        content={message.content}
        autoExpandReasoning={
          isLoading && activeStreamRef.current?.messageId === message.id
        }
      />
    );
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <div className="main-view-meta">
          <div className="main-view-title">科研助手</div>
          <div className="main-view-subtitle" title={activeFileLabel}>
            {activeSessionMeta}
          </div>
        </div>
        <div className="chat-toolbar">
          <button
            className={`session-switch-button ${activeMobileThreadId ? "mobile-active" : ""}`}
            onClick={() => {
              setIsMobileThreadListOpen((previous) => !previous);
              void loadMobileThreads();
            }}
            title="切换本地桌面会话或移动端会话"
          >
            <History size={15} />
            切换会话
          </button>
          <button style={TOOL_BUTTON_STYLE} onClick={handleClearSession}>
            清空会话
          </button>
          <button
            style={TOOL_BUTTON_STYLE}
            onClick={() => void handleExportMarkdown()}
          >
            导出 Markdown
          </button>
          {!isChatSelectionMode &&
            !isLoading &&
            activeStreamRef.current == null &&
            lastAiMessageId && (
              <button
                style={TOOL_BUTTON_STYLE}
                onClick={() => setIsChatSelectionMode(true)}
              >
                选择聊天记录
              </button>
            )}
        </div>
      </div>
      <div
        className={`active-session-strip ${activeMobileThreadId ? "mobile" : "desktop"}`}
      >
        <div className="active-session-icon">
          {activeMobileThreadId ? (
            <Smartphone size={18} />
          ) : (
            <Monitor size={18} />
          )}
        </div>
        <div className="active-session-copy">
          <div className="active-session-label">
            当前会话 · {activeMobileThreadId ? "移动端" : "桌面端"}
          </div>
          <div className="active-session-title">{activeSessionTitle}</div>
        </div>
        <button
          type="button"
          className="active-session-action"
          onClick={() => {
            setIsMobileThreadListOpen((previous) => !previous);
            void loadMobileThreads();
          }}
        >
          切换
        </button>
      </div>
      {isMobileThreadListOpen && (
        <div className="mobile-thread-switcher">
          <div className="mobile-thread-switcher-header">
            <div>
              <div className="mobile-thread-switcher-title">切换会话</div>
              <div className="mobile-thread-switcher-subtitle">
                可回到本地桌面会话，也可打开手机端发起的历史会话。
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`mobile-thread-option ${!activeMobileThreadId ? "active" : ""}`}
            onClick={openLocalDesktopSession}
          >
            <span className="mobile-thread-option-icon">
              <Monitor size={16} />
            </span>
            <span className="mobile-thread-option-main">
              <span className="mobile-thread-option-title">本地桌面会话</span>
              <span className="mobile-thread-option-meta">
                使用当前桌面聊天上下文和当前文件范围
              </span>
            </span>
          </button>
          {mobileThreadSummaries.length ? (
            mobileThreadSummaries.slice(0, 8).map((thread) => (
              <div
                key={thread.threadId}
                className={`mobile-thread-option ${
                  activeMobileThreadId === thread.threadId ? "active" : ""
                }`}
              >
                <button
                  type="button"
                  className="mobile-thread-open"
                  onClick={() => void openMobileThread(thread.threadId)}
                >
                  <span className="mobile-thread-option-icon">
                    <Smartphone size={16} />
                  </span>
                  <span className="mobile-thread-option-main">
                    <span className="mobile-thread-option-title">
                      {thread.title || "移动端会话"}
                    </span>
                    <span className="mobile-thread-option-meta">
                      {thread.messageCount} 条 · {thread.updatedAt}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mobile-thread-delete"
                  title="删除这个移动端会话"
                  onClick={() => void deleteMobileThread(thread.threadId)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <div className="mobile-thread-empty">暂无移动端会话。</div>
          )}
        </div>
      )}

      <div className="chat-body" onContextMenu={handleChatContextMenu}>
        <div className="chat-content-panels">
          <div className="chat-main-pane">
            <div
              ref={messagesListRef}
              className="messages-list"
              onScroll={handleMessagesScroll}
              onContextMenu={handleChatContextMenu}
            >
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`message-row ${message.role} ${
                    isChatSelectionMode ? "selectable" : ""
                  }`}
                >
                  {isChatSelectionMode && message.role === "ai" && (
                    <label className="chat-message-select">
                      <input
                        type="checkbox"
                        className="chat-message-checkbox"
                        checked={selectedMessageIdSet.has(message.id)}
                        onChange={() => toggleMessageSelection(message.id)}
                      />
                    </label>
                  )}
                  <div className={`message ${message.role}`}>
                    {message.role === "ai" ? (
                      renderAssistantMessage(message)
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap" }}>
                        {message.content}
                      </div>
                    )}
                  </div>
                  {isChatSelectionMode && message.role === "user" && (
                    <label className="chat-message-select">
                      <input
                        type="checkbox"
                        className="chat-message-checkbox"
                        checked={selectedMessageIdSet.has(message.id)}
                        onChange={() => toggleMessageSelection(message.id)}
                      />
                    </label>
                  )}
                </div>
              ))}
              {isLoading && !activeStreamRef.current && (
                <div className="message ai">
                  <span className="thinking-text">正在思考...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
              {isChatSelectionMode && (
                <div className="chat-selection-bar">
                  <div className="chat-selection-summary">
                    已选择 {selectedMessageIds.length} 条
                  </div>
                  <div className="chat-selection-actions">
                    <button
                      type="button"
                      className="chat-selection-primary"
                      onClick={() => void handleSaveChatSelectionCard()}
                      disabled={isSavingChatCard}
                    >
                      添加到知识卡片
                    </button>
                    <button
                      type="button"
                      className="chat-selection-secondary"
                      onClick={clearChatSelection}
                      disabled={isSavingChatCard}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="chat-input-pane">
            <div className="input-area">
              {imagePath && (
                <div className="image-chip">
                  <span>图片：{getFileName(imagePath)}</span>
                  <button
                    className="ghost-icon-button"
                    onClick={() => setImagePath(null)}
                    title="移除图片"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="chat-input-wrapper">
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  placeholder="输入消息。可用 @paper 论文标题 换行后提问"
                  value={inputValue}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  onChange={(event) => {
                    setInputValue(event.target.value);
                    setDismissedSlashValue(null);
                    const mentionQuery = extractActiveMentionQuery(
                      event.target.value,
                      event.target.selectionStart,
                    );
                    setPaperMentionQuery(mentionQuery ?? "");
                  }}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
              </div>

              <div className="chat-scope-row">
                <button
                  style={{
                    ...TOOL_BUTTON_STYLE,
                    background:
                      restrictToActivePaper && activeFilePath
                        ? "rgba(31, 62, 107, 0.14)"
                        : "var(--bg-primary)",
                    borderColor:
                      restrictToActivePaper && activeFilePath
                        ? "rgba(31, 62, 107, 0.28)"
                        : "var(--border-color)",
                    color:
                      restrictToActivePaper && activeFilePath
                        ? "var(--text-accent)"
                        : "var(--text-secondary)",
                  }}
                  onClick={() =>
                    setRestrictToActivePaper((current) => !current)
                  }
                  disabled={!activeFilePath}
                  title={
                    activeFilePath
                      ? "只在当前选中文献中检索 RAG 上下文"
                      : "当前没有选中文献"
                  }
                >
                  仅当前文献
                </button>
                {activeChatScopeLabel && (
                  <span className="chat-scope-chip">
                    {activeChatScopeLabel}
                  </span>
                )}
                <button
                  className={`chat-thinking-switch ${thinkingEnabled ? "enabled" : ""}`}
                  onClick={() => void handleToggleThinking()}
                  disabled={isThinkingToggleLoading}
                  title={
                    thinkingEnabled
                      ? "关闭思考模式，减少推理等待时间"
                      : "开启思考模式，允许模型输出推理过程"
                  }
                >
                  <span className="chat-thinking-switch-label">思考模式</span>
                  <span className="chat-thinking-switch-track">
                    <span className="chat-thinking-switch-thumb" />
                  </span>
                </button>
              </div>

              <div className="chat-input-actions">
                <button
                  className="send-button"
                  onClick={() => void handlePickImage()}
                  title="添加图片"
                >
                  <ImagePlus size={18} />
                </button>

                <ModelSelector
                  currentModel={currentModel || ""}
                  onModelChange={(model) => onModelChange?.(model)}
                  onStatus={onStatus}
                  variant="compact"
                  label=""
                />

                <button
                  className={`send-button send-action ${isLoading ? "abort-action" : ""}`}
                  onClick={
                    isLoading
                      ? handleAbortCurrentConversation
                      : () => void handleSendMessage()
                  }
                  disabled={!isLoading && !inputValue.trim()}
                  title={isLoading ? "中止当前对话" : "发送"}
                  aria-label={isLoading ? "中止当前对话" : "发送"}
                >
                  {isLoading ? <X size={18} /> : <Send size={18} />}
                </button>
              </div>

              {showSupportPanels && activePdfPath && (
                <div className="citation-bar chat-citation-bar">
                  <textarea
                    value={citationDraft}
                    onChange={(event) => setCitationDraft(event.target.value)}
                    placeholder="如需保留原文引用，可把 PDF 片段粘贴到这里"
                    rows={2}
                  />
                  <button
                    className="action-button primary"
                    onClick={handleAddCitation}
                    disabled={!citationDraft.trim()}
                  >
                    加入引用
                  </button>
                </div>
              )}

              {showSupportPanels && (
                <div className="support-grid">
                  <section
                    className="support-panel"
                    onContextMenu={handleChatContextMenu}
                  >
                    <div className="support-panel-title">引用片段</div>
                    <div className="support-panel-body">
                      {citations.length === 0 && (
                        <div className="support-empty">暂无引用。</div>
                      )}
                      {citations.slice(0, 8).map((citation) => (
                        <div key={citation.id} className="support-item">
                          <div className="support-item-title">
                            {getFileName(citation.path)} p.{citation.page}
                          </div>
                          <div className="support-item-text">
                            {citation.snippet}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section
                    className="support-panel"
                    onContextMenu={handleChatContextMenu}
                  >
                    <div className="support-panel-title-row">
                      <div className="support-panel-title">笔记</div>
                      <button
                        type="button"
                        style={TOOL_BUTTON_STYLE}
                        onClick={handleStartNewNote}
                      >
                        新建文本
                      </button>
                    </div>
                    <div className="support-panel-body">
                      <div className="support-note-editor">
                        <textarea
                          value={noteDraft}
                          onChange={(event) => setNoteDraft(event.target.value)}
                          placeholder="写一条临时笔记，可编辑后插入输入框或导出 Markdown。"
                          rows={3}
                        />
                        <div className="support-note-editor-actions">
                          <button
                            type="button"
                            style={TOOL_BUTTON_STYLE}
                            onClick={handleSaveNoteDraft}
                            disabled={!noteDraft.trim()}
                          >
                            {editingNoteId ? "保存修改" : "保存笔记"}
                          </button>
                          {(editingNoteId || noteDraft.trim()) && (
                            <button
                              type="button"
                              style={TOOL_BUTTON_STYLE}
                              onClick={handleCancelNoteEdit}
                            >
                              取消
                            </button>
                          )}
                        </div>
                      </div>
                      {notes.length === 0 && (
                        <div className="support-empty">暂无笔记。</div>
                      )}
                      {notes.slice(0, 8).map((note) => (
                        <div key={note.id} className="support-item">
                          <div className="support-item-text">{note.text}</div>
                          <div className="support-item-actions">
                            <button
                              style={TOOL_BUTTON_STYLE}
                              onClick={() => handleStartEditNote(note)}
                            >
                              编辑
                            </button>
                            <button
                              style={TOOL_BUTTON_STYLE}
                              onClick={() => handleInsertNote(note)}
                            >
                              插入输入框
                            </button>
                            <button
                              style={TOOL_BUTTON_STYLE}
                              onClick={() => handleDeleteNote(note.id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section
                    className="support-panel"
                    onContextMenu={handleChatContextMenu}
                  >
                    <div className="support-panel-title">知识库搜索</div>
                    <div className="knowledge-search-row">
                      <input
                        className="knowledge-search-input"
                        value={knowledgeQuery}
                        onChange={(event) =>
                          setKnowledgeQuery(event.target.value)
                        }
                        onKeyDown={handleKnowledgeSearchKeyDown}
                        placeholder="输入关键词搜索已导入知识"
                      />
                      <button
                        style={TOOL_BUTTON_STYLE}
                        onClick={() => void handleKnowledgeSearch()}
                        disabled={
                          isKnowledgeSearching || !knowledgeQuery.trim()
                        }
                      >
                        {isKnowledgeSearching ? "搜索中" : "搜索"}
                      </button>
                    </div>
                    <div className="support-panel-body">
                      {!lastKnowledgeQuery && !isKnowledgeSearching && (
                        <div className="support-empty">
                          输入关键词后检索本地知识库。
                        </div>
                      )}
                      {lastKnowledgeQuery &&
                        !isKnowledgeSearching &&
                        knowledgeResults.length === 0 && (
                          <div className="support-empty">
                            没有找到相关内容。
                          </div>
                        )}
                      {knowledgeResults.map((doc, index) => (
                        <div key={doc.id} className="support-item">
                          <div className="support-item-title">
                            {index + 1}. {getFileName(doc.path)}
                          </div>
                          <div className="support-item-text">
                            {buildDocSnippet(doc.content)}
                          </div>
                          <div className="support-item-actions">
                            <button
                              style={TOOL_BUTTON_STYLE}
                              onClick={() => handleInsertKnowledgeResult(doc)}
                            >
                              插入输入框
                            </button>
                            <button
                              style={TOOL_BUTTON_STYLE}
                              onClick={() =>
                                void invoke("open_file", { path: doc.path })
                              }
                            >
                              打开文件
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ContextMenuPortal
        open={Boolean(selectionMenu)}
        anchor={
          selectionMenu ? { x: selectionMenu.x, y: selectionMenu.y } : null
        }
        className="selection-menu context-menu"
        onClose={() => setSelectionMenu(null)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="context-menu-item"
          onClick={handleExplainSelection}
        >
          解释
        </button>
        <button
          type="button"
          className="context-menu-item"
          onClick={() => void handleExpandRetrievalSelection()}
        >
          扩展检索
        </button>
        <button
          type="button"
          className="context-menu-item"
          onClick={handleAddNoteFromSelection}
        >
          加入笔记
        </button>
        <button
          type="button"
          className="context-menu-item"
          onClick={closeSelectionMenu}
        >
          关闭
        </button>
      </ContextMenuPortal>

      {shouldShowPaperMentionList &&
        filteredPaperOptions.length > 0 &&
        paperMentionMenuRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="chat-paper-mention-list portal"
            style={{
              left: `${paperMentionMenuRect.left}px`,
              width: `${paperMentionMenuRect.width}px`,
              top: `${Math.max(12, paperMentionMenuRect.top - 260)}px`,
            }}
          >
            {filteredPaperOptions.map((paper, index) => (
              <button
                key={paper.paperId}
                className={`chat-paper-mention-item ${index === selectedMentionIndex ? "active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyPaperMention(paper);
                }}
              >
                <span className="chat-paper-mention-title">{paper.title}</span>
                <span className="chat-paper-mention-meta">
                  {paper.chunkCount} chunks · {paper.candidateCount} 候选
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}

      {shouldShowSlashCommandList &&
        slashCommandMenuRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="chat-slash-command-list portal"
            style={{
              left: `${slashCommandMenuRect.left}px`,
              width: `${slashCommandMenuRect.width}px`,
              top: `${Math.max(12, slashCommandMenuRect.top - 96)}px`,
            }}
          >
            {filteredSlashCommands.map((command) => (
              <button
                key={command.name}
                className="chat-slash-command-item active"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashCommand(command.name);
                }}
              >
                <span className="chat-slash-command-title">
                  {command.title}
                </span>
                <span className="chat-slash-command-meta">
                  {command.description}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
};
