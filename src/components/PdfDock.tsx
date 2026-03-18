import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { LookupMode } from "./TermExplainPopover";
import { PdfReader } from "./PdfReader";

type StatusTone = "info" | "error";

interface PdfDockProps {
  activePdfPath: string;
  currentModel: string;
  ensureAiReady?: () => Promise<string>;
  currentPage: number;
  onPageChange: (page: number) => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onCardSaved: () => void;
  isFocusMode: boolean;
  onToggleFocusMode: () => void;
  onClose: () => void;
}

const LOOKUP_MODE_KEY = "ra_term_lookup_mode_v1";

export const PdfDock: React.FC<PdfDockProps> = ({
  activePdfPath,
  currentModel,
  ensureAiReady,
  currentPage,
  onPageChange,
  onStatus,
  onCardSaved,
  isFocusMode,
  onToggleFocusMode,
  onClose,
}) => {
  const [lookupMode, setLookupMode] = useState<LookupMode>(() => {
    const stored = localStorage.getItem(LOOKUP_MODE_KEY);
    if (
      stored === "popular_cn" ||
      stored === "cs_encyclopedia" ||
      stored === "bioinformatics"
    ) {
      return stored;
    }
    return "popular_cn";
  });
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);

  useEffect(() => {
    localStorage.setItem(LOOKUP_MODE_KEY, lookupMode);
  }, [lookupMode]);

  return (
    <div className="pdf-dock">
      <div className="pdf-dock-topbar">
        <button
          className="ghost-icon-button pdf-dock-topbar-button"
          onClick={() => setIsToolbarCollapsed((value) => !value)}
          aria-label={
            isToolbarCollapsed ? "Expand PDF toolbar" : "Collapse PDF toolbar"
          }
          title={isToolbarCollapsed ? "Expand toolbar" : "Collapse toolbar"}
        >
          {isToolbarCollapsed ? (
            <ChevronDown size={16} />
          ) : (
            <ChevronUp size={16} />
          )}
        </button>
        <button
          className="ghost-icon-button pdf-dock-topbar-button"
          onClick={onClose}
          aria-label="Close PDF reader"
          title="Close PDF reader"
        >
          <X size={16} />
        </button>
      </div>

      <div className="pdf-dock-body">
        <PdfReader
          activePdfPath={activePdfPath}
          currentModel={currentModel}
          ensureAiReady={ensureAiReady}
          isFocused
          lookupMode={lookupMode}
          onLookupModeChange={setLookupMode}
          onStatus={onStatus}
          onSaveCardSuccess={onCardSaved}
          onPageChange={onPageChange}
          requestedPage={currentPage}
          isToolbarCollapsed={isToolbarCollapsed}
          toolbarActions={
            <div className="pdf-dock-actions">
              <button
                className="action-button pdf-toolbar-icon-button"
                onClick={onToggleFocusMode}
                aria-label={
                  isFocusMode ? "Exit focus mode" : "Enter focus mode"
                }
                title={isFocusMode ? "Exit focus mode" : "Enter focus mode"}
              >
                {isFocusMode ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
};
