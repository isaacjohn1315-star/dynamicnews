import { XMLParser } from "fast-xml-parser";
import { getDb, type SqlClient, type RssFeedRow } from "./db";
import { buildArticleDedupeKey, clean } from "./dedupe";

/**
 * RSS/Atom football-news discovery (server-only).
 *
 * Feeds complement NewsData.io: they are fetched directly from the
 * publishers at zero NewsData credit cost, which keeps discovery fresh even
 * after the daily NewsData budget is exhausted.
 *
 * Every configured feed below was validated live (HTTP 200 + RSS payload
 * with real items) before being added. Feeds are fetched with:
 *  - a polite, identifiable User-Agent,
 *  - conservative timeouts,
 *  - conditional GETs (ETag / Last-Modified) so unchanged feeds are not
 *    re-downloaded or re-parsed,
 *  - automatic hourly backoff for feeds that repeatedly fail,
 *  - per-feed health recorded in Neon (status, errors, item counts).
 *
 * No scraping: only documented, publicly exposed feed endpoints are read.
 */

export interface RssFeedConfig {
  name: string;
  url: string;
}

export const RSS_FEEDS: RssFeedConfig[] = [
  { name: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/football/rss.xml" },
  { name: "Sky Sports", url: "https://www.skysports.com/rss/12040" },
  { name: "The Guardian", url: "https://www.theguardian.com/football/rss" },
  { name: "talkSPORT", url: "https://talksport.com/football/feed/" },
  { name: "Metro", url: "https://metro.co.uk/sport/football/feed/" },
  { name: "Daily Mirror", url: "https://www.mirror.co.uk/sport/football/rss.xml" },
  { name: "CaughtOffside", url: "https://www.caughtoffside.com/feed/" },
];

const USER_AGENT = "DynaSport/1.0 (+football news monitoring; contact via DynaSport Facebook page)";
const FETCH_TIMEOUT_MS = 7_000;
const MAX_ITEMS_PER_FEED = 30;
/**
 * cron-job.org aborts a request after 30 seconds, so each run only polls a
 * rotating subset of feeds (least-recently-fetched first). Across
 * consecutive 8-minute runs every feed is still checked many times per
 * hour, while any single run stays comfortably inside the timeout.
 */
const MAX_FEEDS_PER_RUN = 4;
const FAILURE_BACKOFF_THRESHOLD = 3;
const FAILURE_BACKOFF_MINUTES = 60;

export interface RssArticle {
  feedName: string;
  title: string;
  link: string | null;
  description: string | null;
  publishedAt: Date | null;
  guid: string | null;
  dedupeKey: string;
}

export interface FeedOutcome {
  feedName: string;
  status: "ok" | "not_modified" | "error" | "skipped_backoff";
  fetched: number;
  articles: RssArticle[];
  error: string | null;
}

export interface RssDiscoveryResult {
  outcomes: FeedOutcome[];
  feedsChecked: number;
  feedsOk: number;
  fetched: number;
  articles: RssArticle[];
}

/**
 * Fetches a rotating subset of enabled feeds (respecting backoff) and
 * returns the discovered articles. `deadline` is an absolute epoch
 * timestamp after which no new feed requests are started.
 */
export async function fetchRssFeeds(deadline?: number): Promise<RssDiscoveryResult> {
  const sql = getDb();
  await ensureFeedRows(sql);

  const feeds = (await sql`
    SELECT id, name, url, enabled, etag, last_modified, last_fetched_at,
           consecutive_failures
    FROM rss_feeds
    WHERE enabled = true
    ORDER BY last_fetched_at ASC NULLS FIRST, name ASC
    LIMIT ${MAX_FEEDS_PER_RUN}
  `) as Pick<
    RssFeedRow,
    "id" | "name" | "url" | "enabled" | "etag" | "last_modified" | "last_fetched_at" | "consecutive_failures"
  >[];

  const outcomes = await Promise.all(
    feeds.map((feed) =>
      deadline !== undefined && Date.now() >= deadline
        ? Promise.resolve<FeedOutcome>({
            feedName: feed.name,
            status: "skipped_backoff",
            fetched: 0,
            articles: [],
            error: null,
          })
        : fetchOneFeed(sql, feed),
    ),
  );

  const all: RssArticle[] = [];
  let fetched = 0;
  let feedsOk = 0;
  for (const outcome of outcomes) {
    all.push(...outcome.articles);
    fetched += outcome.fetched;
    if (outcome.status === "ok" || outcome.status === "not_modified") feedsOk += 1;
  }

  return {
    outcomes,
    feedsChecked: feeds.length,
    feedsOk,
    fetched,
    articles: all,
  };
}

/** Idempotently registers the validated feed list (config-as-data). */
async function ensureFeedRows(sql: SqlClient): Promise<void> {
  for (const feed of RSS_FEEDS) {
    await sql`
      INSERT INTO rss_feeds (name, url)
      VALUES (${feed.name}, ${feed.url})
      ON CONFLICT (url) DO UPDATE
        SET name = EXCLUDED.name, updated_at = now()
    `;
  }
}

async function fetchOneFeed(
  sql: SqlClient,
  feed: Pick<
    RssFeedRow,
    "id" | "name" | "url" | "etag" | "last_modified" | "last_fetched_at" | "consecutive_failures"
  >,
): Promise<FeedOutcome> {
  const base: FeedOutcome = {
    feedName: feed.name,
    status: "error",
    fetched: 0,
    articles: [],
    error: null,
  };

  // Polite backoff: repeatedly failing feeds are retried at most hourly.
  if (
    feed.consecutive_failures >= FAILURE_BACKOFF_THRESHOLD &&
    feed.last_fetched_at &&
    Date.now() - new Date(feed.last_fetched_at).getTime() < FAILURE_BACKOFF_MINUTES * 60_000
  ) {
    return { ...base, status: "skipped_backoff" };
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  };
  if (feed.etag) headers["If-None-Match"] = feed.etag;
  if (feed.last_modified) headers["If-Modified-Since"] = feed.last_modified;

  let response: Response;
  try {
    response = await fetch(feed.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    await recordFeedHealth(sql, feed.id, "error", `request failed: ${messageOf(error)}`, null, null, 0);
    return { ...base, error: `request failed: ${messageOf(error)}` };
  }

  if (response.status === 304) {
    await recordFeedHealth(sql, feed.id, "not_modified", null, null, null, 0);
    return { ...base, status: "not_modified" };
  }

  if (!response.ok) {
    await recordFeedHealth(sql, feed.id, "error", `HTTP ${response.status}`, null, null, 0);
    return { ...base, error: `HTTP ${response.status}` };
  }

  const body = await response.text();
  if (!/^\s*<\?xml|^\s*<rss|^\s*<feed/i.test(body)) {
    await recordFeedHealth(sql, feed.id, "error", "response was not an RSS/Atom feed", null, null, 0);
    return { ...base, error: "response was not an RSS/Atom feed" };
  }

  let articles: RssArticle[];
  try {
    articles = parseFeed(body, feed.name);
  } catch (error) {
    await recordFeedHealth(sql, feed.id, "error", `parse failed: ${messageOf(error)}`, null, null, 0);
    return { ...base, error: `parse failed: ${messageOf(error)}` };
  }

  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  await recordFeedHealth(sql, feed.id, "ok", null, etag, lastModified, articles.length);

  return {
    ...base,
    status: "ok",
    fetched: articles.length,
    articles: articles.slice(0, MAX_ITEMS_PER_FEED),
  };
}

async function recordFeedHealth(
  sql: SqlClient,
  id: string,
  status: string,
  error: string | null,
  etag: string | null,
  lastModified: string | null,
  itemsSeen: number,
): Promise<void> {
  try {
    await sql`
      UPDATE rss_feeds
      SET last_fetched_at = now(),
          last_status = ${status},
          last_error = ${error},
          etag = COALESCE(${etag}, etag),
          last_modified = COALESCE(${lastModified}, last_modified),
          items_seen = ${itemsSeen},
          consecutive_failures = CASE WHEN ${status} = 'error'
            THEN consecutive_failures + 1 ELSE 0 END,
          updated_at = now()
      WHERE id = ${id}
    `;
  } catch {
    // Feed health bookkeeping must never break discovery.
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function parseFeed(xml: string, feedName: string): RssArticle[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const items: RssArticle[] = [];

  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  if (rss && typeof rss === "object" && rss.channel) {
    for (const item of arrayOf(rss.channel.item)) {
      const record = item as Record<string, unknown>;
      const title = textOf(record.title);
      const link = textOf(record.link);
      const publishedRaw = textOf(record.pubDate) ?? textOf(record.date);
      const guid = textOf(record.guid) ?? textOf(record.id);
      const description = stripHtml(textOf(record.description) ?? textOf(record.summary));
      pushItem(items, {
        feedName,
        title,
        link,
        description,
        publishedAt: parseDate(publishedRaw),
        guid,
      });
    }
    return items;
  }

  const atom = doc.feed as { entry?: unknown } | undefined;
  if (atom && typeof atom === "object") {
    for (const entry of arrayOf(atom.entry)) {
      const record = entry as Record<string, unknown>;
      const title = textOf(record.title);
      const link = atomLinkOf(record.link);
      const publishedRaw = textOf(record.published) ?? textOf(record.updated);
      const guid = textOf(record.id);
      const description = stripHtml(textOf(record.summary) ?? textOf(record.content));
      pushItem(items, {
        feedName,
        title,
        link,
        description,
        publishedAt: parseDate(publishedRaw),
        guid,
      });
    }
    return items;
  }

  return items;
}

function pushItem(
  target: RssArticle[],
  item: {
    feedName: string;
    title: string | null;
    link: string | null;
    description: string | null;
    publishedAt: Date | null;
    guid: string | null;
  },
): void {
  const title = clean(item.title);
  if (!title || title.length < 20) return;
  const dedupeKey = buildArticleDedupeKey({
    provider: "rss",
    providerArticleId: item.guid && item.guid.length <= 200 && !item.guid.includes("://") ? item.guid : null,
    url: item.link,
    title,
    source: item.feedName,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
  });
  if (!dedupeKey) return;
  target.push({
    feedName: item.feedName,
    title,
    link: clean(item.link),
    description: item.description,
    publishedAt: item.publishedAt,
    guid: clean(item.guid),
    dedupeKey,
  });
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    return clean(String(value));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["#text"] === "string") return clean(record["#text"]);
    if (typeof record["text"] === "string") return clean(record.text);
  }
  return null;
}

function atomLinkOf(value: unknown): string | null {
  for (const link of arrayOf(value)) {
    if (typeof link === "string") return clean(link);
    if (typeof link === "object" && link !== null) {
      const record = link as Record<string, unknown>;
      const rel = typeof record["@_rel"] === "string" ? record["@_rel"] : "alternate";
      if (rel === "alternate" && typeof record["@_href"] === "string") {
        return clean(record["@_href"]);
      }
    }
  }
  return null;
}

/** RFC-822 named timezones some publishers still emit (V8 only parses numeric offsets). */
const TZ_OFFSETS: Record<string, string> = {
  UT: "+0000", UTC: "+0000", GMT: "+0000", BST: "+0100",
  EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500",
  MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700",
  CET: "+0100", CEST: "+0200", EET: "+0200", EEST: "+0300",
};

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  let normalized = value.trim();
  const tzMatch = normalized.match(/\b([A-Z]{2,4})$/);
  if (tzMatch && TZ_OFFSETS[tzMatch[1]]) {
    normalized = `${normalized.slice(0, tzMatch.index)}${TZ_OFFSETS[tzMatch[1]]}`;
  }
  let parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    // Some feeds use "YYYY-MM-DD HH:MM:SS" (treat as UTC).
    parsed = new Date(normalized.includes("T") ? normalized : `${normalized.replace(" ", "T")}Z`);
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripHtml(value: string | null): string | null {
  if (!value) return null;
  const stripped = value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped.slice(0, 500) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
