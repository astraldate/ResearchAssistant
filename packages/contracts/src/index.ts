export const MOBILE_API_VERSION = "2026-03-13.v1";
export const MOBILE_API_PREFIX = "/api/mobile/v1";
export const MOBILE_DEFAULT_PORT_CANDIDATES = [38465, 38466, 38467, 38468, 38469] as const;
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
  pdfPath?: string | null;
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
  reviewRecords: ReviewRecord[];
}
