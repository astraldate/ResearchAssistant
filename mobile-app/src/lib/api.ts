import {
  MOBILE_API_PREFIX,
  type MobileBootstrapResponse,
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

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit = {}, token?: string): Promise<T> {
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
  return requestJson<MobileHealthResponse>(baseUrl, `${MOBILE_API_PREFIX}/health`);
}

export async function pairDesktopService(baseUrl: string, payload: MobilePairRequest) {
  return requestJson<MobilePairResponse>(baseUrl, `${MOBILE_API_PREFIX}/pair`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchBootstrap(baseUrl: string, token: string) {
  return requestJson<MobileBootstrapResponse>(baseUrl, `${MOBILE_API_PREFIX}/bootstrap`, {}, token);
}

export async function pushReviewEvents(baseUrl: string, token: string, payload: ReviewSyncRequest) {
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

export async function submitInboxItem(baseUrl: string, token: string, payload: MobileInboxItemInput) {
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
