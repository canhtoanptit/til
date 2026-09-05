import { entries, settings as settingsTable } from "@til/db";
import {
  detectContentTypeFromUrl,
  ExtractionError,
  youtubeVideoId,
} from "@til/core";
import type { ContentType } from "@til/core";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import { indexEntry } from "./indexing.js";
import { toLLMSettings } from "./settings.js";
import { fetchYoutubeTranscript } from "./youtube.js";

/** The one sentence a PDF saved on the local stack fails with. */
export const PDF_NEEDS_CLOUD =
  "PDF ingestion requires the cloud stack — deploy or switch TIL_STACK.";

interface SourceText {
  markdown: string;
  title?: string;
  /** The URL the content was really read from — a redirect may have moved it. */
  finalUrl: string;
}

/**
 * The one thing both the success and the failure path need to know: what kind of
 * thing this turned out to be.
 *
 * A mutable holder rather than a return value because it is settled *before* the
 * work that can fail. A PDF discovered by its response header and then failing to
 * convert must still be stored as a PDF — otherwise the feed shows "article" next
 * to an error message about PDFs, and the owner cannot tell what happened.
 */
interface ContentTypeSlot {
  contentType: ContentType;
}

/**
 * Turns the entry's URL into text to digest, by whichever of the three routes the
 * URL and the response call for (P25).
 *
 * All three converge on a markdown string that goes into the *same* `llm.digest`
 * call as an article always did — which is what puts a transcript and a PDF behind
 * the same prompt-injection framing as page text: `DIGEST_SYSTEM_PROMPT` declares
 * everything inside `<article>` untrusted data, and the extraction path has no
 * tools for injected text to reach. Adding a second digest entry point per content
 * type is exactly how that property would get lost, so there is only one.
 */
async function readSource(
  deps: Deps,
  url: string,
  slot: ContentTypeSlot,
): Promise<SourceText> {
  const guess = slot.contentType;

  if (guess === "video") {
    const videoId = youtubeVideoId(url);
    // Unreachable — `guess === "video"` is defined as `youtubeVideoId() !== null` —
    // but the types do not know that and a throw is cheaper than a non-null assert.
    if (videoId === null)
      throw new ExtractionError(`Not a YouTube video: ${url}`);
    const transcript = await fetchYoutubeTranscript(videoId, deps.fetchImpl);
    console.log(
      `[ingest] youtube transcript ${videoId}: ${transcript.text.length} chars, track=${transcript.track.languageCode}${transcript.track.kind === "asr" ? " (auto)" : ""}`,
    );
    return {
      markdown: transcript.text,
      ...(transcript.title === undefined ? {} : { title: transcript.title }),
      finalUrl: url,
    };
  }

  const page = await deps.fetchPage(url, deps.fetchImpl);
  // The refinement, recorded before anything else can fail. An older `FetchPageFn`
  // stub says nothing about content type, which reads as "article" — the only thing
  // fetchPage could return before this existed.
  slot.contentType = page.contentType ?? "article";

  if (slot.contentType === "pdf") {
    const convert = deps.extractor.documentToMarkdown;
    // The capability, not the mode name, is the honest test: `cloud` mode without
    // the AI binding also lands on ReadabilityExtractor, and "deploy" is the right
    // advice there too.
    if (typeof convert !== "function") {
      throw new ExtractionError(PDF_NEEDS_CLOUD);
    }
    const { markdown, title } = await convert.call(
      deps.extractor,
      page.bytes ?? new Uint8Array(0),
      page.finalUrl,
      "application/pdf",
    );
    return {
      markdown,
      ...(title === undefined ? {} : { title }),
      finalUrl: page.finalUrl,
    };
  }

  const { markdown, title } = await deps.extractor.toMarkdown(
    page.html,
    page.finalUrl,
  );
  return {
    markdown,
    ...(title === undefined ? {} : { title }),
    finalUrl: page.finalUrl,
  };
}

export async function ingestEntry(deps: Deps, entryId: string): Promise<void> {
  const beforeRows = await deps.db
    .select()
    .from(entries)
    .where(eq(entries.id, entryId));
  const entry = beforeRows[0];
  if (!entry) return;

  // Starts as the URL-phase guess POST /api/entries already stored, and is settled
  // by `readSource` before any conversion runs — so both outcomes below write the
  // kind of thing this actually was.
  const slot: ContentTypeSlot = {
    contentType: detectContentTypeFromUrl(entry.url),
  };

  try {
    const source = await readSource(deps, entry.url, slot);

    // The entry's own owner decides which BYOK row pays for this ingest — the
    // job is fire-and-forget, so there is no request user to read it from.
    const settingsRows = await deps.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, entry.userId))
      .limit(1);
    const settingsRow = settingsRows[0];
    if (!settingsRow) {
      throw new Error("settings not configured");
    }

    const llm = deps.llmFactory(toLLMSettings(settingsRow));
    const digest = await llm.digest(source.markdown, {
      url: source.finalUrl,
      ...(source.title === undefined ? {} : { title: source.title }),
    });

    const now = deps.now();
    await deps.db
      .update(entries)
      .set({
        title: digest.title,
        contentMarkdown: source.markdown,
        summary: digest.summary,
        takeaway: digest.takeaway,
        question: digest.question,
        tags: JSON.stringify(digest.tags),
        // The refined answer replaces the URL-phase guess POST /api/entries stored.
        contentType: slot.contentType,
        status: "ready",
        error: null,
        updatedAt: now,
      })
      .where(eq(entries.id, entryId));

    // WHY: indexing is deliberately after the `ready` write and never throws —
    // an unindexed entry is a search gap, not a failed capture (ADR-0010).
    await indexEntry(deps, {
      id: entryId,
      userId: entry.userId,
      title: digest.title,
      summary: digest.summary,
      takeaway: digest.takeaway,
      tags: digest.tags,
      sourceDomain: entry.sourceDomain ?? null,
      createdAt: entry.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest ${entryId}] failed:`, message);
    await deps.db
      .update(entries)
      .set({
        status: "failed",
        error: message,
        // Written on failure too: a PDF the fetch discovered and could not convert
        // has to stay a PDF, or the feed contradicts its own error message.
        contentType: slot.contentType,
        updatedAt: deps.now(),
      })
      .where(eq(entries.id, entryId));
  }
}
