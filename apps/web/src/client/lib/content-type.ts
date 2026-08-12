import type { ContentType } from "../api";

/**
 * The copy for the content-type badge (P25). Free of React and UI imports so it
 * stays plain, testable data — the card and the detail page both render it, and
 * this is what keeps them saying the same thing.
 */
export interface ContentTypeBadge {
  /** The visible word. Short on purpose: it sits next to a title. */
  label: string;
  /** The `title` attribute — where the experimental caveat lives. */
  hint: string;
}

/**
 * Null for `article`, which is the overwhelming majority and the thing a badge
 * would only add noise to: the badge exists to mark the two kinds that are *not*
 * a web page. "Absent" is therefore meaningful, not a fallback.
 */
export function contentTypeBadge(
  contentType: ContentType,
): ContentTypeBadge | null {
  switch (contentType) {
    case "pdf":
      return {
        label: "PDF",
        hint: "This entry was summarized from a PDF.",
      };
    case "video":
      return {
        // WHY the caveat is in the hint and not the label: transcript capture is a
        // scrape of YouTube's watch page with no supported API behind it, so it will
        // break, and the person looking at a thin summary deserves to know why
        // without the word "experimental" shouting from every card.
        label: "Video",
        hint: "Summarized from the video's captions. Transcript capture is experimental and can break when YouTube changes.",
      };
    case "article":
      return null;
  }
}
