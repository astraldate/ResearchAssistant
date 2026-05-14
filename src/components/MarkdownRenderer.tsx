import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronUp } from "lucide-react";

interface MarkdownRendererProps {
  content: string;
  autoExpandReasoning?: boolean;
}

type MarkdownSegment =
  | { kind: "text"; content: string }
  | { kind: "think"; content: string };

const splitMarkdownSegments = (content: string): MarkdownSegment[] => {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const openIndex = content.indexOf("<think>", cursor);
    if (openIndex === -1) {
      const plainText = content.slice(cursor).trim();
      if (plainText) {
        segments.push({ kind: "text", content: plainText });
      }
      break;
    }

    const beforeThink = content.slice(cursor, openIndex).trim();
    if (beforeThink) {
      segments.push({ kind: "text", content: beforeThink });
    }

    const thinkStart = openIndex + "<think>".length;
    const closeIndex = content.indexOf("</think>", thinkStart);
    if (closeIndex === -1) {
      const thinkText = content.slice(thinkStart).trim();
      if (thinkText) {
        segments.push({ kind: "think", content: thinkText });
      }
      break;
    }

    const thinkText = content.slice(thinkStart, closeIndex).trim();
    if (thinkText) {
      segments.push({ kind: "think", content: thinkText });
    }
    cursor = closeIndex + "</think>".length;
  }

  return segments.length > 0 ? segments : [{ kind: "text", content }];
};

const MarkdownBlock: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
);

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  autoExpandReasoning = false,
}) => {
  const segments = useMemo(() => splitMarkdownSegments(content), [content]);
  const [expandedThinkSections, setExpandedThinkSections] = useState<
    Record<number, boolean>
  >({});
  const autoExpandedOnceRef = React.useRef(false);

  useEffect(() => {
    if (autoExpandReasoning) {
      const hasThinkSection = segments.some(
        (segment) => segment.kind === "think",
      );
      if (hasThinkSection && !autoExpandedOnceRef.current) {
        const nextState: Record<number, boolean> = {};
        segments.forEach((segment, index) => {
          if (segment.kind === "think") {
            nextState[index] = true;
          }
        });
        setExpandedThinkSections(nextState);
        autoExpandedOnceRef.current = true;
      }
      return;
    }
    autoExpandedOnceRef.current = false;
  }, [autoExpandReasoning, segments]);

  const hasThinkSection = segments.some((segment) => segment.kind === "think");

  return (
    <div className="markdown-content">
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <MarkdownBlock key={`text-${index}`} content={segment.content} />
          );
        }

        const isExpanded = expandedThinkSections[index] ?? false;
        return (
          <section key={`think-${index}`} className="reasoning-block">
            <button
              type="button"
              className="reasoning-toggle"
              onClick={() =>
                setExpandedThinkSections((previous) => ({
                  ...previous,
                  [index]: !isExpanded,
                }))
              }
              aria-expanded={isExpanded}
            >
              <span>{isExpanded ? "隐藏思路" : "显示思路"}</span>
              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {isExpanded && (
              <div className="reasoning-panel">
                <MarkdownBlock content={segment.content} />
              </div>
            )}
          </section>
        );
      })}
      {!hasThinkSection && segments.length === 0 ? (
        <MarkdownBlock content={content} />
      ) : null}
    </div>
  );
};
