import * as FileSystem from "expo-file-system/legacy";
import { downloadCardPdf, downloadPaperPdf, downloadWorkspacePdf } from "./api";
import {
  clearPdfDownloads,
  deletePdfDownload,
  getPdfDownload,
  listPdfDownloads,
  type PdfDownloadRecord,
  type PdfSourceType,
  upsertPdfDownload,
} from "./database";
import { useSessionStore } from "../store/session";

interface EnsurePdfOptions {
  sourceType: PdfSourceType;
  sourceId: string;
  title: string;
  pageHint?: number | null;
  baseUrl?: string;
}

export interface CachedPdfItem extends PdfDownloadRecord {
  exists: boolean;
  sizeBytes: number;
}

export async function ensurePdfCached({
  sourceType,
  sourceId,
  title,
  pageHint,
  baseUrl,
}: EnsurePdfOptions) {
  const existing = await getPdfDownload(sourceType, sourceId);
  if (existing) {
    const info = await FileSystem.getInfoAsync(existing.localUri);
    if (info.exists) {
      return existing;
    }
  }

  const session = useSessionStore.getState().session;
  if (!session) {
    throw new Error("尚未完成配对。");
  }

  const directory = await ensurePdfDirectory(sourceType);
  const destinationUri = `${directory}${safeFileStem(sourceId)}.pdf`;
  const result = await downloadPdfBySourceType(
    sourceType,
    baseUrl ?? session.baseUrl,
    session.deviceToken,
    sourceId,
    destinationUri,
  );

  const record = {
    sourceType,
    sourceId,
    localUri: result.localUri,
    fileName: result.fileName || `${safeFileStem(title || sourceId)}.pdf`,
    downloadedAt: new Date().toISOString(),
    pageHint: pageHint ?? result.pageHint ?? null,
  };
  await upsertPdfDownload(record);
  return record;
}

export async function findCachedPdf(
  sourceType: PdfSourceType,
  sourceId: string,
) {
  const existing = await getPdfDownload(sourceType, sourceId);
  if (!existing) return null;
  const info = await FileSystem.getInfoAsync(existing.localUri);
  if (info.exists) return existing;
  await deletePdfDownload(sourceType, sourceId);
  return null;
}

export async function listCachedPdfs(): Promise<CachedPdfItem[]> {
  const records = await listPdfDownloads();
  const items = await Promise.all(
    records.map(async (record) => {
      const info = await FileSystem.getInfoAsync(record.localUri);
      return {
        ...record,
        exists: info.exists,
        sizeBytes: info.exists && typeof info.size === "number" ? info.size : 0,
      };
    }),
  );
  return items;
}

export async function deleteCachedPdf(item: PdfDownloadRecord) {
  await FileSystem.deleteAsync(item.localUri, { idempotent: true });
  await deletePdfDownload(item.sourceType, item.sourceId);
}

export async function clearCachedPdfs() {
  const records = await listPdfDownloads();
  await Promise.all(
    records.map((record) =>
      FileSystem.deleteAsync(record.localUri, { idempotent: true }),
    ),
  );
  await clearPdfDownloads();
}

export function formatCacheSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

async function downloadPdfBySourceType(
  sourceType: PdfSourceType,
  baseUrl: string,
  token: string,
  sourceId: string,
  destinationUri: string,
) {
  if (sourceType === "card") {
    return downloadCardPdf(baseUrl, token, sourceId, destinationUri);
  }
  if (sourceType === "workspacePdf") {
    return downloadWorkspacePdf(baseUrl, token, sourceId, destinationUri);
  }
  return downloadPaperPdf(baseUrl, token, sourceId, destinationUri);
}

async function ensurePdfDirectory(sourceType: PdfSourceType) {
  if (!FileSystem.documentDirectory) {
    throw new Error("当前设备没有可用的应用文档目录。");
  }
  const root = `${FileSystem.documentDirectory}pdfs/`;
  const directory = `${root}${sourceType}s/`;
  await ensureDirectory(root);
  await ensureDirectory(directory);
  return directory;
}

async function ensureDirectory(uri: string) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
}

function safeFileStem(value: string) {
  const normalized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "document";
}
