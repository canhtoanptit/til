import type { FeedbackKind } from "../api";

/**
 * Which assistant turns have been voted on.
 *
 * The pressed state means "the server has this row", so it is only ever restored
 * by asking the server: `GET /api/feedback?conversationId=…` (P28c) reads the
 * conversation's votes back and `seedVotes` folds them into this shape. That is
 * the one honest way to persist it — a remembered-in-localStorage thumb would
 * claim a row exists without ever having checked.
 */
export interface VoteState {
  /** messageId → the vote the server has confirmed. */
  readonly recorded: Readonly<Record<string, FeedbackKind>>;
  /** messageId → the vote currently in flight. */
  readonly pending: Readonly<Record<string, FeedbackKind>>;
}

export const NO_VOTES: VoteState = { recorded: {}, pending: {} };

/** The one thing seeding needs from a logged row. */
export interface LoggedVote {
  messageId: string | null;
  kind: FeedbackKind;
}

/**
 * Fold one conversation's log into pressed thumbs.
 *
 * WHY the reduction is here and not in SQL: the log arrives oldest-first, so
 * "latest vote per message" is a plain last-write-wins loop over it — no
 * `GROUP BY … max(created_at)`, and none of SQLite's bare-column rules about
 * which row a `max()` aggregate drags along. It is also the only form that is
 * unit-testable without a database.
 *
 * Rows with no messageId (entry votes, or a vote about the conversation itself)
 * light no thumb and are skipped. Anything the reader has already done in this
 * session wins over the seed: a vote recorded or in flight locally is newer than
 * whatever the fetch was told, and must not be rewound by a late response.
 */
export function seedVotes(
  state: VoteState,
  rows: readonly LoggedVote[],
): VoteState {
  const seeded: Record<string, FeedbackKind> = {};
  for (const row of rows) {
    if (row.messageId === null || row.messageId === "") continue;
    seeded[row.messageId] = row.kind;
  }
  return {
    recorded: { ...seeded, ...state.recorded },
    pending: state.pending,
  };
}

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
