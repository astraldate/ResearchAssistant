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
      `无法连接桌面端地址：${url}。请确认手机与电脑的 Tailscale 均在线，且使用 http://100.x.y.z:端口。原始错误：${message}`,
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
  await streamNdjsonWithXhr(
    `${normalizeBaseUrl(baseUrl)}${path}`,
    token,
    payload,
    onEvent,
  );
}

function streamNdjsonWithXhr(
  url: string,
  token: string,
  payload: MobileChatSendRequest,
  onEvent: (event: MobileChatStreamEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seenLength = 0;
    let buffer = "";

    const consumeText = (text: string, tolerateTrailingPartial: boolean) => {
      if (!text) return;
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
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.onprogress = () => {
      const nextText = xhr.responseText.slice(seenLength);
      seenLength = xhr.responseText.length;
      consumeText(nextText, false);
    };
    xhr.onerror = () => reject(new Error("移动端聊天流连接失败。"));
    xhr.onload = () => {
      const nextText = xhr.responseText.slice(seenLength);
      seenLength = xhr.responseText.length;
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            xhr.responseText.trim() || `Request failed with ${xhr.status}`,
          ),
        );
        return;
      }
      consumeText(nextText, true);
      resolve();
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
