import React, { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
}

interface Document {
  id: string;
  path: string;
  content: string;
}

const initialMessages: Message[] = [
  {
    id: '1',
    role: 'ai',
    content: `Hello! I am your research assistant. I can help you with:

- Analyzing academic papers
- Drafting literature reviews
- Managing citations
- Brainstorming research questions

How can I assist you today?`,
    timestamp: new Date(),
  },
];

export const ChatInterface: React.FC<{ currentModel?: string }> = ({ currentModel }) => {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      // 1. Search for relevant context
      let context = "";
      try {
        const docs = await invoke<Document[]>("query_knowledge_base", { query: userMessage.content });
        context = docs.map(d => d.content).join("\n\n");
      } catch (e) {
        console.error("Search failed:", e);
      }

      // 2. Call LLM
      const response = await invoke<string>("chat_with_llm", { 
        query: userMessage.content,
        context: context,
        model: currentModel || 'qwen3-4b-thinking-2507' // Fallback
      });

      const aiResponse: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiResponse]);

    } catch (e) {
      console.error(e);
      const errorResponse: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: `Error: ${e instanceof Error ? e.message : String(e)}\n\nPlease ensure Ollama is running and the model '${currentModel || 'qwen3-4b-thinking-2507'}' is available.`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorResponse]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span>Research Assistant</span>
        <span style={{ fontSize: '0.8em', color: '#6c757d', fontWeight: 'normal' }}>v0.1.0</span>
      </div>

      <div className="messages-list">
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.role === 'ai' ? (
              <MarkdownRenderer content={msg.content} />
            ) : (
              <div>{msg.content}</div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="message ai">
            <span style={{ color: '#6c757d', fontStyle: 'italic' }}>Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <div className="chat-input-wrapper">
          <textarea
            className="chat-input"
            placeholder="Type your message here..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{ height: 'auto', minHeight: '24px' }}
          />
          <button 
            className="send-button" 
            onClick={handleSendMessage}
            disabled={!inputValue.trim() || isLoading}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
