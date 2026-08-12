import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entries } from "@til/db";
import { buildTestApp, insertEntry, makeStubEmbedder } from "./test-harness.js";
import { MAX_ENTRY_NOTE } from "./schemas.js";

interface EntryBody {
  id: string;
  favorite: boolean;
  archived: boolean;
  note: string | null;
  tags: string[];
  updatedAt: number;
  contentMarkdown?: string | null;
}

interface ListBody {
  items: { id: string; archived: boolean; favorite: boolean }[];
  nextCursor: string | null;
}

async function patch(
  t: ReturnType<typeof buildTestApp>,
  id: string,
  body: unknown,
) {
  return t.request(`/api/entries/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/entries/:id", () => {
  it("sets favorite alone, leaving archived and note untouched", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-1", note: "kept" });

    const res = await patch(t, "p-1", { favorite: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EntryBody;
    expect(body.favorite).toBe(true);
    expect(body.archived).toBe(false);
    expect(body.note).toBe("kept");

    const row = (
      await t.deps.db.select().from(entries).where(eq(entries.id, "p-1"))
    )[0];
    expect(row?.favorite).toBe(true);
    expect(row?.archived).toBe(false);
    expect(row?.note).toBe("kept");
  });

  it("sets archived alone, leaving favorite and note untouched", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-2", favorite: true, note: "kept" });

    const body = (await (await patch(t, "p-2", { archived: true })).json()) as EntryBody;
    expect(body.archived).toBe(true);
    expect(body.favorite).toBe(true);
    expect(body.note).toBe("kept");
  });

  it("sets note alone, leaving both flags untouched", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-3", favorite: true, archived: true });

    const body = (await (
      await patch(t, "p-3", { note: "My own words about this." })
    ).json()) as EntryBody;
    expect(body.note).toBe("My own words about this.");
    expect(body.favorite).toBe(true);
    expect(body.archived).toBe(true);
  });

  it("applies all three fields in one request", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-4" });

    const body = (await (
      await patch(t, "p-4", { favorite: true, archived: true, note: "n" })
    ).json()) as EntryBody;
    expect(body).toMatchObject({ favorite: true, archived: true, note: "n" });
  });

  it("un-sets a flag — false is a value, not an omission", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-5", favorite: true, archived: true });

    const body = (await (
      await patch(t, "p-5", { favorite: false })
    ).json()) as EntryBody;
    expect(body.favorite).toBe(false);
    // The other flag was omitted, so it must still be set.
    expect(body.archived).toBe(true);
  });

  it("clears the note to null when sent an empty string", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-6", note: "to be cleared" });

    const body = (await (await patch(t, "p-6", { note: "" })).json()) as EntryBody;
    expect(body.note).toBeNull();
    // NULL in the column, not "" — "no note" has one representation.
    const row = (
      await t.deps.db.select().from(entries).where(eq(entries.id, "p-6"))
    )[0];
    expect(row?.note).toBeNull();
  });

  it("keeps a note across a later flag-only patch", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-7" });
    await patch(t, "p-7", { note: "written first" });
    const body = (await (
      await patch(t, "p-7", { favorite: true })
    ).json()) as EntryBody;
    expect(body.note).toBe("written first");
  });

  it("stamps updatedAt from deps.now()", async () => {
    const now = 4_242_424_242;
    const t = buildTestApp({ now: () => now });
    await insertEntry(t.deps.db, { id: "p-8", createdAt: 1_000, updatedAt: 1_000 });

    const body = (await (
      await patch(t, "p-8", { favorite: true })
    ).json()) as EntryBody;
    expect(body.updatedAt).toBe(now);
  });

  it("returns the detail shape, so a star click cannot drop contentMarkdown", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-9" });
    await t.deps.db
      .update(entries)
      .set({ contentMarkdown: "# extracted" })
      .where(eq(entries.id, "p-9"));

    const body = (await (
      await patch(t, "p-9", { favorite: true })
    ).json()) as EntryBody;
    expect(body.contentMarkdown).toBe("# extracted");
  });

  it("404 for an unknown id", async () => {
    const t = buildTestApp();
    const res = await patch(t, "does-not-exist", { favorite: true });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("422 for an empty body — a patch that cannot mean anything", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-10" });
    const res = await patch(t, "p-10", {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("422 for a non-boolean flag", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-11" });
    const res = await patch(t, "p-11", { favorite: "yes" });
    expect(res.status).toBe(422);
  });

  it("422 for a null note — clearing is spelled \"\", not null", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-12" });
    const res = await patch(t, "p-12", { note: null });
    expect(res.status).toBe(422);
  });

  it("422 for a note over the size cap, and 200 exactly at it", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "p-13" });
    const over = await patch(t, "p-13", { note: "x".repeat(MAX_ENTRY_NOTE + 1) });
    expect(over.status).toBe(422);
    const at = await patch(t, "p-13", { note: "x".repeat(MAX_ENTRY_NOTE) });
    expect(at.status).toBe(200);
  });

  it("leaves the FTS index intact — the AFTER UPDATE trigger re-indexes unchanged terms", async () => {
    const t = buildTestApp({
      embedder: makeStubEmbedder([["rust"]], { dimensions: 4 }),
    });
    await insertEntry(t.deps.db, {
      id: "p-14",
      title: "Rust ownership",
      summary: "borrow checker",
      takeaway: "ownership matters",
      tags: ["rust"],
    });
    const before = (await (await t.request("/api/search?q=ownership")).json()) as {
      items: { id: string }[];
    };
    expect(before.items.map((i) => i.id)).toEqual(["p-14"]);

    await patch(t, "p-14", { favorite: true, note: "a note nobody can search for" });

    const after = (await (await t.request("/api/search?q=ownership")).json()) as {
      items: { id: string; favorite: boolean }[];
    };
    expect(after.items.map((i) => i.id)).toEqual(["p-14"]);
    expect(after.items[0]?.favorite).toBe(true);
    // The note is deliberately not in entries_fts (0001 names its columns).
    const byNote = (await (await t.request("/api/search?q=nobody")).json()) as {
      items: { id: string }[];
    };
    expect(byNote.items).toEqual([]);
  });
});

describe("GET /api/entries?filter=", () => {
  /** a: plain · b: favorite · c: archived · d: archived + favorite. */
  async function seedFour(t: ReturnType<typeof buildTestApp>) {
    await insertEntry(t.deps.db, {
      id: "a",
      createdAt: 100,
      canonicalUrl: "https://example.com/a",
      url: "https://example.com/a",
    });
    await insertEntry(t.deps.db, {
      id: "b",
      createdAt: 200,
      favorite: true,
      canonicalUrl: "https://example.com/b",
      url: "https://example.com/b",
    });
    await insertEntry(t.deps.db, {
      id: "c",
      createdAt: 300,
      archived: true,
      canonicalUrl: "https://example.com/c",
      url: "https://example.com/c",
    });
    await insertEntry(t.deps.db, {
      id: "d",
      createdAt: 400,
      archived: true,
      favorite: true,
      canonicalUrl: "https://example.com/d",
      url: "https://example.com/d",
    });
  }

  it("the default view excludes archived entries", async () => {
    const t = buildTestApp();
    await seedFour(t);
    const body = (await (await t.request("/api/entries")).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(body.items.every((i) => !i.archived)).toBe(true);
  });

  it("favorites means favorite and not archived", async () => {
    const t = buildTestApp();
    await seedFour(t);
    const body = (await (
      await t.request("/api/entries?filter=favorites")
    ).json()) as ListBody;
    // "d" is favorited too, but archiving is the stronger statement.
    expect(body.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("archived means archived only, favorited or not", async () => {
    const t = buildTestApp();
    await seedFour(t);
    const body = (await (
      await t.request("/api/entries?filter=archived")
    ).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["d", "c"]);
  });

  it("an unrecognized filter reads as the default view", async () => {
    const t = buildTestApp();
    await seedFour(t);
    for (const q of ["?filter=bogus", "?filter=", "?filter=ARCHIVED"]) {
      const body = (await (await t.request(`/api/entries${q}`)).json()) as ListBody;
      expect(body.items.map((i) => i.id)).toEqual(["b", "a"]);
    }
  });

  it("paginates the default view over interleaved archived rows without gaps", async () => {
    const t = buildTestApp();
    // Archived rows sit between the visible ones, so a cursor that walked the
    // unfiltered sequence would short a page.
    for (const [id, createdAt, archived] of [
      ["v1", 100, false],
      ["x1", 150, true],
      ["v2", 200, false],
      ["x2", 250, true],
      ["v3", 300, false],
      ["x3", 350, true],
      ["v4", 400, false],
    ] as const) {
      await insertEntry(t.deps.db, {
        id,
        createdAt,
        archived,
        canonicalUrl: `https://example.com/${id}`,
        url: `https://example.com/${id}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const qs = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const body = (await (await t.request(`/api/entries${qs}`)).json()) as ListBody;
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(["v4", "v3", "v2", "v1"]);
  });

  it("paginates within filter=favorites", async () => {
    const t = buildTestApp();
    for (const [id, createdAt, favorite] of [
      ["f1", 100, true],
      ["n1", 150, false],
      ["f2", 200, true],
      ["n2", 250, false],
      ["f3", 300, true],
    ] as const) {
      await insertEntry(t.deps.db, {
        id,
        createdAt,
        favorite,
        canonicalUrl: `https://example.com/${id}`,
        url: `https://example.com/${id}`,
      });
    }

    const first = (await (
      await t.request("/api/entries?filter=favorites&limit=2")
    ).json()) as ListBody;
    expect(first.items.map((i) => i.id)).toEqual(["f3", "f2"]);
    expect(first.nextCursor).toBe("200_f2");

    const second = (await (
      await t.request(
        `/api/entries?filter=favorites&limit=2&cursor=${first.nextCursor}`,
      )
    ).json()) as ListBody;
    expect(second.items.map((i) => i.id)).toEqual(["f1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps sweeping stale pending rows regardless of filter", async () => {
    const now = 5_000_000_000;
    const staleAt = now - 11 * 60 * 1000;
    const t = buildTestApp({ now: () => now });
    await insertEntry(t.deps.db, {
      id: "stale-archived",
      status: "pending",
      archived: true,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    const body = (await (
      await t.request("/api/entries?filter=archived")
    ).json()) as {
      items: { id: string; status: string }[];
    };
    expect(body.items[0]?.status).toBe("failed");
  });
});

describe("GET /api/entries?tag=", () => {
  async function seedTagged(t: ReturnType<typeof buildTestApp>) {
    await insertEntry(t.deps.db, {
      id: "t-go",
      createdAt: 100,
      tags: ["go", "concurrency"],
      canonicalUrl: "https://example.com/go",
      url: "https://example.com/go",
    });
    await insertEntry(t.deps.db, {
      id: "t-golang",
      createdAt: 200,
      tags: ["golang"],
      canonicalUrl: "https://example.com/golang",
      url: "https://example.com/golang",
    });
    await insertEntry(t.deps.db, {
      id: "t-go-2",
      createdAt: 300,
      tags: ["testing", "go"],
      canonicalUrl: "https://example.com/go-2",
      url: "https://example.com/go-2",
    });
  }

  it("matches a tag exactly — 'go' must not match 'golang'", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    const body = (await (await t.request("/api/entries?tag=go")).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["t-go-2", "t-go"]);
  });

  it("matches a tag that is a superstring of another tag", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    const body = (await (
      await t.request("/api/entries?tag=golang")
    ).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["t-golang"]);
  });

  it("matches a tag that is not the first element of the array", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    const body = (await (
      await t.request("/api/entries?tag=testing")
    ).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["t-go-2"]);
  });

  it("returns nothing for a tag nobody used", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    const body = (await (
      await t.request("/api/entries?tag=haskell")
    ).json()) as ListBody;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("cannot be widened with LIKE wildcards", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    // `%` and `_` are stripped before the pattern is built, so this asks for the
    // tag "go" and not "anything starting with go".
    const body = (await (await t.request("/api/entries?tag=go%")).json()) as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(["t-go-2", "t-go"]);
  });

  it("excludes archived entries, and honours filter= alongside the tag", async () => {
    const t = buildTestApp();
    await seedTagged(t);
    await insertEntry(t.deps.db, {
      id: "t-go-archived",
      createdAt: 400,
      tags: ["go"],
      archived: true,
      canonicalUrl: "https://example.com/go-archived",
      url: "https://example.com/go-archived",
    });
    await insertEntry(t.deps.db, {
      id: "t-go-fav",
      createdAt: 500,
      tags: ["go"],
      favorite: true,
      canonicalUrl: "https://example.com/go-fav",
      url: "https://example.com/go-fav",
    });

    const def = (await (await t.request("/api/entries?tag=go")).json()) as ListBody;
    expect(def.items.map((i) => i.id)).toEqual(["t-go-fav", "t-go-2", "t-go"]);

    const favs = (await (
      await t.request("/api/entries?tag=go&filter=favorites")
    ).json()) as ListBody;
    expect(favs.items.map((i) => i.id)).toEqual(["t-go-fav"]);

    const arch = (await (
      await t.request("/api/entries?tag=go&filter=archived")
    ).json()) as ListBody;
    expect(arch.items.map((i) => i.id)).toEqual(["t-go-archived"]);
  });

  it("paginates within a tag", async () => {
    const t = buildTestApp();
    for (let i = 1; i <= 3; i += 1) {
      await insertEntry(t.deps.db, {
        id: `pg-${i}`,
        createdAt: i * 100,
        tags: ["rust"],
        canonicalUrl: `https://example.com/pg-${i}`,
        url: `https://example.com/pg-${i}`,
      });
      await insertEntry(t.deps.db, {
        id: `other-${i}`,
        createdAt: i * 100 + 50,
        tags: ["python"],
        canonicalUrl: `https://example.com/other-${i}`,
        url: `https://example.com/other-${i}`,
      });
    }
    const first = (await (
      await t.request("/api/entries?tag=rust&limit=2")
    ).json()) as ListBody;
    expect(first.items.map((i) => i.id)).toEqual(["pg-3", "pg-2"]);
    const second = (await (
      await t.request(`/api/entries?tag=rust&limit=2&cursor=${first.nextCursor}`)
    ).json()) as ListBody;
    expect(second.items.map((i) => i.id)).toEqual(["pg-1"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("GET /api/tags", () => {
  interface TagsBody {
    items: { tag: string; count: number }[];
  }

  it("counts tags, most-used first and alphabetical within a tie", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "g-1",
      tags: ["go", "testing"],
      canonicalUrl: "https://example.com/1",
      url: "https://example.com/1",
    });
    await insertEntry(t.deps.db, {
      id: "g-2",
      tags: ["go", "arrays"],
      canonicalUrl: "https://example.com/2",
      url: "https://example.com/2",
    });
    await insertEntry(t.deps.db, {
      id: "g-3",
      tags: ["go"],
      canonicalUrl: "https://example.com/3",
      url: "https://example.com/3",
    });

    const body = (await (await t.request("/api/tags")).json()) as TagsBody;
    expect(body.items).toEqual([
      { tag: "go", count: 3 },
      { tag: "arrays", count: 1 },
      { tag: "testing", count: 1 },
    ]);
  });

  it("excludes archived entries, so a count matches what /tags/:tag lists", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "v",
      tags: ["go"],
      canonicalUrl: "https://example.com/v",
      url: "https://example.com/v",
    });
    await insertEntry(t.deps.db, {
      id: "x",
      tags: ["go"],
      archived: true,
      canonicalUrl: "https://example.com/x",
      url: "https://example.com/x",
    });

    const body = (await (await t.request("/api/tags")).json()) as TagsBody;
    expect(body.items).toEqual([{ tag: "go", count: 1 }]);

    // The promise the count makes: following the link finds exactly that many.
    const listed = (await (await t.request("/api/entries?tag=go")).json()) as ListBody;
    expect(listed.items).toHaveLength(1);
  });

  it("drops a tag whose only entries are archived", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "only-archived",
      tags: ["forgotten"],
      archived: true,
    });
    const body = (await (await t.request("/api/tags")).json()) as TagsBody;
    expect(body.items).toEqual([]);
  });

  it("reflects an archive as soon as it is patched in", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "live", tags: ["rust"] });
    expect(
      ((await (await t.request("/api/tags")).json()) as TagsBody).items,
    ).toEqual([{ tag: "rust", count: 1 }]);

    await patch(t, "live", { archived: true });
    expect(
      ((await (await t.request("/api/tags")).json()) as TagsBody).items,
    ).toEqual([]);
  });

  it("is an empty list for an empty library, and ignores untagged entries", async () => {
    const t = buildTestApp();
    const empty = (await (await t.request("/api/tags")).json()) as TagsBody;
    expect(empty.items).toEqual([]);

    await insertEntry(t.deps.db, { id: "untagged", tags: [] });
    await insertEntry(t.deps.db, {
      id: "pending",
      status: "pending",
      tags: [],
      canonicalUrl: "https://example.com/pending",
      url: "https://example.com/pending",
    });
    const still = (await (await t.request("/api/tags")).json()) as TagsBody;
    expect(still.items).toEqual([]);
  });

  it("is behind the bearer token like every other data route", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/tags", { auth: false });
    expect(res.status).toBe(401);
  });
});

describe("entry DTO — P23 additions", () => {
  it("reports the migration defaults for an entry saved before the columns existed", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "dto-1" });

    const list = (await (await t.request("/api/entries")).json()) as {
      items: EntryBody[];
    };
    expect(list.items[0]).toMatchObject({
      favorite: false,
      archived: false,
      note: null,
    });

    const detail = (await (
      await t.request("/api/entries/dto-1")
    ).json()) as EntryBody;
    expect(detail).toMatchObject({ favorite: false, archived: false, note: null });
  });

  it("round-trips the marks through the list and detail responses", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "dto-2",
      favorite: true,
      archived: true,
      note: "why I kept this",
    });

    const detail = (await (
      await t.request("/api/entries/dto-2")
    ).json()) as EntryBody;
    expect(detail).toMatchObject({
      favorite: true,
      archived: true,
      note: "why I kept this",
    });

    const list = (await (
      await t.request("/api/entries?filter=archived")
    ).json()) as { items: EntryBody[] };
    expect(list.items[0]).toMatchObject({
      favorite: true,
      archived: true,
      note: "why I kept this",
    });
  });
});
