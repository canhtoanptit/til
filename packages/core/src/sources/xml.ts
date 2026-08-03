import { XMLParser } from "fast-xml-parser";
import { SourceError } from "../errors.js";
import { collapseWhitespace, describeError } from "./http.js";

const ATTR_PREFIX = "@_";
const TEXT_KEY = "#text";

// parseTagValue/parseAttributeValue off: feed values are titles, URLs and dates —
// strnum coercion would turn "2024" style titles and version numbers into numbers.
// removeNSPrefix on: feeds routinely wrap fields in atom:/dc:/content: namespaces.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  textNodeName: TEXT_KEY,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  processEntities: true,
});

export function parseFeedXml(xml: string, source: string): unknown {
  if (collapseWhitespace(xml).length === 0) {
    throw new SourceError(source, `${source}: empty XML payload`);
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(xml) as unknown;
  } catch (err) {
    throw new SourceError(
      source,
      `${source}: XML payload could not be parsed: ${describeError(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new SourceError(source, `${source}: XML payload was not an element`);
  }
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function child(node: unknown, key: string): unknown {
  return isRecord(node) ? node[key] : undefined;
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function nodeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = collapseWhitespace(value);
    return text.length > 0 ? text : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = nodeText(entry);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (isRecord(value)) return nodeText(value[TEXT_KEY]);
  return undefined;
}

export function childText(node: unknown, key: string): string | undefined {
  return nodeText(child(node, key));
}

export function attrText(node: unknown, name: string): string | undefined {
  const value = child(node, `${ATTR_PREFIX}${name}`);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

export function firstChildText(
  node: unknown,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const text = childText(node, key);
    if (text !== undefined) return text;
  }
  return undefined;
}

// Atom entries carry several <link> elements (alternate HTML page, self, PDF,
// enclosures); the HTML alternate is the one a reader should land on.
export function atomLinkHref(node: unknown): string | undefined {
  const links = asArray(child(node, "link"));
  let fallback: string | undefined;
  for (const link of links) {
    const href = attrText(link, "href");
    if (href === undefined) continue;
    const rel = attrText(link, "rel");
    const type = attrText(link, "type");
    if (
      (rel === undefined || rel === "alternate") &&
      (type === undefined || type === "text/html")
    ) {
      return href;
    }
    fallback ??= href;
  }
  return fallback;
}
