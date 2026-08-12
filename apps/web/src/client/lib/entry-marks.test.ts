import { describe, expect, it } from "vitest";
import { archiveVars, entriesKey, favoriteVars } from "./entry-marks";

describe("entriesKey", () => {
  it("gives each view its own key, under one shared prefix", () => {
    // The prefix is what `invalidateQueries({queryKey: ["entries"]})` matches, so
    // it has to be the first element of every key.
    for (const key of [
      entriesKey(),
      entriesKey({ filter: "favorites" }),
      entriesKey({ tag: "rust" }),
    ]) {
      expect(key[0]).toBe("entries");
    }

    const keys = [
      entriesKey(),
      entriesKey({ filter: "favorites" }),
      entriesKey({ filter: "archived" }),
      entriesKey({ tag: "rust" }),
      entriesKey({ tag: "go" }),
    ].map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("defaults to the unfiltered feed", () => {
    expect(entriesKey()).toEqual(["entries", "all", null]);
    expect(entriesKey({ filter: "all" })).toEqual(entriesKey());
  });

  it("keeps a tag page distinct from the feed even when the tag is a filter name", () => {
    // Both live in the same key space, so the two slots must never be conflated.
    expect(entriesKey({ tag: "archived" })).not.toEqual(
      entriesKey({ filter: "archived" }),
    );
  });
});

describe("mark toast copy", () => {
  it("says what actually happened, in both directions", () => {
    expect(favoriteVars("e1", true)).toMatchObject({
      id: "e1",
      patch: { favorite: true },
      success: "Added to favorites",
    });
    expect(favoriteVars("e1", false).patch).toEqual({ favorite: false });
    expect(favoriteVars("e1", false).success).toBe("Removed from favorites");

    expect(archiveVars("e2", true)).toMatchObject({
      id: "e2",
      patch: { archived: true },
      success: "Archived",
    });
    expect(archiveVars("e2", false).patch).toEqual({ archived: false });
  });
});
