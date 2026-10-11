import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { getDb, type RssFeedRow } from "./db";

/**
 * DynaSport feed registry and scheduler — designed for up to 50,000 feeds.
 *
 * Nothing ever iterates the whole registry. Each automation run claims a
 * small, bounded batch of feeds that are actually DUE, processes them under
 * global and per-domain concurrency limits, then writes each feed's next
 * due time. Work is therefore durable: an interrupted run loses at most the
 * feeds in flight, and the next run resumes from the database rather than
 * from memory.
 *
 * Scale arithmetic (why this fits):
 *   - cron-job.org fires every 10 minutes -> 144 runs/day.
 *   - cron-job.org aborts a request after 30s, which is the binding limit
 *     (Vercel allows far longer), so a run must finish in ~20s.
 *   - At BATCH_SIZE feeds/run, daily capacity = BATCH_SIZE * 144 checks.
 *     With adaptive polling most of the 50,000 feeds are low priority and
 *     are checked a few times a day, while the best sources are checked
 *     every cycle. Capacity is spent where the news actually is.
 */

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Feeds claimed per automation run (from FEED_BATCH_SIZE, default 180). */
export function batchSize(): number {
  return getConfig().feedBatchSize;
}

/** Global cap on simultaneous outbound feed requests (FEED_CONCURRENCY). */
export function globalConcurrency(): number {
  return getConfig().feedConcurrency;
}
/** Simultaneous requests allowed to a single publisher domain. */
export const PER_DOMAIN_CONCURRENCY = 2;
/** Minimum spacing between two requests to the same domain, in ms. */
export const PER_DOMAIN_MIN_INTERVAL_MS = 400;
/** Per-request timeout. */
export const FETCH_TIMEOUT_MS = 5_000;
/** Maximum feed body accepted, to bound memory. */
export const MAX_FEED_BYTES = 2_000_000;
/** A claim older than this is considered abandoned and may be re-claimed. */
export const CLAIM_TTL_MINUTES = 5;
/** Registry capacity target. */
export const FEED_CAPACITY = 50_000;

/** Priority tiers drive how often a feed is polled. */
export const PRIORITY = { high: 1, normal: 2, low: 3 } as const;

/** Base polling interval per priority, in minutes. */
export const BASE_INTERVAL_MINUTES: Record<number, number> = {
  1: 10,   // high: every cycle
  2: 60,   // normal: hourly
  3: 360,  // low: every six hours
};

/** Hard bounds for adaptive polling. */
export const MIN_INTERVAL_MINUTES = 10;
export const MAX_INTERVAL_MINUTES = 2880; // 48h

/* ------------------------------------------------------------------ */
/* SSRF protection                                                     */
/* ------------------------------------------------------------------ */

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]",
  "metadata.google.internal", "metadata.goog", "instance-data",
]);

/**
 * Rejects anything that is not a public http(s) endpoint: non-HTTP schemes,
 * credentials in the URL, loopback, link-local, private and reserved IP
 * ranges, and internal metadata hosts. Applied to the registered URL AND to
 * every redirect destination.
 */
export function isSafeFeedUrl(rawUrl: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `unsupported protocol ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, reason: "credentials in URL" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { safe: false, reason: "internal hostname" };
  }

  // IPv4 literals: block loopback, private, link-local, CGNAT and reserved.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    ) {
      return { safe: false, reason: "private or reserved IP range" };
    }
  }

  // IPv6 literals: block loopback, unique-local (fc00::/7) and link-local.
  if (host.includes(":")) {
    if (host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
      return { safe: false, reason: "private IPv6 range" };
    }
  }

  return { safe: true };
}

/** Canonical form used for duplicate detection on import. */
export function normalizeFeedUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.protocol = parsed.protocol.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    parsed.searchParams.sort();
    return parsed.toString().toLowerCase();
  } catch {
    return null;
  }
}

export function domainOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Batch claiming (atomic, resumable)                                  */
/* ------------------------------------------------------------------ */

export type ClaimedFeed = Pick<
  RssFeedRow,
  | "id" | "name" | "url" | "topic" | "domain" | "priority"
  | "etag" | "last_modified" | "consecutive_failures" | "poll_interval_minutes"
>;

export interface BatchClaim {
  batchId: string;
  workerId: string;
  feeds: ClaimedFeed[];
}

/**
 * Atomically claims up to `limit` DUE feeds.
 *
 * The claim is a single UPDATE over a FOR UPDATE SKIP LOCKED sub-select, so
 * two overlapping cron executions can never claim the same feed: whichever
 * transaction commits first owns the rows, and the other simply skips them
 * and claims different work. Claims carry a worker id and expiry, so a run
 * that dies mid-batch releases its feeds automatically after CLAIM_TTL.
 *
 * Randomised tie-breaking spreads requests across publishers instead of
 * hammering one domain whose feeds all became due together.
 */
export async function claimFeedBatch(limit: number = batchSize()): Promise<BatchClaim> {
  const sql = getDb();
  const workerId = randomUUID();

  const batchRows = (await sql`
    INSERT INTO feed_batches (status) VALUES ('running') RETURNING id
  `) as { id: string }[];
  const batchId = batchRows[0].id;

  const feeds = (await sql`
    UPDATE rss_feeds
    SET claimed_at = now(),
        claimed_by = ${workerId}::uuid,
        total_checks = total_checks + 1
    WHERE id IN (
      SELECT id FROM rss_feeds
      WHERE enabled = true
        AND paused = false
        AND (next_check_at IS NULL OR next_check_at <= now())
        AND (rate_limited_until IS NULL OR rate_limited_until <= now())
        AND (
          claimed_at IS NULL
          OR claimed_at < now() - make_interval(mins => ${CLAIM_TTL_MINUTES})
        )
      ORDER BY priority ASC, next_check_at ASC NULLS FIRST, random()
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, url, topic, domain, priority, etag, last_modified,
              consecutive_failures, poll_interval_minutes
  `) as ClaimedFeed[];

  await sql`UPDATE feed_batches SET claimed = ${feeds.length} WHERE id = ${batchId}`;

  return { batchId, workerId, feeds };
}

/** Releases any claim this worker still holds (called when a run ends early). */
export async function releaseClaims(workerId: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE rss_feeds
      SET claimed_at = NULL, claimed_by = NULL
      WHERE claimed_by = ${workerId}::uuid
    `;
  } catch {
    // Claims expire on their own after CLAIM_TTL_MINUTES.
  }
}

export async function finishBatch(
  batchId: string,
  stats: {
    processed: number; ok: number; failed: number; notModified: number;
    articles: number; avgFetchMs: number | null; rateLimited: number;
    status?: "complete" | "partial";
  },
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE feed_batches
      SET finished_at = now(),
          status = ${stats.status ?? "complete"},
          processed = ${stats.processed},
          ok = ${stats.ok},
          failed = ${stats.failed},
          not_modified = ${stats.notModified},
          articles = ${stats.articles},
          avg_fetch_ms = ${stats.avgFetchMs},
          rate_limited = ${stats.rateLimited}
      WHERE id = ${batchId}
    `;
  } catch {
    // Batch bookkeeping must never break a run.
  }
}

/* ------------------------------------------------------------------ */
/* Adaptive polling                                                    */
/* ------------------------------------------------------------------ */

export interface FeedOutcomeUpdate {
  feedId: string;
  status: "ok" | "not_modified" | "error" | "rate_limited" | "blocked";
  httpStatus: number | null;
  error: string | null;
  etag: string | null;
  lastModified: string | null;
  itemsSeen: number;
  /** Items that passed relevance — the signal that a feed is worth polling. */
  usefulItems: number;
  latestItemAt: Date | null;
  fetchMs: number | null;
  priority: number;
  consecutiveFailures: number;
  pollIntervalMinutes: number;
}

/**
 * Computes the next polling interval for a feed.
 *
 * Productive feeds are polled faster, quiet or failing feeds slower, within
 * hard bounds. Failures use exponential backoff with jitter so a broken
 * publisher is not retried in lockstep by every worker.
 */
export function nextInterval(update: FeedOutcomeUpdate): number {
  const base = BASE_INTERVAL_MINUTES[update.priority] ?? 60;
  let minutes: number;

  if (update.status === "error" || update.status === "blocked") {
    const failures = Math.min(update.consecutiveFailures + 1, 10);
    minutes = Math.min(base * 2 ** failures, MAX_INTERVAL_MINUTES);
  } else if (update.status === "rate_limited") {
    minutes = Math.max(base * 4, 60);
  } else if (update.status === "not_modified") {
    // Nothing changed: ease off slightly, but stay responsive.
    minutes = Math.min(Math.round(update.pollIntervalMinutes * 1.25), base * 4);
  } else if (update.usefulItems > 0) {
    // Producing relevant football news: poll faster, down to the floor.
    minutes = Math.max(Math.round(base / 2), MIN_INTERVAL_MINUTES);
  } else if (update.itemsSeen > 0) {
    minutes = base;
  } else {
    minutes = Math.min(base * 2, MAX_INTERVAL_MINUTES);
  }

  // +/-20% jitter so feeds do not all become due in the same instant.
  // Clamping happens AFTER jitter, so the hard bounds always hold.
  const jitter = 0.8 + Math.random() * 0.4;
  const jittered = Math.round(minutes * jitter);
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(jittered, MAX_INTERVAL_MINUTES));
}

/** Writes one feed's outcome and schedules its next check. */
export async function recordFeedOutcome(update: FeedOutcomeUpdate): Promise<void> {
  const minutes = nextInterval(update);
  try {
    const sql = getDb();
    await sql`
      UPDATE rss_feeds
      SET last_fetched_at = now(),
          last_success_at = CASE WHEN ${update.status} IN ('ok','not_modified')
            THEN now() ELSE last_success_at END,
          last_status = ${update.status},
          last_http_status = ${update.httpStatus},
          last_error = ${update.error},
          etag = COALESCE(${update.etag}, etag),
          last_modified = COALESCE(${update.lastModified}, last_modified),
          items_seen = CASE WHEN ${update.status} = 'ok' THEN ${update.itemsSeen} ELSE items_seen END,
          useful_items = useful_items + ${update.usefulItems},
          latest_item_at = COALESCE(
            ${update.latestItemAt ? update.latestItemAt.toISOString() : null}::timestamptz,
            latest_item_at
          ),
          fetch_ms = ${update.fetchMs},
          consecutive_failures = CASE WHEN ${update.status} IN ('error','blocked')
            THEN consecutive_failures + 1 ELSE 0 END,
          total_failures = total_failures + CASE WHEN ${update.status} IN ('error','blocked') THEN 1 ELSE 0 END,
          poll_interval_minutes = ${minutes},
          next_check_at = now() + make_interval(mins => ${minutes}),
          rate_limited_until = CASE WHEN ${update.status} = 'rate_limited'
            THEN now() + make_interval(mins => ${minutes}) ELSE NULL END,
          claimed_at = NULL,
          claimed_by = NULL,
          updated_at = now()
      WHERE id = ${update.feedId}
    `;

    // A feed that keeps failing is paused rather than retried forever.
    await sql`
      UPDATE rss_feeds
      SET paused = true, last_error = COALESCE(last_error, 'suspended after repeated failures')
      WHERE id = ${update.feedId} AND consecutive_failures >= 20
    `;
  } catch {
    // Never let bookkeeping break discovery.
  }
}

/* ------------------------------------------------------------------ */
/* Per-domain rate limiting                                            */
/* ------------------------------------------------------------------ */

/**
 * Orders a batch so that consecutive entries hit different domains, which
 * keeps per-domain concurrency naturally low without extra locking.
 */
export function interleaveByDomain<T extends { domain: string | null }>(items: T[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = item.domain ?? "unknown";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const queues = [...buckets.values()];
  const out: T[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

/** Simple per-domain gate enforcing concurrency and minimum spacing. */
export class DomainLimiter {
  private active = new Map<string, number>();
  private lastStart = new Map<string, number>();

  async acquire(domain: string): Promise<void> {
    for (;;) {
      const inFlight = this.active.get(domain) ?? 0;
      const since = Date.now() - (this.lastStart.get(domain) ?? 0);
      if (inFlight < PER_DOMAIN_CONCURRENCY && since >= PER_DOMAIN_MIN_INTERVAL_MS) {
        this.active.set(domain, inFlight + 1);
        this.lastStart.set(domain, Date.now());
        return;
      }
      const wait = Math.max(25, PER_DOMAIN_MIN_INTERVAL_MS - since);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  release(domain: string): void {
    const inFlight = this.active.get(domain) ?? 1;
    if (inFlight <= 1) this.active.delete(domain);
    else this.active.set(domain, inFlight - 1);
  }
}

/* ------------------------------------------------------------------ */
/* Bulk import                                                         */
/* ------------------------------------------------------------------ */

export interface ImportResult {
  received: number;
  valid: number;
  inserted: number;
  duplicates: number;
  rejected: { url: string; reason: string }[];
  capacityRemaining: number;
}

/**
 * Imports feed URLs in bounded chunks. Validates and de-duplicates BEFORE
 * insertion, enforces the registry capacity, and never runs one huge
 * transaction — each chunk is independent so a large import is resumable.
 */
export async function importFeeds(
  entries: { url: string; name?: string; category?: string; priority?: number }[],
  chunkSize = 500,
): Promise<ImportResult> {
  const sql = getDb();
  const result: ImportResult = {
    received: entries.length,
    valid: 0,
    inserted: 0,
    duplicates: 0,
    rejected: [],
    capacityRemaining: 0,
  };

  const countRows = (await sql`SELECT count(*)::int AS n FROM rss_feeds`) as { n: number }[];
  let current = countRows[0]?.n ?? 0;
  const seen = new Set<string>();
  const prepared: { url: string; normalized: string; name: string; domain: string; category: string; priority: number }[] = [];

  for (const entry of entries) {
    const url = (entry.url ?? "").trim();
    if (!url) {
      result.rejected.push({ url, reason: "empty URL" });
      continue;
    }
    const safety = isSafeFeedUrl(url);
    if (!safety.safe) {
      result.rejected.push({ url, reason: safety.reason ?? "unsafe URL" });
      continue;
    }
    const normalized = normalizeFeedUrl(url);
    const domain = domainOf(url);
    if (!normalized || !domain) {
      result.rejected.push({ url, reason: "could not normalize URL" });
      continue;
    }
    if (seen.has(normalized)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(normalized);
    result.valid += 1;
    prepared.push({
      url,
      normalized,
      name: (entry.name ?? domain).slice(0, 120),
      domain,
      category: (entry.category ?? "football").slice(0, 60),
      priority: entry.priority === 1 || entry.priority === 3 ? entry.priority : 2,
    });
  }

  for (let i = 0; i < prepared.length; i += chunkSize) {
    if (current >= FEED_CAPACITY) break;
    const room = FEED_CAPACITY - current;
    const chunk = prepared.slice(i, i + Math.min(chunkSize, room));
    if (chunk.length === 0) break;

    const rows = (await sql`
      INSERT INTO rss_feeds (name, url, normalized_url, domain, category, priority, topic, next_check_at, last_status)
      SELECT * FROM UNNEST(
        ${chunk.map((c) => c.name)}::text[],
        ${chunk.map((c) => c.url)}::text[],
        ${chunk.map((c) => c.normalized)}::text[],
        ${chunk.map((c) => c.domain)}::text[],
        ${chunk.map((c) => c.category)}::text[],
        ${chunk.map((c) => c.priority)}::smallint[],
        ${chunk.map((c) => c.category)}::text[],
        ${chunk.map(() => new Date().toISOString())}::timestamptz[],
        ${chunk.map(() => "untested")}::text[]
      )
      ON CONFLICT (url) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    result.inserted += rows.length;
    result.duplicates += chunk.length - rows.length;
    current += rows.length;
  }

  result.capacityRemaining = Math.max(0, FEED_CAPACITY - current);
  return result;
}

/* ------------------------------------------------------------------ */
/* Registry statistics (dashboard)                                     */
/* ------------------------------------------------------------------ */

export interface RegistryStats {
  total: number;
  capacity: number;
  healthy: number;
  failing: number;
  paused: number;
  untested: number;
  dueNow: number;
  checkedLastHour: number;
  checkedLast24h: number;
  avgFetchMs: number | null;
  failureRatePct: number;
  rateLimited: number;
}

export async function getRegistryStats(): Promise<RegistryStats> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE last_status IN ('ok','not_modified') AND paused = false)::int AS healthy,
      count(*) FILTER (WHERE last_status IN ('error','blocked') AND paused = false)::int AS failing,
      count(*) FILTER (WHERE paused = true)::int AS paused,
      count(*) FILTER (WHERE last_status = 'untested' OR last_status IS NULL)::int AS untested,
      count(*) FILTER (WHERE enabled = true AND paused = false
        AND (next_check_at IS NULL OR next_check_at <= now()))::int AS due_now,
      count(*) FILTER (WHERE last_fetched_at > now() - interval '1 hour')::int AS checked_hour,
      count(*) FILTER (WHERE last_fetched_at > now() - interval '24 hours')::int AS checked_day,
      count(*) FILTER (WHERE rate_limited_until > now())::int AS rate_limited,
      avg(fetch_ms) FILTER (WHERE fetch_ms IS NOT NULL) AS avg_fetch_ms,
      sum(total_failures)::bigint AS failures,
      sum(total_checks)::bigint AS checks
    FROM rss_feeds
  `) as Record<string, unknown>[];

  const r = rows[0] ?? {};
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const checks = num(r.checks);
  const failures = num(r.failures);

  return {
    total: num(r.total),
    capacity: FEED_CAPACITY,
    healthy: num(r.healthy),
    failing: num(r.failing),
    paused: num(r.paused),
    untested: num(r.untested),
    dueNow: num(r.due_now),
    checkedLastHour: num(r.checked_hour),
    checkedLast24h: num(r.checked_day),
    avgFetchMs: r.avg_fetch_ms === null || r.avg_fetch_ms === undefined ? null : Math.round(num(r.avg_fetch_ms)),
    failureRatePct: checks > 0 ? Math.round((failures / checks) * 1000) / 10 : 0,
    rateLimited: num(r.rate_limited),
  };
}
