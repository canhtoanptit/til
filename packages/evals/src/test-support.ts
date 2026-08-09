import { normalizeVector } from "@til/core";
import { EMBEDDING_DIMENSIONS } from "@til/core";

/**
 * Deterministic stand-in for bge-m3, same trick as the app's test harness: each
 * text is projected onto keyword "topic" axes, so related texts land close
 * together with no model and no network. Unit length, like every real Embedder.
 *
 * Only the unit tests use this; the real suite runs against Workers AI, because
 * a keyword-shaped stub cannot answer whether the semantic leg earns its keep.
 */
export function stubEmbed(
  topics: string[][],
  opts: { dimensions?: number; onEmbed?: (texts: string[]) => void } = {},
): (texts: string[]) => Promise<number[][]> {
  const dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
  return async (texts: string[]) => {
    opts.onEmbed?.(texts);
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const raw = new Array<number>(dimensions).fill(0);
      topics.forEach((words, axis) => {
        if (axis >= dimensions) return;
        let hits = 0;
        for (const word of words) {
          if (lower.includes(word)) hits += 1;
        }
        raw[axis] = hits;
      });
      let total = 0;
      for (const value of raw) total += value;
      if (total === 0) raw[dimensions - 1] = 1;
      return normalizeVector(raw);
    });
  };
}
