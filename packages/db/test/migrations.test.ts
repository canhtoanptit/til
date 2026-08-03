import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { digests, digestItems } from "../src/schema.js";

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
