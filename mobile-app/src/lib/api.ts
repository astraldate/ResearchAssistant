import * as FileSystem from "expo-file-system/legacy";
import {
  MOBILE_API_PREFIX,
  type MobileBootstrapResponse,
  type MobileCardRecord,
  type MobileCardWriteRequest,
  type MobileChatCancelResponse,
  type MobileChatSendRequest,
  type MobileChatStreamEvent,
  type MobileChatThread,
  type MobileChatThreadSummary,
  type MobileHealthResponse,
  type MobileInboxItem,
  type MobileInboxItemInput,
  type MobileInnovationIntent,
  type MobileInnovationIntentRequest,
  type MobileNoteRecord,
  type MobileNoteWriteRequest,
  type MobilePaperRecord,
  type MobilePairRequest,
  type MobilePairResponse,
  type MobilePdfExplainSelectionRequest,
  type MobilePdfExplainSelectionResult,
  type MobilePdfSaveExplanationCardRequest,
  type MobilePdfSaveExplanationCardResult,
  type MobilePdfSource,
  type MobilePdfTranslatePageRequest,
  type MobilePdfTranslatePageResult,
  type MobilePdfTranslateSelectionRequest,
  type MobilePdfTranslateSelectionResult,
  type ReviewSyncRequest,
  type ReviewSyncResponse,
} from "../contracts";

export interface PdfDownloadResult {
  localUri: string;
  fileName: string;
  pageHint: number | null;
}

export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接桌面端地址：${url}。如果使用 Tailscale，请确认手机与电脑均在线且使用 http://100.x.y.z:端口；如果使用 Cloudflare Tunnel，请确认桌面端已显示 https 公网地址。原始错误：${message}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const suffix =
      response.status === 502
        ? "如果这是 Tailscale 地址，请确认填写的是 http://100.x.y.z:端口，而不是 HTTPS/MagicDNS Serve 地址。"
        : "";
    throw new Error(
      `桌面端返回 ${response.status} ${response.statusText || ""}：${text || "无响应内容"}${suffix ? ` ${suffix}` : ""}`,
    );
  }

  if (!text.trim()) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

export async function checkDesktopService(baseUrl: string) {
  return requestJson<MobileHealthResponse>(
    baseUrl,
    `${MOBILE_API_PREFIX}/health`,
  );
}

export async function selectFastestDesktopBaseUrl(baseUrl: string) {
  const current = normalizeBaseUrl(baseUrl);
  const initial = await probeDesktopHealth(current, 3_000).catch(() => null);
  if (!initial) return current;
  const candidates = Array.from(
    new Set([
      current,
      ...(initial.health.baseUrls ?? [])
        .map(normalizeBaseUrl)
        .filter(
          (value) =>
            value &&
            !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(value),
        ),
    ]),
  );
  const results = await Promise.all(
    candidates.map((candidate) =>
      probeDesktopHealth(candidate, 1_500).catch(() => null),
    ),
  );
  const available = results.filter((result): result is DesktopHealthProbe =>
    Boolean(result?.health.running && result.health.apiVersion),
  );
  available.sort((left, right) => left.elapsedMs - right.elapsedMs);
  return available[0]?.baseUrl ?? current;
}

interface DesktopHealthProbe {
  baseUrl: string;
  elapsedMs: number;
  health: MobileHealthResponse;
}

async function probeDesktopHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<DesktopHealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const health = await requestJson<MobileHealthResponse>(
      baseUrl,
      `${MOBILE_API_PREFIX}/health`,
      { signal: controller.signal },
    );
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      elapsedMs: Date.now() - startedAt,
      health,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function pairDesktopService(
  baseUrl: string,
  payload: MobilePairRequest,
) {
  return requestJson<MobilePairResponse>(baseUrl, `${MOBILE_API_PREFIX}/pair`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchBootstrap(baseUrl: string, token: string) {
  return requestJson<MobileBootstrapResponse>(
    baseUrl,
    `${MOBILE_API_PREFIX}/bootstrap`,
    {},
    token,
  );
}

export async function pushReviewEvents(
  baseUrl: string,
  token: string,
  payload: ReviewSyncRequest,
) {
  return requestJson<ReviewSyncResponse>(
    baseUrl,
    `${MOBILE_API_PREFIX}/review-events`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
  );
}

export async function submitInboxItem(
  baseUrl: string,
  token: string,
  payload: MobileInboxItemInput,
) {
  return requestJson<MobileInboxItem>(
    baseUrl,
    `${MOBILE_API_PREFIX}/inbox/items`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
  );
}

export async function fetchMobilePapers(baseUrl: string, token: string) {
  return requestJson<MobilePaperRecord[]>(
    baseUrl,
    `${MOBILE_API_PREFIX}/papers`,
    {},
    token,
  );
}

export async function deleteMobileCard(
  baseUrl: string,
  token: string,
  cardId: string,
) {
  return requestJson<{ id: string; deleted: boolean }>(
    baseUrl,
    `${MOBILE_API_PREFIX}/cards/${encodeURIComponent(cardId)}`,
    { method: "DELETE" },
    token,
  );
}

export async function createMobileCard(
  baseUrl: string,
  token: string,
  payload: MobileCardWriteRequest,
) {
  return requestJson<MobileCardRecord>(
    baseUrl,
    `${MOBILE_API_PREFIX}/cards`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function updateMobileCard(
  baseUrl: string,
  token: string,
  cardId: string,
  payload: MobileCardWriteRequest,
) {
  return requestJson<MobileCardRecord>(
    baseUrl,
    `${MOBILE_API_PREFIX}/cards/${encodeURIComponent(cardId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token,
  );
}

export async function deleteMobileNote(
  baseUrl: string,
  token: string,
  noteId: MobileNoteRecord["id"],
) {
  return requestJson<{ id: string; deleted: boolean }>(
    baseUrl,
    `${MOBILE_API_PREFIX}/notes/${encodeURIComponent(noteId)}`,
    { method: "DELETE" },
    token,
  );
}

export async function createMobileNote(
  baseUrl: string,
  token: string,
  payload: MobileNoteWriteRequest,
) {
  return requestJson<MobileNoteRecord>(
    baseUrl,
    `${MOBILE_API_PREFIX}/notes`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function updateMobileNote(
  baseUrl: string,
  token: string,
  noteId: string,
  payload: MobileNoteWriteRequest,
) {
  return requestJson<MobileNoteRecord>(
    baseUrl,
    `${MOBILE_API_PREFIX}/notes/${encodeURIComponent(noteId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token,
  );
}

export function buildMobilePdfViewerUrl(
  baseUrl: string,
  source: MobilePdfSource,
) {
  const query = new URLSearchParams({
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    page: String(source.page),
  });
  return `${normalizeBaseUrl(baseUrl)}${MOBILE_API_PREFIX}/pdf-viewer?${query.toString()}`;
}

export async function translateMobilePdfSelection(
  baseUrl: string,
  token: string,
  payload: MobilePdfTranslateSelectionRequest,
) {
  return requestJson<MobilePdfTranslateSelectionResult>(
    baseUrl,
    `${MOBILE_API_PREFIX}/pdf/translate-selection`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function translateMobilePdfPage(
  baseUrl: string,
  token: string,
  payload: MobilePdfTranslatePageRequest,
) {
  return requestJson<MobilePdfTranslatePageResult>(
    baseUrl,
    `${MOBILE_API_PREFIX}/pdf/translate-page`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function explainMobilePdfSelection(
  baseUrl: string,
  token: string,
  payload: MobilePdfExplainSelectionRequest,
) {
  return requestJson<MobilePdfExplainSelectionResult>(
    baseUrl,
    `${MOBILE_API_PREFIX}/pdf/explain-selection`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function saveMobilePdfExplanationCard(
  baseUrl: string,
  token: string,
  payload: MobilePdfSaveExplanationCardRequest,
) {
  return requestJson<MobilePdfSaveExplanationCardResult>(
    baseUrl,
    `${MOBILE_API_PREFIX}/pdf/save-explanation-card`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function detectInnovationIntent(
  baseUrl: string,
  token: string,
  payload: MobileInnovationIntentRequest,
) {
  return requestJson<MobileInnovationIntent>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/innovation-intent`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function downloadCardPdf(
  baseUrl: string,
  token: string,
  cardId: string,
  destinationUri: string,
) {
  return downloadPdfFile(
    baseUrl,
    token,
    `${MOBILE_API_PREFIX}/cards/${encodeURIComponent(cardId)}/pdf`,
    destinationUri,
  );
}

export async function downloadPaperPdf(
  baseUrl: string,
  token: string,
  paperId: string,
  destinationUri: string,
) {
  return downloadPdfFile(
    baseUrl,
    token,
    `${MOBILE_API_PREFIX}/papers/${encodeURIComponent(paperId)}/pdf`,
    destinationUri,
  );
}

export async function downloadWorkspacePdf(
  baseUrl: string,
  token: string,
  pdfId: string,
  destinationUri: string,
) {
  return downloadPdfFile(
    baseUrl,
    token,
    `${MOBILE_API_PREFIX}/workspace-pdfs/${encodeURIComponent(pdfId)}/pdf`,
    destinationUri,
  );
}

async function downloadPdfFile(
  baseUrl: string,
  token: string,
  path: string,
  destinationUri: string,
): Promise<PdfDownloadResult> {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`;
  const result = await FileSystem.downloadAsync(url, destinationUri, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true });
    throw new Error(`PDF 下载失败：桌面端返回 ${result.status}`);
  }
  const headers = normalizeResponseHeaders(result.headers ?? {});
  return {
    localUri: result.uri,
    fileName:
      headers["x-ra-file-name"] ||
      destinationUri.split("/").filter(Boolean).pop() ||
      "document.pdf",
    pageHint: parseHeaderNumber(headers["x-ra-pdf-page"]),
  };
}

function normalizeResponseHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function parseHeaderNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function fetchChatThreads(baseUrl: string, token: string) {
  return requestJson<MobileChatThreadSummary[]>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/threads`,
    {},
    token,
  );
}

export async function fetchChatThread(
  baseUrl: string,
  token: string,
  threadId: string,
) {
  return requestJson<MobileChatThread>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/threads/${encodeURIComponent(threadId)}`,
    {},
    token,
  );
}

export async function deleteChatThread(
  baseUrl: string,
  token: string,
  threadId: string,
) {
  return requestJson<Record<string, never>>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
    token,
  );
}

export async function deleteMobileInnovationResult(
  baseUrl: string,
  token: string,
  threadId: string,
  messageId: string,
) {
  return requestJson<MobileChatThread>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/threads/${encodeURIComponent(threadId)}/innovation-results/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
    token,
  );
}

export async function deleteMobileIdea(
  baseUrl: string,
  token: string,
  ideaId: string,
) {
  return requestJson<{ id: string; deleted: boolean }>(
    baseUrl,
    `${MOBILE_API_PREFIX}/ideas/${encodeURIComponent(ideaId)}`,
    { method: "DELETE" },
    token,
  );
}

export async function streamChatMessage(
  baseUrl: string,
  token: string,
  threadId: string | null,
  payload: MobileChatSendRequest,
  onEvent: (event: MobileChatStreamEvent) => void,
  signal?: AbortSignal,
) {
  const path = threadId
    ? `${MOBILE_API_PREFIX}/chat/threads/${encodeURIComponent(threadId)}/messages/stream`
    : `${MOBILE_API_PREFIX}/chat/threads/stream`;
  await streamNdjsonWithXhr(
    `${normalizeBaseUrl(baseUrl)}${path}`,
    token,
    payload,
    onEvent,
    signal,
  );
}

export async function cancelMobileChatGeneration(
  baseUrl: string,
  token: string,
  clientRequestId: string,
  signal?: AbortSignal,
) {
  return requestJson<MobileChatCancelResponse>(
    baseUrl,
    `${MOBILE_API_PREFIX}/chat/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ clientRequestId }),
      signal,
    },
    token,
  );
}

function streamNdjsonWithXhr(
  url: string,
  token: string,
  payload: MobileChatSendRequest,
  onEvent: (event: MobileChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seenLength = 0;
    let buffer = "";
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const abort = () => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      xhr.abort();
      const error = new Error("用户已停止本次生成。");
      error.name = "AbortError";
      reject(error);
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      signal?.removeEventListener("abort", abort);
      xhr.abort();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      signal?.removeEventListener("abort", abort);
      resolve();
    };

    const resetIdleTimer = (stage: string) => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        fail(
          new Error(
            `${stage}超过 150 秒没有收到桌面端新响应。请确认桌面端应用已重启到最新版、Ollama 正在运行，或先新建会话重试。`,
          ),
        );
      }, 150_000);
    };

    const consumeText = (text: string, tolerateTrailingPartial: boolean) => {
      if (!text) return;
      resetIdleTimer("聊天流");
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach((line) => parseNdjsonLine(line, onEvent));
      if (tolerateTrailingPartial && buffer.trim()) {
        parseNdjsonText(buffer, onEvent, true);
        buffer = "";
      }
    };

    xhr.open("POST", url);
    xhr.timeout = 0;
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    resetIdleTimer("连接桌面端");
    xhr.onprogress = () => {
      const nextText = xhr.responseText.slice(seenLength);
      seenLength = xhr.responseText.length;
      consumeText(nextText, false);
    };
    xhr.onerror = () => fail(new Error("移动端聊天流连接失败。"));
    xhr.ontimeout = () =>
      fail(new Error("移动端聊天流超时：桌面端长时间没有完成响应。"));
    xhr.onload = () => {
      if (settled) return;
      const nextText = xhr.responseText.slice(seenLength);
      seenLength = xhr.responseText.length;
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(
          new Error(
            xhr.responseText.trim() || `Request failed with ${xhr.status}`,
          ),
        );
        return;
      }
      consumeText(nextText, true);
      succeed();
    };
    xhr.send(JSON.stringify(payload));
  });
}

function parseNdjsonText(
  text: string,
  onEvent: (event: MobileChatStreamEvent) => void,
  tolerateTrailingPartial: boolean,
) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (tolerateTrailingPartial && index === lines.length - 1 && line.trim()) {
      try {
        parseNdjsonLine(line, onEvent);
      } catch {
        onEvent({ type: "error", error: "连接中断，最后一段响应不完整。" });
      }
      return;
    }
    parseNdjsonLine(line, onEvent);
  });
}

function parseNdjsonLine(
  line: string,
  onEvent: (event: MobileChatStreamEvent) => void,
) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const event = JSON.parse(trimmed) as MobileChatStreamEvent;
    if (event && typeof event.type === "string") {
      onEvent(event);
    }
  } catch {
    onEvent({ type: "error", error: "收到不完整的流式响应，已停止本次生成。" });
  }
}
