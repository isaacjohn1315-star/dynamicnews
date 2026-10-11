import { ensureSchema, getDb } from "./db";
import { getBudgetStats } from "./request-budget";

/**
 * Read-only aggregation for the production monitoring dashboard.
 * Returns null when the database is not configured or unreachable —
 * the dashboard renders a setup state instead of crashing.
 */

export interface DashboardRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  newsdataRequests: number;
  budgetUsedToday: number | null;
  fetched: number;
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
  published: number;
  feedsChecked: number;
  feedsOk: number;
  rssFetched: number;
  rssNewCandidates: number;
  exactDuplicates: number;
  storyDuplicates: number;
  staleRejected: number;
  followupsAccepted: number;
  discoveryError: string | null;
  publishError: string | null;
  error: string | null;
}

export interface DashboardStory {
  id: string;
  title: string;
  sourceName: string | null;
  provider: "newsdata" | "rss";
  feedName: string | null;
  status: string;
  relevanceScore: number;
  corroborations: number;
  isRumour: boolean;
  storyStage: string | null;
  isFollowup: boolean;
  duplicateKind: string | null;
  rejectKind: string | null;
  decisionReason: string | null;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  publishedAt: string | null;
  postedAt: string | null;
  fbPostId: string | null;
}

export interface DashboardFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  itemsSeen: number;
}

export interface DashboardData {
  generatedAt: string;
  budget: {
    day: string;
    used: number;
    limit: number;
    remaining: number;
    rolling24h: number;
    limitReachedAt: string | null;
    resetsAt: string;
  };
  newsdataHealth: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureError: string | null;
  };
  totals: {
    publishedToday: number;
    publishedTotal: number;
    queue: number;
    rejected: number;
    rejectedStale: number;
    duplicates: number;
    exactDuplicates: number;
    storyDuplicates: number;
    followups: number;
    failed: number;
    awaitingRetry: number;
    runsToday: number;
  };
  lastRun: DashboardRun | null;
  recentRuns: DashboardRun[];
  recentStories: DashboardStory[];
  recentPublished: DashboardStory[];
  feeds: DashboardFeed[];
}

export async function getDashboardData(): Promise<DashboardData | null> {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    return null;
  }

  try {
    await ensureSchema();
    const sql = getDb();

    const budget = await getBudgetStats();

    const totalsRows = (await sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'published' AND posted_at >= (CURRENT_DATE AT TIME ZONE 'UTC')
        )::int AS published_today,
        COUNT(*) FILTER (WHERE status = 'published')::int AS published_total,
        COUNT(*) FILTER (WHERE status IN ('candidate', 'publishing'))::int AS queue,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'rejected' AND reject_kind = 'stale')::int AS rejected_stale,
        COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicates,
        COUNT(*) FILTER (WHERE status = 'duplicate' AND duplicate_kind IS DISTINCT FROM 'story')::int AS exact_duplicates,
        COUNT(*) FILTER (WHERE status = 'duplicate' AND duplicate_kind = 'story')::int AS story_duplicates,
        COUNT(*) FILTER (WHERE is_followup = true AND status = 'published')::int AS followups,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'candidate' AND attempts > 0)::int AS awaiting_retry
      FROM news_items
    `) as {
      published_today: number;
      published_total: number;
      queue: number;
      rejected: number;
      rejected_stale: number;
      duplicates: number;
      exact_duplicates: number;
      story_duplicates: number;
      followups: number;
      failed: number;
      awaiting_retry: number;
    }[];

    const runCountsRows = (await sql`
      SELECT COUNT(*)::int AS runs_today
      FROM automation_runs
      WHERE started_at >= (CURRENT_DATE AT TIME ZONE 'UTC')
    `) as { runs_today: number }[];

    const healthRows = (await sql`
      SELECT
        MAX(started_at) FILTER (
          WHERE newsdata_requests = 1 AND discovery_error IS NULL
        ) AS last_success_at,
        MAX(started_at) FILTER (
          WHERE newsdata_requests = 1 AND discovery_error IS NOT NULL
        ) AS last_failure_at,
        (SELECT discovery_error FROM automation_runs
          WHERE newsdata_requests = 1 AND discovery_error IS NOT NULL
          ORDER BY started_at DESC LIMIT 1) AS last_failure_error
      FROM automation_runs
    `) as { last_success_at: unknown; last_failure_at: unknown; last_failure_error: unknown }[];

    const runRows = (await sql`
      SELECT id, started_at, finished_at, status, newsdata_requests,
             budget_used_today, fetched, new_candidates, rejected,
             duplicates_skipped, published, discovery_error, publish_error, error,
             feeds_checked, feeds_ok, rss_fetched, rss_new_candidates,
             exact_duplicates, story_duplicates, stale_rejected, followups_accepted
      FROM automation_runs
      ORDER BY started_at DESC
      LIMIT 12
    `) as Record<string, unknown>[];

    const storyRows = (await sql`
      SELECT id, title, source_name, provider, feed_name, status, relevance_score,
             corroborations, is_rumour, story_stage, is_followup, duplicate_kind,
             reject_kind, decision_reason, attempts, last_error,
             next_retry_at, created_at, published_at, posted_at, fb_post_id
      FROM news_items
      ORDER BY created_at DESC
      LIMIT 18
    `) as Record<string, unknown>[];

    const publishedRows = (await sql`
      SELECT id, title, source_name, provider, feed_name, status, relevance_score,
             corroborations, is_rumour, story_stage, is_followup, duplicate_kind,
             reject_kind, decision_reason, attempts, last_error,
             next_retry_at, created_at, published_at, posted_at, fb_post_id
      FROM news_items
      WHERE status = 'published'
      ORDER BY posted_at DESC NULLS LAST
      LIMIT 10
    `) as Record<string, unknown>[];

    const feedRows = (await sql`
      SELECT id, name, url, enabled, last_fetched_at, last_status, last_error,
             consecutive_failures, items_seen
      FROM rss_feeds
      ORDER BY name ASC
    `) as Record<string, unknown>[];

    const totals = totalsRows[0] ?? {
      published_today: 0,
      published_total: 0,
      queue: 0,
      rejected: 0,
      rejected_stale: 0,
      duplicates: 0,
      exact_duplicates: 0,
      story_duplicates: 0,
      followups: 0,
      failed: 0,
      awaiting_retry: 0,
    };

    const recentRuns = runRows.map(toRun);
    const recentPublished = publishedRows.map(toStory);
    const health = healthRows[0] ?? {
      last_success_at: null,
      last_failure_at: null,
      last_failure_error: null,
    };

    return {
      generatedAt: new Date().toISOString(),
      budget,
      newsdataHealth: {
        lastSuccessAt: isoStringOrNull(health.last_success_at),
        lastFailureAt: isoStringOrNull(health.last_failure_at),
        lastFailureError:
          typeof health.last_failure_error === "string" && health.last_failure_error.trim().length > 0
            ? health.last_failure_error
            : null,
      },
      totals: {
        publishedToday: totals.published_today,
        publishedTotal: totals.published_total,
        queue: totals.queue,
        rejected: totals.rejected,
        rejectedStale: totals.rejected_stale,
        duplicates: totals.duplicates,
        exactDuplicates: totals.exact_duplicates,
        storyDuplicates: totals.story_duplicates,
        followups: totals.followups,
        failed: totals.failed,
        awaitingRetry: totals.awaiting_retry,
        runsToday: runCountsRows[0]?.runs_today ?? 0,
      },
      lastRun: recentRuns[0] ?? null,
      recentRuns,
      recentStories: storyRows.map(toStory),
      recentPublished,
      feeds: feedRows.map(toFeed),
    };
  } catch {
    return null;
  }
}

function toRun(row: Record<string, unknown>): DashboardRun {
  return {
    id: String(row.id),
    startedAt: isoString(row.started_at),
    finishedAt: isoStringOrNull(row.finished_at),
    status: String(row.status ?? "unknown"),
    newsdataRequests: toNumber(row.newsdata_requests),
    budgetUsedToday: row.budget_used_today === null ? null : toNumber(row.budget_used_today),
    fetched: toNumber(row.fetched),
    newCandidates: toNumber(row.new_candidates),
    rejected: toNumber(row.rejected),
    duplicatesSkipped: toNumber(row.duplicates_skipped),
    published: toNumber(row.published),
    feedsChecked: toNumber(row.feeds_checked),
    feedsOk: toNumber(row.feeds_ok),
    rssFetched: toNumber(row.rss_fetched),
    rssNewCandidates: toNumber(row.rss_new_candidates),
    exactDuplicates: toNumber(row.exact_duplicates),
    storyDuplicates: toNumber(row.story_duplicates),
    staleRejected: toNumber(row.stale_rejected),
    followupsAccepted: toNumber(row.followups_accepted),
    discoveryError: stringOrNull(row.discovery_error),
    publishError: stringOrNull(row.publish_error),
    error: stringOrNull(row.error),
  };
}

function toStory(row: Record<string, unknown>): DashboardStory {
  const provider = row.provider === "rss" ? "rss" : "newsdata";
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    sourceName: stringOrNull(row.source_name),
    provider,
    feedName: stringOrNull(row.feed_name),
    status: String(row.status ?? "unknown"),
    relevanceScore: toNumber(row.relevance_score),
    corroborations: toNumber(row.corroborations),
    isRumour: row.is_rumour === true,
    storyStage: stringOrNull(row.story_stage),
    isFollowup: row.is_followup === true,
    duplicateKind: stringOrNull(row.duplicate_kind),
    rejectKind: stringOrNull(row.reject_kind),
    decisionReason: stringOrNull(row.decision_reason),
    attempts: toNumber(row.attempts),
    lastError: stringOrNull(row.last_error),
    nextRetryAt: isoStringOrNull(row.next_retry_at),
    createdAt: isoString(row.created_at),
    publishedAt: isoStringOrNull(row.published_at),
    postedAt: isoStringOrNull(row.posted_at),
    fbPostId: stringOrNull(row.fb_post_id),
  };
}

function toFeed(row: Record<string, unknown>): DashboardFeed {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    url: String(row.url ?? ""),
    enabled: row.enabled === true,
    lastFetchedAt: isoStringOrNull(row.last_fetched_at),
    lastStatus: stringOrNull(row.last_status),
    lastError: stringOrNull(row.last_error),
    consecutiveFailures: toNumber(row.consecutive_failures),
    itemsSeen: toNumber(row.items_seen),
  };
}

function isoString(value: unknown): string {
  if (value === null || value === undefined) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function isoStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumber(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}
