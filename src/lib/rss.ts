import { XMLParser } from "fast-xml-parser";
import { getDb, type SqlClient, type RssFeedRow } from "./db";
import { buildArticleDedupeKey, clean } from "./dedupe";
import { FEED_CATALOGUE } from "./feeds";
import { cleanText } from "./text";

/**
 * RSS/Atom football-news discovery (server-only).
 *
 * Feeds are the PRIMARY publishing source: they are fetched directly from
 * publishers at zero NewsData.io credit cost and deliver items far fresher
 * than the NewsData free plan (which can lag ~12 hours).
 *
 * Every feed in `FEED_CATALOGUE` was validated with a real HTTP request
 * before inclusion (HTTP 200, parseable RSS/Atom, >= 3 items, usable
 * timestamps). At runtime each feed is still re-verified on every fetch and
 * only marked healthy after a successful fetch AND parse; feeds that have
 * never been fetched in this deployment stay "untested" on the dashboard.
 *
 * Fetching is polite: identifiable User-Agent, bounded timeouts,
 * conditional GETs (ETag / Last-Modified), rotation so each run only polls
 * a slice of the catalogue, and exponential backoff for failing feeds.
 * Only public, documented feed endpoints are read — no scraping and no
 * bypassing of access controls.
 */

export interface RssFeedConfig {
  name: string;
  topic: string;
  url: string;
}

export { FEED_CATALOGUE };

const USER_AGENT = "DynaSport/1.0 (+football news monitoring; contact via DynaSport Facebook page)";
const FETCH_TIMEOUT_MS = 6_000;
const MAX_ITEMS_PER_FEED = 40;
const FAILURE_BACKOFF_THRESHOLD = 3;
const FAILURE_BACKOFF_MINUTES = 90;

/**
 * Feeds polled per run. cron-job.org aborts after 30s, so each run takes a
 * rotating slice (least-recently-fetched first) and the remaining feeds are
 * covered by subsequent runs. At 144 runs/day this still gives the whole
 * catalogue many passes per day.
 */
const MAX_FEEDS_PER_RUN = 14;
const FETCH_CONCURRENCY = 14;

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
 * Fetches a rotating slice of enabled feeds. `deadline` is an absolute
 * epoch timestamp after which no new feed requests are started.
 */
export async function fetchRssFeeds(deadline?: number): Promise<RssDiscoveryResult> {
  const sql = getDb();
  await ensureFeedRows(sql);

  const feeds = (await sql`
    SELECT id, name, url, enabled, etag, last_modified, last_fetched_at,
           consecutive_failures
    FROM rss_feeds
    WHERE enabled = true
    ORDER BY last_fetched_at ASC NULLS FIRST, id ASC
    LIMIT ${MAX_FEEDS_PER_RUN}
  `) as Pick<
    RssFeedRow,
    "id" | "name" | "url" | "enabled" | "etag" | "last_modified" | "last_fetched_at" | "consecutive_failures"
  >[];

  const outcomes: FeedOutcome[] = [];
  for (let i = 0; i < feeds.length; i += FETCH_CONCURRENCY) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const slice = feeds.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.all(slice.map((feed) => fetchOneFeed(sql, feed)));
    outcomes.push(...settled);
  }

  const all: RssArticle[] = [];
  let fetched = 0;
  let feedsOk = 0;
  for (const outcome of outcomes) {
    all.push(...outcome.articles);
    fetched += outcome.fetched;
    if (outcome.status === "ok" || outcome.status === "not_modified") feedsOk += 1;
  }

  return { outcomes, feedsChecked: outcomes.length, feedsOk, fetched, articles: all };
}

/**
 * Registers the validated catalogue in Neon. Runs a cheap count check
 * first, then a single bulk UNNEST upsert, so the 600+ row catalogue costs
 * one statement instead of hundreds. New feeds start as "untested".
 */
async function ensureFeedRows(sql: SqlClient): Promise<void> {
  const countRows = (await sql`SELECT count(*)::int AS n FROM rss_feeds`) as { n: number }[];
  if ((countRows[0]?.n ?? 0) === FEED_CATALOGUE.length) return;

  const names = FEED_CATALOGUE.map((f) => f.name);
  const topics = FEED_CATALOGUE.map((f) => f.topic);
  const urls = FEED_CATALOGUE.map((f) => f.url);

  await sql`
    INSERT INTO rss_feeds (name, topic, url)
    SELECT * FROM UNNEST(${names}::text[], ${topics}::text[], ${urls}::text[])
    ON CONFLICT (url) DO UPDATE
      SET name = EXCLUDED.name,
          topic = EXCLUDED.topic,
          updated_at = now()
  `;
}

async function fetchOneFeed(
  sql: SqlClient,
  feed: Pick<
    RssFeedRow,
    "id" | "name" | "url" | "etag" | "last_modified" | "last_fetched_at" | "consecutive_failures"
  >,
): Promise<FeedOutcome> {
  const base: FeedOutcome = { feedName: feed.name, status: "error", fetched: 0, articles: [], error: null };

  // Polite backoff for repeatedly failing feeds.
  if (
    feed.consecutive_failures >= FAILURE_BACKOFF_THRESHOLD &&
    feed.last_fetched_at &&
    Date.now() - new Date(feed.last_fetched_at).getTime() < FAILURE_BACKOFF_MINUTES * 60_000
  ) {
    return { ...base, status: "skipped_backoff" };
  }

  let response: Response | null = null;
  let error: string | null = null;

  // Attempt 1 uses conditional headers; a conditional-cache bug or an
  // edge-cached error is retried once without them before declaring failure.
  for (const conditional of [true, false]) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept:
        "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      "Accept-Language": "en-GB,en;q=0.9",
    };
    if (conditional && feed.etag) headers["If-None-Match"] = feed.etag;
    if (conditional && feed.last_modified) headers["If-Modified-Since"] = feed.last_modified;

    try {
      const attempt = await fetch(feed.url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (attempt.status === 304) {
        await recordFeedHealth(sql, feed.id, "not_modified", null, null, null, 0, null);
        return { ...base, status: "not_modified" };
      }
      if (attempt.ok) {
        response = attempt;
        error = null;
        break;
      }
      error = `HTTP ${attempt.status}`;
      // 4xx other than 429 will not improve on a retry without conditionals.
      if (attempt.status !== 429 && attempt.status < 500 && !conditional) break;
    } catch (caught) {
      error = `request failed: ${messageOf(caught)}`;
    }
    if (!conditional) break;
  }

  if (!response) {
    await recordFeedHealth(sql, feed.id, "error", error ?? "request failed", null, null, 0, null);
    return { ...base, error: error ?? "request failed" };
  }

  const body = await response.text();
  if (!/^\s*(<\?xml|<rss|<feed)/i.test(body.slice(0, 500))) {
    const message = "response was not an RSS/Atom feed";
    await recordFeedHealth(sql, feed.id, "error", message, null, null, 0, null);
    return { ...base, error: message };
  }

  let articles: RssArticle[];
  try {
    articles = parseFeed(body, feed.name);
  } catch (caught) {
    const message = `parse failed: ${messageOf(caught)}`;
    await recordFeedHealth(sql, feed.id, "error", message, null, null, 0, null);
    return { ...base, error: message };
  }

  const latest = articles.reduce<Date | null>((acc, item) => {
    if (!item.publishedAt) return acc;
    return acc === null || item.publishedAt > acc ? item.publishedAt : acc;
  }, null);

  await recordFeedHealth(
    sql,
    feed.id,
    "ok",
    null,
    response.headers.get("etag"),
    response.headers.get("last-modified"),
    articles.length,
    latest,
  );

  return { ...base, status: "ok", fetched: articles.length, articles: articles.slice(0, MAX_ITEMS_PER_FEED) };
}

async function recordFeedHealth(
  sql: SqlClient,
  id: string,
  status: string,
  error: string | null,
  etag: string | null,
  lastModified: string | null,
  itemsSeen: number,
  latestItemAt: Date | null,
): Promise<void> {
  try {
    await sql`
      UPDATE rss_feeds
      SET last_fetched_at = now(),
          last_success_at = CASE WHEN ${status} = 'ok' THEN now() ELSE last_success_at END,
          last_status = ${status},
          last_error = ${error},
          etag = COALESCE(${etag}, etag),
          last_modified = COALESCE(${lastModified}, last_modified),
          items_seen = CASE WHEN ${status} = 'ok' THEN ${itemsSeen} ELSE items_seen END,
          latest_item_at = COALESCE(${latestItemAt ? latestItemAt.toISOString() : null}::timestamptz, latest_item_at),
          consecutive_failures = CASE WHEN ${status} = 'error' THEN consecutive_failures + 1 ELSE 0 END,
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
      pushItem(items, {
        feedName,
        title: textOf(record.title),
        link: textOf(record.link),
        description: textOf(record.description) ?? textOf(record.summary) ?? textOf(record.encoded),
        publishedAt: parseDate(textOf(record.pubDate) ?? textOf(record.date) ?? textOf(record.published)),
        guid: textOf(record.guid) ?? textOf(record.id),
        sourceOverride: textOf(record.source),
      });
    }
    return items;
  }

  const atom = doc.feed as { entry?: unknown } | undefined;
  if (atom && typeof atom === "object") {
    for (const entry of arrayOf(atom.entry)) {
      const record = entry as Record<string, unknown>;
      pushItem(items, {
        feedName,
        title: textOf(record.title),
        link: atomLinkOf(record.link),
        description: textOf(record.summary) ?? textOf(record.content),
        publishedAt: parseDate(textOf(record.published) ?? textOf(record.updated)),
        guid: textOf(record.id),
        sourceOverride: null,
      });
    }
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
    sourceOverride: string | null;
  },
): void {
  // Clean BEFORE anything else: scoring, storage and posting all use this.
  const title = cleanText(item.title);
  if (!title || title.length < 20) return;

  const description = cleanText(item.description);
  const feedName = cleanText(item.sourceOverride) || item.feedName;

  const dedupeKey = buildArticleDedupeKey({
    provider: "rss",
    providerArticleId:
      item.guid && item.guid.length <= 200 && !item.guid.includes("://") ? item.guid : null,
    url: item.link,
    title,
    source: feedName,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
  });
  if (!dedupeKey) return;

  target.push({
    feedName,
    title,
    link: clean(item.link),
    description: description.length > 0 ? description.slice(0, 600) : null,
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
  if (typeof value === "string" || typeof value === "number") return clean(String(value));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["#text"] === "string") return clean(record["#text"]);
    if (typeof record.text === "string") return clean(record.text);
  }
  return null;
}

function atomLinkOf(value: unknown): string | null {
  for (const link of arrayOf(value)) {
    if (typeof link === "string") return clean(link);
    if (typeof link === "object" && link !== null) {
      const record = link as Record<string, unknown>;
      const rel = typeof record["@_rel"] === "string" ? record["@_rel"] : "alternate";
      if (rel === "alternate" && typeof record["@_href"] === "string") return clean(record["@_href"]);
    }
  }
  return null;
}

/** RFC-822 named timezones some publishers emit (V8 parses only offsets). */
const TZ_OFFSETS: Record<string, string> = {
  UT: "+0000", UTC: "+0000", GMT: "+0000", BST: "+0100", Z: "+0000",
  EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500",
  MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700",
  CET: "+0100", CEST: "+0200", EET: "+0200", EEST: "+0300",
};

export function parseDate(value: string | null): Date | null {
  if (!value) return null;
  let normalized = value.trim();
  const tzMatch = normalized.match(/\b([A-Z]{2,4})$/);
  if (tzMatch && TZ_OFFSETS[tzMatch[1]]) {
    normalized = `${normalized.slice(0, tzMatch.index)}${TZ_OFFSETS[tzMatch[1]]}`;
  }
  let parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    parsed = new Date(normalized.includes("T") ? normalized : `${normalized.replace(" ", "T")}Z`);
  }
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against absurd timestamps (bad feeds sometimes emit year 1970/2100).
  const year = parsed.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
  return parsed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
