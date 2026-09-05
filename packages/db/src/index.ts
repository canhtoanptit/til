import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export {
  chats,
  entries,
  feedback,
  feeds,
  settings,
  digests,
  digestItems,
  entryVectors,
  reviews,
  users,
  sessions,
  OWNER_USER_ID,
} from "./schema.js";
export type {
  Chat,
  NewChat,
  Entry,
  Feed,
  NewFeed,
  Feedback,
  NewFeedback,
  NewEntry,
  Settings,
  NewSettings,
  DigestRun,
  NewDigestRun,
  DigestItem,
  NewDigestItem,
  EntryVector,
  NewEntryVector,
  Review,
  NewReview,
  User,
  NewUser,
  Session,
  NewSession,
} from "./schema.js";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
