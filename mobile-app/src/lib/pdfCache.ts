import * as FileSystem from "expo-file-system/legacy";
import { downloadCardPdf, downloadPaperPdf, downloadWorkspacePdf } from "./api";
import {
  getPdfDownload,
  type PdfSourceType,
  upsertPdfDownload,
} from "./database";
import { useSessionStore } from "../store/session";

interface EnsurePdfOptions {
  sourceType: PdfSourceType;
  sourceId: string;
  title: string;
  pageHint?: number | null;
}

export async function ensurePdfCached({
  sourceType,
  sourceId,
  title,
  pageHint,
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
    session.baseUrl,
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
