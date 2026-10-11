import { getConfig, runsPerDay } from "./config";
import { dbTransport, ensureSchema, getDb, type SqlClient } from "./db";
import { getPublishState, type PublishState } from "./publishing";
import { checkFloodControl, maxPostsPerHour, minSpacingMinutes, popularityMinScore } from "./flood";
import { getLastQueueReset } from "./queue";
import { getScanState } from "./freshness";
import { FEED_COUNT } from "./feeds";
import { getRegistryStats, type RegistryStats } from "./feed-registry";

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
  staleNotNew: number;
  publishSkippedReason: string | null;
  discoveryError: string | null;
  publishError: string | null;
  error: string | null;
}

export interface DashboardStory {
  id: string;
  title: string;
  sourceName: string | null;
  provider: string;
  feedName: string | null;
  status: string;
  relevanceScore: number;
  corroborations: number;
  isRumour: boolean;
  storyStage: string | null;
  headline: string | null;
  explanation: string | null;
  ageMinutesAtDiscovery: number | null;
  firstSeenAt: string | null;
  freshnessCategory: string | null;
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
  imageStatus: string | null;
  imageError: string | null;
  imageOrigin: string | null;
  publishMode: string | null;
  fallbackReason: string | null;
  fbPhotoId: string | null;
}

export interface DashboardFeed {
  id: string;
  name: string;
  topic: string | null;
  url: string;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  latestItemAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  itemsSeen: number;
  paused: boolean;
  priority: number;
  nextCheckAt: string | null;
  pollIntervalMinutes: number;
  lastHttpStatus: number | null;
  fetchMs: number | null;
}

export interface DashboardData {
  generatedAt: string;
  transport: "neon-https" | "postgres-tcp" | "not-configured";
  feedSummary: {
    total: number;
    catalogue: number;
    healthy: number;
    failing: number;
    untested: number;
    backoff: number;
    /** Feeds shown in the list — the registry is too long to render fully. */
    shown: number;
  };
  registry: RegistryStats;
  queueReset: Awaited<ReturnType<typeof getLastQueueReset>>;
  flood: {
    maxPerHour: number;
    minSpacingMinutes: number;
    popularityMinScore: number;
    postsLastHour: number;
    minutesSinceLastPost: number | null;
    nextEligibleAt: string | null;
  };
  batches: {
    lastFinishedAt: string | null;
    lastProcessed: number;
    lastArticles: number;
    lastAvgFetchMs: number | null;
    running: number;
  };
  /** Cron capacity, from configuration rather than any hardcoded number. */
  cron: {
    intervalMinutes: number;
    runsPerDay: number;
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
    trending: number;
    failed: number;
    awaitingRetry: number;
    expired: number;
    cancelled: number;
    superseded: number;
    withPhoto: number;
    textOnly: number;
    imageValidated: number;
    imageRejected: number;
    imageNone: number;
    runsToday: number;
  };
  publish: PublishState;
  scan: { lastScanAt: string | null; lastSuccessfulScanAt: string | null };
  lastRun: DashboardRun | null;
  lastSuccessfulRun: DashboardRun | null;
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
        COUNT(*) FILTER (WHERE freshness_category = 'trending')::int AS trending,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'candidate' AND attempts > 0)::int AS awaiting_retry,
        COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status = 'superseded')::int AS superseded,
        COUNT(*) FILTER (WHERE publish_mode = 'photo')::int AS with_photo,
        COUNT(*) FILTER (WHERE publish_mode IN ('text','text_fallback'))::int AS text_only,
        COUNT(*) FILTER (WHERE image_status IN ('validated','published_with_image'))::int AS image_validated,
        COUNT(*) FILTER (WHERE image_status IN ('download_failed','validation_failed','unsupported_format','too_large','blocked_unsafe'))::int AS image_rejected,
        COUNT(*) FILTER (WHERE image_status = 'none_found')::int AS image_none
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
      trending: number;
      failed: number;
      awaiting_retry: number;
      expired: number;
      cancelled: number;
      superseded: number;
      with_photo: number;
      text_only: number;
      image_validated: number;
      image_rejected: number;
      image_none: number;
    }[];

    const runCountsRows = (await sql`
      SELECT COUNT(*)::int AS runs_today
      FROM automation_runs
      WHERE started_at >= (CURRENT_DATE AT TIME ZONE 'UTC')
    `) as { runs_today: number }[];


    const runRows = (await sql`
      SELECT id, started_at, finished_at, status,
             fetched, new_candidates, rejected,
             duplicates_skipped, published, discovery_error, publish_error, error,
             feeds_checked, feeds_ok, rss_fetched, rss_new_candidates,
             exact_duplicates, story_duplicates, stale_rejected, followups_accepted,
             stale_not_new, publish_skipped_reason
      FROM automation_runs
      ORDER BY started_at DESC
      LIMIT 12
    `) as Record<string, unknown>[];

    const storyRows = (await sql`
      SELECT id, title, source_name, provider, feed_name, status, relevance_score,
             corroborations, is_rumour, story_stage, is_followup, duplicate_kind,
             reject_kind, decision_reason, attempts, last_error, headline, explanation,
             age_minutes_at_discovery, freshness_category, next_retry_at, created_at,
             published_at, first_seen_at, posted_at, fb_post_id,
             image_status, image_error, image_origin, publish_mode, fallback_reason, fb_photo_id
      FROM news_items
      ORDER BY created_at DESC
      LIMIT 18
    `) as Record<string, unknown>[];

    const publishedRows = (await sql`
      SELECT id, title, source_name, provider, feed_name, status, relevance_score,
             corroborations, is_rumour, story_stage, is_followup, duplicate_kind,
             reject_kind, decision_reason, attempts, last_error, headline, explanation,
             age_minutes_at_discovery, freshness_category, next_retry_at, created_at,
             published_at, first_seen_at, posted_at, fb_post_id,
             image_status, image_error, image_origin, publish_mode, fallback_reason, fb_photo_id
      FROM news_items
      WHERE status = 'published'
      ORDER BY posted_at DESC NULLS LAST
      LIMIT 10
    `) as Record<string, unknown>[];

    const feedRows = (await sql`
      SELECT id, name, topic, url, enabled, paused, priority, domain,
             next_check_at, poll_interval_minutes, last_http_status, fetch_ms,
             last_fetched_at, last_success_at,
             latest_item_at, last_status, last_error, consecutive_failures, items_seen
      FROM rss_feeds
      ORDER BY
        CASE last_status WHEN 'error' THEN 0 WHEN 'untested' THEN 1 ELSE 2 END,
        last_fetched_at DESC NULLS LAST
      LIMIT 60
    `) as Record<string, unknown>[];

    const feedStatsRows = (await sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE last_status IN ('ok','not_modified'))::int AS healthy,
        count(*) FILTER (WHERE last_status = 'error')::int AS failing,
        count(*) FILTER (WHERE last_status = 'untested' OR last_status IS NULL)::int AS untested,
        count(*) FILTER (WHERE last_status = 'skipped_backoff')::int AS backoff
      FROM rss_feeds
    `) as { total: number; healthy: number; failing: number; untested: number; backoff: number }[];

    const [registry, queueReset, floodState] = await Promise.all([
      getRegistryStats(),
      getLastQueueReset(),
      checkFloodControl(),
    ]);
    const batchRows = (await sql`
      SELECT started_at, finished_at, status, processed, articles, avg_fetch_ms
      FROM feed_batches ORDER BY started_at DESC LIMIT 5
    `) as Record<string, unknown>[];
    const runningRows = (await sql`
      SELECT count(*)::int AS n FROM feed_batches
      WHERE status = 'running' AND started_at > now() - interval '10 minutes'
    `) as { n: number }[];
    const lastDone = batchRows.find((b) => b.finished_at !== null);

    const publish = await getPublishState();
    const scan = await getScanState();
    const lastSuccessRows = (await sql`
      SELECT id, started_at, finished_at, status,
             fetched, new_candidates, rejected,
             duplicates_skipped, published, discovery_error, publish_error, error,
             feeds_checked, feeds_ok, rss_fetched, rss_new_candidates,
             exact_duplicates, story_duplicates, stale_rejected, followups_accepted,
             stale_not_new, publish_skipped_reason
      FROM automation_runs
      WHERE status <> 'error' AND feeds_ok > 0
      ORDER BY started_at DESC
      LIMIT 1
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
      trending: 0,
      failed: 0,
      awaiting_retry: 0,
      expired: 0,
      cancelled: 0,
      superseded: 0,
      with_photo: 0,
      text_only: 0,
      image_validated: 0,
      image_rejected: 0,
      image_none: 0,
    };

    const recentRuns = runRows.map(toRun);
    const recentPublished = publishedRows.map(toStory);

    return {
      generatedAt: new Date().toISOString(),
      transport: dbTransport(),
      cron: {
        intervalMinutes: getConfig().cronIntervalMinutes,
        runsPerDay: runsPerDay(),
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
        trending: totals.trending,
        failed: totals.failed,
        awaitingRetry: totals.awaiting_retry,
        expired: totals.expired,
        cancelled: totals.cancelled,
        superseded: totals.superseded,
        withPhoto: totals.with_photo,
        textOnly: totals.text_only,
        imageValidated: totals.image_validated,
        imageRejected: totals.image_rejected,
        imageNone: totals.image_none,
        runsToday: runCountsRows[0]?.runs_today ?? 0,
      },
      publish,
      scan,
      feedSummary: {
        total: feedStatsRows[0]?.total ?? 0,
        catalogue: FEED_COUNT,
        healthy: feedStatsRows[0]?.healthy ?? 0,
        failing: feedStatsRows[0]?.failing ?? 0,
        untested: feedStatsRows[0]?.untested ?? 0,
        backoff: feedStatsRows[0]?.backoff ?? 0,
        shown: Math.min(feedRows.length, 60),
      },
      registry,
      queueReset,
      flood: {
        maxPerHour: maxPostsPerHour(),
        minSpacingMinutes: minSpacingMinutes(),
        popularityMinScore: popularityMinScore(),
        postsLastHour: floodState.postsLastHour,
        minutesSinceLastPost: floodState.minutesSinceLastPost,
        nextEligibleAt: floodState.nextEligibleAt,
      },
      batches: {
        lastFinishedAt: isoStringOrNull(lastDone?.finished_at),
        lastProcessed: toNumber(lastDone?.processed),
        lastArticles: toNumber(lastDone?.articles),
        lastAvgFetchMs: lastDone?.avg_fetch_ms === null || lastDone?.avg_fetch_ms === undefined
          ? null : toNumber(lastDone.avg_fetch_ms),
        running: runningRows[0]?.n ?? 0,
      },
      lastRun: recentRuns[0] ?? null,
      lastSuccessfulRun: lastSuccessRows[0] ? toRun(lastSuccessRows[0]) : null,
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
    staleNotNew: toNumber(row.stale_not_new),
    publishSkippedReason: stringOrNull(row.publish_skipped_reason),
    discoveryError: stringOrNull(row.discovery_error),
    publishError: stringOrNull(row.publish_error),
    error: stringOrNull(row.error),
  };
}

function toStory(row: Record<string, unknown>): DashboardStory {
  const provider = String(row.provider ?? "rss");
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
    headline: stringOrNull(row.headline),
    explanation: stringOrNull(row.explanation),
    ageMinutesAtDiscovery: row.age_minutes_at_discovery === null ? null : toNumber(row.age_minutes_at_discovery),
    publishedAt: isoStringOrNull(row.published_at),
    firstSeenAt: isoStringOrNull(row.first_seen_at),
    freshnessCategory: stringOrNull(row.freshness_category),
    imageStatus: stringOrNull(row.image_status),
    imageError: stringOrNull(row.image_error),
    imageOrigin: stringOrNull(row.image_origin),
    publishMode: stringOrNull(row.publish_mode),
    fallbackReason: stringOrNull(row.fallback_reason),
    fbPhotoId: stringOrNull(row.fb_photo_id),
    isFollowup: row.is_followup === true,
    duplicateKind: stringOrNull(row.duplicate_kind),
    rejectKind: stringOrNull(row.reject_kind),
    decisionReason: stringOrNull(row.decision_reason),
    attempts: toNumber(row.attempts),
    lastError: stringOrNull(row.last_error),
    nextRetryAt: isoStringOrNull(row.next_retry_at),
    createdAt: isoString(row.created_at),
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
    topic: stringOrNull(row.topic),
    lastFetchedAt: isoStringOrNull(row.last_fetched_at),
    lastSuccessAt: isoStringOrNull(row.last_success_at),
    latestItemAt: isoStringOrNull(row.latest_item_at),
    lastStatus: stringOrNull(row.last_status),
    lastError: stringOrNull(row.last_error),
    consecutiveFailures: toNumber(row.consecutive_failures),
    itemsSeen: toNumber(row.items_seen),
    paused: row.paused === true,
    priority: toNumber(row.priority),
    nextCheckAt: isoStringOrNull(row.next_check_at),
    pollIntervalMinutes: toNumber(row.poll_interval_minutes),
    lastHttpStatus: row.last_http_status === null ? null : toNumber(row.last_http_status),
    fetchMs: row.fetch_ms === null ? null : toNumber(row.fetch_ms),
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
