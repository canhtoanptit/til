import { and, asc, eq, getTableColumns, gt, or } from "drizzle-orm";
import type { Column, GetColumnData, SQL } from "drizzle-orm";
import {
  digestItems,
  digests,
  entries,
  feedback,
  feeds,
  reviews,
} from "@til/db";
import type {
  DigestItem,
  DigestRun,
  Entry,
  Feed,
  Feedback,
  Review,
} from "@til/db";
import type { Deps } from "./deps.js";
import { parseEvidence, parseTags } from "./dto.js";
import type { DigestEvidenceDTO } from "./dto.js";

/**
 * The owner's escape hatch, per ADR-0007's "one copy is zero copies": a single
 * authenticated GET that walks every table worth keeping and streams it out.
 *
 * ## What is deliberately NOT in an export
 *
 * - **`settings`** — the row holds the provider API key in cleartext. An export
 *   lands in a downloads folder, gets synced, gets mailed to yourself; a backup
 *   that is also a copy of a secret is a liability, not a safety net. Re-entering
 *   one key after a restore is cheap. `EXPORT_EXCLUSIONS` repeats this reason
 *   inside every exported file, so it travels with the artefact.
 * - **`entry_vectors`** — recomputable from the entries themselves via
 *   `POST /api/entries/reembed`, and at ~1024 floats per entry it would dominate
 *   the file size. Excluding it keeps the export small enough to open.
 * - **`chats`** — that table is only a cross-Durable-Object *index*. The
 *   transcripts live in each chat DO's own SQLite, which D1 cannot read, so
 *   exporting the index would promise conversations the file does not contain.
 *
 * ## Why it streams
 *
 * `contentMarkdown` is the whole article, for every entry. Serialising a library
 * into one string before responding is how a Worker discovers its memory limit,
 * so nothing here ever holds more than one batch of rows: every table is walked
 * with a keyset cursor (`EXPORT_BATCH_SIZE` rows per D1 round-trip) and each row
 * is written to the sink as it arrives.
 */

export const EXPORT_BATCH_SIZE = 200;

/**
 * The shape version of the export document — not the app version. A future
 * importer needs to know how to read the file, and the Worker has no honest
 * source for a build version at runtime: `package.json` is not readable from a
 * Worker, and a hardcoded string is a value that silently goes stale.
 */
export const EXPORT_FORMAT_VERSION = 1;

export const EXPORT_EXCLUSIONS = {
  settings:
    "Excluded on purpose: this row holds your provider API key in cleartext. A backup that sits in a downloads folder must not also be a copy of a secret — re-enter the key after a restore.",
  entry_vectors:
    "Excluded on purpose: embeddings are recomputable from the entries with POST /api/entries/reembed, and they would dominate the size of this file.",
  chats:
    "Excluded: the chats table is only a cross-Durable-Object index. Transcripts live in each chat Durable Object's own storage, which the database this export reads cannot see.",
} as const;

export type ExportFormat = "json" | "markdown";

/** The envelope's `counts` keys — one per exported table. */
export interface ExportCounts {
  entries: number;
  digests: number;
  digestItems: number;
  reviews: number;
  feeds: number;
  feedback: number;
}

/**
 * Everything the writers need from a stream. Hono's `StreamingApi` satisfies it,
 * and so does a string-collecting stub — which is what lets a test count writes
 * and prove the document was not assembled in one buffer.
 */
export interface ExportSink {
  write(chunk: string): Promise<unknown>;
}

/** Rows go out as stored, except the two columns that hold JSON inside TEXT. */
export type ExportEntry = Omit<Entry, "tags"> & { tags: string[] };
export type ExportDigestItem = Omit<DigestItem, "evidence"> & {
  evidence: DigestEvidenceDTO[];
};
export type ExportDigest = DigestRun;
export type ExportReview = Review;
export type ExportFeed = Feed;
export type ExportFeedback = Feedback;

/** Null means "not a format we serve" — the route turns that into a 422. */
export function parseExportFormat(raw: string | null): ExportFormat | null {
  if (raw === null || raw === "" || raw === "json") return "json";
  if (raw === "markdown" || raw === "md") return "markdown";
  return null;
}

export function exportContentType(format: ExportFormat): string {
  return format === "markdown"
    ? "text/markdown; charset=utf-8"
    : "application/json; charset=utf-8";
}

/** UTC, so the filename matches `exportedAt` rather than the reader's timezone. */
export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function exportFilename(
  format: ExportFormat,
  exportedAt: number,
): string {
  const ext = format === "markdown" ? "md" : "json";
  return `til-export-${isoDate(exportedAt)}.${ext}`;
}

export function exportContentDisposition(
  format: ExportFormat,
  exportedAt: number,
): string {
  // The filename is ASCII by construction (`til-export-` + an ISO date), so the
  // plain `filename=` form is enough — no RFC 5987 encoding needed.
  return `attachment; filename="${exportFilename(format, exportedAt)}"`;
}

/**
 * Walks a table in `EXPORT_BATCH_SIZE` chunks, resuming from a keyset cursor
 * built out of the previous batch's last row. Keyset rather than OFFSET because
 * OFFSET re-scans everything it skips, and because a cursor keeps the memory
 * ceiling at one batch no matter how large the table gets.
 *
 * A short batch ends the walk: fewer rows than asked for means there is no next
 * page.
 */
async function* batched<TRow, TCursor>(
  fetchBatch: (cursor: TCursor | null) => Promise<TRow[]>,
  cursorOf: (row: TRow) => TCursor,
): AsyncGenerator<TRow> {
  let cursor: TCursor | null = null;
  for (;;) {
    const rows = await fetchBatch(cursor);
    for (const row of rows) yield row;
    if (rows.length < EXPORT_BATCH_SIZE) return;
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    cursor = cursorOf(last);
  }
}

/**
 * `(a, b) > (valA, valB)` as SQL — the two-column keyset predicate, spelled once.
 * The second column is always a primary key, so the pair is a total order and no
 * row can be skipped or repeated at a batch boundary.
 */
function afterPair<A extends Column, B extends Column>(
  colA: A,
  valA: GetColumnData<A, "raw">,
  colB: B,
  valB: GetColumnData<B, "raw">,
): SQL | undefined {
  return or(gt(colA, valA), and(eq(colA, valA), gt(colB, valB)));
}

interface PairCursor<A, B> {
  a: A;
  b: B;
}

/**
 * Every walk is scoped to one user: the tenant predicate ANDs alongside the
 * keyset one, so the two-column total order is untouched. Exported rows now
 * carry a `userId` field with a constant value — deliberate: the JSON is a
 * restore format, and a row without its tenant cannot be restored.
 */
export function exportEntries(
  db: Deps["db"],
  userId: string,
): AsyncGenerator<ExportEntry> {
  return (async function* () {
    const rows = batched<Entry, PairCursor<number, string>>(
      (cursor) =>
        db
          .select()
          .from(entries)
          .where(
            and(
              eq(entries.userId, userId),
              cursor === null
                ? undefined
                : afterPair(entries.createdAt, cursor.a, entries.id, cursor.b),
            ),
          )
          .orderBy(asc(entries.createdAt), asc(entries.id))
          .limit(EXPORT_BATCH_SIZE),
      (row) => ({ a: row.createdAt, b: row.id }),
    );
    for await (const row of rows) {
      yield { ...row, tags: parseTags(row.tags) };
    }
  })();
}

export function exportDigests(
  db: Deps["db"],
  userId: string,
): AsyncGenerator<ExportDigest> {
  return batched<DigestRun, PairCursor<number, string>>(
    (cursor) =>
      db
        .select()
        .from(digests)
        .where(
          and(
            eq(digests.userId, userId),
            cursor === null
              ? undefined
              : afterPair(digests.runAt, cursor.a, digests.id, cursor.b),
          ),
        )
        .orderBy(asc(digests.runAt), asc(digests.id))
        .limit(EXPORT_BATCH_SIZE),
    (row) => ({ a: row.runAt, b: row.id }),
  );
}

/**
 * Every digest item, grouped by digest and in rank order — the order the markdown
 * bundle renders them in and the order a reader expects.
 *
 * Pass `digestId` to walk one digest's items: that is what the markdown writer
 * uses, so it never has to hold the whole join table to group it.
 *
 * `digest_items` carries no user column, so the scope is an INNER JOIN onto the
 * parent digest. `getTableColumns` keeps the projection at exactly the
 * `DigestItem` row shape the join would otherwise nest.
 */
export function exportDigestItems(
  db: Deps["db"],
  userId: string,
  digestId?: string,
): AsyncGenerator<ExportDigestItem> {
  return (async function* () {
    const scope =
      digestId === undefined ? undefined : eq(digestItems.digestId, digestId);
    const rows = batched<
      DigestItem,
      { digestId: string; rank: number; id: string }
    >(
      (cursor) =>
        db
          .select(getTableColumns(digestItems))
          .from(digestItems)
          .innerJoin(digests, eq(digests.id, digestItems.digestId))
          .where(
            and(
              eq(digests.userId, userId),
              scope,
              cursor === null
                ? undefined
                : or(
                    gt(digestItems.digestId, cursor.digestId),
                    and(
                      eq(digestItems.digestId, cursor.digestId),
                      gt(digestItems.rank, cursor.rank),
                    ),
                    and(
                      eq(digestItems.digestId, cursor.digestId),
                      eq(digestItems.rank, cursor.rank),
                      gt(digestItems.id, cursor.id),
                    ),
                  ),
            ),
          )
          .orderBy(
            asc(digestItems.digestId),
            asc(digestItems.rank),
            asc(digestItems.id),
          )
          .limit(EXPORT_BATCH_SIZE),
      (row) => ({ digestId: row.digestId, rank: row.rank, id: row.id }),
    );
    for await (const row of rows) {
      yield { ...row, evidence: parseEvidence(row.evidence) };
    }
  })();
}

export function exportReviews(
  db: Deps["db"],
  userId: string,
): AsyncGenerator<ExportReview> {
  // entryId is the primary key, so on its own it is already a total order.
  return batched<Review, string>(
    (cursor) =>
      db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, userId),
            cursor === null ? undefined : gt(reviews.entryId, cursor),
          ),
        )
        .orderBy(asc(reviews.entryId))
        .limit(EXPORT_BATCH_SIZE),
    (row) => row.entryId,
  );
}

export function exportFeeds(
  db: Deps["db"],
  userId: string,
): AsyncGenerator<ExportFeed> {
  return batched<Feed, PairCursor<number, string>>(
    (cursor) =>
      db
        .select()
        .from(feeds)
        .where(
          and(
            eq(feeds.userId, userId),
            cursor === null
              ? undefined
              : afterPair(feeds.createdAt, cursor.a, feeds.id, cursor.b),
          ),
        )
        .orderBy(asc(feeds.createdAt), asc(feeds.id))
        .limit(EXPORT_BATCH_SIZE),
    (row) => ({ a: row.createdAt, b: row.id }),
  );
}

export function exportFeedback(
  db: Deps["db"],
  userId: string,
): AsyncGenerator<ExportFeedback> {
  return batched<Feedback, PairCursor<number, string>>(
    (cursor) =>
      db
        .select()
        .from(feedback)
        .where(
          and(
            eq(feedback.userId, userId),
            cursor === null
              ? undefined
              : afterPair(feedback.createdAt, cursor.a, feedback.id, cursor.b),
          ),
        )
        .orderBy(asc(feedback.createdAt), asc(feedback.id))
        .limit(EXPORT_BATCH_SIZE),
    (row) => ({ a: row.createdAt, b: row.id }),
  );
}

/**
 * Written into a stream that has already begun when the walk fails. Hono's
 * `app.onError` cannot help here — the status line and the first bytes are gone
 * by then — so the failure is recorded in the file itself, and the marker is
 * deliberately not valid JSON: a truncated backup must fail loudly at parse time
 * rather than look like a complete one with fewer entries in it.
 */
export const EXPORT_FAILURE_MARKER =
  "<<< TIL EXPORT FAILED — INCOMPLETE FILE >>>";

export function exportFailureChunk(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `\n${EXPORT_FAILURE_MARKER} ${message}\n`;
}

function zeroCounts(): ExportCounts {
  return {
    entries: 0,
    digests: 0,
    digestItems: 0,
    reviews: 0,
    feeds: 0,
    feedback: 0,
  };
}

/**
 * The JSON backup — the restore format. Envelope first (`formatVersion`,
 * `exportedAt`, `excluded`), then one array per table, then `counts`.
 *
 * WHY `counts` is last: it is counted from the rows actually written, so it
 * cannot drift from the body the way a `SELECT count(*)` taken before the walk
 * could. It doubles as a completion marker — a stream that died halfway has no
 * `counts` at all, which is a far better signal than a plausible-looking number
 * at the top of a truncated file. Key order is irrelevant to a JSON parser.
 */
export async function writeJsonExport(
  db: Deps["db"],
  userId: string,
  exportedAt: number,
  sink: ExportSink,
): Promise<ExportCounts> {
  const counts = zeroCounts();
  await sink.write(
    `{"formatVersion":${EXPORT_FORMAT_VERSION},` +
      `"exportedAt":${exportedAt},` +
      `"exportedAtIso":${JSON.stringify(new Date(exportedAt).toISOString())},` +
      `"excluded":${JSON.stringify(EXPORT_EXCLUSIONS)}`,
  );

  const walk = async <TRow>(
    key: keyof ExportCounts,
    rows: AsyncGenerator<TRow>,
  ): Promise<void> => {
    await sink.write(`,${JSON.stringify(key)}:[`);
    let first = true;
    for await (const row of rows) {
      await sink.write((first ? "" : ",") + JSON.stringify(row));
      first = false;
      counts[key] += 1;
    }
    await sink.write("]");
  };

  await walk("entries", exportEntries(db, userId));
  await walk("digests", exportDigests(db, userId));
  await walk("digestItems", exportDigestItems(db, userId));
  await walk("reviews", exportReviews(db, userId));
  await walk("feeds", exportFeeds(db, userId));
  await walk("feedback", exportFeedback(db, userId));

  await sink.write(`,"counts":${JSON.stringify(counts)}}\n`);
  return counts;
}

function orDash(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "—";
}

/**
 * The markdown bundle — one document, no archive. A zip would mean a new runtime
 * dependency (the Workers runtime ships no zip encoder), and a single `.md` is the
 * honest no-dependency answer: it opens in anything, and it is what you actually
 * want when the goal is to read or grep your reading rather than restore it.
 *
 * It is deliberately lossy — entries and digests only. Review schedules, feed
 * subscriptions and the feedback log have no readable rendering, and including
 * them would make this look like the restore format. That is the JSON.
 *
 * Entry content is emitted verbatim, so an article's own `#` headings appear at
 * their original level and can outrank the entry heading that introduced them.
 * That is the right trade: a backup must not rewrite the content it backs up.
 */
export async function writeMarkdownExport(
  db: Deps["db"],
  userId: string,
  exportedAt: number,
  sink: ExportSink,
): Promise<ExportCounts> {
  const counts = zeroCounts();

  await sink.write(
    `# TIL export\n\n` +
      `Exported ${isoDate(exportedAt)} (${new Date(exportedAt).toISOString()}).\n\n` +
      `This is the readable bundle: your saved entries and your digests. It is ` +
      `not a restore file — review schedules, feed subscriptions and the feedback ` +
      `log live only in the JSON export.\n\n` +
      `Also absent on purpose: your provider API key (a backup must not be a copy ` +
      `of a secret) and the embedding vectors (recomputable, and they would dwarf ` +
      `the text).\n`,
  );

  await sink.write(`\n## Entries\n`);
  for await (const row of exportEntries(db, userId)) {
    counts.entries += 1;
    const tags = row.tags.length > 0 ? row.tags.join(", ") : "—";
    await sink.write(
      `\n---\n\n` +
        `### ${orDash(row.title)}\n\n` +
        `- URL: ${row.url}\n` +
        `- Domain: ${orDash(row.sourceDomain)}\n` +
        `- Saved: ${isoDate(row.createdAt)}\n` +
        `- Tags: ${tags}\n`,
    );
    if (row.takeaway) {
      await sink.write(`\n**Takeaway.** ${row.takeaway.trim()}\n`);
    }
    if (row.note) await sink.write(`\n**My note.** ${row.note.trim()}\n`);
    if (row.summary) await sink.write(`\n${row.summary.trim()}\n`);
    if (row.contentMarkdown) {
      await sink.write(`\n#### Content\n\n${row.contentMarkdown.trim()}\n`);
    }
  }
  if (counts.entries === 0) await sink.write(`\n_No entries saved yet._\n`);

  // Digests close the document: they are commentary on the reading above, and
  // putting them last keeps the entry sections contiguous for someone scrolling
  // through their library.
  await sink.write(`\n## Digests\n`);
  for await (const row of exportDigests(db, userId)) {
    counts.digests += 1;
    await sink.write(
      `\n---\n\n### ${orDash(row.title)}\n\n` +
        `- Run: ${isoDate(row.runAt)}\n` +
        `- Window: ${row.windowDays} days\n`,
    );
    if (row.intro) await sink.write(`\n${row.intro.trim()}\n`);
    // One scoped walk per digest rather than grouping the whole join table in a
    // Map: the point of this endpoint is that it never holds a table in memory.
    let items = 0;
    for await (const item of exportDigestItems(db, userId, row.id)) {
      if (items === 0) await sink.write(`\n`);
      items += 1;
      counts.digestItems += 1;
      const why = item.why ? ` — ${item.why.trim()}` : "";
      await sink.write(
        `${item.rank}. [${item.title}](${item.url}) · ${item.sourceDomain}${why}\n`,
      );
    }
    if (items === 0) await sink.write(`\n_No items in this digest._\n`);
  }
  if (counts.digests === 0) await sink.write(`\n_No digests yet._\n`);

  // The numbers a reader can check the file against — and, like the JSON's
  // trailing `counts`, proof the stream finished.
  await sink.write(
    `\n---\n\n${counts.entries} entries · ${counts.digests} digests · ` +
      `${counts.digestItems} digest items.\n`,
  );
  return counts;
}
