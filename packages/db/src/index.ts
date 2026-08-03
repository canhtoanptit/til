import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export { entries, settings } from "./schema.js";
export type { Entry, NewEntry, Settings, NewSettings } from "./schema.js";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
