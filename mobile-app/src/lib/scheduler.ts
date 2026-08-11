import type { MobileReviewEvent, ReviewRecord } from "../contracts";

export function isoNow() {
  return new Date().toISOString();
}

export function buildInitialReviewRecord(
  cardId: string,
  nowIso = isoNow(),
): ReviewRecord {
  return {
    cardId,
    dueAt: nowIso,
    intervalDays: 0,
    easeFactor: 2.5,
    lapses: 0,
    consecutiveSuccesses: 0,
    totalReviews: 0,
    lastRating: null,
    lastReviewedAt: null,
    history: [],
  };
}

function addDays(iso: string, days: number) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.round(days)));
  return date.toISOString();
}

export function applyReviewEvent(
  current: ReviewRecord | null | undefined,
  event: MobileReviewEvent,
): ReviewRecord {
  const base =
    current ?? buildInitialReviewRecord(event.cardId, event.reviewedAt);
  let easeFactor = base.easeFactor || 2.5;
  let intervalDays = base.intervalDays || 0;
  let lapses = base.lapses;
  let consecutiveSuccesses = base.consecutiveSuccesses;

  switch (event.rating) {
    case "again":
      easeFactor = Math.max(1.3, easeFactor - 0.2);
      intervalDays = 1;
      lapses += 1;
      consecutiveSuccesses = 0;
      break;
    case "hard":
      easeFactor = Math.max(1.3, easeFactor - 0.15);
      intervalDays =
        base.totalReviews === 0
          ? 1
          : Math.max(1, Math.round(Math.max(1, intervalDays) * 1.2));
      consecutiveSuccesses += 1;
      break;
    case "good":
      intervalDays =
        base.totalReviews === 0
          ? 1
          : Math.max(2, Math.round(Math.max(1, intervalDays) * easeFactor));
      consecutiveSuccesses += 1;
      break;
    case "easy":
      easeFactor += 0.15;
      intervalDays =
        base.totalReviews === 0
          ? 3
          : Math.max(
              4,
              Math.round(Math.max(1, intervalDays) * easeFactor * 1.3),
            );
      consecutiveSuccesses += 1;
      break;
  }

  return {
    cardId: base.cardId,
    dueAt: addDays(event.reviewedAt, intervalDays),
    intervalDays,
    easeFactor: Number(easeFactor.toFixed(2)),
    lapses,
    consecutiveSuccesses,
    totalReviews: base.totalReviews + 1,
    lastRating: event.rating,
    lastReviewedAt: event.reviewedAt,
    history: [
      ...base.history,
      {
        eventId: event.eventId,
        rating: event.rating,
        reviewedAt: event.reviewedAt,
        deviceId: event.deviceId,
      },
    ].slice(-60),
  };
}
