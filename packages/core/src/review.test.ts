import { describe, expect, it } from "vitest";
import {
  clampEase,
  clampIntervalDays,
  DAY_MS,
  EASE_DEFAULT,
  EASE_MAX,
  EASE_MIN,
  initialReviewCard,
  isReviewCardState,
  isReviewDue,
  isReviewGrade,
  ladderPosition,
  MAX_INTERVAL_DAYS,
  REVIEW_GRADES,
  scheduleReview,
  type ReviewCard,
  type ReviewGrade,
} from "./review.js";

const NOW = 1_700_000_000_000;

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    state: overrides.state ?? "new",
    intervalDays: overrides.intervalDays === undefined ? null : overrides.intervalDays,
    ease: overrides.ease ?? EASE_DEFAULT,
    lapses: overrides.lapses ?? 0,
  };
}

describe("initialReviewCard", () => {
  it("is due immediately, unrated, at the default ease", () => {
    expect(initialReviewCard(NOW)).toEqual({
      state: "new",
      dueAt: NOW,
      intervalDays: null,
      ease: EASE_DEFAULT,
      lapses: 0,
    });
  });
});

describe("scheduleReview — the full grade × state matrix", () => {
  // Every reachable starting shape crossed with every grade. Expected values are
  // written out by hand from the documented rules, not computed by the code under
  // test, so a rule change has to be a deliberate edit here too.
  const cases: {
    name: string;
    from: ReviewCard;
    grade: ReviewGrade;
    state: string;
    intervalDays: number;
    ease: number;
    lapses: number;
  }[] = [
    // --- new -------------------------------------------------------------
    { name: "new + Again", from: card(), grade: 1, state: "learning", intervalDays: 1, ease: 2.3, lapses: 1 },
    { name: "new + Hard", from: card(), grade: 2, state: "learning", intervalDays: 1, ease: 2.35, lapses: 0 },
    { name: "new + Good", from: card(), grade: 3, state: "learning", intervalDays: 1, ease: 2.5, lapses: 0 },
    { name: "new + Easy", from: card(), grade: 4, state: "learning", intervalDays: 3, ease: 2.65, lapses: 0 },

    // --- learning, on the 1-day step ------------------------------------
    {
      name: "learning 1d + Again",
      from: card({ state: "learning", intervalDays: 1 }),
      grade: 1,
      state: "learning",
      intervalDays: 1,
      ease: 2.3,
      lapses: 1,
    },
    {
      name: "learning 1d + Hard repeats the step",
      from: card({ state: "learning", intervalDays: 1 }),
      grade: 2,
      state: "learning",
      intervalDays: 1,
      ease: 2.35,
      lapses: 0,
    },
    {
      name: "learning 1d + Good advances to 3d",
      from: card({ state: "learning", intervalDays: 1 }),
      grade: 3,
      state: "learning",
      intervalDays: 3,
      ease: 2.5,
      lapses: 0,
    },
    {
      name: "learning 1d + Easy graduates with the easy bonus",
      from: card({ state: "learning", intervalDays: 1 }),
      grade: 4,
      // round(3 * 2.65 * 1.3) = round(10.335)
      state: "review",
      intervalDays: 10,
      ease: 2.65,
      lapses: 0,
    },

    // --- learning, on the 3-day step ------------------------------------
    {
      name: "learning 3d + Again drops to the bottom step",
      from: card({ state: "learning", intervalDays: 3 }),
      grade: 1,
      state: "learning",
      intervalDays: 1,
      ease: 2.3,
      lapses: 1,
    },
    {
      name: "learning 3d + Hard repeats the step",
      from: card({ state: "learning", intervalDays: 3 }),
      grade: 2,
      state: "learning",
      intervalDays: 3,
      ease: 2.35,
      lapses: 0,
    },
    {
      name: "learning 3d + Good graduates at round(3 * ease)",
      from: card({ state: "learning", intervalDays: 3 }),
      grade: 3,
      // round(3 * 2.5) = round(7.5) = 8
      state: "review",
      intervalDays: 8,
      ease: 2.5,
      lapses: 0,
    },
    {
      name: "learning 3d + Easy graduates at round(3 * ease * 1.3)",
      from: card({ state: "learning", intervalDays: 3 }),
      grade: 4,
      state: "review",
      intervalDays: 10,
      ease: 2.65,
      lapses: 0,
    },

    // --- review ----------------------------------------------------------
    {
      name: "review 10d + Again relearns at 1 day and counts a lapse",
      from: card({ state: "review", intervalDays: 10, lapses: 2 }),
      grade: 1,
      state: "learning",
      intervalDays: 1,
      ease: 2.3,
      lapses: 3,
    },
    {
      name: "review 10d + Hard creeps forward by 1.2",
      from: card({ state: "review", intervalDays: 10 }),
      grade: 2,
      state: "review",
      intervalDays: 12,
      ease: 2.35,
      lapses: 0,
    },
    {
      name: "review 10d + Good multiplies by ease",
      from: card({ state: "review", intervalDays: 10 }),
      grade: 3,
      state: "review",
      intervalDays: 25,
      ease: 2.5,
      lapses: 0,
    },
    {
      name: "review 10d + Easy multiplies by ease and the bonus",
      from: card({ state: "review", intervalDays: 10 }),
      grade: 4,
      // round(10 * 2.65 * 1.3) = round(34.45)
      state: "review",
      intervalDays: 34,
      ease: 2.65,
      lapses: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const next = scheduleReview(c.from, c.grade, NOW);
      expect(next.state).toBe(c.state);
      expect(next.intervalDays).toBe(c.intervalDays);
      expect(next.ease).toBeCloseTo(c.ease, 10);
      expect(next.lapses).toBe(c.lapses);
      expect(next.lastGrade).toBe(c.grade);
      expect(next.reviewedAt).toBe(NOW);
      expect(next.dueAt).toBe(NOW + c.intervalDays * DAY_MS);
    });
  }

  it("covers every grade for every reachable state", () => {
    const seen = new Set(
      cases.map((c) => `${c.from.state}:${c.from.intervalDays ?? "null"}:${c.grade}`),
    );
    expect(seen.size).toBe(cases.length);
    for (const grade of REVIEW_GRADES) {
      const withGrade = cases.filter((c) => c.grade === grade);
      expect(withGrade).toHaveLength(4);
    }
  });
});

describe("scheduleReview — invariants across every grade", () => {
  const starts: ReviewCard[] = [
    card(),
    card({ state: "learning", intervalDays: 1 }),
    card({ state: "learning", intervalDays: 3 }),
    card({ state: "review", intervalDays: 8 }),
    card({ state: "review", intervalDays: 200, ease: 1.3 }),
    card({ state: "review", intervalDays: 45, ease: 2.9, lapses: 7 }),
  ];

  it("always stamps lastGrade, reviewedAt and a dueAt derived from the interval", () => {
    for (const start of starts) {
      for (const grade of REVIEW_GRADES) {
        const next = scheduleReview(start, grade, NOW);
        expect(next.lastGrade).toBe(grade);
        expect(next.reviewedAt).toBe(NOW);
        expect(next.dueAt).toBe(NOW + next.intervalDays * DAY_MS);
      }
    }
  });

  it("keeps intervals whole days inside [1, 365]", () => {
    for (const start of starts) {
      for (const grade of REVIEW_GRADES) {
        const next = scheduleReview(start, grade, NOW);
        expect(Number.isInteger(next.intervalDays)).toBe(true);
        expect(next.intervalDays).toBeGreaterThanOrEqual(1);
        expect(next.intervalDays).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
      }
    }
  });

  it("keeps ease inside [1.3, 3.0]", () => {
    for (const start of starts) {
      for (const grade of REVIEW_GRADES) {
        const next = scheduleReview(start, grade, NOW);
        expect(next.ease).toBeGreaterThanOrEqual(EASE_MIN);
        expect(next.ease).toBeLessThanOrEqual(EASE_MAX);
      }
    }
  });

  it("increments lapses only on Again", () => {
    for (const start of starts) {
      for (const grade of REVIEW_GRADES) {
        const next = scheduleReview(start, grade, NOW);
        expect(next.lapses).toBe(start.lapses + (grade === 1 ? 1 : 0));
      }
    }
  });

  it("only Again and a fresh card ever land on state 'learning'", () => {
    for (const start of starts) {
      const again = scheduleReview(start, 1, NOW);
      expect(again.state).toBe("learning");
      expect(again.intervalDays).toBe(1);
      if (start.state === "review") {
        for (const grade of [2, 3, 4] as ReviewGrade[]) {
          expect(scheduleReview(start, grade, NOW).state).toBe("review");
        }
      }
    }
  });

  it("is pure: repeated calls agree and the input card is untouched", () => {
    const start = card({ state: "review", intervalDays: 12, ease: 2.4, lapses: 1 });
    const snapshot = { ...start };
    for (const grade of REVIEW_GRADES) {
      const a = scheduleReview(start, grade, NOW);
      const b = scheduleReview(start, grade, NOW);
      expect(a).toEqual(b);
    }
    expect(start).toEqual(snapshot);
  });

  it("every passing review in 'review' state is strictly longer than the last", () => {
    // The shortest reachable review interval is round(3 * 1.3) = 4, so the walk
    // starts there; below it Hard's 1.2 factor would round back onto itself.
    for (let interval = 4; interval <= MAX_INTERVAL_DAYS; interval += 1) {
      for (const ease of [EASE_MIN, 1.7, 2.2, EASE_DEFAULT, EASE_MAX]) {
        for (const grade of [2, 3, 4] as ReviewGrade[]) {
          const next = scheduleReview(
            card({ state: "review", intervalDays: interval, ease }),
            grade,
            NOW,
          );
          if (next.intervalDays < MAX_INTERVAL_DAYS) {
            expect(next.intervalDays).toBeGreaterThan(interval);
          } else {
            expect(next.intervalDays).toBe(MAX_INTERVAL_DAYS);
          }
        }
      }
    }
  });

  it("clamps a runaway interval at 365 days instead of scheduling into the 2030s", () => {
    const next = scheduleReview(
      card({ state: "review", intervalDays: 300, ease: EASE_MAX }),
      4,
      NOW,
    );
    expect(next.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(next.dueAt).toBe(NOW + MAX_INTERVAL_DAYS * DAY_MS);
  });

  it("floors ease at 1.3 no matter how many lapses pile up", () => {
    let current: ReviewCard = card({ state: "review", intervalDays: 20 });
    for (let i = 0; i < 20; i += 1) {
      const next = scheduleReview(current, 1, NOW);
      current = {
        state: next.state,
        intervalDays: next.intervalDays,
        ease: next.ease,
        lapses: next.lapses,
      };
    }
    expect(current.ease).toBe(EASE_MIN);
    expect(current.lapses).toBe(20);
  });

  it("caps ease at 3.0 no matter how many Easy answers pile up", () => {
    let current: ReviewCard = card({ state: "review", intervalDays: 20 });
    for (let i = 0; i < 20; i += 1) {
      const next = scheduleReview(current, 4, NOW);
      current = {
        state: next.state,
        intervalDays: next.intervalDays,
        ease: next.ease,
        lapses: next.lapses,
      };
    }
    expect(current.ease).toBe(EASE_MAX);
  });

  it("Hard never graduates a card off the ladder", () => {
    let current: ReviewCard = card();
    for (let i = 0; i < 5; i += 1) {
      const next = scheduleReview(current, 2, NOW);
      expect(next.state).toBe("learning");
      expect(next.intervalDays).toBe(1);
      current = {
        state: next.state,
        intervalDays: next.intervalDays,
        ease: next.ease,
        lapses: next.lapses,
      };
    }
  });

  it("walks a clean card new → 1d → 3d → 8d → 20d on Good", () => {
    const walk: number[] = [];
    let current: ReviewCard = card();
    for (let i = 0; i < 4; i += 1) {
      const next = scheduleReview(current, 3, NOW);
      walk.push(next.intervalDays);
      current = {
        state: next.state,
        intervalDays: next.intervalDays,
        ease: next.ease,
        lapses: next.lapses,
      };
    }
    // 1, 3, round(3 * 2.5) = 8, round(8 * 2.5) = 20
    expect(walk).toEqual([1, 3, 8, 20]);
  });

  it("recovers a lapsed card back up the ladder", () => {
    const lapsed = scheduleReview(
      card({ state: "review", intervalDays: 30, ease: 2.5 }),
      1,
      NOW,
    );
    expect(lapsed).toMatchObject({ state: "learning", intervalDays: 1, ease: 2.3, lapses: 1 });
    const back = scheduleReview(
      { state: lapsed.state, intervalDays: lapsed.intervalDays, ease: lapsed.ease, lapses: lapsed.lapses },
      3,
      NOW,
    );
    expect(back).toMatchObject({ state: "learning", intervalDays: 3, ease: 2.3, lapses: 1 });
    const graduated = scheduleReview(
      { state: back.state, intervalDays: back.intervalDays, ease: back.ease, lapses: back.lapses },
      3,
      NOW,
    );
    // round(3 * 2.3) = round(6.9) = 7 — a lower ease than before the lapse.
    expect(graduated).toMatchObject({ state: "review", intervalDays: 7, ease: 2.3 });
  });

  it("does not accumulate float noise in ease across many grades", () => {
    let current: ReviewCard = card({ state: "review", intervalDays: 20 });
    for (const grade of [2, 2, 3, 4, 2, 4] as ReviewGrade[]) {
      const next = scheduleReview(current, grade, NOW);
      current = {
        state: next.state,
        intervalDays: next.intervalDays,
        ease: next.ease,
        lapses: next.lapses,
      };
    }
    // 2.5 - .15 - .15 + 0 + .15 - .15 + .15 = 2.35, exactly.
    expect(current.ease).toBe(2.35);
  });

  it("repairs a corrupt row rather than propagating NaN", () => {
    const next = scheduleReview(
      { state: "review", intervalDays: Number.NaN, ease: Number.NaN, lapses: -3 },
      3,
      NOW,
    );
    expect(next.ease).toBe(EASE_DEFAULT);
    expect(Number.isInteger(next.intervalDays)).toBe(true);
    expect(next.intervalDays).toBeGreaterThanOrEqual(1);
    expect(next.lapses).toBe(0);
  });

  it("treats a 'learning' row with no interval as a new card", () => {
    const next = scheduleReview(card({ state: "learning", intervalDays: null }), 3, NOW);
    expect(next).toMatchObject({ state: "learning", intervalDays: 1 });
  });
});

describe("ladderPosition", () => {
  it("maps stored intervals onto ladder positions", () => {
    expect(ladderPosition(card())).toBe(-1);
    expect(ladderPosition(card({ state: "learning", intervalDays: null }))).toBe(-1);
    expect(ladderPosition(card({ state: "learning", intervalDays: 0.5 }))).toBe(-1);
    expect(ladderPosition(card({ state: "learning", intervalDays: 1 }))).toBe(0);
    expect(ladderPosition(card({ state: "learning", intervalDays: 2 }))).toBe(0);
    expect(ladderPosition(card({ state: "learning", intervalDays: 3 }))).toBe(1);
    expect(ladderPosition(card({ state: "review", intervalDays: 99 }))).toBe(1);
  });

  it("ignores a stored interval on a 'new' card", () => {
    expect(ladderPosition(card({ state: "new", intervalDays: 30 }))).toBe(-1);
  });
});

describe("clampEase / clampIntervalDays", () => {
  it("clamps ease to the SM-2 floor and our ceiling", () => {
    expect(clampEase(1.0)).toBe(EASE_MIN);
    expect(clampEase(1.3)).toBe(EASE_MIN);
    expect(clampEase(2.0)).toBe(2);
    expect(clampEase(3.4)).toBe(EASE_MAX);
    expect(clampEase(Number.NaN)).toBe(EASE_DEFAULT);
    expect(clampEase(Number.POSITIVE_INFINITY)).toBe(EASE_DEFAULT);
  });

  it("clamps intervals to [1, 365]", () => {
    expect(clampIntervalDays(0)).toBe(1);
    expect(clampIntervalDays(-5)).toBe(1);
    expect(clampIntervalDays(1)).toBe(1);
    expect(clampIntervalDays(400)).toBe(MAX_INTERVAL_DAYS);
    expect(clampIntervalDays(Number.NaN)).toBe(1);
  });
});

describe("isReviewDue", () => {
  it("counts an unscheduled card as due", () => {
    expect(isReviewDue({ dueAt: null }, NOW)).toBe(true);
    expect(isReviewDue({ dueAt: undefined }, NOW)).toBe(true);
    expect(isReviewDue({ dueAt: Number.NaN }, NOW)).toBe(true);
  });

  it("is inclusive of the due instant", () => {
    expect(isReviewDue({ dueAt: NOW }, NOW)).toBe(true);
    expect(isReviewDue({ dueAt: NOW - 1 }, NOW)).toBe(true);
    expect(isReviewDue({ dueAt: NOW + 1 }, NOW)).toBe(false);
  });
});

describe("guards", () => {
  it("accepts exactly grades 1-4", () => {
    for (const grade of REVIEW_GRADES) expect(isReviewGrade(grade)).toBe(true);
    for (const bad of [0, 5, -1, 1.5, "3", null, undefined, {}]) {
      expect(isReviewGrade(bad)).toBe(false);
    }
  });

  it("accepts exactly the three card states", () => {
    for (const state of ["new", "learning", "review"]) {
      expect(isReviewCardState(state)).toBe(true);
    }
    for (const bad of ["ready", "", null, undefined, 1]) {
      expect(isReviewCardState(bad)).toBe(false);
    }
  });
});
