/**
 * SM-2-lite: the spaced-repetition scheduler behind the review queue.
 *
 * "Lite" because it keeps SM-2's two moving parts — a per-card ease factor and a
 * multiplicative interval — and drops everything else (no response-time model, no
 * matrix of optimal factors). The whole thing is a pure function so the rules can
 * be tested exhaustively instead of observed in production months later.
 *
 * ## The rules, exactly
 *
 * Four grades: 1 Again, 2 Hard, 3 Good, 4 Easy.
 *
 * **Ease** starts at 2.5 and moves by grade: Again −0.20, Hard −0.15, Good ±0,
 * Easy +0.15, clamped to [1.3, 3.0]. The 1.3 floor is the SM-2 floor: below it a
 * card stops making progress and just churns.
 *
 * **The ladder.** A card that has never passed climbs two fixed steps, 1 day then
 * 3 days, before it earns an ease-driven interval. Position on the ladder is
 * derived from the stored interval (−1 = not on it yet, 0 = 1 day, 1 = 3 days), so
 * the schedule is a function of the card's stored state and nothing else.
 *
 * - Again  → interval 1 day, state `learning`, lapses +1. (Relearn from the
 *   bottom, whatever the card had reached.)
 * - Hard   → repeat the current step (a `new` card still lands on the 1-day step);
 *   never graduates.
 * - Good   → advance one step: new → 1d, 1d → 3d, 3d → graduate.
 * - Easy   → advance two steps: new → 3d, 1d → graduate, 3d → graduate.
 *
 * **Graduation** leaves the ladder for state `review` with
 * `round(3 · ease)` days — `round(3 · ease · 1.3)` when the grade was Easy.
 *
 * **In `review` state** the interval is multiplicative, as in SM-2:
 * - Hard → `round(interval · 1.2)` (creeps forward instead of stalling)
 * - Good → `round(interval · ease)`
 * - Easy → `round(interval · ease · 1.3)`
 *
 * Intervals are whole days clamped to [1, 365]; the ease floor of 1.3 and the
 * 1.2 Hard factor make every passing review strictly longer than the last, so a
 * card can never get stuck repeating the same interval forever.
 */

export const DAY_MS = 86_400_000;

/** 1 Again · 2 Hard · 3 Good · 4 Easy. */
export type ReviewGrade = 1 | 2 | 3 | 4;

export const REVIEW_GRADES: readonly ReviewGrade[] = [1, 2, 3, 4];

export type ReviewCardState = "new" | "learning" | "review";

export const REVIEW_CARD_STATES: readonly ReviewCardState[] = [
  "new",
  "learning",
  "review",
];

export const EASE_DEFAULT = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;

export const EASE_DELTA: Readonly<Record<ReviewGrade, number>> = {
  1: -0.2,
  2: -0.15,
  3: 0,
  4: 0.15,
};

/** Fixed pre-graduation intervals, in days. */
export const LEARNING_STEPS_DAYS: readonly number[] = [1, 3];

/** Hard in `review` state ignores ease and creeps forward by this factor. */
export const HARD_FACTOR = 1.2;

/** Easy stretches the ease-driven interval by this much. */
export const EASY_BONUS = 1.3;

export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 365;

/** The stored scheduling state of one card — the scheduler's whole input. */
export interface ReviewCard {
  state: ReviewCardState;
  /** Days since the last review; null until the card has been graded once. */
  intervalDays: number | null;
  ease: number;
  lapses: number;
}

/** The scheduler's whole output: what to write back for the graded card. */
export interface ReviewSchedule {
  state: ReviewCardState;
  dueAt: number;
  intervalDays: number;
  ease: number;
  lapses: number;
  lastGrade: ReviewGrade;
  reviewedAt: number;
}

/** A freshly enrolled card: due immediately, never graded, default ease. */
export function initialReviewCard(now: number): ReviewCard & { dueAt: number } {
  return {
    state: "new",
    dueAt: now,
    intervalDays: null,
    ease: EASE_DEFAULT,
    lapses: 0,
  };
}

export function isReviewGrade(value: unknown): value is ReviewGrade {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

export function isReviewCardState(value: unknown): value is ReviewCardState {
  return value === "new" || value === "learning" || value === "review";
}

/** A card with no `dueAt` has never been scheduled, so it is due now. */
export function isReviewDue(
  card: { dueAt: number | null | undefined },
  now: number,
): boolean {
  const due = card.dueAt;
  if (due === null || due === undefined || !Number.isFinite(due)) return true;
  return due <= now;
}

export function clampEase(ease: number): number {
  if (!Number.isFinite(ease)) return EASE_DEFAULT;
  return Math.min(EASE_MAX, Math.max(EASE_MIN, roundEase(ease)));
}

export function clampIntervalDays(days: number): number {
  if (!Number.isFinite(days)) return MIN_INTERVAL_DAYS;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, days));
}

/**
 * Where this card sits on the learning ladder: −1 before the first step, then the
 * index of the largest step it has reached. Derived from the interval rather than
 * stored, so a hand-edited row can never describe a position that does not exist.
 */
export function ladderPosition(card: ReviewCard): number {
  if (card.state === "new") return -1;
  const interval = card.intervalDays;
  if (interval === null || !Number.isFinite(interval)) return -1;
  let position = -1;
  for (let i = 0; i < LEARNING_STEPS_DAYS.length; i += 1) {
    const step = LEARNING_STEPS_DAYS[i];
    if (step !== undefined && interval >= step) position = i;
  }
  return position;
}

/** Steps a passing grade moves the card up the ladder. */
function ladderAdvance(grade: ReviewGrade): number {
  if (grade === 2) return 0;
  if (grade === 3) return 1;
  return 2;
}

function lastStepDays(): number {
  return LEARNING_STEPS_DAYS[LEARNING_STEPS_DAYS.length - 1] ?? 1;
}

// Ease accumulates ±0.15/±0.2 steps, so without rounding it drifts into float
// noise (2.5 - 0.15 - 0.15 = 2.1999999999999997) that then shows up in intervals.
function roundEase(ease: number): number {
  return Math.round(ease * 1000) / 1000;
}

/**
 * The next schedule for `card` after answering with `grade` at `now`.
 * Pure: same inputs, same output, no clock and no I/O.
 */
export function scheduleReview(
  card: ReviewCard,
  grade: ReviewGrade,
  now: number,
): ReviewSchedule {
  const ease = clampEase(card.ease + EASE_DELTA[grade]);
  const lapses = Math.max(0, Math.trunc(card.lapses)) + (grade === 1 ? 1 : 0);

  let state: ReviewCardState;
  let intervalDays: number;

  if (grade === 1) {
    // Again: back to the bottom of the ladder, however far the card had got.
    state = "learning";
    intervalDays = LEARNING_STEPS_DAYS[0] ?? 1;
  } else if (card.state === "review") {
    const factor = grade === 2 ? HARD_FACTOR : grade === 3 ? ease : ease * EASY_BONUS;
    const previous = clampIntervalDays(card.intervalDays ?? lastStepDays());
    state = "review";
    intervalDays = clampIntervalDays(Math.round(previous * factor));
  } else {
    const next = Math.max(0, ladderPosition(card) + ladderAdvance(grade));
    const step = LEARNING_STEPS_DAYS[next];
    if (step !== undefined) {
      state = "learning";
      intervalDays = step;
    } else {
      // Ladder exhausted: graduate onto an ease-driven interval.
      state = "review";
      const bonus = grade === 4 ? EASY_BONUS : 1;
      intervalDays = clampIntervalDays(Math.round(lastStepDays() * ease * bonus));
    }
  }

  return {
    state,
    dueAt: now + intervalDays * DAY_MS,
    intervalDays,
    ease,
    lapses,
    lastGrade: grade,
    reviewedAt: now,
  };
}
