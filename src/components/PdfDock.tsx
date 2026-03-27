import React, { Suspense, lazy, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { LookupMode } from "./TermExplainPopover";

type StatusTone = "info" | "error";

interface PdfDockProps {
  activePdfPath: string;
  currentModel: string;
  ensureAiReady?: () => Promise<string>;
  translationModel: string;
  ensureTranslationReady?: () => Promise<string>;
  currentPage: number;
  requestedAnchorText?: string;
  requestedAnchorKey?: string;
  onPageChange: (page: number) => void;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
  onCardSaved: () => void;
  isFocusMode: boolean;
  onToggleFocusMode: () => void;
  onClose: () => void;
}

const LOOKUP_MODE_KEY = "ra_term_lookup_mode_v1";

const PdfReader = lazy(() =>
  import("./PdfReader").then((module) => ({
    default: module.PdfReader,
  })),
);

export const PdfDock: React.FC<PdfDockProps> = ({
  activePdfPath,
  currentModel,
  ensureAiReady,
  translationModel,
  ensureTranslationReady,
  currentPage,
  requestedAnchorText,
  requestedAnchorKey,
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
        <Suspense
          fallback={
            <div className="pdf-empty-state">
              <h2>Loading PDF Reader</h2>
              <p>正在按需加载 PDF 引擎和阅读器组件...</p>
            </div>
          }
        >
          <PdfReader
            activePdfPath={activePdfPath}
            currentModel={currentModel}
            ensureAiReady={ensureAiReady}
            translationModel={translationModel}
            ensureTranslationReady={ensureTranslationReady}
            isFocused
            lookupMode={lookupMode}
            onLookupModeChange={setLookupMode}
            onStatus={onStatus}
            onSaveCardSuccess={onCardSaved}
            onPageChange={onPageChange}
            requestedPage={currentPage}
            requestedAnchorText={requestedAnchorText}
            requestedAnchorKey={requestedAnchorKey}
            isToolbarCollapsed={isToolbarCollapsed}
            toolbarActions={null}
          />
        </Suspense>
      </div>
    </div>
  );
};
