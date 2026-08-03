import type { SourceAdapter } from "../types.js";
import { createArxivAdapter, type ArxivAdapterOptions } from "./arxiv.js";
import { createHNAdapter, type HNAdapterOptions } from "./hn.js";
import {
  createLobstersAdapter,
  type LobstersAdapterOptions,
} from "./lobsters.js";
import { createRssAdapter, type RssAdapterOptions } from "./rss.js";

export const DEFAULT_RSS_FEEDS: readonly string[] = [
  "https://blog.cloudflare.com/rss/",
  "https://jvns.ca/atom.xml",
  "https://simonwillison.net/atom/everything/",
];

export interface DefaultAdaptersOptions {
  hn?: HNAdapterOptions | false;
  lobsters?: LobstersAdapterOptions | false;
  arxiv?: ArxivAdapterOptions | false;
  rss?: Partial<RssAdapterOptions> | false;
}

export function defaultAdapters(
  opts: DefaultAdaptersOptions = {},
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  if (opts.hn !== false) adapters.push(createHNAdapter(opts.hn));
  if (opts.lobsters !== false) {
    adapters.push(createLobstersAdapter(opts.lobsters));
  }
  if (opts.arxiv !== false) adapters.push(createArxivAdapter(opts.arxiv));
  if (opts.rss !== false) {
    const rss = opts.rss ?? {};
    adapters.push(
      createRssAdapter({ ...rss, feeds: rss.feeds ?? DEFAULT_RSS_FEEDS }),
    );
  }
  return adapters;
}
