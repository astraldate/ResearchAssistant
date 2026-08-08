import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import {
  MOBILE_DB_NAME,
  type MobileCardRecord,
  type MobileReviewEvent,
  type ReviewRecord,
} from "../contracts";

export type PdfSourceType = "card" | "paper" | "workspacePdf";
export interface PdfDownloadRecord {
  sourceType: PdfSourceType;
  sourceId: string;
  localUri: string;
  fileName: string;
  downloadedAt: string;
  pageHint: number | null;
}

type CardRow = Omit<MobileCardRecord, "pdfPage" | "hasPdf"> & {
  hasPdf?: number | null;
  pdfPage: number | null;
};
type ReviewRow = {
  cardId: string;
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  lapses: number;
  consecutiveSuccesses: number;
  totalReviews: number;
  lastRating: string | null;
  lastReviewedAt: string | null;
  historyJson: string;
};
type QueueRow = {
  eventId: string;
  payloadJson: string;
};
type PdfDownloadRow = {
  sourceType: PdfSourceType;
  sourceId: string;
  localUri: string;
  fileName: string;
  downloadedAt: string;
  pageHint: number | null;
};

let databasePromise: Promise<SQLiteDatabase> | null = null;

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn("Failed to parse cached mobile JSON payload:", error);
    return fallback;
  }
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = openDatabaseAsync(MOBILE_DB_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY NOT NULL,
          term TEXT NOT NULL,
          title TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          preview TEXT NOT NULL,
          markdown TEXT NOT NULL,
          sourceProvider TEXT,
          sourceStatus TEXT NOT NULL,
          lookupMode TEXT NOT NULL,
          hasPdf INTEGER NOT NULL DEFAULT 0,
          pdfPath TEXT,
          pdfPage INTEGER
        );
        CREATE TABLE IF NOT EXISTS review_records (
          cardId TEXT PRIMARY KEY NOT NULL,
          dueAt TEXT NOT NULL,
          intervalDays REAL NOT NULL,
          easeFactor REAL NOT NULL,
          lapses INTEGER NOT NULL,
          consecutiveSuccesses INTEGER NOT NULL,
          totalReviews INTEGER NOT NULL,
          lastRating TEXT,
          lastReviewedAt TEXT,
          historyJson TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS queued_review_events (
          eventId TEXT PRIMARY KEY NOT NULL,
          payloadJson TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pdf_downloads (
          sourceType TEXT NOT NULL,
          sourceId TEXT NOT NULL,
          localUri TEXT NOT NULL,
          fileName TEXT NOT NULL,
          downloadedAt TEXT NOT NULL,
          pageHint INTEGER,
          PRIMARY KEY (sourceType, sourceId)
        );
      `);
      await ensureColumn(db, "cards", "hasPdf", "INTEGER NOT NULL DEFAULT 0");
      return db;
    });
  }
  return databasePromise;
}

async function ensureColumn(
  db: SQLiteDatabase,
  tableName: string,
  columnName: string,
  declaration: string,
) {
  const rows = await db.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${tableName})`,
  );
  if (!rows.some((row) => row.name === columnName)) {
    await db.execAsync(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declaration};`,
    );
  }
}

export async function replaceCards(cards: MobileCardRecord[]) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.execAsync("DELETE FROM cards;");
    for (const card of cards) {
      await db.runAsync(
        `INSERT INTO cards (
          id, term, title, createdAt, preview, markdown, sourceProvider, sourceStatus, lookupMode, hasPdf, pdfPath, pdfPage
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          card.id,
          card.term,
          card.title,
          card.createdAt,
          card.preview,
          card.markdown,
          card.sourceProvider ?? null,
          card.sourceStatus,
          card.lookupMode,
          card.hasPdf ? 1 : 0,
          card.pdfPath ?? null,
          typeof card.pdfPage === "number" ? card.pdfPage : null,
        ],
      );
    }
  });
}

export async function listCards(searchText = "") {
  const db = await getDatabase();
  const rows = await db.getAllAsync<CardRow>(
    `SELECT * FROM cards
     WHERE (? = '' OR lower(term) LIKE '%' || lower(?) || '%' OR lower(title) LIKE '%' || lower(?) || '%' OR lower(preview) LIKE '%' || lower(?) || '%')
     ORDER BY createdAt DESC`,
    [searchText, searchText, searchText, searchText],
  );

  return rows.map((row) => ({ ...row, hasPdf: Boolean(row.hasPdf) }));
}

export async function saveReviewRecords(records: ReviewRecord[]) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (const record of records) {
      await db.runAsync(
        `INSERT OR REPLACE INTO review_records (
          cardId, dueAt, intervalDays, easeFactor, lapses, consecutiveSuccesses, totalReviews, lastRating, lastReviewedAt, historyJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.cardId,
          record.dueAt,
          record.intervalDays,
          record.easeFactor,
          record.lapses,
          record.consecutiveSuccesses,
          record.totalReviews,
          record.lastRating ?? null,
          record.lastReviewedAt ?? null,
          JSON.stringify(record.history),
        ],
      );
    }
  });
}

export async function getReviewRecord(cardId: string) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ReviewRow>(
    "SELECT * FROM review_records WHERE cardId = ?",
    [cardId],
  );
  if (!row) return null;
  return {
    cardId: row.cardId,
    dueAt: row.dueAt,
    intervalDays: row.intervalDays,
    easeFactor: row.easeFactor,
    lapses: row.lapses,
    consecutiveSuccesses: row.consecutiveSuccesses,
    totalReviews: row.totalReviews,
    lastRating: row.lastRating as ReviewRecord["lastRating"],
    lastReviewedAt: row.lastReviewedAt,
    history: parseJsonValue(row.historyJson, []),
  } satisfies ReviewRecord;
}

export async function listDueReviewCards(nowIso: string) {
  const db = await getDatabase();
  const rows = await db.getAllAsync<
    CardRow & Partial<ReviewRow> & { reviewCardId?: string | null }
  >(
    `SELECT
       c.*,
       rr.cardId as reviewCardId,
       rr.dueAt,
       rr.intervalDays,
       rr.easeFactor,
       rr.lapses,
       rr.consecutiveSuccesses,
       rr.totalReviews,
       rr.lastRating,
       rr.lastReviewedAt,
       rr.historyJson
     FROM cards c
     LEFT JOIN review_records rr ON rr.cardId = c.id
     WHERE rr.dueAt IS NULL OR rr.dueAt <= ?
     ORDER BY COALESCE(rr.dueAt, c.createdAt) ASC, c.createdAt DESC`,
    [nowIso],
  );

  return rows.map((row) => ({
    card: {
      id: row.id,
      term: row.term,
      title: row.title,
      createdAt: row.createdAt,
      preview: row.preview,
      markdown: row.markdown,
      sourceProvider: row.sourceProvider ?? null,
      sourceStatus: row.sourceStatus,
      lookupMode: row.lookupMode,
      hasPdf: Boolean(row.hasPdf),
      pdfPath: row.pdfPath ?? null,
      pdfPage: row.pdfPage ?? null,
    } satisfies MobileCardRecord,
    review: row.reviewCardId
      ? ({
          cardId: row.reviewCardId,
          dueAt: row.dueAt as string,
          intervalDays: row.intervalDays as number,
          easeFactor: row.easeFactor as number,
          lapses: row.lapses as number,
          consecutiveSuccesses: row.consecutiveSuccesses as number,
          totalReviews: row.totalReviews as number,
          lastRating: (row.lastRating ?? null) as ReviewRecord["lastRating"],
          lastReviewedAt: row.lastReviewedAt ?? null,
          history: parseJsonValue(row.historyJson as string | null, []),
        } satisfies ReviewRecord)
      : null,
  }));
}

export async function upsertReviewRecord(record: ReviewRecord) {
  await saveReviewRecords([record]);
}

export async function enqueueReviewEvent(event: MobileReviewEvent) {
  const db = await getDatabase();
  await db.runAsync(
    "INSERT OR REPLACE INTO queued_review_events (eventId, payloadJson) VALUES (?, ?)",
    [event.eventId, JSON.stringify(event)],
  );
}

export async function listQueuedReviewEvents() {
  const db = await getDatabase();
  const rows = await db.getAllAsync<QueueRow>(
    "SELECT * FROM queued_review_events ORDER BY rowid ASC",
  );
  return rows
    .map((row) =>
      parseJsonValue<MobileReviewEvent | null>(row.payloadJson, null),
    )
    .filter((event): event is MobileReviewEvent => Boolean(event));
}

export async function removeQueuedReviewEvents(eventIds: string[]) {
  if (eventIds.length === 0) return;
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (const eventId of eventIds) {
      await db.runAsync("DELETE FROM queued_review_events WHERE eventId = ?", [
        eventId,
      ]);
    }
  });
}

export async function getPdfDownload(
  sourceType: PdfSourceType,
  sourceId: string,
) {
  const db = await getDatabase();
  return db.getFirstAsync<PdfDownloadRow>(
    "SELECT * FROM pdf_downloads WHERE sourceType = ? AND sourceId = ?",
    [sourceType, sourceId],
  );
}

export async function listPdfDownloads() {
  const db = await getDatabase();
  return db.getAllAsync<PdfDownloadRow>(
    "SELECT * FROM pdf_downloads ORDER BY downloadedAt DESC",
  );
}

export async function upsertPdfDownload(record: PdfDownloadRecord) {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT OR REPLACE INTO pdf_downloads (
      sourceType, sourceId, localUri, fileName, downloadedAt, pageHint
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.sourceType,
      record.sourceId,
      record.localUri,
      record.fileName,
      record.downloadedAt,
      record.pageHint,
    ],
  );
}

export async function deletePdfDownload(
  sourceType: PdfSourceType,
  sourceId: string,
) {
  const db = await getDatabase();
  await db.runAsync(
    "DELETE FROM pdf_downloads WHERE sourceType = ? AND sourceId = ?",
    [sourceType, sourceId],
  );
}

export async function clearPdfDownloads() {
  const db = await getDatabase();
  await db.execAsync("DELETE FROM pdf_downloads;");
}

export async function clearAllCachedData() {
  const db = await getDatabase();
  await db.execAsync(`
    DELETE FROM cards;
    DELETE FROM review_records;
    DELETE FROM queued_review_events;
    DELETE FROM pdf_downloads;
  `);
}
