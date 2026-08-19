import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  digests,
  digestItems,
  entries,
  feedback,
  feeds,
} from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec(sql);
  }
}

function insertEntry(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    url: string;
    canonical_url: string;
    title: string | null;
    summary: string | null;
    takeaway: string | null;
    tags: string;
    content_markdown: string | null;
  }> = {},
): void {
  const now = Date.now();
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    url: overrides.url ?? "https://example.com/a",
    canonical_url: overrides.canonical_url ?? "https://example.com/a",
    title: overrides.title ?? "Sample Title",
    summary: overrides.summary ?? "Sample summary",
    takeaway: overrides.takeaway ?? "Sample takeaway",
    tags: overrides.tags ?? '["sample"]',
    content_markdown: overrides.content_markdown ?? "Sample content",
    now,
  };
  db.prepare(
    `INSERT INTO entries (id, url, canonical_url, title, source_domain, content_markdown, summary, takeaway, question, tags, status, error, created_at, updated_at)
     VALUES (@id, @url, @canonical_url, @title, NULL, @content_markdown, @summary, @takeaway, NULL, @tags, 'ready', NULL, @now, @now)`,
  ).run(row);
}

function insertDigest(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    run_at: number;
    window_days: number;
    status: string;
    title: string | null;
    intro: string | null;
    error: string | null;
  }> = {},
): string {
  const now = Date.now();
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    run_at: overrides.run_at ?? now,
    window_days: overrides.window_days ?? 7,
    status: overrides.status ?? "ready",
    title: overrides.title ?? "Week of interesting things",
    intro: overrides.intro ?? "Three themes stood out this week.",
    error: overrides.error ?? null,
    now,
  };
  db.prepare(
    `INSERT INTO digests (id, run_at, window_days, status, title, intro, error, created_at, updated_at)
     VALUES (@id, @run_at, @window_days, @status, @title, @intro, @error, @now, @now)`,
  ).run(row);
  return row.id;
}

function insertDigestItem(
  db: Database.Database,
  digestId: string,
  overrides: Partial<{
    id: string;
    rank: number;
    title: string;
    url: string;
    source_name: string;
    source_domain: string;
    score: number;
    why: string | null;
    evidence: string;
  }> = {},
): string {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    digest_id: digestId,
    rank: overrides.rank ?? 1,
    title: overrides.title ?? "Some interesting post",
    url: overrides.url ?? "https://example.com/post",
    source_name: overrides.source_name ?? "hn",
    source_domain: overrides.source_domain ?? "example.com",
    score: overrides.score ?? 1.5,
    why: overrides.why ?? "Cross-posted on three sources.",
    evidence: overrides.evidence ?? "[]",
    now: Date.now(),
  };
  db.prepare(
    `INSERT INTO digest_items (id, digest_id, rank, title, url, source_name, source_domain, score, why, evidence, created_at)
     VALUES (@id, @digest_id, @rank, @title, @url, @source_name, @source_domain, @score, @why, @evidence, @now)`,
  ).run(row);
  return row.id;
}

describe("migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // D1 enforces foreign keys by default; better-sqlite3 does not, so match D1 here.
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("applies all migration files in filename order", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("entries");
    expect(names).toContain("settings");
    expect(names).toContain("entries_fts");
    expect(names).toContain("digests");
    expect(names).toContain("digest_items");
  });

  it("enforces unique index on canonical_url", () => {
    insertEntry(db, { id: "id-1", canonical_url: "https://example.com/dup" });
    expect(() =>
      insertEntry(db, { id: "id-2", canonical_url: "https://example.com/dup" }),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it("FTS trigger AFTER INSERT populates entries_fts", () => {
    insertEntry(db, {
      id: "id-insert",
      canonical_url: "https://example.com/insert",
      takeaway: "microservices architecture patterns",
    });
    const hit = db
      .prepare(
        `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("microservices") as { id: string } | undefined;
    expect(hit?.id).toBe("id-insert");
  });

  it("FTS trigger AFTER UPDATE swaps old/new terms", () => {
    insertEntry(db, {
      id: "id-update",
      canonical_url: "https://example.com/update",
      takeaway: "kubernetes clustering guide",
    });
    const beforeOld = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("kubernetes");
    expect(beforeOld).toHaveLength(1);

    db.prepare(
      `UPDATE entries SET takeaway = ?, updated_at = ? WHERE id = ?`,
    ).run("serverless deployment strategy", Date.now(), "id-update");

    const oldTerm = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("kubernetes");
    expect(oldTerm).toHaveLength(0);

    const newTerm = db
      .prepare(
        `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("serverless") as { id: string } | undefined;
    expect(newTerm?.id).toBe("id-update");
  });

  it("FTS trigger AFTER DELETE removes row from entries_fts", () => {
    insertEntry(db, {
      id: "id-delete",
      canonical_url: "https://example.com/delete",
      takeaway: "postgres replication tuning",
    });
    const before = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("postgres");
    expect(before).toHaveLength(1);

    db.prepare(`DELETE FROM entries WHERE id = ?`).run("id-delete");

    const after = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("postgres");
    expect(after).toHaveLength(0);
  });

  it("FTS MATCH against seeded row can be joined back to entries via rowid", () => {
    insertEntry(db, {
      id: "id-match",
      canonical_url: "https://example.com/match",
      title: "Rust ownership deep dive",
      takeaway: "borrow checker prevents data races at compile time",
    });
    const row = db
      .prepare(
        `SELECT e.id, e.title FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("borrow") as { id: string; title: string } | undefined;
    expect(row?.id).toBe("id-match");
    expect(row?.title).toBe("Rust ownership deep dive");
  });
});

describe("digests schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // D1 enforces foreign keys by default; better-sqlite3 does not, so match D1 here.
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("has foreign key enforcement enabled in this harness", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates the contract indexes digests(run_at desc) and digest_items(digest_id, rank)", () => {
    const indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
      .all() as { name: string; tbl_name: string }[];
    const byName = new Map(indexes.map((i) => [i.name, i.tbl_name]));
    expect(byName.get("digests_run_at_idx")).toBe("digests");
    expect(byName.get("digest_items_digest_id_rank_idx")).toBe("digest_items");
  });

  it("applies column defaults for status and evidence", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO digests (id, run_at, window_days, created_at, updated_at)
       VALUES ('d-default', @now, 7, @now, @now)`,
    ).run({ now });
    db.prepare(
      `INSERT INTO digest_items (id, digest_id, rank, title, url, source_name, source_domain, score, created_at)
       VALUES ('i-default', 'd-default', 1, 'T', 'https://example.com/x', 'hn', 'example.com', 2.25, @now)`,
    ).run({ now });

    const digest = db
      .prepare(`SELECT status, title, intro, error FROM digests WHERE id = ?`)
      .get("d-default") as {
      status: string;
      title: string | null;
      intro: string | null;
      error: string | null;
    };
    expect(digest.status).toBe("pending");
    expect(digest.title).toBeNull();
    expect(digest.intro).toBeNull();
    expect(digest.error).toBeNull();

    const item = db
      .prepare(`SELECT evidence, why, score FROM digest_items WHERE id = ?`)
      .get("i-default") as {
      evidence: string;
      why: string | null;
      score: number;
    };
    expect(item.evidence).toBe("[]");
    expect(item.why).toBeNull();
    expect(item.score).toBeCloseTo(2.25);
  });

  it("defaults digests.kind to 'weekly' for a row that never mentions it (0011)", () => {
    // The whole point of the migration's default: every row already in the
    // deployed database predates the monthly report and must read as weekly
    // without a backfill.
    const legacyId = insertDigest(db, { id: "d-legacy" });
    const row = db
      .prepare(`SELECT kind FROM digests WHERE id = ?`)
      .get(legacyId) as { kind: string };
    expect(row.kind).toBe("weekly");
  });

  it("rejects a digests row with an explicit NULL kind", () => {
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO digests (id, run_at, window_days, kind, created_at, updated_at)
           VALUES ('d-nullkind', @now, 7, NULL, @now, @now)`,
        )
        .run({ now }),
    ).toThrow(/NOT NULL|constraint/i);
  });

  it("round-trips kind = 'monthly-report' through the drizzle definition", () => {
    const orm = drizzle(db, { schema: { digests } });
    const runAt = Date.now();
    orm
      .insert(digests)
      .values({
        id: "d-report",
        runAt,
        windowDays: 30,
        kind: "monthly-report",
        status: "ready",
        title: "A month of databases",
        createdAt: runAt,
        updatedAt: runAt,
      })
      .run();
    orm
      .insert(digests)
      .values({
        id: "d-weekly-default",
        runAt,
        windowDays: 7,
        status: "ready",
        createdAt: runAt,
        updatedAt: runAt,
      })
      .run();

    const rows = orm
      .select({ id: digests.id, kind: digests.kind })
      .from(digests)
      .orderBy(digests.id)
      .all();
    expect(rows).toEqual([
      { id: "d-report", kind: "monthly-report" },
      // Omitted by the caller: drizzle's schema default has to agree with the
      // column default, or a report and a digest could disagree about a row.
      { id: "d-weekly-default", kind: "weekly" },
    ]);
  });

  it("rejects a digest_items row whose digest_id does not exist", () => {
    expect(() => insertDigestItem(db, "does-not-exist")).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  it("cascades deletes from digests to digest_items", () => {
    const keptId = insertDigest(db, { id: "d-kept" });
    const doomedId = insertDigest(db, { id: "d-doomed" });
    insertDigestItem(db, keptId, { id: "i-kept", rank: 1 });
    insertDigestItem(db, doomedId, { id: "i-doomed-1", rank: 1 });
    insertDigestItem(db, doomedId, { id: "i-doomed-2", rank: 2 });

    expect(
      db.prepare(`SELECT count(*) AS n FROM digest_items`).get(),
    ).toMatchObject({ n: 3 });

    db.prepare(`DELETE FROM digests WHERE id = ?`).run(doomedId);

    const remaining = db
      .prepare(`SELECT id FROM digest_items ORDER BY id`)
      .all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["i-kept"]);
  });

  it("returns digest items in rank order per digest", () => {
    const a = insertDigest(db, { id: "d-a" });
    const b = insertDigest(db, { id: "d-b" });
    insertDigestItem(db, a, { id: "a-3", rank: 3, title: "third" });
    insertDigestItem(db, a, { id: "a-1", rank: 1, title: "first" });
    insertDigestItem(db, a, { id: "a-2", rank: 2, title: "second" });
    insertDigestItem(db, b, { id: "b-1", rank: 1, title: "other digest" });

    const ordered = db
      .prepare(
        `SELECT id, title FROM digest_items WHERE digest_id = ? ORDER BY digest_id, rank`,
      )
      .all(a) as { id: string; title: string }[];
    expect(ordered.map((r) => r.id)).toEqual(["a-1", "a-2", "a-3"]);
    expect(ordered.map((r) => r.title)).toEqual(["first", "second", "third"]);

    const all = db
      .prepare(
        `SELECT digest_id, rank FROM digest_items ORDER BY digest_id, rank`,
      )
      .all() as { digest_id: string; rank: number }[];
    expect(all).toEqual([
      { digest_id: "d-a", rank: 1 },
      { digest_id: "d-a", rank: 2 },
      { digest_id: "d-a", rank: 3 },
      { digest_id: "d-b", rank: 1 },
    ]);
  });

  it("lists digest runs newest-first by run_at", () => {
    insertDigest(db, { id: "d-old", run_at: 1_000 });
    insertDigest(db, { id: "d-new", run_at: 3_000 });
    insertDigest(db, { id: "d-mid", run_at: 2_000 });

    const rows = db
      .prepare(`SELECT id FROM digests ORDER BY run_at DESC`)
      .all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["d-new", "d-mid", "d-old"]);
  });

  it("round-trips evidence JSON verbatim", () => {
    const digestId = insertDigest(db, { id: "d-evidence" });
    const evidence = JSON.stringify([
      {
        url: "https://news.ycombinator.com/item?id=1",
        sourceName: "hn",
        title: "A",
      },
      {
        url: "https://lobste.rs/s/abc",
        sourceName: "lobsters",
        title: "A (dup)",
      },
    ]);
    insertDigestItem(db, digestId, { id: "i-evidence", evidence });

    const row = db
      .prepare(`SELECT evidence FROM digest_items WHERE id = ?`)
      .get("i-evidence") as { evidence: string };
    expect(JSON.parse(row.evidence)).toHaveLength(2);
    expect(row.evidence).toBe(evidence);
  });

  it("leaves entries/entries_fts behavior untouched", () => {
    const digestId = insertDigest(db, { id: "d-fts" });
    insertDigestItem(db, digestId, {
      id: "i-fts",
      title: "graphql federation gateway",
    });

    insertEntry(db, {
      id: "id-after-digest",
      canonical_url: "https://example.com/after-digest",
      takeaway: "sqlite wal mode tradeoffs",
    });

    const hit = db
      .prepare(
        `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("sqlite") as { id: string } | undefined;
    expect(hit?.id).toBe("id-after-digest");

    // Digest rows must never leak into the entries index.
    const leaked = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("federation");
    expect(leaked).toHaveLength(0);
    expect(
      db.prepare(`SELECT count(*) AS n FROM entries_fts`).get(),
    ).toMatchObject({ n: 1 });

    // Deleting entries must not touch digests, and vice versa.
    db.prepare(`DELETE FROM entries WHERE id = ?`).run("id-after-digest");
    expect(db.prepare(`SELECT count(*) AS n FROM digests`).get()).toMatchObject(
      {
        n: 1,
      },
    );
    expect(
      db.prepare(`SELECT count(*) AS n FROM digest_items`).get(),
    ).toMatchObject({ n: 1 });
  });

  it("round-trips the drizzle table definitions against the migrated schema", () => {
    // Guards src/schema.ts column mapping against the generated SQL, the way the
    // Workflow will write a run + its items.
    const orm = drizzle(db, { schema: { digests, digestItems } });
    const runAt = Date.now();

    orm
      .insert(digests)
      .values({
        id: "d-orm",
        runAt,
        windowDays: 7,
        status: "ready",
        title: "ORM digest",
        intro: "Intro text.",
        createdAt: runAt,
        updatedAt: runAt,
      })
      .run();
    orm
      .insert(digestItems)
      .values([
        {
          id: "orm-2",
          digestId: "d-orm",
          rank: 2,
          title: "Second",
          url: "https://example.com/2",
          sourceName: "rss:example.com",
          sourceDomain: "example.com",
          score: 0.5,
          createdAt: runAt,
        },
        {
          id: "orm-1",
          digestId: "d-orm",
          rank: 1,
          title: "First",
          url: "https://example.com/1",
          sourceName: "hn",
          sourceDomain: "example.com",
          score: 3.75,
          why: "Corroborated by lobsters.",
          evidence: JSON.stringify([
            {
              url: "https://lobste.rs/s/x",
              sourceName: "lobsters",
              title: "First",
            },
          ]),
          createdAt: runAt,
        },
      ])
      .run();

    const run = orm
      .select()
      .from(digests)
      .where(eq(digests.id, "d-orm"))
      .all()
      .at(0);
    expect(run).toMatchObject({
      id: "d-orm",
      runAt,
      windowDays: 7,
      status: "ready",
      title: "ORM digest",
      error: null,
    });

    const items = orm
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, "d-orm"))
      .orderBy(digestItems.rank)
      .all();
    expect(items.map((i) => i.id)).toEqual(["orm-1", "orm-2"]);
    expect(items.at(0)?.score).toBeCloseTo(3.75);
    expect(items.at(1)?.evidence).toBe("[]");
    expect(items.at(1)?.why).toBeNull();

    orm.delete(digests).where(eq(digests.id, "d-orm")).run();
    expect(orm.select().from(digestItems).all()).toHaveLength(0);
  });
});

describe("feeds schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("seeds the three default RSS sources as enabled rows", () => {
    const rows = db
      .prepare(`SELECT id, url, title, enabled FROM feeds ORDER BY url`)
      .all() as {
      id: string;
      url: string;
      title: string | null;
      enabled: number;
    }[];
    expect(rows.map((r) => r.url)).toEqual([
      "https://blog.cloudflare.com/rss/",
      "https://jvns.ca/atom.xml",
      "https://simonwillison.net/atom/everything/",
    ]);
    expect(rows.every((r) => r.enabled === 1)).toBe(true);
    expect(rows.every((r) => (r.title ?? "").length > 0)).toBe(true);
    // Stable ids, so re-applying the seed cannot fork into duplicate rows.
    expect(rows.map((r) => r.id)).toEqual([
      "feed-blog-cloudflare-com",
      "feed-jvns-ca",
      "feed-simonwillison-net",
    ]);
  });

  it("is idempotent when the seed statement is applied twice", () => {
    const seed = readFileSync(join(migrationsDir, "0005_feeds.sql"), "utf8");
    const insert = seed.slice(seed.lastIndexOf("INSERT OR IGNORE"));
    db.exec(insert);
    expect(db.prepare(`SELECT count(*) AS n FROM feeds`).get()).toMatchObject({
      n: 3,
    });
  });

  it("rejects a duplicate feed url", () => {
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO feeds (id, url, enabled, created_at, updated_at)
           VALUES ('dup', 'https://jvns.ca/atom.xml', 1, @now, @now)`,
        )
        .run({ now }),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it("defaults enabled to 1 and title to NULL", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO feeds (id, url, created_at, updated_at)
       VALUES ('f-default', 'https://example.com/feed.xml', @now, @now)`,
    ).run({ now });
    const row = db
      .prepare(`SELECT enabled, title FROM feeds WHERE id = ?`)
      .get("f-default") as { enabled: number; title: string | null };
    expect(row.enabled).toBe(1);
    expect(row.title).toBeNull();
  });

  it("round-trips the drizzle table definition, mapping enabled to a boolean", () => {
    const orm = drizzle(db, { schema: { feeds } });
    const now = Date.now();
    orm
      .insert(feeds)
      .values({
        id: "f-orm",
        url: "https://orm.example.com/atom.xml",
        title: "ORM feed",
        enabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = orm
      .select()
      .from(feeds)
      .where(eq(feeds.id, "f-orm"))
      .all()
      .at(0);
    expect(row).toMatchObject({
      id: "f-orm",
      url: "https://orm.example.com/atom.xml",
      title: "ORM feed",
      enabled: false,
    });

    const enabled = orm
      .select({ url: feeds.url })
      .from(feeds)
      .where(eq(feeds.enabled, true))
      .all();
    expect(enabled).toHaveLength(3);
  });

  it("creates the contract indexes on feeds", () => {
    const indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
      .all() as { name: string; tbl_name: string }[];
    const byName = new Map(indexes.map((i) => [i.name, i.tbl_name]));
    expect(byName.get("feeds_url_uq")).toBe("feeds");
    expect(byName.get("feeds_enabled_idx")).toBe("feeds");
  });
});

describe("library columns (0009)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("adds favorite, archived and note to entries", () => {
    const cols = db.prepare(`PRAGMA table_info(entries)`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));

    // PRAGMA reports the affinity, upper-cased, whatever the declaration spelled.
    expect(byName.get("favorite")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
    expect(byName.get("archived")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
    expect(byName.get("note")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(byName.get("note")?.dflt_value).toBeNull();
  });

  it("leaves every pre-0009 column in place", () => {
    // The migration is ADD COLUMN only: it lands on a deployed database, so
    // nothing that was already there may change shape.
    const cols = (
      db.prepare(`PRAGMA table_info(entries)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "url",
        "canonical_url",
        "title",
        "source_domain",
        "content_markdown",
        "summary",
        "takeaway",
        "question",
        "tags",
        "status",
        "error",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("gives an already-saved row the defaults, with no backfill statement", () => {
    // insertEntry names only the pre-0009 columns, exactly like the INSERT the
    // app shipped before this migration.
    insertEntry(db, {
      id: "e-legacy",
      canonical_url: "https://example.com/legacy",
    });
    const row = db
      .prepare(`SELECT favorite, archived, note FROM entries WHERE id = ?`)
      .get("e-legacy") as {
      favorite: number;
      archived: number;
      note: string | null;
    };
    expect(row).toEqual({ favorite: 0, archived: 0, note: null });
  });

  it("rejects a NULL flag", () => {
    const now = Date.now();
    for (const column of ["favorite", "archived"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entries (id, url, canonical_url, tags, status, ${column}, created_at, updated_at)
             VALUES (@id, 'https://example.com/n', 'https://example.com/n', '[]', 'ready', NULL, @now, @now)`,
          )
          .run({ id: `e-null-${column}`, now }),
      ).toThrow(/NOT NULL|constraint/i);
    }
  });

  it("keeps entries_fts intact when only the new columns are updated", () => {
    // The 0001 triggers fire on any UPDATE, but they name their columns, so this
    // is a delete-then-reinsert of the same terms — a no-op re-index.
    insertEntry(db, {
      id: "e-marks",
      canonical_url: "https://example.com/marks",
      takeaway: "postgres replication tuning",
    });
    const before = db
      .prepare(`SELECT count(*) AS n FROM entries_fts`)
      .get() as { n: number };

    db.prepare(
      `UPDATE entries SET favorite = 1, archived = 1, note = ?, updated_at = ? WHERE id = ?`,
    ).run("kubernetes clustering guide", Date.now(), "e-marks");

    expect(db.prepare(`SELECT count(*) AS n FROM entries_fts`).get()).toEqual(
      before,
    );
    const hit = db
      .prepare(
        `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("replication") as { id: string } | undefined;
    expect(hit?.id).toBe("e-marks");

    // A note is private prose, not indexed text — 0001 lists the five columns it
    // mirrors and `note` is not among them.
    const leaked = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("kubernetes");
    expect(leaked).toHaveLength(0);
  });

  it("round-trips the drizzle table definition, mapping both flags to booleans", () => {
    const orm = drizzle(db, { schema: { entries } });
    const now = Date.now();
    orm
      .insert(entries)
      .values({
        id: "e-orm",
        url: "https://orm.example.com/a",
        canonicalUrl: "https://orm.example.com/a",
        title: "ORM entry",
        tags: '["orm"]',
        favorite: true,
        archived: false,
        note: "written by hand",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = orm
      .select()
      .from(entries)
      .where(eq(entries.id, "e-orm"))
      .all()
      .at(0);
    expect(row).toMatchObject({
      id: "e-orm",
      favorite: true,
      archived: false,
      note: "written by hand",
    });

    // The boolean seam works in a predicate too, which is what the feed filters do.
    insertEntry(db, {
      id: "e-plain",
      canonical_url: "https://example.com/plain",
    });
    expect(
      orm
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.favorite, true))
        .all(),
    ).toEqual([{ id: "e-orm" }]);
    expect(
      orm
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.archived, false))
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["e-orm", "e-plain"]);
  });
});

describe("content type column (0010)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("adds content_type to entries as a NOT NULL text defaulting to 'article'", () => {
    const cols = db.prepare(`PRAGMA table_info(entries)`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const col = new Map(cols.map((c) => [c.name, c])).get("content_type");
    expect(col).toMatchObject({
      type: "TEXT",
      notnull: 1,
      dflt_value: "'article'",
    });
  });

  it("leaves every pre-0010 column in place", () => {
    // ADD COLUMN only: it lands on a deployed database, so nothing already there
    // may change shape — including the three columns 0009 added.
    const cols = (
      db.prepare(`PRAGMA table_info(entries)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "url",
        "canonical_url",
        "title",
        "source_domain",
        "content_markdown",
        "summary",
        "takeaway",
        "question",
        "tags",
        "favorite",
        "archived",
        "note",
        "status",
        "error",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("reads an already-saved row as an article, with no backfill statement", () => {
    // insertEntry names only the pre-0009 columns, exactly like the INSERT the app
    // shipped before either migration — a legacy row is an article.
    insertEntry(db, {
      id: "e-legacy-ct",
      canonical_url: "https://example.com/legacy-ct",
    });
    const row = db
      .prepare(`SELECT content_type FROM entries WHERE id = ?`)
      .get("e-legacy-ct") as { content_type: string };
    expect(row).toEqual({ content_type: "article" });
  });

  it("rejects a NULL content_type", () => {
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO entries (id, url, canonical_url, tags, status, content_type, created_at, updated_at)
           VALUES (@id, 'https://example.com/n', 'https://example.com/n', '[]', 'ready', NULL, @now, @now)`,
        )
        .run({ id: "e-null-ct", now }),
    ).toThrow(/NOT NULL|constraint/i);
  });

  it("has no CHECK constraint — the vocabulary is enforced in code, not SQL", () => {
    // Asserted so the reason is written down: SQLite cannot ALTER TABLE ADD a
    // CHECK, so an unknown value has to be survivable. `normalizeContentType`
    // reads anything it does not know as 'article'.
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO entries (id, url, canonical_url, tags, status, content_type, created_at, updated_at)
           VALUES (@id, 'https://example.com/odd', 'https://example.com/odd', '[]', 'ready', 'audio', @now, @now)`,
        )
        .run({ id: "e-odd-ct", now }),
    ).not.toThrow();
  });

  it("keeps entries_fts intact when only content_type is updated", () => {
    // The 0001 triggers fire on any UPDATE, but they name their columns, so this
    // is a delete-then-reinsert of the same terms — a no-op re-index. It matters
    // because ingest overwrites content_type on every run.
    insertEntry(db, {
      id: "e-ct-fts",
      canonical_url: "https://example.com/ct-fts",
      takeaway: "postgres replication tuning",
    });
    const before = db
      .prepare(`SELECT count(*) AS n FROM entries_fts`)
      .get() as { n: number };

    db.prepare(
      `UPDATE entries SET content_type = 'pdf', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), "e-ct-fts");

    expect(db.prepare(`SELECT count(*) AS n FROM entries_fts`).get()).toEqual(
      before,
    );
    const hit = db
      .prepare(
        `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`,
      )
      .get("replication") as { id: string } | undefined;
    expect(hit?.id).toBe("e-ct-fts");

    // The kind of a document is not searchable text — 0001 lists the five columns
    // it mirrors and `content_type` is not among them.
    expect(
      db
        .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
        .all("pdf"),
    ).toHaveLength(0);
  });

  it("round-trips the drizzle table definition", () => {
    const orm = drizzle(db, { schema: { entries } });
    const now = Date.now();
    orm
      .insert(entries)
      .values({
        id: "e-orm-ct",
        url: "https://orm.example.com/v",
        canonicalUrl: "https://orm.example.com/v",
        title: "A talk",
        tags: '["talk"]',
        contentType: "video",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(
      orm.select().from(entries).where(eq(entries.id, "e-orm-ct")).all().at(0),
    ).toMatchObject({ id: "e-orm-ct", contentType: "video" });

    // Omitting it in the ORM path gets the column default, like a legacy row.
    orm
      .insert(entries)
      .values({
        id: "e-orm-default",
        url: "https://orm.example.com/a",
        canonicalUrl: "https://orm.example.com/a",
        tags: "[]",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(
      orm
        .select()
        .from(entries)
        .where(eq(entries.id, "e-orm-default"))
        .all()
        .at(0),
    ).toMatchObject({ contentType: "article" });
  });
});

describe("feedback schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  function insertFeedback(
    overrides: Partial<{
      id: string;
      conversation_id: string | null;
      message_id: string | null;
      entry_id: string | null;
      kind: string;
      comment: string | null;
      created_at: number;
    }> = {},
  ): string {
    const row = {
      id: overrides.id ?? crypto.randomUUID(),
      conversation_id: overrides.conversation_id ?? null,
      message_id: overrides.message_id ?? null,
      entry_id: overrides.entry_id ?? null,
      kind: overrides.kind ?? "up",
      comment: overrides.comment ?? null,
      created_at: overrides.created_at ?? Date.now(),
    };
    db.prepare(
      `INSERT INTO feedback (id, conversation_id, message_id, entry_id, kind, comment, created_at)
       VALUES (@id, @conversation_id, @message_id, @entry_id, @kind, @comment, @created_at)`,
    ).run(row);
    return row.id;
  }

  it("creates the table and its created_at index", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toContain("feedback");

    const indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
      .all() as { name: string; tbl_name: string }[];
    expect(
      new Map(indexes.map((i) => [i.name, i.tbl_name])).get(
        "feedback_created_at_idx",
      ),
    ).toBe("feedback");
  });

  it("requires only id, kind and created_at", () => {
    db.prepare(
      `INSERT INTO feedback (id, kind, created_at) VALUES ('f-min', 'down', 1700)`,
    ).run();
    const row = db
      .prepare(`SELECT * FROM feedback WHERE id = ?`)
      .get("f-min") as Record<string, unknown>;
    expect(row).toEqual({
      id: "f-min",
      conversation_id: null,
      message_id: null,
      entry_id: null,
      kind: "down",
      comment: null,
      created_at: 1700,
    });
  });

  it("rejects a row with no kind", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO feedback (id, created_at) VALUES ('f-nokind', 1700)`,
        )
        .run(),
    ).toThrow(/NOT NULL|constraint/i);
  });

  it("keeps a vote after the entry it was about is deleted", () => {
    // The no-foreign-key decision. A cascade here would erase exactly the
    // history this table exists to accumulate, and a restricting FK would make
    // DELETE /api/entries/:id fail once any feedback existed.
    insertEntry(db, {
      id: "e-voted",
      canonical_url: "https://example.com/voted",
    });
    insertFeedback({ id: "f-entry", entry_id: "e-voted", kind: "down" });

    expect(() =>
      db.prepare(`DELETE FROM entries WHERE id = ?`).run("e-voted"),
    ).not.toThrow();

    const row = db
      .prepare(`SELECT entry_id FROM feedback WHERE id = ?`)
      .get("f-entry") as { entry_id: string | null };
    // Still pointing at the deleted id: the subject of the signal is preserved.
    expect(row.entry_id).toBe("e-voted");
  });

  it("accepts an entry_id that never existed (chat/DO ids are unresolvable too)", () => {
    expect(() => insertFeedback({ entry_id: "no-such-entry" })).not.toThrow();
    expect(() =>
      insertFeedback({ conversation_id: "conv-x", message_id: "msg-x" }),
    ).not.toThrow();
  });

  it("stores repeat votes on one message as separate rows, newest-first by created_at", () => {
    insertFeedback({
      id: "f-1",
      message_id: "m",
      kind: "up",
      created_at: 1_000,
    });
    insertFeedback({
      id: "f-2",
      message_id: "m",
      kind: "down",
      created_at: 2_000,
    });

    const rows = db
      .prepare(
        `SELECT id, kind FROM feedback WHERE message_id = ? ORDER BY created_at DESC`,
      )
      .all("m") as { id: string; kind: string }[];
    expect(rows).toEqual([
      { id: "f-2", kind: "down" },
      { id: "f-1", kind: "up" },
    ]);
  });

  it("round-trips the drizzle table definition against the migrated schema", () => {
    const orm = drizzle(db, { schema: { feedback } });
    orm
      .insert(feedback)
      .values({
        id: "f-orm",
        conversationId: "conv-orm",
        messageId: "msg-orm",
        kind: "up",
        comment: "Exactly the answer I wanted.",
        createdAt: 1_700_000_000_000,
      })
      .run();

    const row = orm
      .select()
      .from(feedback)
      .where(eq(feedback.id, "f-orm"))
      .all()
      .at(0);
    expect(row).toEqual({
      id: "f-orm",
      conversationId: "conv-orm",
      messageId: "msg-orm",
      entryId: null,
      kind: "up",
      comment: "Exactly the answer I wanted.",
      createdAt: 1_700_000_000_000,
    });
  });

  it("leaves the entries index untouched — feedback text is never searchable", () => {
    insertEntry(db, {
      id: "e-fts-feedback",
      canonical_url: "https://example.com/fts-feedback",
      takeaway: "vitest snapshot hygiene",
    });
    insertFeedback({ comment: "kubernetes clustering guide" });

    const leaked = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`)
      .all("kubernetes");
    expect(leaked).toHaveLength(0);
    expect(
      db.prepare(`SELECT count(*) AS n FROM entries_fts`).get(),
    ).toMatchObject({ n: 1 });
  });
});
