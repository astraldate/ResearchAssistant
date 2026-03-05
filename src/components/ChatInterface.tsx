import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Send, X } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Message {
  id: string;
  role: "user" | "ai";
  content: string;
  timestamp: number;
}

interface Document {
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

const ZH = {
  assistantTitle: "\u79d1\u7814\u52a9\u624b",
  statusThinking: "\u601d\u8003\u4e2d...",
  inputPlaceholder: "\u8f93\u5165\u6d88\u606f...",
  pickImage: "\u6dfb\u52a0\u56fe\u7247",
  removeImage: "\u79fb\u9664\u56fe\u7247",
  imageTag: "\u56fe\u7247",
  openImageFailed: "\u9009\u62e9\u56fe\u7247\u5931\u8d25",
  askFailed: "\u9519\u8bef",
  askFailedHint: "\u8bf7\u786e\u8ba4 Ollama \u6b63\u5728\u8fd0\u884c\uff0c\u4e14\u6a21\u578b\u53ef\u7528\u3002",
  retrievalTitle: "\u6269\u5c55\u68c0\u7d22\u7ed3\u679c",
  retrievalEmpty: "\u672a\u68c0\u7d22\u5230\u66f4\u591a\u5185\u5bb9\u3002",
  retrievalFailed: "\u6269\u5c55\u68c0\u7d22\u5931\u8d25",
  sessionSaved: "\u4f1a\u8bdd\u5df2\u4fdd\u5b58\u3002",
  sessionRestored: "\u4f1a\u8bdd\u5df2\u6062\u590d\u3002",
  sessionCleared: "\u5df2\u6e05\u7a7a\u5f53\u524d\u4f1a\u8bdd\u3002",
  sessionMissing: "\u6ca1\u6709\u627e\u5230\u53ef\u6062\u590d\u7684\u4f1a\u8bdd\u3002",
  sessionRestoreFailed: "\u6062\u590d\u4f1a\u8bdd\u5931\u8d25\u3002",
  exportSuccess: "\u5df2\u5bfc\u51fa\u5230",
  exportFailed: "\u5bfc\u51fa Markdown \u5931\u8d25\uff1a",
  toolbarSave: "\u4fdd\u5b58\u4f1a\u8bdd",
  toolbarRestore: "\u6062\u590d\u4f1a\u8bdd",
  toolbarClear: "\u6e05\u7a7a\u4f1a\u8bdd",
  toolbarExport: "\u5bfc\u51fa\u7efc\u8ff0 Markdown",
  pdfTitle: "PDF \u9605\u8bfb\u5668",
  pdfNoFile: "\u672a\u9009\u4e2d PDF \u6587\u4ef6\u3002",
  pdfLoading: "\u6b63\u5728\u52a0\u8f7d PDF...",
  pdfPage: "\u9875\u7801",
  pdfPrev: "\u4e0a\u4e00\u9875",
  pdfNext: "\u4e0b\u4e00\u9875",
  pdfPageText: "\u5f53\u524d\u9875\u6587\u672c\uff08\u53ef\u5212\u8bcd\u89e6\u53d1\uff09",
  pdfPageTextEmpty: "\u672c\u9875\u672a\u89e3\u6790\u5230\u53ef\u8bfb\u6587\u672c\u3002",
  pdfPageTextLoading: "\u6b63\u5728\u89e3\u6790\u5f53\u524d\u9875\u6587\u672c...",
  pdfParseFailed: "PDF \u9875\u9762\u6587\u672c\u89e3\u6790\u5931\u8d25",
  pdfSnippetPlaceholder: "\u8f93\u5165\u6216\u7c98\u8d34\u5f53\u524d\u9875\u5173\u952e\u7247\u6bb5\uff0c\u7528\u4e8e\u5f15\u7528\u3002",
  addCitation: "\u52a0\u5165\u5f15\u7528\u5230\u8f93\u5165\u6846",
  citationTitle: "\u5f15\u7528\u7247\u6bb5",
  noteTitle: "\u7b14\u8bb0",
  insertToInput: "\u63d2\u5165\u8f93\u5165\u6846",
  delete: "\u5220\u9664",
  selectionExplain: "\u89e3\u91ca",
  selectionSearch: "\u6269\u5c55\u68c0\u7d22",
  selectionNote: "\u52a0\u5165\u7b14\u8bb0",
  selectionToCitation: "\u8bbe\u4e3a\u5f15\u7528\u7247\u6bb5",
  noCitation: "\u6682\u65e0\u5f15\u7528\u3002",
  noNote: "\u6682\u65e0\u7b14\u8bb0\u3002",
};

const DEFAULT_MESSAGES: Message[] = [
  {
    id: "welcome-1",
    role: "ai",
    content:
      "\u4f60\u597d\uff0c\u6211\u662f\u79d1\u7814\u52a9\u624b\u3002\n\n\u6211\u53ef\u4ee5\u5e2e\u4f60\u603b\u7ed3\u8bba\u6587\u3001\u6574\u7406\u7efc\u8ff0\u3001\u57fa\u4e8e\u77e5\u8bc6\u5e93\u95ee\u7b54\uff0c\u4e5f\u652f\u6301\u56fe\u6587\u95ee\u7b54\u3002",
    timestamp: Date.now(),
  },
];

const SESSION_KEY = "ra_chat_session_v2";

const getFileName = (path: string) => {
  const tokens = path.split(/[\\/]/);
  return tokens[tokens.length - 1] || path;
};

const isPdfFile = (path: string) => /\.pdf$/i.test(path);

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const readSessionFromStorage = (): SessionPayload | null => {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    if (!Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const ChatInterface: React.FC<{ currentModel?: string; activeFilePath?: string | null }> = ({
  currentModel,
  activeFilePath,
}) => {
  const [messages, setMessages] = useState<Message[]>(DEFAULT_MESSAGES);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [citationDraft, setCitationDraft] = useState("");
  const [citations, setCitations] = useState<CitationItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [pdfPageText, setPdfPageText] = useState("");
  const [isPdfPageTextLoading, setIsPdfPageTextLoading] = useState(false);
  const [isSessionHydrated, setIsSessionHydrated] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activePdfPath = activeFilePath && isPdfFile(activeFilePath) ? activeFilePath : null;

  const persistSession = useCallback(
    (payload?: SessionPayload) => {
      const data: SessionPayload =
        payload ?? {
          messages,
          inputValue,
          imagePath,
          pdfPage,
          citationDraft,
          citations,
          notes,
        };
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    },
    [messages, inputValue, imagePath, pdfPage, citationDraft, citations, notes],
  );

  useEffect(() => {
    const stored = readSessionFromStorage();
    if (stored) {
      setMessages(stored.messages.length > 0 ? stored.messages : DEFAULT_MESSAGES);
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    let revokedUrl: string | null = null;
    let cancelled = false;

    if (!activePdfPath) {
      setPdfBlobUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      setIsPdfLoading(false);
      return () => {
        // noop
      };
    }

    setIsPdfLoading(true);
    setStatusText(null);

    void invoke<string>("read_file_base64", { path: activePdfPath })
      .then((base64) => {
        if (cancelled) return;
        const bytes = base64ToBytes(base64);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const objectUrl = URL.createObjectURL(blob);
        revokedUrl = objectUrl;
        setPdfBlobUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return objectUrl;
        });
        setIsPdfLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load PDF:", error);
        setPdfBlobUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return null;
        });
        setIsPdfLoading(false);
        setStatusText(`${ZH.askFailed}：${String(error)}`);
      });

    return () => {
      cancelled = true;
      if (revokedUrl) {
        URL.revokeObjectURL(revokedUrl);
      }
    };
  }, [activePdfPath]);

  useEffect(() => {
    let cancelled = false;

    if (!activePdfPath) {
      setPdfPageText("");
      setIsPdfPageTextLoading(false);
      return () => {
        // noop
      };
    }

    setIsPdfPageTextLoading(true);
    void invoke<string>("extract_pdf_page_text", { path: activePdfPath, page: Math.max(1, pdfPage) })
      .then((text) => {
        if (cancelled) return;
        setPdfPageText(text);
        setIsPdfPageTextLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to extract PDF page text:", error);
        setPdfPageText("");
        setIsPdfPageTextLoading(false);
        setStatusText(`${ZH.pdfParseFailed}: ${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activePdfPath, pdfPage]);

  const pdfViewerSrc = useMemo(() => {
    if (!pdfBlobUrl) return null;
    return `${pdfBlobUrl}#page=${pdfPage}`;
  }, [pdfBlobUrl, pdfPage]);

  const handlePickImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: ZH.imageTag, extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });

      if (selected && typeof selected === "string") {
        setImagePath(selected);
      }
    } catch (error) {
      console.error(`${ZH.openImageFailed}:`, error);
      setStatusText(`${ZH.openImageFailed}: ${String(error)}`);
    }
  };

  const handleTextSelection = () => {
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
    const selection = window.getSelection();
    selection?.removeAllRanges();
  };

  const handleExplainSelection = () => {
    if (!selectionMenu) return;
    const prompt = `\u8bf7\u89e3\u91ca\u4e0b\u5217\u5185\u5bb9\uff1a\n${selectionMenu.text}`;
    setInputValue((previous) => (previous.trim() ? `${previous}\n\n${prompt}` : prompt));
    closeSelectionMenu();
  };

  const handleExpandRetrievalSelection = async () => {
    if (!selectionMenu) return;
    const query = selectionMenu.text;
    closeSelectionMenu();

    try {
      const docs = await invoke<Document[]>("query_knowledge_base", { query });
      const summary =
        docs.length === 0
          ? ZH.retrievalEmpty
          : docs
              .map((doc, index) => {
                const snippet = doc.content.replace(/\s+/g, " ").slice(0, 180);
                return `${index + 1}. ${getFileName(doc.path)}\n${snippet}${doc.content.length > 180 ? "..." : ""}`;
              })
              .join("\n\n");

      const retrievalMessage: Message = {
        id: `${Date.now()}-retrieval`,
        role: "ai",
        content: `### ${ZH.retrievalTitle}\n\n${summary}`,
        timestamp: Date.now(),
      };
      setMessages((previous) => [...previous, retrievalMessage]);
    } catch (error) {
      console.error("Retrieval failed:", error);
      setStatusText(`${ZH.retrievalFailed}: ${String(error)}`);
    }
  };

  const handleAddNoteFromSelection = () => {
    if (!selectionMenu) return;
    const note: NoteItem = {
      id: `${Date.now()}-note`,
      text: selectionMenu.text,
      createdAt: Date.now(),
    };
    setNotes((previous) => [note, ...previous]);
    closeSelectionMenu();
  };

  const handleUseSelectionAsCitation = () => {
    if (!selectionMenu) return;
    setCitationDraft(selectionMenu.text);
    closeSelectionMenu();
  };

  const handleAddCitationFromPdf = () => {
    if (!activePdfPath) return;
    const snippet = citationDraft.trim();
    if (!snippet) return;

    const citation: CitationItem = {
      id: `${Date.now()}-citation`,
      path: activePdfPath,
      page: Math.max(1, pdfPage),
      snippet,
      createdAt: Date.now(),
    };

    setCitations((previous) => [citation, ...previous]);

    const citationLine = `[\u5f15\u7528:${getFileName(activePdfPath)} p.${citation.page}] ${citation.snippet}`;
    setInputValue((previous) => (previous.trim() ? `${previous}\n${citationLine}` : citationLine));
    setCitationDraft("");
  };

  const handleSendMessage = async () => {
    const question = inputValue.trim();
    if (!question) return;

    const userMessage: Message = {
      id: `${Date.now()}-user`,
      role: "user",
      content: imagePath ? `${question}\n\n[${ZH.imageTag}: ${getFileName(imagePath)}]` : question,
      timestamp: Date.now(),
    };

    setMessages((previous) => [...previous, userMessage]);
    setInputValue("");
    setIsLoading(true);
    setStatusText(null);

    try {
      let context = "";
      try {
        const docs = await invoke<Document[]>("query_knowledge_base", { query: question });
        context = docs.map((doc) => doc.content).join("\n\n");
      } catch (error) {
        console.error("Search failed:", error);
      }

      const response = await invoke<string>("chat_with_llm", {
        query: question,
        context,
        model: currentModel || "qwen2.5:0.5b",
        image_path: imagePath,
      });

      const aiResponse: Message = {
        id: `${Date.now()}-ai`,
        role: "ai",
        content: response,
        timestamp: Date.now(),
      };

      setMessages((previous) => [...previous, aiResponse]);
      setImagePath(null);
    } catch (error) {
      console.error("Chat failed:", error);
      const aiError: Message = {
        id: `${Date.now()}-error`,
        role: "ai",
        content: `${ZH.askFailed}：${error instanceof Error ? error.message : String(error)}\n\n${ZH.askFailedHint}`,
        timestamp: Date.now(),
      };
      setMessages((previous) => [...previous, aiError]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveSession = () => {
    persistSession();
    setStatusText(ZH.sessionSaved);
  };

  const handleRestoreSession = () => {
    const stored = readSessionFromStorage();
    if (!stored) {
      setStatusText(ZH.sessionMissing);
      return;
    }

    try {
      setMessages(stored.messages.length > 0 ? stored.messages : DEFAULT_MESSAGES);
      setInputValue(stored.inputValue || "");
      setImagePath(stored.imagePath || null);
      setPdfPage(stored.pdfPage && stored.pdfPage > 0 ? stored.pdfPage : 1);
      setCitationDraft(stored.citationDraft || "");
      setCitations(Array.isArray(stored.citations) ? stored.citations : []);
      setNotes(Array.isArray(stored.notes) ? stored.notes : []);
      setStatusText(ZH.sessionRestored);
    } catch {
      setStatusText(ZH.sessionRestoreFailed);
    }
  };

  const handleClearSession = () => {
    setMessages(DEFAULT_MESSAGES);
    setInputValue("");
    setImagePath(null);
    setPdfPage(1);
    setCitationDraft("");
    setCitations([]);
    setNotes([]);
    setStatusText(ZH.sessionCleared);
  };

  const buildMarkdownDraft = useCallback(() => {
    const now = new Date();
    const header = [
      "# \u7efc\u8ff0\u8349\u7a3f",
      "",
      `\u751f\u6210\u65f6\u95f4\uff1a${now.toLocaleString()}`,
      currentModel ? `\u6a21\u578b\uff1a${currentModel}` : "\u6a21\u578b\uff1a\u672a\u8bbe\u7f6e",
      "",
      "## \u5bf9\u8bdd\u7eaa\u8981",
      "",
    ];

    const dialogue = messages.map((message, index) => {
      const role = message.role === "user" ? "\u7528\u6237" : "AI";
      return `### ${index + 1}. ${role}\n\n${message.content}`;
    });

    const citationSection = [
      "",
      "## \u5f15\u7528\u6e05\u5355",
      "",
      ...(citations.length === 0
        ? ["- \u65e0"]
        : citations.map(
            (citation, index) =>
              `- [${index + 1}] ${getFileName(citation.path)} p.${citation.page}\\n  ${citation.snippet}`,
          )),
    ];

    const noteSection = [
      "",
      "## \u7814\u7a76\u7b14\u8bb0",
      "",
      ...(notes.length === 0 ? ["- \u65e0"] : notes.map((note, index) => `- [${index + 1}] ${note.text}`)),
    ];

    return [...header, ...dialogue, ...citationSection, ...noteSection].join("\n");
  }, [messages, citations, notes, currentModel]);

  const handleExportMarkdown = async () => {
    try {
      const dateTag = new Date().toISOString().slice(0, 10);
      const destination = await save({
        defaultPath: `review-draft-${dateTag}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });

      if (!destination || typeof destination !== "string") {
        return;
      }

      const content = buildMarkdownDraft();
      await invoke("write_text_file", { path: destination, content });
      setStatusText(`${ZH.exportSuccess} ${destination}`);
    } catch (error) {
      console.error("Export failed:", error);
      setStatusText(`${ZH.exportFailed}${String(error)}`);
    }
  };

  const handleInsertNoteToInput = (note: NoteItem) => {
    setInputValue((previous) => (previous.trim() ? `${previous}\n${note.text}` : note.text));
  };

  const handleRemoveNote = (noteId: string) => {
    setNotes((previous) => previous.filter((note) => note.id !== noteId));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  };

  const toolButtonStyle: React.CSSProperties = {
    border: "1px solid var(--border-color)",
    background: "var(--bg-primary)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: "0.75rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div className="chat-container" onMouseUp={handleTextSelection}>
      <div className="chat-header" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>{ZH.assistantTitle}</span>
          <span style={{ fontSize: "0.8em", color: "#6c757d", fontWeight: "normal" }}>v0.1.0</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={handleSaveSession} style={toolButtonStyle}>
            {ZH.toolbarSave}
          </button>
          <button onClick={handleRestoreSession} style={toolButtonStyle}>
            {ZH.toolbarRestore}
          </button>
          <button onClick={handleClearSession} style={toolButtonStyle}>
            {ZH.toolbarClear}
          </button>
          <button onClick={handleExportMarkdown} style={toolButtonStyle}>
            {ZH.toolbarExport}
          </button>
        </div>
      </div>

      {activePdfPath && (
        <div
          style={{
            borderBottom: "1px solid var(--border-color)",
            padding: "10px 12px",
            background: "var(--bg-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>
              {ZH.pdfTitle}: {getFileName(activePdfPath)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button style={toolButtonStyle} onClick={() => setPdfPage((value) => Math.max(1, value - 1))}>
                {ZH.pdfPrev}
              </button>
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{ZH.pdfPage}</span>
              <input
                type="number"
                min={1}
                value={pdfPage}
                onChange={(event) => setPdfPage(Math.max(1, Number(event.target.value) || 1))}
                style={{ width: 70, padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border-color)" }}
              />
              <button style={toolButtonStyle} onClick={() => setPdfPage((value) => value + 1)}>
                {ZH.pdfNext}
              </button>
            </div>
          </div>

          <div style={{ height: 260, border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
            {isPdfLoading && (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
                {ZH.pdfLoading}
              </div>
            )}
            {!isPdfLoading && pdfViewerSrc && (
              <iframe title={ZH.pdfTitle} src={pdfViewerSrc} style={{ width: "100%", height: "100%", border: "none" }} />
            )}
            {!isPdfLoading && !pdfViewerSrc && (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
                {ZH.pdfNoFile}
              </div>
            )}
          </div>

          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              padding: "8px 10px",
              background: "var(--bg-primary)",
              maxHeight: 150,
              overflowY: "auto",
              fontSize: "0.82rem",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              userSelect: "text",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text-secondary)" }}>{ZH.pdfPageText}</div>
            {isPdfPageTextLoading ? ZH.pdfPageTextLoading : pdfPageText || ZH.pdfPageTextEmpty}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={citationDraft}
              onChange={(event) => setCitationDraft(event.target.value)}
              placeholder={ZH.pdfSnippetPlaceholder}
              rows={2}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--border-color)",
                fontSize: "0.85rem",
              }}
            />
            <button
              style={{ ...toolButtonStyle, minWidth: 160 }}
              onClick={handleAddCitationFromPdf}
              disabled={!citationDraft.trim()}
            >
              {ZH.addCitation}
            </button>
          </div>
        </div>
      )}

      <div className="messages-list">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.role === "ai" ? (
              <MarkdownRenderer content={message.content} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="message ai">
            <span style={{ color: "#6c757d", fontStyle: "italic" }}>{ZH.statusThinking}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        {statusText && (
          <div style={{ marginBottom: 8, fontSize: "0.8rem", color: "var(--text-secondary)", wordBreak: "break-all" }}>
            {statusText}
          </div>
        )}

        {imagePath && (
          <div
            style={{
              marginBottom: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--bg-tertiary)",
              borderRadius: 999,
              padding: "4px 10px",
              fontSize: "0.8rem",
              color: "var(--text-secondary)",
            }}
          >
            <span>
              {ZH.imageTag}：{getFileName(imagePath)}
            </span>
            <button
              onClick={() => setImagePath(null)}
              style={{ border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}
              title={ZH.removeImage}
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="chat-input-wrapper">
          <button className="send-button" onClick={handlePickImage} disabled={isLoading} title={ZH.pickImage} style={{ marginRight: 4 }}>
            <ImagePlus size={18} />
          </button>
          <textarea
            className="chat-input"
            placeholder={ZH.inputPlaceholder}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{ height: "auto", minHeight: "24px" }}
          />
          <button className="send-button" onClick={() => void handleSendMessage()} disabled={!inputValue.trim() || isLoading}>
            <Send size={18} />
          </button>
        </div>

        <div
          style={{
            marginTop: 10,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          <div style={{ border: "1px solid var(--border-color)", borderRadius: 6, padding: 8 }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: 6 }}>{ZH.citationTitle}</div>
            <div style={{ maxHeight: 110, overflowY: "auto", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
              {citations.length === 0 && <div>{ZH.noCitation}</div>}
              {citations.slice(0, 6).map((citation) => (
                <div key={citation.id} style={{ marginBottom: 8 }}>
                  <div>
                    {getFileName(citation.path)} p.{citation.page}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{citation.snippet}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ border: "1px solid var(--border-color)", borderRadius: 6, padding: 8 }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: 6 }}>{ZH.noteTitle}</div>
            <div style={{ maxHeight: 110, overflowY: "auto", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
              {notes.length === 0 && <div>{ZH.noNote}</div>}
              {notes.slice(0, 8).map((note) => (
                <div key={note.id} style={{ marginBottom: 8 }}>
                  <div style={{ whiteSpace: "pre-wrap", marginBottom: 4 }}>{note.text}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={toolButtonStyle} onClick={() => handleInsertNoteToInput(note)}>
                      {ZH.insertToInput}
                    </button>
                    <button style={toolButtonStyle} onClick={() => handleRemoveNote(note.id)}>
                      {ZH.delete}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selectionMenu && (
        <div
          style={{
            position: "fixed",
            top: selectionMenu.y,
            left: selectionMenu.x,
            transform: "translate(-50%, -100%)",
            zIndex: 12000,
            background: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: 8,
            boxShadow: "0 8px 20px rgba(0, 0, 0, 0.16)",
            padding: 6,
            display: "flex",
            gap: 6,
            maxWidth: "min(90vw, 420px)",
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button style={toolButtonStyle} onClick={handleExplainSelection}>
            {ZH.selectionExplain}
          </button>
          <button style={toolButtonStyle} onClick={() => void handleExpandRetrievalSelection()}>
            {ZH.selectionSearch}
          </button>
          <button style={toolButtonStyle} onClick={handleAddNoteFromSelection}>
            {ZH.selectionNote}
          </button>
          {activePdfPath && (
            <button style={toolButtonStyle} onClick={handleUseSelectionAsCitation}>
              {ZH.selectionToCitation}
            </button>
          )}
          <button style={toolButtonStyle} onClick={closeSelectionMenu}>
            X
          </button>
        </div>
      )}
    </div>
  );
};
