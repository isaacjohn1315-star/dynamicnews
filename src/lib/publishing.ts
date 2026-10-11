import { ensureSchema, getDb } from "./db";
import type { SourceCredibility } from "./relevance";

/**
 * Facebook publishing pacing.
 *
 * There is NO daily posting cap. DynaSport never limits how many legitimate
 * football stories it can publish in a day: if eight genuinely important
 * new stories qualify, all eight are published; if none qualify, nothing is
 * published. Quality control happens in the relevance, freshness, source
 * and duplicate layers — not here.
 *
 * Meta's Graph API applies no fixed posts-per-day ceiling either. Its rate
 * limits scale with the Page's engaged users over a rolling 24 hours, and
 * news Pages routinely publish far more than a handful of posts a day. The
 * only pacing kept here is therefore politeness, not restriction:
 *
 *   - exactly ONE post per automation run, so posts are always sequential
 *     and never batched (the 10-minute cron cadence naturally spaces them);
 *   - a short spacing interval between ordinary posts, so Facebook has time
 *     to process each request;
 *   - a verified high-priority breaking story BYPASSES that spacing, so a
 *     soft interval can never hold back real news.
 *
 * `next_eligible_publish_at` is persisted in Neon so redeploys and cold
 * starts cannot reset it. Slots are claimed in a single atomic statement,
 * which keeps overlapping workers from posting twice without imposing any
 * daily ceiling.
 */

/**
 * Minimum minutes between ordinary posts. Short by design: it exists only
 * to avoid firing a burst of requests at Facebook. Adjust this constant to
 * change pacing — it never blocks a qualifying high-priority story.
 */
export const POST_SPACING_MINUTES = 3;

/**
 * Relevance score at which a story is treated as high-priority and skips
 * the ordinary spacing interval. Only confirmed, non-rumour developments
 * qualify — never an ordinary transfer rumour.
 */
export const HIGH_PRIORITY_SCORE_THRESHOLD = 100;

/** Relevance stage rank required for a confirmed story ("official" = 5). */
export const HIGH_PRIORITY_STAGE_RANK = 5;

/**
 * Relevance score at which a RUMOUR skips the spacing interval. Transfer
 * rumours are core football-news content — a major exclusive from a
 * credible reporter is exactly what a football page posts immediately — so
 * this route is limited to credible sources (see isHighPriorityStory).
 */
export const RUMOUR_HIGH_PRIORITY_SCORE_THRESHOLD = 105;

export function publishDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Why a run published nothing. There is deliberately no daily-cap reason. */
export type SlotRefusal = "spacing" | null;

export interface SlotClaim {
  granted: boolean;
  highPriority: boolean;
  reason: SlotRefusal;
  postsToday: number;
  nextEligibleAt: string | null;
}

/**
 * Decides whether a story qualifies as high priority and skips the ordinary
 * spacing interval.
 *
 * Two routes, both requiring real editorial weight:
 *
 *  1. A confirmed development at the "official" stage.
 *  2. A significant rumour, negotiation or bid from a credible source —
 *     because transfer rumours are exactly what football news pages publish
 *     immediately. Weak or unknown sources never qualify on this route, so
 *     aggregator blogs cannot jump the queue.
 */
export function isHighPriorityStory(
  score: number,
  stageRank: number,
  isRumour: boolean,
  credibility: SourceCredibility,
): boolean {
  const credible = credibility === "top" || credibility === "mainstream";

  // Confirmed developments.
  if (!isRumour && stageRank >= HIGH_PRIORITY_STAGE_RANK && score >= HIGH_PRIORITY_SCORE_THRESHOLD) {
    return true;
  }

  // Significant rumours, talks and bids from credible reporters.
  return credible && score >= RUMOUR_HIGH_PRIORITY_SCORE_THRESHOLD;
}

/**
 * Atomically claims the single publishing slot for this run. Grants unless
 * an ordinary post would fall inside the short spacing window. There is no
 * daily counter to exhaust.
 */
export async function claimPublishSlot(highPriority: boolean): Promise<SlotClaim> {
  await ensureSchema();
  const sql = getDb();
  const day = publishDayKey();

  await sql`
    INSERT INTO publish_state (day) VALUES (${day})
    ON CONFLICT (day) DO NOTHING
  `;

  // The spacing window is the ONLY condition. High-priority stories ignore
  // it entirely; ordinary posts respect it.
  const rows = (await sql`
    UPDATE publish_state
    SET posts_total = posts_total + 1,
        last_published_at = now(),
        next_eligible_publish_at = now() + make_interval(mins => ${POST_SPACING_MINUTES}),
        updated_at = now()
    WHERE day = ${day}
      AND (
        ${highPriority}
        OR next_eligible_publish_at IS NULL
        OR next_eligible_publish_at <= now()
      )
    RETURNING posts_total, next_eligible_publish_at
  `) as { posts_total: number; next_eligible_publish_at: string | null }[];

  if (rows.length > 0) {
    return {
      granted: true,
      highPriority,
      reason: null,
      postsToday: rows[0].posts_total,
      nextEligibleAt: rows[0].next_eligible_publish_at,
    };
  }

  const state = await getPublishState();
  return {
    granted: false,
    highPriority,
    reason: "spacing",
    postsToday: state.postsToday,
    nextEligibleAt: state.nextEligibleAt,
  };
}

/**
 * Returns an unused slot (e.g. the Facebook call failed). Eligibility is
 * moved forward immediately so a transient failure costs almost no time.
 */
export async function releasePublishSlot(): Promise<void> {
  try {
    const sql = getDb();
    const day = publishDayKey();
    await sql`
      UPDATE publish_state
      SET posts_total = GREATEST(0, posts_total - 1),
          next_eligible_publish_at = now(),
          updated_at = now()
      WHERE day = ${day}
    `;
  } catch {
    // If this fails the slot stays consumed — safe (under-posting).
  }
}

export interface PublishState {
  day: string;
  postsToday: number;
  spacingMinutes: number;
  nextEligibleAt: string | null;
  lastPublishedAt: string | null;
}

/** Read-only view for the dashboard. Carries no limits. */
export async function getPublishState(): Promise<PublishState> {
  await ensureSchema();
  const sql = getDb();
  const day = publishDayKey();

  const rows = (await sql`
    SELECT posts_total, next_eligible_publish_at, last_published_at
    FROM publish_state
    WHERE day = ${day}
  `) as {
    posts_total: number | null;
    next_eligible_publish_at: string | null;
    last_published_at: string | null;
  }[];

  const row = rows[0];
  return {
    day,
    postsToday: row?.posts_total ?? 0,
    spacingMinutes: POST_SPACING_MINUTES,
    nextEligibleAt: row?.next_eligible_publish_at ?? null,
    lastPublishedAt: row?.last_published_at ?? null,
  };
}
