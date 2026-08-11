import { fetchBootstrap, pushReviewEvents } from "./api";
import {
  enqueueReviewEvent,
  getReviewRecord,
  listQueuedReviewEvents,
  removeQueuedReviewEvents,
  replaceCards,
  replaceNotes,
  replaceReviewRecords,
  saveReviewRecords,
  upsertReviewRecord,
} from "./database";
import { applyReviewEvent, isoNow } from "./scheduler";
import { useSessionStore } from "../store/session";
import type { MobileReviewEvent, ReviewRating } from "../contracts";

export async function bootstrapSync() {
  const { session, setSyncState } = useSessionStore.getState();
  if (!session) {
    throw new Error("尚未完成配对。");
  }

  setSyncState({ isSyncing: true, lastSyncError: null });
  try {
    const bootstrap = await fetchBootstrap(
      session.baseUrl,
      session.deviceToken,
    );
    await replaceCards(bootstrap.cards);
    if (bootstrap.notes) {
      await replaceNotes(bootstrap.notes);
    }
    await replaceReviewRecords(bootstrap.reviewRecords);
    setSyncState({
      isSyncing: false,
      lastSyncAt: isoNow(),
      lastSyncError: null,
    });
    await flushQueuedReviewEvents();
    return bootstrap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSyncState({ isSyncing: false, lastSyncError: message });
    throw error;
  }
}

export async function queueLocalReview(cardId: string, rating: ReviewRating) {
  const session = useSessionStore.getState().session;
  if (!session) {
    throw new Error("尚未完成配对。");
  }

  const event: MobileReviewEvent = {
    eventId: `${cardId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    cardId,
    rating,
    reviewedAt: isoNow(),
    deviceId: session.deviceId,
  };

  await enqueueReviewEvent(event);
  const current = await getReviewRecord(cardId);
  const next = applyReviewEvent(current, event);
  await upsertReviewRecord(next);
  void flushQueuedReviewEvents();
  return next;
}

export async function flushQueuedReviewEvents() {
  const session = useSessionStore.getState().session;
  if (!session) return;

  const events = await listQueuedReviewEvents();
  if (events.length === 0) return;

  const response = await pushReviewEvents(
    session.baseUrl,
    session.deviceToken,
    { events },
  );
  await saveReviewRecords(response.reviewRecords);
  await removeQueuedReviewEvents(response.acceptedEventIds);
  useSessionStore
    .getState()
    .setSyncState({ lastSyncAt: isoNow(), lastSyncError: null });
}
