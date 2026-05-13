import {
  MOBILE_API_PREFIX,
  type MobileBootstrapResponse,
  type MobileChatSendRequest,
  type MobileChatStreamEvent,
  type MobileChatThread,
  type MobileChatThreadSummary,
  type MobileHealthResponse,
  type MobileInboxItem,
  type MobileInboxItemInput,
  type MobilePairRequest,
  type MobilePairResponse,
  type ReviewSyncRequest,
  type ReviewSyncResponse,
} from "../contracts";

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Request failed with ${response.status}`);
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

export async function streamChatMessage(
  baseUrl: string,
  token: string,
  threadId: string | null,
  payload: MobileChatSendRequest,
  onEvent: (event: MobileChatStreamEvent) => void,
) {
  const path = threadId
    ? `${MOBILE_API_PREFIX}/chat/threads/${encodeURIComponent(threadId)}/messages/stream`
    : `${MOBILE_API_PREFIX}/chat/threads/stream`;
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      (await response.text()) || `Request failed with ${response.status}`,
    );
  }

  await parseNdjsonResponse(response, onEvent);
}

async function parseNdjsonResponse(
  response: Response,
  onEvent: (event: MobileChatStreamEvent) => void,
) {
  const body = response.body as unknown as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    };
  } | null;
  const reader = body?.getReader?.();
  if (!reader) {
    parseNdjsonText(await response.text(), onEvent, false);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        parseNdjsonLine(line, onEvent);
      }
    }
  }
  buffer += decoder.decode();
  parseNdjsonText(buffer, onEvent, true);
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
