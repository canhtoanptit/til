import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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

describe("migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  it("applies all migration files in filename order", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("entries");
    expect(names).toContain("settings");
    expect(names).toContain("entries_fts");
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
