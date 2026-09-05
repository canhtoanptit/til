import type { Db } from "@til/db";
import { OWNER_USER_ID, users } from "@til/db";
import { eq } from "drizzle-orm";
import type { SessionUser } from "./deps.js";
import type { GoogleIdentity } from "./google-oauth.js";

/**
 * Maps a verified Google identity onto a `users` row.
 *
 * The `google_sub` is the join key, never the email: Google addresses can be
 * changed and reassigned, subjects cannot, so a rename refreshes the row rather
 * than forking it.
 */
export async function upsertGoogleUser(
  db: Db,
  now: number,
  identity: GoogleIdentity,
  ownerEmail: string | undefined,
): Promise<SessionUser> {
  const bySub = await db
    .select()
    .from(users)
    .where(eq(users.googleSub, identity.sub))
    .limit(1);
  const existing = bySub[0];
  if (existing) {
    await db
      .update(users)
      .set({
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
    };
  }

  // Owner claim (migration 0012). Every pre-multi-user row was backfilled to
  // the placeholder `owner` tenant; the first sign-in whose verified email
  // matches OWNER_EMAIL adopts that row and inherits all of it. Guarded by
  // `google_sub IS NULL` so it can happen exactly once — after that the
  // by-sub branch above is the only way back in.
  const claimant = ownerEmail?.trim().toLowerCase();
  if (claimant !== undefined && claimant.length > 0) {
    if (identity.email.trim().toLowerCase() === claimant) {
      const ownerRows = await db
        .select()
        .from(users)
        .where(eq(users.id, OWNER_USER_ID))
        .limit(1);
      const owner = ownerRows[0];
      if (owner && owner.googleSub === null) {
        await db
          .update(users)
          .set({
            googleSub: identity.sub,
            email: identity.email,
            name: identity.name,
            picture: identity.picture,
            updatedAt: now,
          })
          .where(eq(users.id, OWNER_USER_ID));
        return {
          id: OWNER_USER_ID,
          email: identity.email,
          name: identity.name,
          picture: identity.picture,
        };
      }
    }
  }

  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    googleSub: identity.sub,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
  };
}

/**
 * The local dev-login identity. Routed through the very same upsert as a real
 * Google sign-in, so `TIL_STACK=local` exercises the production code path — and
 * a dev-login with OWNER_EMAIL claims the owner row, which is exactly how a
 * developer gets at the seeded data.
 */
export function devIdentity(email: string): GoogleIdentity {
  return { sub: `dev:${email}`, email, name: null, picture: null };
}
