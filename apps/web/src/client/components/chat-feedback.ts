import type { FeedbackKind } from "../api";

/**
 * Which assistant turns have been voted on, for the lifetime of this mounted
 * conversation — deliberately not persisted.
 *
 * WHY not persisted: the pressed state means "the server has this row", and the
 * only honest way to restore it after a reload would be to read the votes back
 * from the server, which needs a GET the C20 contract does not include (the log
 * is append-only and write-only for now). A remembered-in-localStorage thumb
 * would claim a row exists without ever having checked. So a reload shows the
 * unvoted state, and a second vote appends a second row — which is exactly what
 * an append-only signal log should record.
 */
export interface VoteState {
  /** messageId → the vote the server has confirmed. */
  readonly recorded: Readonly<Record<string, FeedbackKind>>;
  /** messageId → the vote currently in flight. */
  readonly pending: Readonly<Record<string, FeedbackKind>>;
}

export const NO_VOTES: VoteState = { recorded: {}, pending: {} };

/**
 * What a click should do.
 * - `submit`: post it (first vote, or a correction of the opposite vote).
 * - `in-flight`: a post for this turn has not answered yet; ignore the click.
 * - `already-recorded`: the exact same vote is already logged; re-posting it
 *   would only add a duplicate row that means nothing new.
 */
export type VoteAction = "submit" | "in-flight" | "already-recorded";

export function recordedVote(
  state: VoteState,
  messageId: string,
): FeedbackKind | null {
  return state.recorded[messageId] ?? null;
}

export function pendingVote(
  state: VoteState,
  messageId: string,
): FeedbackKind | null {
  return state.pending[messageId] ?? null;
}

export function voteActionFor(
  state: VoteState,
  messageId: string,
  kind: FeedbackKind,
): VoteAction {
  if (state.pending[messageId] !== undefined) return "in-flight";
  if (state.recorded[messageId] === kind) return "already-recorded";
  return "submit";
}

export function voteStarted(
  state: VoteState,
  messageId: string,
  kind: FeedbackKind,
): VoteState {
  return {
    recorded: state.recorded,
    pending: { ...state.pending, [messageId]: kind },
  };
}

export function voteSucceeded(
  state: VoteState,
  messageId: string,
  kind: FeedbackKind,
): VoteState {
  return {
    recorded: { ...state.recorded, [messageId]: kind },
    pending: omit(state.pending, messageId),
  };
}

/** A failed post leaves `recorded` alone: the thumb must never claim a row that
 * the server rejected. The toast is the only signal. */
export function voteFailed(state: VoteState, messageId: string): VoteState {
  return { recorded: state.recorded, pending: omit(state.pending, messageId) };
}

/**
 * Only completed assistant turns are votable. The last message while the turn is
 * still in flight is half-written, so voting on it would rate a partial answer.
 */
export function canVoteOnTurn(turn: {
  role: string;
  isLast: boolean;
  busy: boolean;
}): boolean {
  if (turn.role !== "assistant") return false;
  return !(turn.isLast && turn.busy);
}

export function voteButtonLabel(kind: FeedbackKind): string {
  return kind === "up"
    ? "Mark this answer helpful"
    : "Mark this answer unhelpful";
}

/** The inline confirmation shown in place of a per-vote toast. */
export function voteConfirmation(kind: FeedbackKind): string {
  return kind === "up" ? "Noted as helpful" : "Noted as unhelpful";
}

function omit(
  map: Readonly<Record<string, FeedbackKind>>,
  key: string,
): Record<string, FeedbackKind> {
  if (map[key] === undefined) return { ...map };
  const next: Record<string, FeedbackKind> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== key) next[k] = v;
  }
  return next;
}
