import { randomUUID } from "node:crypto";
import { ensureSchema, getDb, type NewsItemRow } from "./db";
import { articleBudgetRemaining, fetchArticleContent, resetArticleBudget } from "./article";
import { buildExplanation, composePost, finalQualityCheck } from "./compose";
import {
  FacebookPublishError,
  findRecentMatchingPost,
  isValidPostText,
  postHashOf,
  publishPhotoToFacebook,
  publishToFacebook,
  releasePostHash,
} from "./facebook";
import {
  imageCandidatesFromHtml,
  resolveImage,
  type ImageCandidate,
} from "./image";
import {
  computeLifecycle,
  markInvalid,
  sweepExpired,
  validateBeforePublish,
} from "./lifecycle";
import { evaluateFreshness, getScanState, recordScan, type FreshnessVerdict } from "./freshness";
import {
  evaluateArticle,
  findDuplicateStory,
  normalizeSourceName,
  rateSource,
  type NormalizedArticle,
  type StoryTokenSet,
} from "./relevance";
import { getConfig, runsPerDay } from "./config";
import { fetchRssFeeds, type RssArticle, type RssDiscoveryResult } from "./rss";
import {
  buildStoryIdentity,
  isMaterialFollowUp,
  STAGE_RANK,
  type StoryStage,
} from "./story";
import {
  checkFloodControl,
  meetsPopularityBar,
  popularityScore,
  type PopularityInput,
} from "./flood";
import { clearQueueOnceOnDeploy } from "./queue";
import {
  claimPublishSlot,
  releasePublishSlot,
} from "./publishing";

/**
 * DynaSport automation pipeline — every 10 minutes, 24/7.
 *
 *   1. Expire anything whose publishing window closed (incl. retries).
 *   2. RSS batch discovery (never hits the whole registry).
 *   3. Deduplicate: exact article, cross-publisher story, story/stage
 *   4. Deduplicate: exact article, cross-publisher story, story/stage
 *      claims, and an exact post-text hash.
 *   5. Compose a context-aware post (fetch article detail when needed,
 *      run the final quality gate).
 *   6. Claim one atomic publish slot, validate the item's freshness and
 *      lifecycle IMMEDIATELY before the Facebook call, then post.
 *   7. Record the run in Neon.
 */
const PUBLISH_RESERVE_MS = 8_000;
const LEASE_SECONDS = 50;
const MAX_PUBLISH_ATTEMPTS = 8;

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
  status: "ok" | "skipped_overlap" | "error";
  trigger: string;
  /** Expected runs/day at the configured cron interval (reporting only). */
  runsPerDayExpected: number;
  fetched: number;
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
  notNewRejected: number;
  expired: number;
  /** Items cancelled by the one-time deploy clear (0 on normal runs). */
  queueCleared: number;
  dedupe: DedupeStats;
  rss: RssRunStats;
  publish: {
    attempted: boolean;
    published: boolean;
    reconciled: boolean;
    highPriority: boolean;
    itemId: string | null;
    fbPostId: string | null;
    error: string | null;
    skippedReason: "spacing" | "no_candidate" | null;
    postsToday: number;
    postsLastHour: number;
    nextEligibleAt: string | null;
    withPhoto: boolean;
    textFallback: boolean;
    popularityScore: number;
  };
  discoveryError: string | null;
  error: string | null;
}

export async function runAutomation(trigger: "scheduled" | "manual" = "scheduled"): Promise<AutomationSummary> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + getConfig().runDeadlineMs;
  const summary: AutomationSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    status: "ok",
    trigger,
    runsPerDayExpected: runsPerDay(),
    fetched: 0,
    newCandidates: 0,
    rejected: 0,
    duplicatesSkipped: 0,
    notNewRejected: 0,
    expired: 0,
    queueCleared: 0,
    dedupe: { exactDuplicates: 0, storyDuplicates: 0, staleRejected: 0, irrelevantRejected: 0, followUpsAccepted: 0 },
    rss: { feedsChecked: 0, feedsOk: 0, fetched: 0, newCandidates: 0, rejected: 0, duplicatesSkipped: 0, errors: 0 },
    publish: {
      attempted: false, published: false, reconciled: false, highPriority: false,
      itemId: null, fbPostId: null, error: null, skippedReason: null,
      postsToday: 0, postsLastHour: 0, nextEligibleAt: null,
      withPhoto: false, textFallback: false, popularityScore: 0,
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

  // One-time, automatic clear of any pre-existing queue backlog. Guarded by
  // a marker row so it runs only on the first run after deployment.
  const autoClear = await clearQueueOnceOnDeploy();
  if (autoClear) {
    summary.queueCleared = autoClear.cancelled;
  }

  const lease = await acquireLease();
  if (!lease) {
    summary.status = "skipped_overlap";
    finalize(summary, startedAt);
    await recordRun(summary);
    return summary;
  }

  const scan = await getScanState();
  resetArticleBudget();

  try {
    // Stage 1 — RSS discovery.
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

    // Stage 3 — publish the best eligible story, deadline-guarded.
    if (Date.now() < deadline + PUBLISH_RESERVE_MS) {
      try {
        await publishNextCandidate(summary);
      } catch (error) {
        summary.publish.error = errorMessage(error);
      }
    }

    const discoveryWorked = rssResult !== null && rssResult.feedsOk > 0;
    summary.fetched = rssResult ? rssResult.fetched : 0;
    await recordScan(discoveryWorked);
  } finally {
    await releaseLease(lease);
  }

  if (summary.status === "ok" && summary.discoveryError !== null && summary.rss.feedsOk === 0) {
    summary.status = "error";
    summary.error = "Feed discovery failed this run";
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
    return randomUUID();
  }
}

async function releaseLease(holder: string | null): Promise<void> {
  if (!holder) return;
  try {
    const sql = getDb();
    await sql`
      UPDATE automation_lease SET expires_at = now()
      WHERE id = 1 AND holder = ${holder}::uuid
    `;
  } catch {
    // Lease expires on its own.
  }
}

/* ------------------------------------------------------------------ */
/* Stage 3: expire, validate, claim, publish                           */
/* ------------------------------------------------------------------ */

async function publishNextCandidate(summary: AutomationSummary): Promise<void> {
  const sql = getDb();

  // Expire anything whose window closed — including items awaiting retry.
  const sweep = await sweepExpired();
  summary.expired += sweep.expired;

  const watermarkRows = (await sql`
    SELECT queue_reset_at FROM scan_state WHERE id = 1
  `) as { queue_reset_at: string | null }[];
  const queueResetAt = watermarkRows[0]?.queue_reset_at ?? null;

  const peek = (await sql`
    SELECT id, relevance_score, story_stage_rank, is_rumour, source_name, priority_score,
           story_fingerprint, freshness_category
    FROM news_items
    WHERE status = 'candidate'
      AND (next_retry_at IS NULL OR next_retry_at <= now())
      AND (publish_after IS NULL OR publish_after <= now())
      AND (expires_at IS NULL OR expires_at > now())
      AND (${queueResetAt}::timestamptz IS NULL OR first_seen_at >= ${queueResetAt}::timestamptz)
    ORDER BY priority_score DESC, published_at ASC NULLS LAST, created_at ASC
    LIMIT 1
  `) as {
    id: string;
    relevance_score: number;
    story_stage_rank: number;
    is_rumour: boolean;
    source_name: string | null;
    priority_score: number;
    story_fingerprint: string | null;
    freshness_category: string | null;
  }[];

  if (peek.length === 0) {
    summary.publish.skippedReason = "no_candidate";
    return;
  }

  // ── Anti-flood: no daily cap, but a rolling one-hour burst limit. ──
  // Posts may go out at any hour and any number per day; only rapid
  // bursts are limited, and the window rolls so nothing is held for long.
  const flood = await checkFloodControl();
  summary.publish.postsLastHour = flood.postsLastHour;
  summary.publish.nextEligibleAt = flood.nextEligibleAt;
  if (!flood.allowed) {
    summary.publish.skippedReason = "spacing";
    summary.publish.error = `anti-flood: ${flood.reason}`;
    return;
  }

  // ── Popularity bar: only stories with broad football interest publish. ──
  const popularityInput: PopularityInput = {
    relevanceScore: peek[0].relevance_score,
    distinctPublishers: await countDistinctPublishersFor(
      peek[0].story_fingerprint ?? null,
      peek[0].source_name,
    ),
    isRumour: peek[0].is_rumour,
    isFollowUp: false,
    sourceCredibility: rateSource(peek[0].source_name, null),
    freshnessCategory: (peek[0].freshness_category as PopularityInput["freshnessCategory"]) ?? null,
  };
  const popularity = meetsPopularityBar(popularityInput);
  summary.publish.popularityScore = popularity.score;
  if (!popularity.passes) {
    await markInvalid(String(peek[0].id), "cancelled", popularity.reason ?? "below popularity bar");
    summary.publish.skippedReason = "no_candidate";
    summary.publish.error = popularity.reason ?? "below popularity bar";
    return;
  }

  const highPriority = popularity.score >= 95;

  const slot = await claimPublishSlot(highPriority);
  summary.publish.nextEligibleAt = slot.nextEligibleAt ?? flood.nextEligibleAt;
  if (!slot.granted) {
    summary.publish.skippedReason = slot.reason;
    return;
  }
  summary.publish.highPriority = highPriority;

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
        AND (publish_after IS NULL OR publish_after <= now())
        AND (expires_at IS NULL OR expires_at > now())
        AND (${queueResetAt}::timestamptz IS NULL OR first_seen_at >= ${queueResetAt}::timestamptz)
      ORDER BY priority_score DESC, published_at ASC NULLS LAST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, title, source_name, post_text, attempts,
              story_fingerprint, story_stage, story_stage_rank, is_followup,
              fb_post_id, expires_at, event_at, event_category, first_seen_at, status,
              image_url, image_origin, image_publisher, article_url
  `) as Pick<
    NewsItemRow,
    | "id" | "title" | "source_name" | "post_text" | "attempts"
    | "story_fingerprint" | "story_stage" | "story_stage_rank" | "is_followup"
    | "fb_post_id" | "expires_at" | "event_at" | "event_category" | "first_seen_at" | "status"
    | "image_url" | "image_origin" | "image_publisher" | "article_url"
  >[];

  if (claimed.length === 0) {
    await releasePublishSlot();
    summary.publish.skippedReason = "no_candidate";
    return;
  }

  const item = claimed[0];
  summary.publish.attempted = true;
  summary.publish.itemId = item.id;

  // Final lifecycle validation immediately BEFORE the Facebook call.
  const invalid = await validateBeforePublish({
    id: String(item.id),
    status: item.status ?? "candidate",
    story_fingerprint: item.story_fingerprint,
    story_stage_rank: item.story_stage_rank ?? 0,
    post_text: item.post_text,
    fb_post_id: item.fb_post_id,
    expires_at: item.expires_at ? new Date(String(item.expires_at)) : null,
    event_at: item.event_at ? new Date(String(item.event_at)) : null,
    event_category: item.event_category ?? null,
    first_seen_at: new Date(String(item.first_seen_at)),
  });
  if (invalid) {
    await markInvalid(String(item.id), invalid.markStatus, invalid.reason);
    if (invalid.markStatus !== "duplicate") {
      await releaseStoryClaim(item.story_fingerprint, item.story_stage_rank ?? 0);
    }
    await releasePublishSlot();
    summary.publish.skippedReason = "no_candidate";
    summary.publish.error = invalid.reason;
    return;
  }

  if (!item.post_text || !isValidPostText(item.post_text)) {
    await releaseClaim(item.id, item.attempts, "Stored post text failed DynaSport format validation");
    await releasePublishSlot();
    summary.publish.error = "Stored post text failed format validation; item rescheduled";
    return;
  }

  // Layer C — one post per (story, stage), enforced by primary key.
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
        SET status = 'duplicate', duplicate_kind = 'story',
            decision_reason = 'story already published at this stage',
            next_retry_at = NULL, updated_at = now()
        WHERE id = ${item.id}
      `;
      await releasePublishSlot();
      summary.duplicatesSkipped += 1;
      summary.dedupe.storyDuplicates += 1;
      return;
    }
  }

  // ---- Image: download real bytes and validate before uploading ----
  // Resolution happens HERE, immediately before publishing, so an image is
  // only fetched for a story that actually passed every freshness,
  // duplicate and quality check.
  let imageResult: Awaited<ReturnType<typeof resolveImage>> | null = null;
  if (item.image_url) {
    imageResult = await resolveImage([
      {
        url: item.image_url,
        origin: (item.image_origin as ImageCandidate["origin"]) ?? "og:image",
        publisher: item.image_publisher ?? null,
      },
    ]);
    await recordImageOutcome(item.id, imageResult);
  } else {
    await sql`
      UPDATE news_items SET image_status = 'none_found', updated_at = now()
      WHERE id = ${item.id}
    `;
  }

  const usableImage = imageResult && imageResult.ok ? imageResult : null;

  try {
    if (usableImage) {
      // One combined photo + caption post.
      const result = await publishPhotoToFacebook(item.post_text, {
        bytes: usableImage.bytes,
        mime: usableImage.mime,
      });
      const postId = result.postId ?? result.id;
      await markPublished(
        {
          id: item.id,
          story_fingerprint: fingerprint,
          story_stage: item.story_stage,
          story_stage_rank: stageRank,
          is_followup: item.is_followup,
        },
        postId,
      );
      await sql`
        UPDATE news_items
        SET fb_photo_id = ${result.id}, publish_mode = 'photo',
            image_status = 'published_with_image', updated_at = now()
        WHERE id = ${item.id}
      `;
      summary.publish.published = true;
      summary.publish.fbPostId = postId;
      summary.publish.withPhoto = true;
      return;
    }

    const result = await publishToFacebook(item.post_text);
    await markPublished(
      {
        id: item.id,
        story_fingerprint: fingerprint,
        story_stage: item.story_stage,
        story_stage_rank: stageRank,
        is_followup: item.is_followup,
      },
      result.id,
    );
    await sql`
      UPDATE news_items
      SET publish_mode = 'text',
          fallback_reason = ${imageResult && !imageResult.ok ? imageResult.reason : "no image available"},
          updated_at = now()
      WHERE id = ${item.id}
    `;
    summary.publish.published = true;
    summary.publish.fbPostId = result.id;
  } catch (error) {
    const uncertain = error instanceof FacebookPublishError ? error.uncertain : true;

    // A photo upload that failed for a CERTAIN reason (bad media, size,
    // permissions) may fall back to a text-only post — but only after
    // confirming Facebook did not already accept it, so the same story can
    // never appear as both a photo post and a text post.
    if (usableImage && !uncertain) {
      const already = await findRecentMatchingPost(item.post_text);
      if (already) {
        await markPublished(
          {
            id: item.id, story_fingerprint: fingerprint, story_stage: item.story_stage,
            story_stage_rank: stageRank, is_followup: item.is_followup,
          },
          already.id,
        );
        summary.publish.published = true;
        summary.publish.reconciled = true;
        summary.publish.fbPostId = already.id;
        return;
      }
      try {
        // The failed photo attempt released its hash claim, so the same
        // caption can now publish as text.
        const fallback = await publishToFacebook(item.post_text);
        await markPublished(
          {
            id: item.id, story_fingerprint: fingerprint, story_stage: item.story_stage,
            story_stage_rank: stageRank, is_followup: item.is_followup,
          },
          fallback.id,
        );
        await sql`
          UPDATE news_items
          SET publish_mode = 'text_fallback',
              fallback_reason = ${`photo upload failed: ${errorMessage(error)}`.slice(0, 400)},
              updated_at = now()
          WHERE id = ${item.id}
        `;
        summary.publish.published = true;
        summary.publish.fbPostId = fallback.id;
        summary.publish.textFallback = true;
        return;
      } catch {
        // Fall through to the normal retry path below.
      }
    }

    if (uncertain) {
      const found = await findRecentMatchingPost(item.post_text);
      if (found) {
        await markPublished(
          {
            id: item.id,
            story_fingerprint: fingerprint,
            story_stage: item.story_stage,
            story_stage_rank: stageRank,
            is_followup: item.is_followup,
          },
          found.id,
        );
        summary.publish.published = true;
        summary.publish.reconciled = true;
        summary.publish.fbPostId = found.id;
        return;
      }
    }
    const message = errorMessage(error);
    if (fingerprint) await releaseStoryClaim(fingerprint, stageRank);
    await releaseClaim(item.id, item.attempts, message);
    await releasePublishSlot();
    summary.publish.error = message;
  }
}

/** Persists image metadata (never binaries, never tokens). */
async function recordImageOutcome(
  id: string,
  result: Awaited<ReturnType<typeof resolveImage>>,
): Promise<void> {
  try {
    const sql = getDb();
    if (result.ok) {
      await sql`
        UPDATE news_items
        SET image_url = ${result.sourceUrl}, image_final_url = ${result.finalUrl},
            image_mime = ${result.mime}, image_bytes = ${result.byteSize},
            image_origin = ${result.origin}, image_publisher = ${result.publisher},
            image_status = 'validated', image_error = NULL, updated_at = now()
        WHERE id = ${id}
      `;
    } else {
      await sql`
        UPDATE news_items
        SET image_status = ${result.status}, image_error = ${result.reason.slice(0, 400)},
            updated_at = now()
        WHERE id = ${id}
      `;
    }
  } catch {
    // Image bookkeeping must never break publishing.
  }
}

async function markPublished(
  item: {
    id: string;
    story_fingerprint: string | null;
    story_stage: string | null;
    story_stage_rank: number;
    is_followup: boolean;
  },
  fbPostId: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE news_items
    SET status = 'published', fb_post_id = ${fbPostId}, posted_at = now(),
        next_retry_at = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${item.id}
  `;

  if (!item.story_fingerprint) return;

  await sql`
    UPDATE story_publications
    SET fb_post_id = ${fbPostId}, published_at = now()
    WHERE fingerprint = ${item.story_fingerprint} AND stage_rank = ${item.story_stage_rank}
  `;
  await sql`
    UPDATE stories
    SET published_stage = ${item.story_stage},
        published_stage_rank = GREATEST(published_stage_rank, ${item.story_stage_rank}),
        published_count = published_count + 1,
        followups_published = followups_published + ${item.is_followup ? 1 : 0},
        last_published_at = now(), updated_at = now()
    WHERE fingerprint = ${item.story_fingerprint}
  `;
}

/** A failed Facebook post stays retryable — never falsely marked published. */
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
    SET status = 'candidate', last_error = ${error},
        next_retry_at = now() + make_interval(mins => ${backoffMinutes}),
        updated_at = now()
    WHERE id = ${id}
  `;
}

async function releaseStoryClaim(fingerprint: string | null, stageRank: number): Promise<void> {
  if (!fingerprint) return;
  try {
    const sql = getDb();
    await sql`
      DELETE FROM story_publications
      WHERE fingerprint = ${fingerprint} AND stage_rank = ${stageRank} AND published_at IS NULL
    `;
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ */
/* Ingestion (shared): relevance, lifecycle, dedupe, compose           */
/* ------------------------------------------------------------------ */

interface IngestCounters {
  newCandidates: number;
  rejected: number;
  duplicatesSkipped: number;
}

async function ingestRssArticles(
  articles: RssArticle[],
  summary: AutomationSummary,
  lastScanAt: string | null,
): Promise<void> {
  const inputs: (NormalizedArticle & { articleId: string; imageCandidates?: ImageCandidate[] })[] = [];
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
      imageCandidates: raw.imageCandidates,
    });
  }
  const counters = await ingestNormalized(inputs, "rss", feedByDedupeKey, summary, lastScanAt);
  summary.rss.newCandidates += counters.newCandidates;
  summary.rss.rejected += counters.rejected;
  summary.rss.duplicatesSkipped += counters.duplicatesSkipped;
}

async function ingestNormalized(
  inputs: (NormalizedArticle & { articleId: string; imageCandidates?: ImageCandidate[] })[],
  provider: string,
  feedByDedupeKey: Map<string, string> | null,
  summary: AutomationSummary,
  lastScanAt: string | null,
): Promise<IngestCounters> {
  const counters: IngestCounters = { newCandidates: 0, rejected: 0, duplicatesSkipped: 0 };
  if (inputs.length === 0) return counters;

  const sql = getDb();
  const now = new Date();

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
    const decision = evaluateArticle(article, now);
    const sourceName = normalizeSourceName({
      source_name: article.sourceName,
      source_id: article.sourceId,
    });
    const feedName = provider === "rss" ? (feedByDedupeKey?.get(article.articleId) ?? article.sourceName) : null;

    const identity = buildStoryIdentity(article.title, article.description);
    const similar = decision.relevant
      ? findDuplicateStory(decision.titleTokens, [...recent, ...batchSets])
      : null;
    const fingerprint = similar?.id ?? identity.fingerprint;

    let status: "candidate" | "rejected" | "duplicate" = decision.relevant ? "candidate" : "rejected";
    let duplicateKind: string | null = null;
    let isFollowUp = false;
    let reason = decision.reason;

    // Story already posted, or already queued? Only a materially new
    // development may post again.
    if (decision.relevant) {
      const storyRows = (await sql`
        SELECT published_stage_rank, published_count, followups_published
        FROM stories
        WHERE fingerprint = ${fingerprint}
      `) as { published_stage_rank: number; published_count: number; followups_published: number }[];
      const story = storyRows[0];
      if (story && story.published_count > 0) {
        if (isMaterialFollowUp(story.published_stage_rank, identity.stageRank, story.followups_published)) {
          isFollowUp = true;
          reason = `follow-up: story advanced to "${identity.stage}" (was rank ${story.published_stage_rank})`;
        } else {
          status = "duplicate";
          duplicateKind = "story";
          reason = "duplicate of a story DynaSport already published";
        }
      } else if (similar) {
        status = "duplicate";
        duplicateKind = "story";
        reason = "duplicate of a story already queued from another source";
      }
    }

    // Freshness + significance policy.
    // RSS is the sole discovery source, so every story is judged on its own
    // freshness and corroboration evidence.
    const distinctPublishers = await countDistinctPublishers(fingerprint, sourceName);
    const freshness: FreshnessVerdict = evaluateFreshness(
      {
        publishedAt: article.publishedAt,
        stageRank: identity.stageRank,
        isRumour: decision.isRumour,
        score: decision.score,
        distinctPublishers,
      },
      now,
    );

    if (status === "candidate" && !freshness.eligible) {
      status = "rejected";
      reason = freshness.reason;
      summary.notNewRejected += 1;
    }

    if (status === "candidate" && freshness.category === "trending") {
      const alreadyPublished = await storyAlreadyPublished(fingerprint);
      if (alreadyPublished) {
        status = "duplicate";
        duplicateKind = "story";
        reason = "trending story already published by DynaSport — no new development";
      }
    }

    // Lifecycle: category, priority and publishing window. The reference
    // time is the ORIGINAL publication time, never the discovery time.
    const lifecycle = computeLifecycle(
      article.title,
      identity.eventKind,
      identity.stage,
      decision.isRumour,
      decision.score,
      article.publishedAt,
      now,
    );
    if (status === "candidate" && lifecycle.expiresAt && lifecycle.expiresAt <= now) {
      status = "rejected";
      reason = `already expired (${lifecycle.category}: publishing window closed before discovery)`;
      summary.notNewRejected += 1;
    }

    // Compose + quality gate, fetching article detail when needed.
    let postText: string | null = null;
    let headline: string | null = null;
    let explanation: string | null = null;
    let imageCandidates: ImageCandidate[] = article.imageCandidates ?? [];
    if (status === "candidate" && decision.statement && sourceName) {
      let sourceText: string | null = article.description;
      let body = buildExplanation(sourceText, decision.statement, identity.stage, decision.isRumour);
      const needsDetail =
        !body ||
        countWordsOf(body) < 30 ||
        /(?:\.\.\.|\u2026|…)$/.test((article.description ?? "").trim());

      if (needsDetail && article.articleUrl && articleBudgetRemaining() > 0) {
        const content = await fetchArticleContent(article.articleUrl);
        if (content.text) {
          sourceText = `${article.description ?? ""}\n\n${content.text}`;
          body = buildExplanation(sourceText, decision.statement, identity.stage, decision.isRumour);
        }
        // Harvest the publisher's own share image from the same fetch.
        if (content.html && article.articleUrl) {
          imageCandidates = [
            ...imageCandidates,
            ...imageCandidatesFromHtml(content.html, article.articleUrl, sourceName),
          ];
        }
      }

      const composed = body ? composePost(decision.statement, body, sourceName) : null;
      if (composed) {
        const quality = finalQualityCheck(composed, { sourceText, headline: decision.statement });
        if (quality.ok) {
          postText = composed.message;
          headline = composed.headline;
          explanation = composed.explanation;
        } else {
          status = "rejected";
          reason = `quality gate: ${quality.problems[0] ?? "post did not pass the final check"}`;
        }
      } else {
        status = "rejected";
        reason = "no accurate, useful explanation could be produced from the source report";
      }
    } else if (status === "candidate") {
      status = "rejected";
      reason = "no trustworthy source attribution for a publishable statement";
    }

    const inserted = (await sql`
      INSERT INTO news_items (
        dedupe_key, title, title_tokens, description, article_url,
        source_name, source_id, published_at, language,
        relevance_score, is_rumour, post_text, status, decision_reason,
        provider, feed_name,
        story_fingerprint, story_stage, story_stage_rank, is_followup,
        duplicate_kind, reject_kind, headline, explanation, age_minutes_at_discovery,
        freshness_category, requires_corroboration, last_seen_at,
        event_category, priority_score, expires_at, event_at, publish_after,
        image_url, image_origin, image_publisher, image_status
      )
      VALUES (
        ${article.articleId}, ${article.title}, ${JSON.stringify(decision.titleTokens)}::jsonb,
        ${article.description}, ${article.articleUrl}, ${sourceName}, ${article.sourceId},
        ${article.publishedAt ? article.publishedAt.toISOString() : null}, ${article.language},
        ${decision.score}, ${decision.isRumour}, ${postText}, ${status}, ${reason},
        ${provider}, ${feedName},
        ${fingerprint}, ${identity.stage}, ${identity.stageRank}, ${isFollowUp},
        ${duplicateKind}, ${decision.rejectKind}, ${headline}, ${explanation},
        ${freshness.ageMinutes}, ${freshness.category}, ${freshness.requiresCorroboration},
        now(),
        ${lifecycle.category}, ${lifecycle.priorityScore},
        ${lifecycle.expiresAt ? lifecycle.expiresAt.toISOString() : null},
        ${lifecycle.eventAt ? lifecycle.eventAt.toISOString() : null},
        ${now.toISOString()},
        ${imageCandidates[0]?.url ?? null}, ${imageCandidates[0]?.origin ?? null},
        ${imageCandidates[0]?.publisher ?? sourceName},
        ${imageCandidates.length > 0 ? "discovered" : "none_found"}
      )
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    if (inserted.length === 0) {
      counters.duplicatesSkipped += 1;
      summary.dedupe.exactDuplicates += 1;
      continue;
    }

    await upsertStory(fingerprint, identity.entities, identity.eventKind, decision.titleTokens, article.title);
    await recordStorySource(fingerprint, sourceName);

    if (status === "candidate") {
      counters.newCandidates += 1;
      if (isFollowUp) summary.dedupe.followUpsAccepted += 1;
      if (decision.titleTokens.length > 0) {
        batchSets.push({ id: fingerprint, tokens: decision.titleTokens });
      }
    } else if (status === "duplicate") {
      counters.duplicatesSkipped += 1;
      summary.dedupe.storyDuplicates += 1;
    } else {
      counters.rejected += 1;
      if (decision.rejectKind === "stale") summary.dedupe.staleRejected += 1;
      else summary.dedupe.irrelevantRejected += 1;
    }
  }

  return counters;
}

function parseValueDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const isoLike = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T") + "Z";
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ---------- story tracking helpers ---------- */

/** Read-only distinct-publisher count used by the popularity bar. */
async function countDistinctPublishersFor(
  fingerprint: string | null,
  sourceName: string | null,
): Promise<number> {
  if (!fingerprint) return sourceName ? 1 : 0;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT count(*)::int AS n FROM story_sources WHERE fingerprint = ${fingerprint}
    `) as { n: number }[];
    return Math.max(sourceName ? 1 : 0, rows[0]?.n ?? 1);
  } catch {
    return sourceName ? 1 : 0;
  }
}

async function countDistinctPublishers(fingerprint: string, sourceName: string | null): Promise<number> {
  if (!sourceName) return 1;
  try {
    const sql = getDb();
    await recordStorySource(fingerprint, sourceName);
    const rows = (await sql`
      SELECT count(*)::int AS n FROM story_sources WHERE fingerprint = ${fingerprint}
    `) as { n: number }[];
    return Math.max(1, rows[0]?.n ?? 1);
  } catch {
    return 1;
  }
}

async function recordStorySource(fingerprint: string, publisher: string | null): Promise<void> {
  if (!publisher) return;
  try {
    const sql = getDb();
    await sql`
      INSERT INTO story_sources (fingerprint, publisher)
      VALUES (${fingerprint}, ${publisher})
      ON CONFLICT (fingerprint, publisher) DO UPDATE SET last_seen_at = now()
    `;
  } catch {
    // Corroboration bookkeeping must never break ingestion.
  }
}

async function storyAlreadyPublished(fingerprint: string): Promise<boolean> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT published_count FROM stories WHERE fingerprint = ${fingerprint}
    `) as { published_count: number }[];
    return (rows[0]?.published_count ?? 0) > 0;
  } catch {
    return false;
  }
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

/* ------------------------------------------------------------------ */
/* Run bookkeeping                                                      */
/* ------------------------------------------------------------------ */

async function recordRun(summary: AutomationSummary): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO automation_runs (
        trigger_source, started_at, finished_at, status,
        fetched, new_candidates,
        rejected, duplicates_skipped, published, discovery_error,
        publish_error, error, summary,
        feeds_checked, feeds_ok, rss_fetched, rss_new_candidates,
        exact_duplicates, story_duplicates, stale_rejected, followups_accepted,
        stale_not_new, publish_skipped_reason, expired, photo_posts
      )
      VALUES (
        ${summary.trigger}, ${summary.startedAt}, ${summary.finishedAt}, ${summary.status},
        ${summary.fetched},
        ${summary.newCandidates}, ${summary.rejected}, ${summary.duplicatesSkipped},
        ${summary.publish.published ? 1 : 0}, ${summary.discoveryError},
        ${summary.publish.error}, ${summary.error}, ${JSON.stringify(summary)}::jsonb,
        ${summary.rss.feedsChecked}, ${summary.rss.feedsOk}, ${summary.rss.fetched},
        ${summary.rss.newCandidates},
        ${summary.dedupe.exactDuplicates}, ${summary.dedupe.storyDuplicates},
        ${summary.dedupe.staleRejected}, ${summary.dedupe.followUpsAccepted},
        ${summary.notNewRejected}, ${summary.publish.skippedReason}, ${summary.expired},
        ${summary.publish.withPhoto ? 1 : 0}
      )
    `;
  } catch {
    // Bookkeeping must never break the automation result.
  }
}

function finalize(summary: AutomationSummary, startedAt: Date): void {
  const finishedAt = new Date();
  summary.finishedAt = finishedAt.toISOString();
  summary.durationMs = finishedAt.getTime() - startedAt.getTime();
}

function countWordsOf(text: string | null): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let safe = message;
  for (const envName of [
    "FACEBOOK_PAGE_ACCESS_TOKEN", "FACEBOOK_APP_SECRET", "CRON_SECRET", "DATABASE_URL",
  ]) {
    const secret = process.env[envName];
    if (secret && secret.length > 0) {
      safe = safe.split(secret).join("[redacted]");
    }
  }
  return safe;
}

export { STAGE_RANK, type StoryStage };
