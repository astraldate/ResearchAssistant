import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { MOBILE_SESSION_KEY, type MobileSession } from "../contracts";

interface SessionState {
  hydrated: boolean;
  session: MobileSession | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  isSyncing: boolean;
  setHydrated: (value: boolean) => void;
  setSession: (session: MobileSession | null) => void;
  setSyncState: (
    next: Partial<
      Pick<SessionState, "lastSyncAt" | "lastSyncError" | "isSyncing">
    >,
  ) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  hydrated: false,
  session: null,
  lastSyncAt: null,
  lastSyncError: null,
  isSyncing: false,
  setHydrated: (value) => set({ hydrated: value }),
  setSession: (session) => set({ session }),
  setSyncState: (next) => set(next),
}));

function isMobileSession(value: unknown): value is MobileSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.baseUrl === "string" &&
    typeof session.deviceId === "string" &&
    typeof session.deviceToken === "string"
  );
}

export async function hydrateSessionStore() {
  try {
    const raw = await SecureStore.getItemAsync(MOBILE_SESSION_KEY);
    if (!raw) {
      useSessionStore.getState().setSession(null);
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isMobileSession(parsed)) {
      throw new Error("Stored session payload is invalid.");
    }
    useSessionStore.getState().setSession(parsed);
  } catch (error) {
    console.warn("Failed to hydrate mobile session store:", error);
    useSessionStore.getState().setSession(null);
    try {
      await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
    } catch (deleteError) {
      console.warn("Failed to clear invalid mobile session:", deleteError);
    }
  } finally {
    useSessionStore.getState().setHydrated(true);
  }
}

export async function persistSession(session: MobileSession | null) {
  if (session) {
    await SecureStore.setItemAsync(MOBILE_SESSION_KEY, JSON.stringify(session));
  } else {
    await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
  }
  useSessionStore.getState().setSession(session);
}
