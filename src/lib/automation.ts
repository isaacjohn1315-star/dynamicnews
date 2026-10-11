import { randomUUID } from "node:crypto";
import { ensureSchema, getDb, type NewsItemRow } from "./db";
import {
  buildFacebookPostText,
  FacebookPublishError,
  findRecentMatchingPost,
  isValidPostText,
  publishToFacebook,
} from "./facebook";
import { buildDedupeKey, fetchLatestFootballNews, type NewsDataArticle } from "./newsdata";
import {
  evaluateArticle,
  findDuplicateStory,
  normalizeSourceName,
  parsePubDate,
  rateSource,
  type NormalizedArticle,
  type StoryTokenSet,
} from "./relevance";
import { DAILY_NEWSDATA_REQUEST_LIMIT, getBudgetStats } from "./request-budget";
import { fetchRssFeeds, type RssArticle, type RssDiscoveryResult } from "./rss";
import { buildExplanation, composePost } from "./compose";
import { evaluateFreshness, getScanState, recordScan } from "./freshness";
import {
  claimPublishSlot,
  getPublishState,
  isHighPriorityStory,
  releasePublishSlot,
  type SlotRefusal,
} from "./publishing";
import { cleanText } from "./text";
import { buildStoryIdentity, isMaterialFollowUp, STAGE_RANK, type StoryStage, type StoryStage as Stage } from "./story";

/**
 * DynaSport automation pipeline — runs 24/7, every 10 minutes, all year.
 *
 *   cron-job.org (every 10 minutes, around the clock)
 *     -> protected /api/football/automation endpoint
 *     -> single-flight lease (overlapping runs exit early)
 *     -> paced publish of the next queued story, one per run, no daily cap
 *        (retry-safe; uncertain
 *        Facebook outcomes are reconciled before any retry)
 *     -> shared daily budget check (max 200 NewsData.io requests/day)
 *     -> NewsData.io discovery (at most one request per run)
 *     -> rotating validated RSS feeds (zero NewsData credits; keeps
 *        working after the NewsData budget is exhausted)
 *     -> relevance + freshness + source filtering
 *     -> three-layer duplicate protection (exact article, same story,
 *        database claim) with materially-new-development follow-ups
 *     -> Neon PostgreSQL
 *     -> concise DynaSport post -> Meta Graph API -> Facebook Page
 *
 * Every run is bounded by RUN_DEADLINE_MS because cron-job.org aborts the
 * connection after 30 seconds. Work that does not fit simply happens on
 * the next run ten minutes later — the system recovers automatically.
 */

const MAX_PUBLISH_ATTEMPTS = 8;
const RUN_DEADLINE_MS = 22_000;
const PUBLISH_DEADLINE_MS = 14_000;
const LEASE_SECONDS = 50;

interface RssRunStats {
  feedsChecked: number;
  feedsOk: number;
  fetched: number;
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
  errors: number;
}

interface DedupeStats {
  exactDuplicates: number;
  storyDuplicates: number;
  staleRejected: number;
  irrelevantRejected: number;
  followUpsAccepted: number;
}

export interface AutomationSummary {
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: "ok" | "budget_exhausted" | "skipped_overlap" | "error";
  trigger: string;
  newsdataRequests: number;
  budgetUsedToday: number | null;
  budgetLimit: number;
  fetched: number;
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
  dedupe: DedupeStats;
  notNewRejected: number;
  rss: RssRunStats;
  publish: {
    attempted: boolean;
    published: boolean;
    reconciled: boolean;
    /** True when the story bypassed ordinary spacing (breaking news). */
    highPriority: boolean;
    itemId: string | null;
    fbPostId: string | null;
    error: string | null;
    skippedReason: SlotRefusal | "no_candidate" | null;
    postsToday: number;
    nextEligibleAt: string | null;
  };
  discoveryError: string | null;
  error: string | null;
}

export async function runAutomation(trigger: "scheduled" | "manual" = "scheduled"): Promise<AutomationSummary> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + RUN_DEADLINE_MS;
  const summary: AutomationSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    status: "ok",
    trigger,
    newsdataRequests: 0,
    budgetUsedToday: null,
    budgetLimit: DAILY_NEWSDATA_REQUEST_LIMIT,
    fetched: 0,
    newCandidates: 0,
    rejected: 0,
    duplicatesSkipped: 0,
    dedupe: {
      exactDuplicates: 0,
      storyDuplicates: 0,
      staleRejected: 0,
      irrelevantRejected: 0,
      followUpsAccepted: 0,
    },
    rss: { feedsChecked: 0, feedsOk: 0, fetched: 0, newCandidates: 0, rejected: 0, duplicatesSkipped: 0, errors: 0 },
    notNewRejected: 0,
    publish: {
      attempted: false, published: false, reconciled: false, highPriority: false,
      itemId: null, fbPostId: null, error: null, skippedReason: null,
      postsToday: 0, nextEligibleAt: null,
    },
    discoveryError: null,
    error: null,
  };

  try {
    await ensureSchema();
  } catch (error) {
    summary.status = "error";
    summary.error = `Database unavailable: ${errorMessage(error)}`;
    finalize(summary, startedAt);
    return summary;
  }

  // Single-flight: if another execution is mid-run, exit immediately. The
  // budget counter and publication claims are independently safe, so this
  // is purely to avoid redundant work from overlapping triggers.
  const lease = await acquireLease();
  if (!lease) {
    summary.status = "skipped_overlap";
    finalize(summary, startedAt);
    await recordRun(summary);
    return summary;
  }

  const scan = await getScanState();

  try {
    // Stage 1 — publish the next queued story (no NewsData credit used).
    try {
      await publishNextCandidate(summary);
    } catch (error) {
      summary.publish.error = errorMessage(error);
    }

    // Stage 2 — NewsData.io discovery inside the shared daily budget.
    if (Date.now() < deadline) {
      try {
        const fetchResult = await fetchLatestFootballNews();
        if (fetchResult.kind === "limit_reached") {
          summary.status = "budget_exhausted";
        } else if (fetchResult.kind === "error") {
          summary.discoveryError = fetchResult.error;
          summary.newsdataRequests = fetchResult.error.includes("not configured") ? 0 : 1;
        } else {
          summary.newsdataRequests = 1;
          summary.fetched = fetchResult.received;
          await ingestNewsDataArticles(fetchResult.articles, summary, scan.lastSuccessfulScanAt);
        }
      } catch (error) {
        summary.discoveryError = errorMessage(error);
      }
    }

    // Stage 3 — RSS discovery. Always attempted: it costs no NewsData
    // credit, so coverage continues after the daily budget is exhausted.
    let rssResult: RssDiscoveryResult | null = null;
    if (Date.now() < deadline) {
      try {
        rssResult = await fetchRssFeeds(deadline);
        summary.rss.feedsChecked = rssResult.feedsChecked;
        summary.rss.feedsOk = rssResult.feedsOk;
        summary.rss.fetched = rssResult.fetched;
        summary.rss.errors = rssResult.outcomes.filter((o) => o.status === "error").length;
        await ingestRssArticles(rssResult.articles, summary, scan.lastSuccessfulScanAt);
      } catch (error) {
        const message = errorMessage(error);
        summary.discoveryError = summary.discoveryError
          ? `${summary.discoveryError}; RSS: ${message}`
          : `RSS: ${message}`;
      }
    }

    try {
      const budget = await getBudgetStats();
      summary.budgetUsedToday = budget.used;
    } catch {
      summary.budgetUsedToday = null;
    }

    const newsdataFailed =
      summary.discoveryError !== null && summary.newsdataRequests === 0 && summary.fetched === 0;
    const rssFailed =
      rssResult === null || (rssResult.feedsChecked > 0 && rssResult.feedsOk === 0 && rssResult.articles.length === 0);
    if (summary.status === "ok" && newsdataFailed && rssFailed && summary.discoveryError) {
      // Transient: the next scheduled run (10 minutes later) retries.
      summary.status = "error";
      summary.error = "All discovery paths failed this run";
    }
    // Checkpoint the scan: successful only when discovery actually worked,
    // so an outage cannot advance the freshness window past missed stories.
    const discoveryWorked =
      (rssResult !== null && rssResult.feedsOk > 0) || summary.fetched > 0;
    await recordScan(discoveryWorked);
  } finally {
    await releaseLease(lease);
  }

  finalize(summary, startedAt);
  await recordRun(summary);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Single-flight lease                                                  */
/* ------------------------------------------------------------------ */

async function acquireLease(): Promise<string | null> {
  try {
    const sql = getDb();
    const holder = randomUUID();
    const rows = (await sql`
      INSERT INTO automation_lease (id, holder, acquired_at, expires_at)
      VALUES (1, ${holder}::uuid, now(), now() + make_interval(secs => ${LEASE_SECONDS}))
      ON CONFLICT (id) DO UPDATE
        SET holder = ${holder}::uuid,
            acquired_at = now(),
            expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE automation_lease.expires_at IS NULL
           OR automation_lease.expires_at < now()
      RETURNING holder
    `) as { holder: string }[];
    return rows.length > 0 ? holder : null;
  } catch {
    // If leasing is unavailable, continue: budget and publication claims
    // remain atomic, so correctness does not depend on the lease.
    return randomUUID();
  }
}

async function releaseLease(holder: string | null): Promise<void> {
  if (!holder) return;
  try {
    const sql = getDb();
    await sql`
      UPDATE automation_lease
      SET expires_at = now()
      WHERE id = 1 AND holder = ${holder}::uuid
    `;
  } catch {
    // Lease expires on its own; nothing to do.
  }
}

/* ------------------------------------------------------------------ */
/* Stage 1: atomic claim + publish + reconcile                          */
/* ------------------------------------------------------------------ */

async function publishNextCandidate(summary: AutomationSummary): Promise<void> {
  const sql = getDb();

  // Peek at the best eligible candidate BEFORE consuming a publishing slot.
  const peek = (await sql`
    SELECT id, relevance_score, story_stage_rank, is_rumour, source_name
    FROM news_items
    WHERE status = 'candidate'
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY relevance_score DESC, published_at DESC NULLS LAST, created_at ASC
    LIMIT 1
  `) as {
    id: string;
    relevance_score: number;
    story_stage_rank: number;
    is_rumour: boolean;
    source_name: string | null;
  }[];

  const state = await getPublishState();
  summary.publish.postsToday = state.postsToday;
  summary.publish.nextEligibleAt = state.nextEligibleAt;

  if (peek.length === 0) {
    summary.publish.skippedReason = "no_candidate";
    return;
  }

  // A high-priority story bypasses the ordinary spacing interval. This
  // covers confirmed announcements AND significant rumours from credible
  // reporters, because transfer rumours are core football-news content.
  // It is a pacing bypass only — there is no daily allowance, so no story
  // is ever held back by a post counter.
  const highPriority = isHighPriorityStory(
    peek[0].relevance_score,
    peek[0].story_stage_rank ?? 0,
    peek[0].is_rumour,
    rateSource(peek[0].source_name, null),
  );

  const slot = await claimPublishSlot(highPriority);
  summary.publish.postsToday = slot.postsToday;
  summary.publish.nextEligibleAt = slot.nextEligibleAt;
  if (!slot.granted) {
    // Ordinary post inside the short spacing window: nothing is published
    // this run, and the story simply goes out on the next run. Discovery,
    // filtering and deduplication continue regardless.
    summary.publish.skippedReason = slot.reason;
    return;
  }
  summary.publish.highPriority = highPriority;

  // Atomically claim exactly one candidate article.
  const claimed = (await sql`
    UPDATE news_items
    SET status = 'publishing',
        attempts = attempts + 1,
        last_attempt_at = now(),
        updated_at = now()
    WHERE id = (
      SELECT id FROM news_items
      WHERE status = 'candidate'
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      ORDER BY relevance_score DESC,
               published_at DESC NULLS LAST,
               created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, title, source_name, post_text, attempts,
              story_fingerprint, story_stage, story_stage_rank, is_followup
  `) as Pick<
    NewsItemRow,
    | "id" | "title" | "source_name" | "post_text" | "attempts"
    | "story_fingerprint" | "story_stage" | "story_stage_rank" | "is_followup"
  >[];

  if (claimed.length === 0) {
    await releasePublishSlot();
    summary.publish.skippedReason = "no_candidate";
    return;
  }

  const item = claimed[0];
  summary.publish.attempted = true;
  summary.publish.itemId = item.id;

  if (!item.post_text || !isValidPostText(item.post_text)) {
    await releaseClaim(item.id, item.attempts, "Stored post text failed DynaSport format validation");
    await releasePublishSlot();
    summary.publish.error = "Stored post text failed format validation; item rescheduled";
    return;
  }

  // Layer C - database enforcement. One post per (story, stage).
  const fingerprint = item.story_fingerprint;
  const stageRank = item.story_stage_rank ?? 0;
  if (fingerprint) {
    const claimRows = (await sql`
      INSERT INTO story_publications (fingerprint, stage_rank, news_item_id, claimed_at)
      VALUES (${fingerprint}, ${stageRank}, ${item.id}::uuid, now())
      ON CONFLICT (fingerprint, stage_rank) DO NOTHING
      RETURNING fingerprint
    `) as { fingerprint: string }[];

    if (claimRows.length === 0) {
      await sql`
        UPDATE news_items
        SET status = 'duplicate',
            duplicate_kind = 'story',
            decision_reason = 'story already published at this stage',
            next_retry_at = NULL,
            updated_at = now()
        WHERE id = ${item.id}
      `;
      await releasePublishSlot();
      summary.duplicatesSkipped += 1;
      summary.dedupe.storyDuplicates += 1;
      return;
    }
  }

  try {
    const result = await publishToFacebook(item.post_text);
    await markPublished(item, result.id);
    summary.publish.published = true;
    summary.publish.fbPostId = result.id;
  } catch (error) {
    const uncertain = error instanceof FacebookPublishError ? error.uncertain : true;
    if (uncertain) {
      const found = await findRecentMatchingPost(item.post_text);
      if (found) {
        await markPublished(item, found.id);
        summary.publish.published = true;
        summary.publish.reconciled = true;
        summary.publish.fbPostId = found.id;
        return;
      }
    }
    const message = errorMessage(error);
    if (fingerprint) {
      try {
        await sql`
          DELETE FROM story_publications
          WHERE fingerprint = ${fingerprint} AND stage_rank = ${stageRank} AND published_at IS NULL
        `;
      } catch {
        // Claim expires with the item; retry logic still applies.
      }
    }
    await releaseClaim(item.id, item.attempts, message);
    await releasePublishSlot();
    summary.publish.error = message;
  }
}

async function markPublished(
  item: { id: string; story_fingerprint: string | null; story_stage: string | null; story_stage_rank: number; is_followup: boolean },
  fbPostId: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE news_items
    SET status = 'published',
        fb_post_id = ${fbPostId},
        posted_at = now(),
        next_retry_at = NULL,
        last_error = NULL,
        updated_at = now()
    WHERE id = ${item.id}
  `;

  if (!item.story_fingerprint) return;

  await sql`
    UPDATE story_publications
    SET fb_post_id = ${fbPostId}, published_at = now()
    WHERE fingerprint = ${item.story_fingerprint} AND stage_rank = ${item.story_stage_rank}
  `;

  // The story is now published at this stage and is excluded from any
  // future publication attempt below this stage, forever.
  await sql`
    UPDATE stories
    SET published_stage = ${item.story_stage},
        published_stage_rank = GREATEST(published_stage_rank, ${item.story_stage_rank}),
        published_count = published_count + 1,
        followups_published = followups_published + ${item.is_followup ? 1 : 0},
        last_published_at = now(),
        updated_at = now()
    WHERE fingerprint = ${item.story_fingerprint}
  `;
}

/**
 * A failed Facebook post is never marked as published: it returns to the
 * candidate queue with exponential backoff and stays retryable until the
 * attempt ceiling, after which it is parked as "failed" (unpublished and
 * visible on the dashboard).
 */
async function releaseClaim(id: string, attempts: number, error: string): Promise<void> {
  const sql = getDb();
  const exhausted = attempts >= MAX_PUBLISH_ATTEMPTS;
  const backoffMinutes = Math.min(240, 5 * 2 ** Math.max(0, attempts - 1));

  if (exhausted) {
    await sql`
      UPDATE news_items
      SET status = 'failed', last_error = ${error}, next_retry_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
    return;
  }

  await sql`
    UPDATE news_items
    SET status = 'candidate',
        last_error = ${error},
        next_retry_at = now() + make_interval(mins => ${backoffMinutes}),
        updated_at = now()
    WHERE id = ${id}
  `;
}

/* ------------------------------------------------------------------ */
/* Stage 2/3: ingestion (shared by NewsData.io and RSS)                  */
/* ------------------------------------------------------------------ */

interface IngestCounters {
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
}

async function ingestNewsDataArticles(articles: NewsDataArticle[], summary: AutomationSummary, lastScanAt: string | null): Promise<void> {
  const inputs: (NormalizedArticle & { articleId: string })[] = [];
  for (const raw of articles) {
    const normalized = normalizeNewsDataArticle(raw);
    if (!normalized) {
      summary.duplicatesSkipped += 1;
      summary.dedupe.exactDuplicates += 1;
      continue;
    }
    inputs.push(normalized);
  }
  const counters = await ingestNormalized(inputs, "newsdata", null, summary, lastScanAt);
  summary.newCandidates += counters.newCandidates;
  summary.rejected += counters.rejected;
  summary.duplicatesSkipped += counters.duplicatesSkipped;
}

async function ingestRssArticles(articles: RssArticle[], summary: AutomationSummary, lastScanAt: string | null): Promise<void> {
  const inputs: (NormalizedArticle & { articleId: string })[] = [];
  const feedByDedupeKey = new Map<string, string>();
  for (const raw of articles) {
    feedByDedupeKey.set(raw.dedupeKey, raw.feedName);
    inputs.push({
      articleId: raw.dedupeKey,
      title: raw.title,
      description: raw.description,
      articleUrl: raw.link,
      sourceName: raw.feedName,
      sourceId: null,
      publishedAt: raw.publishedAt,
      language: "en",
      categories: ["sports"],
      fromFootballFeed: true,
    });
  }
  const counters = await ingestNormalized(inputs, "rss", feedByDedupeKey, summary, lastScanAt);
  summary.rss.newCandidates += counters.newCandidates;
  summary.rss.rejected += counters.rejected;
  summary.rss.duplicatesSkipped += counters.duplicatesSkipped;
}

/**
 * Shared ingestion implementing duplicate-protection layers A and B:
 *   A. exact article identity (unique dedupe key in the database);
 *   B. same-story identity (deterministic fingerprint + headline
 *      similarity across publishers), with stage-aware follow-ups.
 */
async function ingestNormalized(
  inputs: (NormalizedArticle & { articleId: string })[],
  provider: "newsdata" | "rss",
  feedByDedupeKey: Map<string, string> | null,
  summary: AutomationSummary,
  lastScanAt: string | null,
): Promise<IngestCounters> {
  const counters: IngestCounters = { newCandidates: 0, rejected: 0, duplicatesSkipped: 0 };
  if (inputs.length === 0) return counters;

  const sql = getDb();

  // Recent stories for cross-publisher similarity matching.
  const recentRows = (await sql`
    SELECT id, title_tokens, story_fingerprint
    FROM news_items
    WHERE status IN ('candidate', 'publishing', 'published', 'failed')
      AND created_at > now() - interval '5 days'
    ORDER BY created_at DESC
    LIMIT 300
  `) as { id: string; title_tokens: unknown; story_fingerprint: string | null }[];

  const recent: StoryTokenSet[] = recentRows
    .map((row) => ({
      id: row.story_fingerprint ?? null,
      tokens: Array.isArray(row.title_tokens) ? (row.title_tokens as string[]) : [],
    }))
    .filter((set) => set.tokens.length > 0);

  const batchSets: StoryTokenSet[] = [];

  for (const article of inputs) {
    const decision = evaluateArticle(article);
    const sourceName = normalizeSourceName({
      source_name: article.sourceName,
      source_id: article.sourceId,
    });
    const feedName =
      provider === "rss" ? feedByDedupeKey?.get(article.articleId) ?? article.sourceName : null;

    const identity = buildStoryIdentity(article.title, article.description);

    // Layer B — canonicalize the fingerprint: if this headline closely
    // matches a story already captured from another publisher, adopt that
    // story's fingerprint so both map to one underlying story.
    const similar = decision.relevant
      ? findDuplicateStory(decision.titleTokens, [...recent, ...batchSets])
      : null;
    const fingerprint = similar?.id ?? identity.fingerprint;

    let status: "candidate" | "rejected" | "duplicate" = decision.relevant ? "candidate" : "rejected";
    let duplicateKind: string | null = null;
    let isFollowUp = false;
    let reason = decision.reason;

    if (decision.relevant) {
      const storyRows = (await sql`
        SELECT published_stage_rank, published_count, followups_published
        FROM stories
        WHERE fingerprint = ${fingerprint}
      `) as { published_stage_rank: number; published_count: number; followups_published: number }[];

      const story = storyRows[0];
      if (story && story.published_count > 0) {
        // The underlying story has already been posted. Only a materially
        // new development (bid / agreement / official) may post again.
        if (isMaterialFollowUp(story.published_stage_rank, identity.stageRank, story.followups_published)) {
          isFollowUp = true;
          reason = `follow-up: story advanced to "${identity.stage}" (was rank ${story.published_stage_rank})`;
        } else {
          status = "duplicate";
          duplicateKind = "story";
          reason = "duplicate of a story DynaSport already published";
        }
      } else if (similar) {
        // Same story already queued (not yet posted) — do not queue twice.
        status = "duplicate";
        duplicateKind = "story";
        reason = "duplicate of a story already queued from another source";
      }
    }

    // --- Freshness gate: only genuinely NEW stories may be published ---
    const freshness = evaluateFreshness(article.publishedAt, provider, lastScanAt);
    if (status === "candidate" && !freshness.publishable) {
      status = "rejected";
      reason = freshness.reason;
      summary.notNewRejected += 1;
    }

    // --- Compose headline + explanation ---
    let postText: string | null = null;
    let headline: string | null = null;
    let explanation: string | null = null;
    if (status === "candidate" && decision.statement && sourceName) {
      const body = buildExplanation(
        article.description,
        decision.statement,
        identity.stage,
        decision.isRumour,
      );
      const composed = body ? composePost(decision.statement, body, sourceName) : null;
      if (composed) {
        postText = composed.message;
        headline = composed.headline;
        explanation = composed.explanation;
      } else {
        status = "rejected";
        reason = "no accurate, useful explanation could be produced from the source report";
      }
    } else if (status === "candidate") {
      status = "rejected";
      reason = "no trustworthy source attribution for a publishable statement";
    }

    // Layer A — exact article identity. The unique key makes this
    // race-safe across concurrent runs.
    const inserted = (await sql`
      INSERT INTO news_items (
        dedupe_key, title, title_tokens, description, article_url,
        source_name, source_id, published_at, language,
        relevance_score, is_rumour, post_text, status, decision_reason,
        provider, feed_name,
        story_fingerprint, story_stage, story_stage_rank, is_followup,
        duplicate_kind, reject_kind, headline, explanation, age_minutes_at_discovery
      )
      VALUES (
        ${article.articleId}, ${article.title}, ${JSON.stringify(decision.titleTokens)}::jsonb,
        ${article.description}, ${article.articleUrl}, ${sourceName}, ${article.sourceId},
        ${article.publishedAt ? article.publishedAt.toISOString() : null}, ${article.language},
        ${decision.score}, ${decision.isRumour}, ${postText}, ${status}, ${reason},
        ${provider}, ${feedName},
        ${fingerprint}, ${identity.stage}, ${identity.stageRank}, ${isFollowUp},
        ${duplicateKind}, ${decision.rejectKind}, ${headline}, ${explanation},
        ${freshness.ageMinutes}
      )
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    if (inserted.length === 0) {
      counters.duplicatesSkipped += 1;
      summary.dedupe.exactDuplicates += 1;
      continue;
    }

    // Track the story itself (identity, not publication state).
    await upsertStory(fingerprint, identity.entities, identity.eventKind, decision.titleTokens, article.title);

    if (status === "candidate") {
      counters.newCandidates += 1;
      if (isFollowUp) summary.dedupe.followUpsAccepted += 1;
      if (decision.titleTokens.length > 0) {
        batchSets.push({ id: fingerprint, tokens: decision.titleTokens });
      }
    } else if (status === "duplicate") {
      counters.duplicatesSkipped += 1;
      summary.dedupe.storyDuplicates += 1;
      if (similar) {
        const boost = decision.credibility === "top" || decision.credibility === "mainstream" ? 4 : 2;
        try {
          await sql`
            UPDATE news_items
            SET corroborations = corroborations + 1,
                relevance_score = LEAST(relevance_score + ${boost}, 130),
                updated_at = now()
            WHERE story_fingerprint = ${fingerprint} AND status = 'candidate'
          `;
        } catch {
          // Opportunistic ranking boost only.
        }
      }
    } else {
      counters.rejected += 1;
      if (decision.rejectKind === "stale") summary.dedupe.staleRejected += 1;
      else summary.dedupe.irrelevantRejected += 1;
    }
  }

  return counters;
}

async function upsertStory(
  fingerprint: string,
  entities: string[],
  eventKind: string,
  titleTokens: string[],
  title: string,
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO stories (fingerprint, entities, event_kind, title_tokens, representative_title)
      VALUES (${fingerprint}, ${JSON.stringify(entities)}::jsonb, ${eventKind},
              ${JSON.stringify(titleTokens)}::jsonb, ${title})
      ON CONFLICT (fingerprint) DO UPDATE
        SET last_seen_at = now(), updated_at = now()
    `;
  } catch {
    // Story bookkeeping must never break ingestion.
  }
}

function normalizeNewsDataArticle(raw: NewsDataArticle): (NormalizedArticle & { articleId: string }) | null {
  const title = cleanText(raw.title);
  if (!title) return null;

  const dedupeKey = buildDedupeKey(raw);
  if (!dedupeKey) return null;

  return {
    articleId: dedupeKey,
    title,
    description: cleanText(raw.description) || null,
    articleUrl: typeof raw.link === "string" && raw.link.trim().length > 0 ? raw.link.trim() : null,
    sourceName: normalizeSourceName(raw),
    sourceId:
      typeof raw.source_id === "string" && raw.source_id.trim().length > 0 ? raw.source_id.trim() : null,
    publishedAt: parsePubDate(raw.pubDate),
    language: typeof raw.language === "string" ? raw.language.trim().toLowerCase() : null,
    categories: Array.isArray(raw.category)
      ? raw.category.filter((c): c is string => typeof c === "string")
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* Run bookkeeping                                                      */
/* ------------------------------------------------------------------ */

async function recordRun(summary: AutomationSummary): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO automation_runs (
        trigger_source, started_at, finished_at, status,
        newsdata_requests, budget_used_today, fetched, new_candidates,
        rejected, duplicates_skipped, published, discovery_error,
        publish_error, error, summary,
        feeds_checked, feeds_ok, rss_fetched, rss_new_candidates,
        exact_duplicates, story_duplicates, stale_rejected, followups_accepted,
        stale_not_new, publish_skipped_reason
      )
      VALUES (
        ${summary.trigger}, ${summary.startedAt}, ${summary.finishedAt}, ${summary.status},
        ${summary.newsdataRequests}, ${summary.budgetUsedToday}, ${summary.fetched},
        ${summary.newCandidates}, ${summary.rejected}, ${summary.duplicatesSkipped},
        ${summary.publish.published ? 1 : 0}, ${summary.discoveryError},
        ${summary.publish.error}, ${summary.error}, ${JSON.stringify(summary)}::jsonb,
        ${summary.rss.feedsChecked}, ${summary.rss.feedsOk}, ${summary.rss.fetched},
        ${summary.rss.newCandidates},
        ${summary.dedupe.exactDuplicates}, ${summary.dedupe.storyDuplicates},
        ${summary.dedupe.staleRejected}, ${summary.dedupe.followUpsAccepted},
        ${summary.notNewRejected}, ${summary.publish.skippedReason}
      )
    `;
  } catch {
    // Bookkeeping must never break the automation result itself.
  }
}

function finalize(summary: AutomationSummary, startedAt: Date): void {
  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let safe = message;
  for (const envName of ["NEWSDATA_API_KEY", "FACEBOOK_PAGE_ACCESS_TOKEN", "FACEBOOK_APP_SECRET", "CRON_SECRET"]) {
    const secret = process.env[envName];
    if (secret && secret.length > 0) {
      safe = safe.split(secret).join("[redacted]");
    }
  }
  return safe;
}

export { STAGE_RANK, type StoryStage };
