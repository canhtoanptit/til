import { describe, expect, it } from "vitest";
import {
  NO_VOTES,
  canVoteOnTurn,
  pendingVote,
  recordedVote,
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
    expect(canVoteOnTurn({ role: "assistant", isLast: true, busy: false })).toBe(
      true,
    );
    expect(
      canVoteOnTurn({ role: "assistant", isLast: false, busy: false }),
    ).toBe(true);
  });

  it("blocks the streaming turn but not the ones already finished", () => {
    expect(canVoteOnTurn({ role: "assistant", isLast: true, busy: true })).toBe(
      false,
    );
    expect(canVoteOnTurn({ role: "assistant", isLast: false, busy: true })).toBe(
      true,
    );
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
