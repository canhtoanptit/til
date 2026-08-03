/**
 * FTS5 query sanitizer: strips operators (AND/OR/NOT/NEAR/quotes/parens/colons/*),
 * then wraps each remaining term as a quoted phrase joined by OR. This is safe
 * for user-provided text; the caller runs `MATCH ?` with the result.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/["'`]/g, " ")
    .replace(/[():*^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;

  const RESERVED = new Set(["and", "or", "not", "near"]);
  const parts = cleaned.split(" ").filter((p) => {
    if (p.length === 0) return false;
    if (RESERVED.has(p.toLowerCase())) return false;
    return /[A-Za-z0-9À-￿]/.test(p);
  });
  if (parts.length === 0) return null;

  return parts
    .map((p) => `"${p.replace(/"/g, "")}"`)
    .join(" OR ");
}
