import type { EntryFilter, UpdateEntryInput } from "../api";

/**
 * Cache keys and toast copy for the owner's marks on an entry. Deliberately free of
 * React and UI imports so it stays plain, testable data — the mutation itself lives
 * in `use-entry-patch.ts`.
 */

/**
 * The cache key of one entry list. Every view of the feed — the three filter chips
 * and each tag page — is its own paginated cursor sequence, so each gets its own
 * key; `["entries"]` stays the prefix that invalidates all of them at once.
 *
 * `filter` and `tag` occupy separate slots on purpose: `?tag=archived` is a real
 * tag someone could have, and it must not collide with the Archived chip.
 */
export function entriesKey(
  params: { filter?: EntryFilter; tag?: string } = {},
): readonly ["entries", EntryFilter, string | null] {
  return ["entries", params.filter ?? "all", params.tag ?? null] as const;
}

export const TAGS_KEY = ["tags"] as const;

export interface EntryPatchVars {
  id: string;
  patch: UpdateEntryInput;
  /** Toast copy. The same PATCH means different things to a user — "Favorited",
   * "Archived", "Note saved" — and only the caller knows which gesture it was. */
  success: string;
  failure: string;
}

/** The copy for a star click, so the card and the detail page agree. */
export function favoriteVars(id: string, next: boolean): EntryPatchVars {
  return {
    id,
    patch: { favorite: next },
    success: next ? "Added to favorites" : "Removed from favorites",
    failure: next
      ? "Could not favorite that entry"
      : "Could not unfavorite that entry",
  };
}

export function archiveVars(id: string, next: boolean): EntryPatchVars {
  return {
    id,
    patch: { archived: next },
    success: next ? "Archived" : "Restored to your feed",
    failure: next
      ? "Could not archive that entry"
      : "Could not restore that entry",
  };
}
