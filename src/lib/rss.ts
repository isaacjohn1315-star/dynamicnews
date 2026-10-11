import { XMLParser } from "fast-xml-parser";
import { getDb, type SqlClient, type RssFeedRow } from "./db";
import { buildArticleDedupeKey, clean } from "./dedupe";
import { FEED_CATALOGUE } from "./feeds";
import {
  claimFeedBatch,
  DomainLimiter,
  domainOf,
  finishBatch,
  globalConcurrency,
  interleaveByDomain,
  isSafeFeedUrl,
  MAX_FEED_BYTES,
  recordFeedOutcome,
  releaseClaims,
  type ClaimedFeed,
} from "./feed-registry";
import { imageCandidatesFromFeedItem, type ImageCandidate } from "./image";
import { cleanText } from "./text";

/**
 * RSS/Atom football-news discovery (server-only).
 *
 * Feeds are the ONLY discovery source: they are fetched directly from
 * publishers, with no third-party API budget or request ceiling.
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
const FETCH_TIMEOUT_MS = 5_000;
const MAX_ITEMS_PER_FEED = 40;

/**
 * Feeds polled per run. This is sized against the freshness window: with
 * 624 feeds, a 10-minute cron cadence gives 6 runs per hour, so ~104 feeds
 * per run is needed to cycle the entire catalogue inside 60 minutes. The
 * previous value of 14 produced a ~7.5-hour cycle, which meant almost no
 * article could still be inside the freshness window when its feed was
 * polled. Rotation stays least-recently-fetched-first, and the run deadline
 * still cuts fetching short if feeds respond slowly.
 */

export interface RssArticle {
  feedName: string;
  title: string;
  link: string | null;
  description: string | null;
  publishedAt: Date | null;
  guid: string | null;
  dedupeKey: string;
  /** Image URLs advertised by the feed itself, in priority order. */
  imageCandidates: ImageCandidate[];
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
 * Idempotently registers the curated catalogue. Runs a cheap count first, so
 * a normal run costs one count and no writes. New feeds enter as "untested"
 * and are only marked healthy once a real fetch succeeds.
 */
async function ensureFeedRows(sql: SqlClient): Promise<void> {
  const countRows = (await sql`SELECT count(*)::int AS n FROM rss_feeds`) as { n: number }[];
  const registered = countRows[0]?.n ?? 0;
  if (registered >= FEED_CATALOGUE.length) return;

  const names = FEED_CATALOGUE.map((f) => f.name);
  const topics = FEED_CATALOGUE.map((f) => f.topic);
  const urls = FEED_CATALOGUE.map((f) => f.url);

  await sql`
    INSERT INTO rss_feeds (name, topic, url, normalized_url, domain, category, next_check_at, last_status)
    SELECT u.name, u.topic, u.url, lower(u.url),
           lower(split_part(split_part(regexp_replace(u.url, '^https?://', ''), '/', 1), ':', 1)),
           u.topic, now(), 'untested'
    FROM UNNEST(${names}::text[], ${topics}::text[], ${urls}::text[]) AS u(name, topic, url)
    ON CONFLICT (url) DO UPDATE
      SET name = EXCLUDED.name,
          topic = EXCLUDED.topic,
          updated_at = now()
  `;
}

/**
 * Claims and processes one bounded batch of DUE feeds.
 *
 * Work is claimed atomically from the registry, so overlapping cron runs
 * never process the same feed. Requests run under a global concurrency cap
 * and a per-domain limiter, and the whole batch is bounded by `deadline`
 * so the run always returns before cron-job.org's 30-second abort.
 */
export async function fetchRssFeeds(deadline?: number, batchSize?: number): Promise<RssDiscoveryResult> {
  const sql = getDb();
  await ensureFeedRows(sql);

  const { batchId, workerId, feeds } = await claimFeedBatch(batchSize);
  const ordered = interleaveByDomain(feeds);

  const outcomes: FeedOutcome[] = [];
  const limiter = new DomainLimiter();
  const fetchTimes: number[] = [];
  let cursor = 0;
  let rateLimited = 0;

  // Fixed-size worker pool: never an unbounded Promise.all over 50k feeds.
  const workerCount = Math.min(globalConcurrency(), ordered.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) return;
      const index = cursor;
      cursor += 1;
      if (index >= ordered.length) return;

      const feed = ordered[index];
      const domain = feed.domain ?? domainOf(feed.url) ?? "unknown";
      await limiter.acquire(domain);
      try {
        const started = Date.now();
        const outcome = await fetchOneFeed(feed);
        const elapsed = Date.now() - started;
        fetchTimes.push(elapsed);
        if (outcome.status === "rate_limited") rateLimited += 1;
        outcomes.push(outcome.result);
        await recordFeedOutcome({
          feedId: feed.id,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          error: outcome.result.error,
          etag: outcome.etag,
          lastModified: outcome.lastModified,
          itemsSeen: outcome.result.fetched,
          usefulItems: 0,
          latestItemAt: outcome.latestItemAt,
          fetchMs: elapsed,
          priority: feed.priority ?? 2,
          consecutiveFailures: feed.consecutive_failures ?? 0,
          pollIntervalMinutes: feed.poll_interval_minutes ?? 60,
        });
      } finally {
        limiter.release(domain);
      }
    }
  });

  await Promise.all(workers);
  await releaseClaims(workerId);

  const all: RssArticle[] = [];
  let fetched = 0;
  let feedsOk = 0;
  let failed = 0;
  let notModified = 0;
  for (const outcome of outcomes) {
    all.push(...outcome.articles);
    fetched += outcome.fetched;
    if (outcome.status === "ok") feedsOk += 1;
    else if (outcome.status === "not_modified") { feedsOk += 1; notModified += 1; }
    else failed += 1;
  }

  await finishBatch(batchId, {
    processed: outcomes.length,
    ok: feedsOk,
    failed,
    notModified,
    articles: all.length,
    avgFetchMs: fetchTimes.length
      ? Math.round(fetchTimes.reduce((a, b) => a + b, 0) / fetchTimes.length)
      : null,
    rateLimited,
    status: outcomes.length < feeds.length ? "partial" : "complete",
  });

  return { outcomes, feedsChecked: outcomes.length, feedsOk, fetched, articles: all };
}

interface FetchOutcome {
  result: FeedOutcome;
  status: "ok" | "not_modified" | "error" | "rate_limited" | "blocked";
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  latestItemAt: Date | null;
}

async function fetchOneFeed(feed: ClaimedFeed): Promise<FetchOutcome> {
  const base: FeedOutcome = { feedName: feed.name, status: "error", fetched: 0, articles: [], error: null };
  const fail = (
    status: FetchOutcome["status"],
    error: string,
    httpStatus: number | null = null,
  ): FetchOutcome => ({
    result: { ...base, status: status === "rate_limited" ? "error" : "error", error },
    status,
    httpStatus,
    etag: null,
    lastModified: null,
    latestItemAt: null,
  });

  // SSRF guard on the registered URL.
  const safety = isSafeFeedUrl(feed.url);
  if (!safety.safe) {
    return fail("blocked", `blocked unsafe URL: ${safety.reason}`);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    "Accept-Language": "en-GB,en;q=0.9",
  };
  if (feed.etag) headers["If-None-Match"] = feed.etag;
  if (feed.last_modified) headers["If-Modified-Since"] = feed.last_modified;

  let response: Response;
  try {
    // Redirects are followed manually so every hop is SSRF-checked.
    let url = feed.url;
    let current: Response | null = null;
    for (let hop = 0; hop < 4; hop += 1) {
      const hopSafety = isSafeFeedUrl(url);
      if (!hopSafety.safe) return fail("blocked", `unsafe redirect target: ${hopSafety.reason}`);
      current = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (current.status >= 300 && current.status < 400) {
        const location = current.headers.get("location");
        if (!location) break;
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }
    if (!current) return fail("error", "no response");
    response = current;
  } catch (caught) {
    return fail("error", `request failed: ${messageOf(caught)}`);
  }

  if (response.status === 304) {
    return {
      result: { ...base, status: "not_modified" },
      status: "not_modified",
      httpStatus: 304,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      latestItemAt: null,
    };
  }
  if (response.status === 429 || response.status === 503) {
    return fail("rate_limited", `HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    return fail("error", `HTTP ${response.status}`, response.status);
  }

  // Bound memory: reject oversized bodies before parsing.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_FEED_BYTES) {
    return fail("error", `feed too large (${declared} bytes)`, response.status);
  }
  const body = await response.text();
  if (body.length > MAX_FEED_BYTES) {
    return fail("error", `feed too large (${body.length} bytes)`, response.status);
  }
  if (!/^\s*(<\?xml|<rss|<feed)/i.test(body.slice(0, 500))) {
    return fail("error", "response was not an RSS/Atom feed", response.status);
  }

  let articles: RssArticle[];
  try {
    articles = parseFeed(body, feed.name);
  } catch (caught) {
    return fail("error", `parse failed: ${messageOf(caught)}`, response.status);
  }

  const latest = articles.reduce<Date | null>((acc, item) => {
    if (!item.publishedAt) return acc;
    return acc === null || item.publishedAt > acc ? item.publishedAt : acc;
  }, null);

  return {
    result: {
      ...base,
      status: "ok",
      fetched: articles.length,
      articles: articles.slice(0, MAX_ITEMS_PER_FEED),
    },
    status: "ok",
    httpStatus: response.status,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    latestItemAt: latest,
  };
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
        imageCandidates: imageCandidatesFromFeedItem(record, feedName),
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
        imageCandidates: imageCandidatesFromFeedItem(record, feedName),
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
    imageCandidates: ImageCandidate[];
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
    // Store the full summary. Truncating here produced posts that ended
    // mid-name ("...and Juan"); sentence-level trimming happens in the
    // composer, which can drop an incomplete sentence instead of keeping it.
    description: description.length > 0 ? description.slice(0, 4000) : null,
    publishedAt: item.publishedAt,
    guid: clean(item.guid),
    dedupeKey,
    imageCandidates: item.imageCandidates ?? [],
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
