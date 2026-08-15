export const MOBILE_API_VERSION = "2026-08-10.v2";
export const MOBILE_API_PREFIX = "/api/mobile/v1";
export const MOBILE_DEFAULT_PORT_CANDIDATES = [
  38465, 38466, 38467, 38468, 38469,
] as const;
export const MOBILE_SESSION_KEY = "researchassistant.mobile.session.v1";
export const MOBILE_DB_NAME = "researchassistant-mobile.db";

export type ReviewRating = "again" | "hard" | "good" | "easy";
export type MobileCaptureKind = "image" | "url" | "note";
export type MobileInboxStatus = "received" | "processed";

export interface PairedDeviceSummary {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  lastSeenAt?: string | null;
}

export interface MobileCompanionStatus {
  apiVersion: string;
  serviceName: string;
  pairCode: string;
  listenerPort: number;
  baseUrls: string[];
  pairedDevices: PairedDeviceSummary[];
  inboxCount: number;
  reviewRecordCount: number;
  cardCount: number;
  running: boolean;
  lastError?: string | null;
  inboxDir: string;
  reviewStateDir: string;
}

export interface MobileHealthResponse {
  apiVersion: string;
  serviceName: string;
  running: boolean;
  baseUrls?: string[];
}

export interface MobilePairRequest {
  pairCode: string;
  deviceName: string;
  appVersion: string;
}

export interface MobilePairResponse {
  apiVersion: string;
  serviceName: string;
  deviceId: string;
  deviceToken: string;
  pairedAt: string;
  baseUrls: string[];
}

export interface MobileSession {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  pairedAt: string;
}

export interface MobileCardRecord {
  id: string;
  term: string;
  title: string;
  createdAt: string;
  preview: string;
  markdown: string;
  sourceProvider?: string | null;
  sourceStatus: string;
  lookupMode: string;
  hasPdf: boolean;
  pdfPath?: string | null;
  pdfPage?: number | null;
}

export interface MobileNoteRecord {
  id: string;
  title: string;
  createdAt: string;
  sourcePaper?: string | null;
  preview: string;
  markdown: string;
}

export interface MobileCardWriteRequest {
  term: string;
  title: string;
  markdown: string;
}

export interface MobileNoteWriteRequest {
  title: string;
  markdown: string;
}

export interface MobileCardWriteRequest {
  term: string;
  title: string;
  markdown: string;
}

export interface MobileNoteWriteRequest {
  title: string;
  markdown: string;
}

export interface MobilePaperRecord {
  paperId: string;
  title: string;
  paperType: string;
  updatedAt: string;
  hasPdf: boolean;
  sourceType: "paper" | "workspacePdf";
}

export type MobilePdfSourceType = "card" | "paper" | "workspacePdf";

export interface MobilePdfSource {
  sourceType: MobilePdfSourceType;
  sourceId: string;
  page: number;
}

export interface MobilePdfTranslateSelectionRequest extends MobilePdfSource {
  text: string;
}

export interface MobilePdfTranslateSelectionResult {
  originalText: string;
  translatedText: string;
  page: number;
  generatedAt: string;
  modelUsed: string;
  promptVersionUsed: string;
}

export type MobilePdfTranslatePageRequest = MobilePdfSource;

export interface MobilePdfTranslatePageResult {
  page: number;
  translatedMarkdown: string;
  sourceTextLength: number;
  generatedAt: string;
  modelUsed: string;
}

export type MobilePdfLookupMode =
  | "popular_cn"
  | "cs_encyclopedia"
  | "bioinformatics";

export interface MobilePdfExplainSelectionRequest extends MobilePdfSource {
  term: string;
  context?: string | null;
  lookupMode?: MobilePdfLookupMode | null;
}

export interface MobilePdfExplainSelectionResult {
  term: string;
  plainSummary: string;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  sourceProvider?: string | null;
  sourceLang?: string | null;
  sourceExtract?: string | null;
  pageContextSnippet?: string | null;
  sourceStatus: string;
  generatedAt: string;
  lookupMode: MobilePdfLookupMode;
  modelUsed: string;
}

export interface MobilePdfSaveExplanationCardRequest extends MobilePdfSource {
  explanation: MobilePdfExplainSelectionResult;
  selectedText: string;
}

export interface MobilePdfSaveExplanationCardResult {
  id: string;
  term: string;
  title: string;
  createdAt: string;
  preview: string;
  pdfPage?: number | null;
}

export interface ReviewHistoryEntry {
  eventId: string;
  rating: ReviewRating;
  reviewedAt: string;
  deviceId: string;
}

export interface ReviewRecord {
  cardId: string;
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  lapses: number;
  consecutiveSuccesses: number;
  totalReviews: number;
  lastRating?: ReviewRating | null;
  lastReviewedAt?: string | null;
  history: ReviewHistoryEntry[];
}

export interface MobileReviewEvent {
  eventId: string;
  cardId: string;
  rating: ReviewRating;
  reviewedAt: string;
  deviceId: string;
}

export interface ReviewSyncRequest {
  events: MobileReviewEvent[];
}

export interface ReviewSyncResponse {
  acceptedEventIds: string[];
  reviewRecords: ReviewRecord[];
}

export interface MobileInboxItemInput {
  captureKind: MobileCaptureKind;
  title?: string | null;
  note?: string | null;
  url?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  assetBase64?: string | null;
  createdAt?: string | null;
}

export interface MobileInboxItem {
  id: string;
  captureKind: MobileCaptureKind;
  status: MobileInboxStatus;
  title?: string | null;
  note?: string | null;
  url?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  storedAssetPath?: string | null;
  deviceId: string;
  createdAt: string;
}

export interface MobileBootstrapResponse {
  service: MobileCompanionStatus;
  cards: MobileCardRecord[];
  notes?: MobileNoteRecord[];
  reviewRecords: ReviewRecord[];
}

export type MobileChatRole = "user" | "assistant";
export type MobileChatStatus = "idle" | "streaming" | "error";
export type MobileChatMessageStatus =
  | "complete"
  | "streaming"
  | "error"
  | "interrupted";

export interface MobileChatMessage {
  messageId: string;
  role: MobileChatRole;
  content: string;
  createdAt: string;
  source: "mobile" | "desktop";
  status: MobileChatMessageStatus;
  citations?: MobileCitation[];
  innovationAnalysis?: MobileInnovationAnalysis | null;
  ideaId?: string | null;
  command?: MobileChatCommand | null;
  paperContext?: MobileChatPaperContext | null;
}

export type MobileChatCommand =
  | "ask"
  | "method"
  | "exp"
  | "claim"
  | "brief"
  | "innovation";

export interface MobileChatPaperContext {
  sourceType: "paper" | "workspacePdf";
  sourceId: string;
  title: string;
}

export interface MobileCitation {
  label: `A${number}` | `B${number}`;
  paperId: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  snippet: string;
  sourceType: "paper" | "workspacePdf";
}

export interface MobileInnovationAnalysis {
  conceptA: string;
  conceptB: string;
  conceptAExpansion?: string | null;
  conceptBExpansion?: string | null;
  evidenceStatus?: "both" | "a_only" | "b_only" | "none" | null;
}

export interface MobileInnovationIntentRequest {
  message: string;
}

export interface MobileInnovationIntent {
  detected: boolean;
  conceptA?: string | null;
  conceptB?: string | null;
  conceptAExpansion?: string | null;
  conceptBExpansion?: string | null;
  conceptARole?: string | null;
  conceptBRole?: string | null;
  ambiguityNote?: string | null;
}

export interface MobileChatThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  status: MobileChatStatus;
  messages: MobileChatMessage[];
  lastError?: string | null;
}

export interface MobileChatThreadSummary {
  threadId: string;
  title: string;
  updatedAt: string;
  model: string;
  status: MobileChatStatus;
  lastMessagePreview: string;
  messageCount: number;
  lastError?: string | null;
}

export interface MobileChatSendRequest {
  message: string;
  clientRequestId?: string | null;
  useRetrieval?: boolean | null;
  thinkingEnabled?: boolean | null;
  innovationAnalysis?: MobileInnovationAnalysis | null;
  command?: MobileChatCommand | null;
  paperContext?: MobileChatPaperContext | null;
}

export interface MobileChatCancelRequest {
  clientRequestId: string;
}

export interface MobileChatCancelResponse {
  clientRequestId: string;
  cancelled: boolean;
}

export type MobileChatStreamEvent =
  | { type: "thread"; thread: MobileChatThread; useRetrieval?: boolean }
  | { type: "queued" }
  | { type: "status"; status: string }
  | {
      type: "sources";
      citations: MobileCitation[];
      innovationAnalysis?: MobileInnovationAnalysis | null;
    }
  | { type: "idea"; ideaId?: string; title?: string; error?: string }
  | { type: "delta"; delta: string; phase?: "thinking" | "answer" }
  | { type: "interrupted"; message?: string }
  | { type: "done"; ideaId?: string | null }
  | { type: "error"; error: string };
