import { describe, expect, it } from "vitest";
import {
  NO_VOTES,
  canVoteOnTurn,
  pendingVote,
  recordedVote,
  seedVotes,
  voteActionFor,
  voteButtonLabel,
  voteConfirmation,
  voteFailed,
  voteStarted,
  voteSucceeded,
} from "./chat-feedback";

describe("vote lifecycle", () => {
  it("starts with nothing recorded or pending", () => {
    expect(recordedVote(NO_VOTES, "m1")).toBeNull();
    expect(pendingVote(NO_VOTES, "m1")).toBeNull();
  });

  it("records a vote only once the post has succeeded", () => {
    const started = voteStarted(NO_VOTES, "m1", "up");
    // The pressed thumb is a claim that the row exists, so nothing is recorded
    // while the request is still in flight.
    expect(pendingVote(started, "m1")).toBe("up");
    expect(recordedVote(started, "m1")).toBeNull();

    const done = voteSucceeded(started, "m1", "up");
    expect(recordedVote(done, "m1")).toBe("up");
    expect(pendingVote(done, "m1")).toBeNull();
  });

  it("leaves nothing recorded when the post fails", () => {
    const failed = voteFailed(voteStarted(NO_VOTES, "m1", "down"), "m1");
    expect(recordedVote(failed, "m1")).toBeNull();
    expect(pendingVote(failed, "m1")).toBeNull();
  });

  it("keeps a failure from erasing an earlier recorded vote on the same turn", () => {
    const recorded = voteSucceeded(NO_VOTES, "m1", "up");
    const failed = voteFailed(voteStarted(recorded, "m1", "down"), "m1");
    expect(recordedVote(failed, "m1")).toBe("up");
  });

  it("tracks turns independently", () => {
    let state = voteSucceeded(NO_VOTES, "m1", "up");
    state = voteStarted(state, "m2", "down");
    expect(recordedVote(state, "m1")).toBe("up");
    expect(pendingVote(state, "m1")).toBeNull();
    expect(recordedVote(state, "m2")).toBeNull();
    expect(pendingVote(state, "m2")).toBe("down");
  });

  it("never mutates the state it is given", () => {
    const before = voteSucceeded(NO_VOTES, "m1", "up");
    const snapshot = JSON.stringify(before);
    voteStarted(before, "m2", "down");
    voteSucceeded(before, "m2", "down");
    voteFailed(before, "m1");
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(NO_VOTES).toEqual({ recorded: {}, pending: {} });
  });
});

describe("seedVotes", () => {
  it("marks each message with the vote from the log", () => {
    const state = seedVotes(NO_VOTES, [
      { messageId: "m1", kind: "up" },
      { messageId: "m2", kind: "down" },
    ]);
    expect(recordedVote(state, "m1")).toBe("up");
    expect(recordedVote(state, "m2")).toBe("down");
    expect(recordedVote(state, "m3")).toBeNull();
    expect(pendingVote(state, "m1")).toBeNull();
  });

  it("takes the last row for a message — the log's corrections win", () => {
    const state = seedVotes(NO_VOTES, [
      { messageId: "m1", kind: "up" },
      { messageId: "m1", kind: "down" },
    ]);
    expect(recordedVote(state, "m1")).toBe("down");
  });

  it("resolves a same-millisecond tie by list order, not by kind", () => {
    // Rows arrive oldest-first with a stable id tiebreak, so "later in the list"
    // is the whole definition of "later" — both directions must behave the same.
    expect(
      recordedVote(
        seedVotes(NO_VOTES, [
          { messageId: "m1", kind: "down" },
          { messageId: "m1", kind: "up" },
        ]),
        "m1",
      ),
    ).toBe("up");
    expect(
      recordedVote(
        seedVotes(NO_VOTES, [
          { messageId: "m1", kind: "up" },
          { messageId: "m1", kind: "down" },
        ]),
        "m1",
      ),
    ).toBe("down");
  });

  it("skips rows that cannot light a thumb", () => {
    const state = seedVotes(NO_VOTES, [
      { messageId: null, kind: "down" },
      { messageId: "", kind: "down" },
      { messageId: "m1", kind: "up" },
    ]);
    expect(state.recorded).toEqual({ m1: "up" });
  });

  it("seeds nothing from an empty log", () => {
    expect(seedVotes(NO_VOTES, [])).toEqual(NO_VOTES);
  });

  it("never rewinds a vote the reader has already cast in this session", () => {
    // The race: the reader votes down before the seed fetch answers with the
    // older up. The click is newer than the response, so the click wins.
    const local = voteSucceeded(NO_VOTES, "m1", "down");
    const state = seedVotes(local, [
      { messageId: "m1", kind: "up" },
      { messageId: "m2", kind: "up" },
    ]);
    expect(recordedVote(state, "m1")).toBe("down");
    expect(recordedVote(state, "m2")).toBe("up");
  });

  it("leaves an in-flight vote in flight", () => {
    const local = voteStarted(NO_VOTES, "m1", "down");
    const state = seedVotes(local, [{ messageId: "m1", kind: "up" }]);
    expect(pendingVote(state, "m1")).toBe("down");
    // The up row does exist on the server, so claiming it is honest.
    expect(recordedVote(state, "m1")).toBe("up");
    expect(voteActionFor(state, "m1", "up")).toBe("in-flight");
  });

  it("does not mutate the state it seeds into", () => {
    const before = voteSucceeded(NO_VOTES, "m1", "up");
    const snapshot = JSON.stringify(before);
    seedVotes(before, [{ messageId: "m2", kind: "down" }]);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(NO_VOTES).toEqual({ recorded: {}, pending: {} });
  });

  it("makes a seeded vote behave exactly like one cast this session", () => {
    const state = seedVotes(NO_VOTES, [{ messageId: "m1", kind: "up" }]);
    expect(voteActionFor(state, "m1", "up")).toBe("already-recorded");
    expect(voteActionFor(state, "m1", "down")).toBe("submit");
  });
});

describe("voteActionFor", () => {
  it("submits a first vote", () => {
    expect(voteActionFor(NO_VOTES, "m1", "up")).toBe("submit");
  });

  it("submits the opposite vote as a correction", () => {
    const state = voteSucceeded(NO_VOTES, "m1", "up");
    expect(voteActionFor(state, "m1", "down")).toBe("submit");
  });

  it("ignores a repeat of the vote already recorded", () => {
    const state = voteSucceeded(NO_VOTES, "m1", "up");
    expect(voteActionFor(state, "m1", "up")).toBe("already-recorded");
  });

  it("ignores any click while a vote for that turn is in flight", () => {
    const state = voteStarted(NO_VOTES, "m1", "up");
    expect(voteActionFor(state, "m1", "up")).toBe("in-flight");
    expect(voteActionFor(state, "m1", "down")).toBe("in-flight");
    // Another turn is unaffected.
    expect(voteActionFor(state, "m2", "up")).toBe("submit");
  });
});

describe("canVoteOnTurn", () => {
  it("allows a settled assistant turn", () => {
    expect(
      canVoteOnTurn({ role: "assistant", isLast: true, busy: false }),
    ).toBe(true);
    expect(
      canVoteOnTurn({ role: "assistant", isLast: false, busy: false }),
    ).toBe(true);
  });

  it("blocks the streaming turn but not the ones already finished", () => {
    expect(canVoteOnTurn({ role: "assistant", isLast: true, busy: true })).toBe(
      false,
    );
    expect(
      canVoteOnTurn({ role: "assistant", isLast: false, busy: true }),
    ).toBe(true);
  });

  it("never offers a vote on the reader's own messages", () => {
    expect(canVoteOnTurn({ role: "user", isLast: false, busy: false })).toBe(
      false,
    );
    expect(canVoteOnTurn({ role: "system", isLast: true, busy: false })).toBe(
      false,
    );
  });
});

describe("labels", () => {
  it("distinguishes the two controls", () => {
    expect(voteButtonLabel("up")).not.toBe(voteButtonLabel("down"));
    expect(voteButtonLabel("up")).toMatch(/helpful/i);
    expect(voteButtonLabel("down")).toMatch(/unhelpful/i);
  });

  it("confirms which way the vote went", () => {
    expect(voteConfirmation("up")).toMatch(/helpful/i);
    expect(voteConfirmation("down")).toMatch(/unhelpful/i);
    expect(voteConfirmation("up")).not.toBe(voteConfirmation("down"));
  });
});
