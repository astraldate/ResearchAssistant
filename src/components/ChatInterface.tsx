import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Maximize2, Minimize2, Send, X } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { LookupMode } from "./TermExplainPopover";
import { PdfReader } from "./PdfReader";

type StatusTone = "info" | "error";

interface Message {
  id: string;
  role: "user" | "ai";
  content: string;
  timestamp: number;
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

interface SessionPayload {
  messages: Message[];
  inputValue: string;
  imagePath: string | null;
  pdfPage: number;
  citationDraft: string;
  citations: CitationItem[];
  notes: NoteItem[];
}

interface SelectionMenuState {
  text: string;
  x: number;
  y: number;
}

interface ChatInterfaceProps {
  currentModel?: string;
  activeFilePath?: string | null;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onCardSaved: () => void;
}

const SESSION_KEY = "ra_chat_session_v3";
const LOOKUP_MODE_KEY = "ra_term_lookup_mode_v1";

const DEFAULT_MESSAGES: Message[] = [
  {
    id: "welcome-message",
    role: "ai",
    content:
      "你好，我是科研助手。\n\n你可以直接导入资料、建立本地知识库、在 PDF 页面选词解释并沉淀知识卡片，也可以继续使用对话、笔记和 Markdown 导出能力。",
    timestamp: Date.now(),
  },
];

const TOOL_BUTTON_STYLE: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  background: "var(--bg-primary)",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: "0.78rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;
const isPdfFile = (path: string) => /\.pdf$/i.test(path);
const buildDocSnippet = (content: string, limit = 220) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
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

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ currentModel, activeFilePath, onStatus, onCardSaved }) => {
  const [messages, setMessages] = useState<Message[]>(DEFAULT_MESSAGES);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [citationDraft, setCitationDraft] = useState("");
  const [citations, setCitations] = useState<CitationItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<DocumentResult[]>([]);
  const [lastKnowledgeQuery, setLastKnowledgeQuery] = useState("");
  const [isKnowledgeSearching, setIsKnowledgeSearching] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [isSessionHydrated, setIsSessionHydrated] = useState(false);
  const [isReaderFocused, setIsReaderFocused] = useState(false);
  const [lookupMode, setLookupMode] = useState<LookupMode>(() => {
    const stored = localStorage.getItem(LOOKUP_MODE_KEY);
    if (stored === "popular_cn" || stored === "cs_encyclopedia" || stored === "bioinformatics") {
      return stored;
    }
    return "popular_cn";
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  const activePdfPath = activeFilePath && isPdfFile(activeFilePath) ? activeFilePath : null;

  const persistSession = useCallback(
    (payload?: SessionPayload) => {
      const nextPayload: SessionPayload =
        payload ?? {
          messages,
          inputValue,
          imagePath,
          pdfPage,
          citationDraft,
          citations,
          notes,
        };
      localStorage.setItem(SESSION_KEY, JSON.stringify(nextPayload));
    },
    [citationDraft, citations, imagePath, inputValue, messages, notes, pdfPage],
  );

  useEffect(() => {
    const stored = readSession();
    if (stored) {
      setMessages(stored.messages?.length ? stored.messages : DEFAULT_MESSAGES);
      setInputValue(stored.inputValue || "");
      setImagePath(stored.imagePath || null);
      setPdfPage(stored.pdfPage && stored.pdfPage > 0 ? stored.pdfPage : 1);
      setCitationDraft(stored.citationDraft || "");
      setCitations(Array.isArray(stored.citations) ? stored.citations : []);
      setNotes(Array.isArray(stored.notes) ? stored.notes : []);
    }
    setIsSessionHydrated(true);
  }, []);

  useEffect(() => {
    if (!isSessionHydrated) return;
    persistSession();
  }, [isSessionHydrated, persistSession]);

  useEffect(() => {
    localStorage.setItem(LOOKUP_MODE_KEY, lookupMode);
  }, [lookupMode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    if (!activePdfPath) {
      setIsReaderFocused(false);
    }
  }, [activePdfPath]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setSelectionMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handlePickImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      if (selected && typeof selected === "string") {
        setImagePath(selected);
      }
    } catch (error) {
      onStatus(`选择图片失败：${String(error)}`, "error", true);
    }
  };

  const handleScopedTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionMenu(null);
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      setSelectionMenu(null);
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      setSelectionMenu(null);
      return;
    }

    setSelectionMenu({
      text,
      x: rect.left + rect.width / 2,
      y: Math.max(8, rect.top - 8),
    });
  };

  const closeSelectionMenu = () => {
    setSelectionMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleExplainSelection = () => {
    if (!selectionMenu) return;
    const prompt = `请用中文解释下面这个概念，并结合我的研究语境说明它可能表示什么：\n${selectionMenu.text}`;
    setInputValue((previous) => (previous.trim() ? `${previous}\n\n${prompt}` : prompt));
    closeSelectionMenu();
  };

  const handleExpandRetrievalSelection = async () => {
    if (!selectionMenu) return;
    const query = selectionMenu.text;
    closeSelectionMenu();

    try {
      const docs = await invoke<DocumentResult[]>("query_knowledge_base", { query });
      const summary =
        docs.length === 0
          ? "未检索到更多相关内容。"
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

  const handleUseSelectionAsCitation = () => {
    if (!selectionMenu) return;
    setCitationDraft(selectionMenu.text);
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

      setIsKnowledgeSearching(true);
      setLastKnowledgeQuery(query);
      try {
        const docs = await invoke<DocumentResult[]>("query_knowledge_base", { query });
        setKnowledgeResults(docs);
      } catch (error) {
        onStatus(`知识库搜索失败：${String(error)}`, "error", true);
      } finally {
        setIsKnowledgeSearching(false);
      }
    },
    [knowledgeQuery, onStatus],
  );

  const handleKnowledgeSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void handleKnowledgeSearch();
    }
  };

  const handleInsertKnowledgeResult = (doc: DocumentResult) => {
    const line = `[知识库:${getFileName(doc.path)}] ${buildDocSnippet(doc.content, 180)}`;
    setInputValue((previous) => (previous.trim() ? `${previous}\n${line}` : line));
  };

  const handleSendMessage = async () => {
    const question = inputValue.trim();
    if (!question) return;

    setMessages((previous) => [
      ...previous,
      {
        id: `${Date.now()}-user`,
        role: "user",
        content: imagePath ? `${question}\n\n[图片: ${getFileName(imagePath)}]` : question,
        timestamp: Date.now(),
      },
    ]);
    setInputValue("");
    setIsLoading(true);

    try {
      let context = "";
      try {
        const docs = await invoke<DocumentResult[]>("query_knowledge_base", { query: question });
        context = docs.map((doc) => doc.content).join("\n\n");
      } catch {
        context = "";
      }

      const response = await invoke<string>("chat_with_llm", {
        query: question,
        context,
        model: currentModel || "qwen2.5:0.5b",
        image_path: imagePath,
      });

      setMessages((previous) => [
        ...previous,
        {
          id: `${Date.now()}-ai`,
          role: "ai",
          content: response,
          timestamp: Date.now(),
        },
      ]);
      setImagePath(null);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          id: `${Date.now()}-error`,
          role: "ai",
          content: `回答失败：${String(error)}\n\n请确认 Ollama 已启动，并且模型可用。`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveSession = () => {
    persistSession();
    onStatus("已保存当前会话。", "info", false);
  };

  const handleRestoreSession = () => {
    const stored = readSession();
    if (!stored) {
      onStatus("没有可恢复的会话。", "error", true);
      return;
    }
    setMessages(stored.messages?.length ? stored.messages : DEFAULT_MESSAGES);
    setInputValue(stored.inputValue || "");
    setImagePath(stored.imagePath || null);
    setPdfPage(stored.pdfPage && stored.pdfPage > 0 ? stored.pdfPage : 1);
    setCitationDraft(stored.citationDraft || "");
    setCitations(Array.isArray(stored.citations) ? stored.citations : []);
    setNotes(Array.isArray(stored.notes) ? stored.notes : []);
    onStatus("已恢复会话。", "info", false);
  };

  const handleClearSession = () => {
    setMessages(DEFAULT_MESSAGES);
    setInputValue("");
    setImagePath(null);
    setPdfPage(1);
    setCitationDraft("");
    setCitations([]);
    setNotes([]);
    localStorage.removeItem(SESSION_KEY);
    onStatus("已清空当前会话。", "info", false);
  };

  const buildMarkdownDraft = useCallback(() => {
    const generatedAt = new Date().toLocaleString();
    const dialogue = messages.map((message, index) => {
      const role = message.role === "user" ? "用户" : "AI";
      return `### ${index + 1}. ${role}\n\n${message.content}`;
    });

    const citationSection = citations.length
      ? citations.map((citation, index) => `- [${index + 1}] ${getFileName(citation.path)} p.${citation.page}\n  ${citation.snippet}`)
      : ["- 无"];

    const noteSection = notes.length ? notes.map((note, index) => `- [${index + 1}] ${note.text}`) : ["- 无"];

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
      await invoke("write_text_file", { path: destination, content: buildMarkdownDraft() });
      onStatus(`Markdown 已导出到：${destination}`, "info", false);
    } catch (error) {
      onStatus(`导出 Markdown 失败：${String(error)}`, "error", true);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  };

  const handleInsertNote = (note: NoteItem) => {
    setInputValue((previous) => (previous.trim() ? `${previous}\n${note.text}` : note.text));
  };

  const handleDeleteNote = (noteId: string) => {
    setNotes((previous) => previous.filter((note) => note.id !== noteId));
  };

  return (
    <div className={`chat-container ${isReaderFocused ? "pdf-focus-mode" : ""}`}>
      <div className="chat-header">
        <div className="chat-header-main">
          <div className="main-view-title">科研助手</div>
          <div className="chat-toolbar">
            {activePdfPath && (
              <button style={TOOL_BUTTON_STYLE} onClick={() => setIsReaderFocused((previous) => !previous)}>
                {isReaderFocused ? (
                  <>
                    <Minimize2 size={14} />
                    退出专注阅读
                  </>
                ) : (
                  <>
                    <Maximize2 size={14} />
                    放大阅读区
                  </>
                )}
              </button>
            )}
            <button style={TOOL_BUTTON_STYLE} onClick={handleSaveSession}>
              保存会话
            </button>
            <button style={TOOL_BUTTON_STYLE} onClick={handleRestoreSession}>
              恢复会话
            </button>
            <button style={TOOL_BUTTON_STYLE} onClick={handleClearSession}>
              清空会话
            </button>
            <button style={TOOL_BUTTON_STYLE} onClick={() => void handleExportMarkdown()}>
              导出 Markdown
            </button>
          </div>
        </div>
      </div>

      {activePdfPath && (
        <div className={`pdf-workspace ${isReaderFocused ? "focus-mode" : ""}`}>
          <PdfReader
            activePdfPath={activePdfPath}
            currentModel={currentModel || "qwen2.5:0.5b"}
            lookupMode={lookupMode}
            onLookupModeChange={setLookupMode}
            onStatus={onStatus}
            onSaveCardSuccess={onCardSaved}
            onPageChange={setPdfPage}
          />
          <div className="citation-bar">
            <textarea
              value={citationDraft}
              onChange={(event) => setCitationDraft(event.target.value)}
              placeholder="如果要保留原文引用，可把当前选中的 PDF 片段粘贴到这里，再加入会话输入框。"
              rows={2}
            />
            <button className="action-button primary" onClick={handleAddCitation} disabled={!citationDraft.trim()}>
              加入引用
            </button>
          </div>
        </div>
      )}

      <div className="messages-list" onMouseUp={handleScopedTextSelection}>
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.role === "ai" ? <MarkdownRenderer content={message.content} /> : <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>}
          </div>
        ))}
        {isLoading && (
          <div className="message ai">
            <span className="thinking-text">正在思考...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        {imagePath && (
          <div className="image-chip">
            <span>图片：{getFileName(imagePath)}</span>
            <button className="ghost-icon-button" onClick={() => setImagePath(null)} title="移除图片">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="chat-input-wrapper">
          <button className="send-button" onClick={() => void handlePickImage()} disabled={isLoading} title="添加图片">
            <ImagePlus size={18} />
          </button>
          <textarea
            className="chat-input"
            placeholder="输入消息，或先在 PDF 页面选词再点击解释。"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button className="send-button" onClick={() => void handleSendMessage()} disabled={!inputValue.trim() || isLoading}>
            <Send size={18} />
          </button>
        </div>

        <div className="support-grid">
          <section className="support-panel" onMouseUp={handleScopedTextSelection}>
            <div className="support-panel-title">引用片段</div>
            <div className="support-panel-body">
              {citations.length === 0 && <div className="support-empty">暂无引用。</div>}
              {citations.slice(0, 8).map((citation) => (
                <div key={citation.id} className="support-item">
                  <div className="support-item-title">
                    {getFileName(citation.path)} p.{citation.page}
                  </div>
                  <div className="support-item-text">{citation.snippet}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="support-panel" onMouseUp={handleScopedTextSelection}>
            <div className="support-panel-title">笔记</div>
            <div className="support-panel-body">
              {notes.length === 0 && <div className="support-empty">暂无笔记。</div>}
              {notes.slice(0, 8).map((note) => (
                <div key={note.id} className="support-item">
                  <div className="support-item-text">{note.text}</div>
                  <div className="support-item-actions">
                    <button style={TOOL_BUTTON_STYLE} onClick={() => handleInsertNote(note)}>
                      插入输入框
                    </button>
                    <button style={TOOL_BUTTON_STYLE} onClick={() => handleDeleteNote(note.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="support-panel" onMouseUp={handleScopedTextSelection}>
            <div className="support-panel-title">知识库搜索</div>
            <div className="knowledge-search-row">
              <input
                className="knowledge-search-input"
                value={knowledgeQuery}
                onChange={(event) => setKnowledgeQuery(event.target.value)}
                onKeyDown={handleKnowledgeSearchKeyDown}
                placeholder="输入关键词检索已导入知识库，例如 LoRA、adapter、thyroid cancer"
              />
              <button
                style={TOOL_BUTTON_STYLE}
                onClick={() => void handleKnowledgeSearch()}
                disabled={isKnowledgeSearching || !knowledgeQuery.trim()}
              >
                {isKnowledgeSearching ? "搜索中" : "搜索"}
              </button>
            </div>
            <div className="support-panel-body">
              {!lastKnowledgeQuery && !isKnowledgeSearching && <div className="support-empty">输入关键词后检索本地知识库摘要片段。</div>}
              {lastKnowledgeQuery && !isKnowledgeSearching && knowledgeResults.length === 0 && (
                <div className="support-empty">没有找到与“{lastKnowledgeQuery}”相关的知识库片段。</div>
              )}
              {knowledgeResults.map((doc, index) => (
                <div key={doc.id} className="support-item">
                  <div className="support-item-title">
                    {index + 1}. {getFileName(doc.path)}
                  </div>
                  <div className="support-item-text">{buildDocSnippet(doc.content)}</div>
                  <div className="support-item-actions">
                    <button style={TOOL_BUTTON_STYLE} onClick={() => handleInsertKnowledgeResult(doc)}>
                      插入输入框
                    </button>
                    <button style={TOOL_BUTTON_STYLE} onClick={() => void invoke("open_file", { path: doc.path })}>
                      打开文件
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {selectionMenu && (
        <div
          ref={selectionMenuRef}
          className="selection-menu"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button style={TOOL_BUTTON_STYLE} onClick={handleExplainSelection}>
            解释
          </button>
          <button style={TOOL_BUTTON_STYLE} onClick={() => void handleExpandRetrievalSelection()}>
            扩展检索
          </button>
          <button style={TOOL_BUTTON_STYLE} onClick={handleAddNoteFromSelection}>
            加入笔记
          </button>
          {activePdfPath && (
            <button style={TOOL_BUTTON_STYLE} onClick={handleUseSelectionAsCitation}>
              设为引用
            </button>
          )}
          <button style={TOOL_BUTTON_STYLE} onClick={closeSelectionMenu}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
};



