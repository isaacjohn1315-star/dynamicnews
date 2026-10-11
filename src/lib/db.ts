import { neon } from "@neondatabase/serverless";

/**
 * DynaSport database layer — Neon PostgreSQL (serverless) only.
 * There is no local PostgreSQL fallback, no ORM, and no second database
 * layer. Every production query goes through this module.
 */
export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  return neon(databaseUrl);
}

export type SqlClient = ReturnType<typeof getDb>;

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
    CREATE TABLE IF NOT EXISTS request_budget (
      day text PRIMARY KEY,
      used integer NOT NULL DEFAULT 0,
      limit_reached_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

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
      newsdata_requests integer NOT NULL DEFAULT 0,
      budget_used_today integer,
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

  // Rolling-window request events complement the per-day counter so usage
  // stays within 200 requests in ANY 24-hour period, regardless of the
  // provider's actual credit reset timezone.
  await sql`
    CREATE TABLE IF NOT EXISTS request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS request_events_created_idx
      ON request_events (created_at DESC)
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
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'newsdata'`;
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

  await sql`
    CREATE INDEX IF NOT EXISTS rss_feeds_rotation_idx
      ON rss_feeds (last_fetched_at ASC NULLS FIRST)
      WHERE enabled = true
  `;

  // Article freshness: when DynaSport first saw an item, and whether it was
  // new at the moment of discovery.
  await sql`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now()`;
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
  posted_at: string | null;
  provider: "newsdata" | "rss";
  feed_name: string | null;
  corroborations: number;
  story_fingerprint: string | null;
  story_stage: string | null;
  story_stage_rank: number;
  is_followup: boolean;
  duplicate_kind: string | null;
  reject_kind: string | null;
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
  newsdata_requests: number;
  budget_used_today: number | null;
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

export interface RssFeedRow {
  id: string;
  name: string;
  topic: string | null;
  url: string;
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
