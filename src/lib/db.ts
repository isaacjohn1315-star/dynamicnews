import { neon } from "@neondatabase/serverless";

/**
 * DynaSport database layer — one Postgres database, no ORM, one SQL surface.
 *
 * PRODUCTION uses Neon PostgreSQL through the official Neon serverless
 * driver over HTTPS, which is the only transport that works on Vercel's
 * Node.js runtime (no persistent sockets required). A Neon connection
 * string is what `DATABASE_URL` must contain in production.
 *
 * The driver is HTTP-only: it cannot speak raw TCP to a local Postgres
 * process, so `DATABASE_URL` pointing at 127.0.0.1 would otherwise make the
 * app impossible to run or debug outside production. When the URL is NOT a
 * Neon endpoint, the same SQL runs over a standard TCP connection instead.
 * It is the same single database layer and identical SQL — only the wire
 * differs — and a Neon URL always takes the Neon driver, so production is
 * never affected.
 */

export type SqlClient = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** True when the URL points at a Neon endpoint (production). */
function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith(".neon.tech") || host.includes("neon.tech");
  } catch {
    return false;
  }
}

/**
 * node-postgres is imported lazily and only when the URL is not a Neon
 * endpoint. On Vercel (Neon) the module is therefore never bundled into the
 * serverless function, which avoids the known pg/pg-cloudflare bundling
 * issues and keeps the production path on the Neon HTTPS driver alone.
 */
type PgPoolLike = {
  query(args: { text: string; values: unknown[] }): Promise<{ rows: unknown[] }>;
};

let cachedPool: PgPoolLike | null = null;

async function getLocalPool(connectionString: string): Promise<PgPoolLike> {
  if (!cachedPool) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    cachedPool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 }) as unknown as PgPoolLike;
  }
  return cachedPool;
}

/**
 * Adapts node-postgres to the same tagged-template SQL surface the Neon
 * driver exposes, so every query in the application works unchanged on
 * either transport.
 */
function pgTagged(pool: PgPoolLike): SqlClient {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let i = 1; i < strings.length; i += 1) {
      text += `$${i}${strings[i]}`;
    }
    const result = await pool.query({ text, values: values as unknown[] });
    return result.rows as unknown[];
  };
}

export function getDb(): SqlClient {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  // Production path: Neon serverless driver over HTTPS.
  if (isNeonUrl(databaseUrl)) {
    return neon(databaseUrl) as unknown as SqlClient;
  }

  // Non-Neon URL (local development / debugging): same SQL over TCP.
  // Returned asynchronously so the pg module stays out of the Neon path.
  let cache: SqlClient | null = null;
  return async (strings, ...values) => {
    if (!cache) {
      cache = pgTagged(await getLocalPool(databaseUrl));
    }
    return cache(strings, ...values);
  };
}

/** Reports which transport is active, for the dashboard and health check. */
export function dbTransport(): "neon-https" | "postgres-tcp" | "not-configured" {
  const url = process.env.DATABASE_URL;
  if (!url) return "not-configured";
  return isNeonUrl(url) ? "neon-https" : "postgres-tcp";
}

/* ------------------------------------------------------------------ */
/* Schema (idempotent, created on first use — no migrations tooling)   */
/* ------------------------------------------------------------------ */

let schemaPromise: Promise<void> | null = null;

/**
 * Ensures the DynaSport tables exist. Safe to call on every cold start;
 * failures reset the cached promise so the next call retries.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = createSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function createSchema(): Promise<void> {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS news_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dedupe_key text NOT NULL UNIQUE,
      title text NOT NULL,
      title_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
      description text,
      article_url text,
      source_name text,
      source_id text,
      published_at timestamptz,
      language text,
      relevance_score integer NOT NULL DEFAULT 0,
      is_rumour boolean NOT NULL DEFAULT false,
      post_text text,
      status text NOT NULL DEFAULT 'candidate',
      decision_reason text,
      attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamptz,
      next_retry_at timestamptz,
      last_error text,
      fb_post_id text,
      posted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS news_items_status_idx
      ON news_items (status, relevance_score DESC, created_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS news_items_posted_idx
      ON news_items (posted_at DESC)
      WHERE posted_at IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trigger_source text NOT NULL DEFAULT 'automation',
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'ok',
      fetched integer NOT NULL DEFAULT 0,
      new_candidates integer NOT NULL DEFAULT 0,
      rejected integer NOT NULL DEFAULT 0,
      duplicates_skipped integer NOT NULL DEFAULT 0,
      published integer NOT NULL DEFAULT 0,
      discovery_error text,
      publish_error text,
      error text,
      summary jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS automation_runs_started_idx
      ON automation_runs (started_at DESC)
  `;

  // Monitored RSS/Atom feeds with health + conditional-GET state.
  await sql`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      url text NOT NULL UNIQUE,
      enabled boolean NOT NULL DEFAULT true,
      etag text,
      last_modified text,
      last_fetched_at timestamptz,
      last_status text,
      last_error text,
      consecutive_failures integer NOT NULL DEFAULT 0,
      items_seen integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Additive columns for pre-existing deployments (idempotent).
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'rss'`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS feed_name text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS corroborations integer NOT NULL DEFAULT 1`;

  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS feeds_checked integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS feeds_ok integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS rss_fetched integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS rss_new_candidates integer NOT NULL DEFAULT 0`;

  /* -------------------------------------------------------------- */
  /* Story-level identity (layer B/C of duplicate protection)        */
  /* -------------------------------------------------------------- */

  // One row per underlying real-world story (not per article).
  await sql`
    CREATE TABLE IF NOT EXISTS stories (
      fingerprint text PRIMARY KEY,
      entities jsonb NOT NULL DEFAULT '[]'::jsonb,
      event_kind text NOT NULL DEFAULT 'other',
      title_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
      representative_title text,
      published_stage text,
      published_stage_rank integer NOT NULL DEFAULT -1,
      published_count integer NOT NULL DEFAULT 0,
      followups_published integer NOT NULL DEFAULT 0,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      last_published_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS stories_last_seen_idx
      ON stories (last_seen_at DESC)
  `;

  // Atomic publication claim: at most ONE Facebook post per
  // (story, stage). The primary key is the concurrency guarantee.
  await sql`
    CREATE TABLE IF NOT EXISTS story_publications (
      fingerprint text NOT NULL,
      stage_rank integer NOT NULL,
      news_item_id uuid,
      fb_post_id text,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      PRIMARY KEY (fingerprint, stage_rank)
    )
  `;

  // Single-flight lease so overlapping cron executions cannot both run
  // discovery (budget and claims are already safe; this avoids waste).
  await sql`
    CREATE TABLE IF NOT EXISTS automation_lease (
      id integer PRIMARY KEY DEFAULT 1,
      holder uuid,
      acquired_at timestamptz,
      expires_at timestamptz,
      CONSTRAINT automation_lease_single CHECK (id = 1)
    )
  `;

  await sql`
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS story_fingerprint text
  `;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS story_stage text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS story_stage_rank integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS is_followup boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS duplicate_kind text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS reject_kind text`;

  await sql`
    CREATE INDEX IF NOT EXISTS news_items_story_idx
      ON news_items (story_fingerprint)
      WHERE story_fingerprint IS NOT NULL
  `;

  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS exact_duplicates integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS story_duplicates integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS stale_rejected integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS followups_accepted integer NOT NULL DEFAULT 0`;

  /* -------------------------------------------------------------- */
  /* Feed catalogue metadata + freshness checkpoints                 */
  /* -------------------------------------------------------------- */

  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS topic text`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS last_success_at timestamptz`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS latest_item_at timestamptz`;
  // Feeds registered before this release default to "untested" until the
  // first successful fetch in this deployment proves they work.
  await sql`ALTER TABLE rss_feeds ALTER COLUMN last_status SET DEFAULT 'untested'`;
  await sql`UPDATE rss_feeds SET last_status = 'untested' WHERE last_status IS NULL`;

  /* -------------------------------------------------------------- */
  /* Feed registry at scale (target capacity: 50,000 feeds)          */
  /* -------------------------------------------------------------- */

  // Additive only: existing feed rows keep their data and status.
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS normalized_url text`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS domain text`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS category text`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 2`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS last_http_status integer`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS next_check_at timestamptz`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS poll_interval_minutes integer NOT NULL DEFAULT 60`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS claimed_at timestamptz`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS claimed_by uuid`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS fetch_ms integer`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS useful_items integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS total_checks integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS total_failures integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS rate_limited_until timestamptz`;

  // Backfill derived columns for pre-existing rows (bounded, idempotent).
  await sql`
    UPDATE rss_feeds
    SET normalized_url = COALESCE(normalized_url, lower(url)),
        domain = COALESCE(
          domain,
          lower(split_part(split_part(regexp_replace(url, '^https?://', ''), '/', 1), ':', 1))
        ),
        next_check_at = COALESCE(next_check_at, now())
    WHERE normalized_url IS NULL OR domain IS NULL OR next_check_at IS NULL
  `;

  // Scheduler index: the claim query orders by due time among eligible feeds.
  await sql`
    CREATE INDEX IF NOT EXISTS rss_feeds_due_idx
      ON rss_feeds (next_check_at ASC NULLS FIRST)
      WHERE enabled = true AND paused = false
  `;
  await sql`CREATE INDEX IF NOT EXISTS rss_feeds_domain_idx ON rss_feeds (domain)`;
  await sql`CREATE INDEX IF NOT EXISTS rss_feeds_status_idx ON rss_feeds (last_status)`;
  await sql`CREATE INDEX IF NOT EXISTS rss_feeds_priority_idx ON rss_feeds (priority, next_check_at)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS rss_feeds_normalized_url_key
      ON rss_feeds (normalized_url)
      WHERE normalized_url IS NOT NULL
  `;

  // Durable batch progress so an interrupted run resumes instead of restarting.
  await sql`
    CREATE TABLE IF NOT EXISTS feed_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      claimed integer NOT NULL DEFAULT 0,
      processed integer NOT NULL DEFAULT 0,
      ok integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      not_modified integer NOT NULL DEFAULT 0,
      articles integer NOT NULL DEFAULT 0,
      avg_fetch_ms integer,
      rate_limited integer NOT NULL DEFAULT 0
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS feed_batches_started_idx ON feed_batches (started_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS rss_feeds_rotation_idx
      ON rss_feeds (last_fetched_at ASC NULLS FIRST)
      WHERE enabled = true
  `;

  // Article freshness: when DynaSport first saw an item, and whether it was
  // new at the moment of discovery.
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now()`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now()`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS freshness_category text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS requires_corroboration boolean NOT NULL DEFAULT false`;

  // Article-content cache: prevents re-downloading the same article page
  // within a day, which is both polite to publishers and fast.
  /* -------------------------------------------------------------- */
  /* Publishing lifecycle (time-sensitive news publishing)           */
  /* -------------------------------------------------------------- */

  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS event_category text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS priority_score integer NOT NULL DEFAULT 50`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS publish_after timestamptz`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS event_at timestamptz`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS updated_at_checked timestamptz`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS cancel_reason text`;

  await sql`
    CREATE INDEX IF NOT EXISTS news_items_publish_idx
      ON news_items (priority_score DESC, published_at ASC)
      WHERE status = 'candidate'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS news_items_expiry_idx
      ON news_items (expires_at)
      WHERE expires_at IS NOT NULL
  `;

  // Audit trail for controlled queue resets.
  await sql`
    CREATE TABLE IF NOT EXISTS queue_resets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      performed_at timestamptz NOT NULL DEFAULT now(),
      candidate_cancelled integer NOT NULL DEFAULT 0,
      publishing_reconciled integer NOT NULL DEFAULT 0,
      publishing_cancelled integer NOT NULL DEFAULT 0,
      failed_cancelled integer NOT NULL DEFAULT 0,
      notes text
    )
  `;

  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS queue_reset_at timestamptz`;

  await sql`
    CREATE TABLE IF NOT EXISTS article_cache (
      url text PRIMARY KEY,
      content text NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS article_cache_fetched_idx ON article_cache (fetched_at DESC)`;

  // STRICT duplicate protection: the final Facebook message text can never
  // be published twice, whatever path produced it.
  await sql`
    CREATE TABLE IF NOT EXISTS published_posts (
      post_hash text PRIMARY KEY,
      news_item_id uuid,
      fb_post_id text,
      published_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Distinct publishers per story: the PRIMARY KEY guarantees one row per
  // (story, publisher), so one outlet republishing five near-copies counts
  // as breadth of one, not five. This is the only corroboration evidence
  // DynaSport uses — it never fabricates engagement or popularity numbers.
  await sql`
    CREATE TABLE IF NOT EXISTS story_sources (
      fingerprint text NOT NULL,
      publisher text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (fingerprint, publisher)
    )
  `;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS headline text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS explanation text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS age_minutes_at_discovery integer`;

  // Single-row scan checkpoint used by the "newly published only" gate.
  await sql`
    CREATE TABLE IF NOT EXISTS scan_state (
      id integer PRIMARY KEY DEFAULT 1,
      last_scan_at timestamptz,
      last_successful_scan_at timestamptz,
      CONSTRAINT scan_state_single CHECK (id = 1)
    )
  `;

  // Publishing pacing: NO daily cap is stored here. `posts_total` is a
  // monitoring counter only; `next_eligible_publish_at` holds the short,
  // non-blocking spacing interval between ordinary posts.
  await sql`
    CREATE TABLE IF NOT EXISTS publish_state (
      day text PRIMARY KEY,
      posts_total integer NOT NULL DEFAULT 0,
      next_eligible_publish_at timestamptz,
      last_published_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Installations created before caps were removed keep their old columns;
  // the new counter is added alongside them without data loss.
  await sql`ALTER TABLE publish_state ADD COLUMN IF NOT EXISTS posts_total integer NOT NULL DEFAULT 0`;

  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS stale_not_new integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS publish_skipped_reason text`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS expired integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS photo_posts integer NOT NULL DEFAULT 0`;

  /* -------------------------------------------------------------- */
  /* Image metadata (metadata only — binaries are never stored)      */
  /* -------------------------------------------------------------- */

  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_url text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_final_url text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_mime text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_bytes integer`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_origin text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_publisher text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_status text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS image_error text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS fb_photo_id text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS publish_mode text`;
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS fallback_reason text`;

  await sql`
    CREATE INDEX IF NOT EXISTS news_items_image_status_idx
      ON news_items (image_status)
      WHERE image_status IS NOT NULL
  `;
}

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type NewsItemStatus =
  | "candidate"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "duplicate";

export interface NewsItemRow {
  id: string;
  dedupe_key: string;
  title: string;
  title_tokens: unknown;
  description: string | null;
  article_url: string | null;
  source_name: string | null;
  source_id: string | null;
  published_at: string | null;
  language: string | null;
  relevance_score: number;
  is_rumour: boolean;
  post_text: string | null;
  status: NewsItemStatus;
  decision_reason: string | null;
  attempts: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  fb_post_id: string | null;
  fb_photo_id: string | null;
  publish_mode: string | null;
  fallback_reason: string | null;
  image_url: string | null;
  image_final_url: string | null;
  image_mime: string | null;
  image_bytes: number | null;
  image_origin: string | null;
  image_publisher: string | null;
  image_status: string | null;
  image_error: string | null;
  posted_at: string | null;
  provider: string;
  feed_name: string | null;
  corroborations: number;
  story_fingerprint: string | null;
  story_stage: string | null;
  story_stage_rank: number;
  is_followup: boolean;
  duplicate_kind: string | null;
  reject_kind: string | null;
  priority_score: number;
  event_category: string | null;
  publish_after: string | null;
  expires_at: string | null;
  event_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  first_seen_at: string;
  headline: string | null;
  explanation: string | null;
  age_minutes_at_discovery: number | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationRunRow {
  id: string;
  trigger_source: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  fetched: number;
  new_candidates: number;
  rejected: number;
  duplicates_skipped: number;
  published: number;
  discovery_error: string | null;
  publish_error: string | null;
  error: string | null;
  feeds_checked: number;
  feeds_ok: number;
  rss_fetched: number;
  rss_new_candidates: number;
  exact_duplicates: number;
  story_duplicates: number;
  stale_rejected: number;
  followups_accepted: number;
  stale_not_new: number;
  publish_skipped_reason: string | null;
  summary: unknown;
  created_at: string;
}

export interface StoryRow {
  fingerprint: string;
  entities: unknown;
  event_kind: string;
  title_tokens: unknown;
  representative_title: string | null;
  published_stage: string | null;
  published_stage_rank: number;
  published_count: number;
  followups_published: number;
  first_seen_at: string;
  last_seen_at: string;
  last_published_at: string | null;
  updated_at: string;
}

export interface FeedBatchRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  claimed: number;
  processed: number;
  ok: number;
  failed: number;
  not_modified: number;
  articles: number;
  avg_fetch_ms: number | null;
  rate_limited: number;
}

export interface RssFeedRow {
  id: string;
  name: string;
  topic: string | null;
  url: string;
  normalized_url: string | null;
  domain: string | null;
  category: string | null;
  priority: number;
  paused: boolean;
  last_http_status: number | null;
  next_check_at: string | null;
  poll_interval_minutes: number;
  claimed_at: string | null;
  claimed_by: string | null;
  fetch_ms: number | null;
  useful_items: number;
  total_checks: number;
  total_failures: number;
  rate_limited_until: string | null;
  enabled: boolean;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: string | null;
  last_success_at: string | null;
  latest_item_at: string | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  items_seen: number;
  created_at: string;
  updated_at: string;
}

export interface RequestBudgetRow {
  day: string;
  used: number;
  limit_reached_at: string | null;
  updated_at: string;
}
