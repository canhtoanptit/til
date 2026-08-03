import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export { entries, settings, digests, digestItems } from "./schema.js";
export type {
  Entry,
  NewEntry,
  Settings,
  NewSettings,
  DigestRun,
  NewDigestRun,
  DigestItem,
  NewDigestItem,
} from "./schema.js";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
