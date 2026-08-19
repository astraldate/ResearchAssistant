import type { PdfOutlineEntry, PdfViewMode } from "../contracts";

export type { PdfOutlineEntry, PdfViewMode } from "../contracts";

export const MOBILE_PDF_VIEWER_REVISION = "strict-glyph-selection-v3";

export interface NativePdfOutlineEntry {
  title?: string;
  pageIdx?: number;
  children?: NativePdfOutlineEntry[];
}

export type PdfViewerMessage =
  | {
      type: "ready";
      pageCount?: number;
      protocolVersion?: number;
      capabilities: string[];
      outline: PdfOutlineEntry[];
    }
  | { type: "page"; page: number; pageCount?: number }
  | { type: "selection"; text: string; page: number; context?: string }
  | { type: "viewMode"; mode: PdfViewMode }
  | { type: "selectionMode"; enabled: boolean }
  | { type: "interaction"; kind: "scroll" | "tap" }
  | { type: "error"; message?: string };

export type PdfViewerCommand =
  | { type: "hostReady" }
  | { type: "goToPage"; page: number }
  | { type: "setViewMode"; mode: PdfViewMode }
  | { type: "setSelectionMode"; enabled: boolean }
  | { type: "resetFit" }
  | { type: "clearSelection" };

export function parsePdfViewerMessage(value: string): PdfViewerMessage | null {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (raw.type === "ready") {
      return {
        type: "ready",
        pageCount: toPositiveInteger(raw.pageCount),
        protocolVersion: toPositiveInteger(raw.protocolVersion),
        capabilities: stringArray(raw.capabilities),
        outline: normalizeViewerOutline(raw.outline),
      };
    }
    if (
      raw.type === "page" ||
      raw.type === "pageChanged" ||
      raw.type === "page-change"
    ) {
      const page = toPositiveInteger(raw.page);
      return page
        ? {
            type: "page",
            page,
            pageCount: toPositiveInteger(raw.pageCount),
          }
        : null;
    }
    if (raw.type === "selection") {
      const page = toPositiveInteger(raw.page);
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      const context =
        typeof raw.context === "string"
          ? raw.context.trim().slice(0, 1400)
          : undefined;
      return page ? { type: "selection", text, page, context } : null;
    }
    if (
      raw.type === "viewMode" &&
      (raw.mode === "continuous" || raw.mode === "single")
    ) {
      return { type: "viewMode", mode: raw.mode };
    }
    if (raw.type === "selectionMode" && typeof raw.enabled === "boolean") {
      return { type: "selectionMode", enabled: raw.enabled };
    }
    if (
      raw.type === "interaction" &&
      (raw.kind === "scroll" || raw.kind === "tap")
    ) {
      return { type: "interaction", kind: raw.kind };
    }
    if (raw.type === "error") {
      return {
        type: "error",
        message: typeof raw.message === "string" ? raw.message : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function serializePdfViewerCommand(command: PdfViewerCommand) {
  return JSON.stringify(command);
}

export function normalizeNativeOutline(
  entries: readonly NativePdfOutlineEntry[] | undefined,
) {
  const result: PdfOutlineEntry[] = [];
  const visit = (
    items: readonly NativePdfOutlineEntry[] | undefined,
    depth: number,
  ) => {
    for (const item of items ?? []) {
      const pageIndex = Number(item.pageIdx);
      if (Number.isFinite(pageIndex) && pageIndex >= 0) {
        const page = Math.floor(pageIndex) + 1;
        const title = item.title?.trim() || `第 ${page} 页`;
        result.push({ title, page, depth });
      }
      visit(item.children, depth + 1);
    }
  };
  visit(entries, 0);
  return result;
}

export function buildPageFallbackOutline(pageCount: number) {
  const safeCount = Math.max(0, Math.floor(pageCount));
  return Array.from({ length: safeCount }, (_, index) => ({
    title: `第 ${index + 1} 页`,
    page: index + 1,
    depth: 0,
  }));
}

export function buildSelectionCacheKey(page: number, text: string) {
  return `${Math.max(1, Math.floor(page))}:${text.trim()}`;
}

export function addMobilePdfViewerRevision(
  viewerUrl: string,
  revision = MOBILE_PDF_VIEWER_REVISION,
) {
  const url = new URL(viewerUrl);
  url.searchParams.set("viewerRevision", revision);
  return url.toString();
}

export function shouldUseControlledPdfSelection(
  protocolVersion: number,
  capabilities: readonly string[] = [],
) {
  return (
    Number.isFinite(protocolVersion) &&
    protocolVersion >= 3 &&
    capabilities.includes("strict-glyph-selection")
  );
}

function normalizeViewerOutline(value: unknown) {
  if (!Array.isArray(value)) return [];
  const result: PdfOutlineEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const page = toPositiveInteger(raw.page);
    if (!page) continue;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const depth = Math.max(0, Math.floor(Number(raw.depth) || 0));
    result.push({ title: title || `第 ${page} 页`, page, depth });
  }
  return result;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
