import { getConfig } from "./config";
import { getDb } from "./db";

/**
 * Anti-flood publishing policy.
 *
 * There is NO daily cap. DynaSport may post at any hour of any day, and there
 * is no ceiling on how many genuinely important stories go out in a day.
 *
 * What is guarded is BURSTING: a rolling one-hour window limits how many
 * posts can land in quick succession. Because the window rolls, it never
 * blocks a story for long and never resets at a fixed time of day, so it is
 * not a daily quota in disguise — a busy afternoon can still produce many
 * posts as long as they are spaced, and a quiet night is not "topped up".
 *
 * The window is stored in Neon (`published_posts.published_at`), so a
 * redeploy, a cold start or a manual run cannot reset or bypass it, and the
 * claim is atomic so overlapping cron runs cannot exceed it.
 */

/**
 * Limits below are read from configuration (MAX_POSTS_PER_HOUR,
 * MIN_SPACING_MINUTES, POPULARITY_MIN_SCORE) so they can be changed without
 * a code change. These exported helpers keep call sites readable.
 */
export function maxPostsPerHour(): number {
  return getConfig().maxPostsPerHour;
}

export function minSpacingMinutes(): number {
  return getConfig().minSpacingMinutes;
}

export function popularityMinScore(): number {
  return getConfig().popularityMinScore;
}

/**
 * Corroboration required when the source is not a top-tier outlet: the same
 * story must be independently reported by at least this many publishers.
 */
export const CORROBORATION_FOR_LESSER_SOURCE = 2;

export interface FloodDecision {
  allowed: boolean;
  reason: "hour_window_full" | "spacing" | null;
  postsLastHour: number;
  minutesSinceLastPost: number | null;
  nextEligibleAt: string | null;
}

/** Reads the real publishing history to decide whether a post may go out now. */
export async function checkFloodControl(): Promise<FloodDecision> {
  const sql = getDb();

  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE published_at > now() - interval '1 hour')::int AS last_hour,
      max(published_at) AS last_post
    FROM published_posts
    WHERE published_at IS NOT NULL
  `) as { last_hour: number; last_post: string | null }[];

  const postsLastHour = rows[0]?.last_hour ?? 0;
  const lastPost = rows[0]?.last_post ? new Date(String(rows[0].last_post)) : null;
  const minutesSinceLastPost = lastPost
    ? Math.round((Date.now() - lastPost.getTime()) / 60_000)
    : null;

  if (postsLastHour >= maxPostsPerHour()) {
    return {
      allowed: false,
      reason: "hour_window_full",
      postsLastHour,
      minutesSinceLastPost,
      nextEligibleAt: lastPost
        ? new Date(lastPost.getTime() + 60 * 60_000).toISOString()
        : null,
    };
  }

  if (minutesSinceLastPost !== null && minutesSinceLastPost < minSpacingMinutes()) {
    return {
      allowed: false,
      reason: "spacing",
      postsLastHour,
      minutesSinceLastPost,
      nextEligibleAt: lastPost
        ? new Date(lastPost.getTime() + minSpacingMinutes() * 60_000).toISOString()
        : null,
    };
  }

  return { allowed: true, reason: null, postsLastHour, minutesSinceLastPost, nextEligibleAt: null };
}

/**
 * Popularity score for ranking which story deserves the next slot.
 *
 * Combines editorial relevance with real, verifiable interest signals:
 *   - how many DISTINCT reputable publishers independently report it
 *     (independent coverage, not copied syndication);
 *   - the credibility of the outlet;
 *   - a confirmed development outranks a rumour of equal weight.
 *
 * Nothing is invented: no fabricated share counts or engagement figures.
 */
export interface PopularityInput {
  relevanceScore: number;
  distinctPublishers: number;
  isRumour: boolean;
  isFollowUp: boolean;
  sourceCredibility: "top" | "mainstream" | "tabloid" | "unknown";
  freshnessCategory: "breaking" | "fresh" | "trending" | "older" | null;
}

export function popularityScore(input: PopularityInput): number {
  const { relevanceScore, distinctPublishers, isRumour, isFollowUp, sourceCredibility, freshnessCategory } =
    input;

  let score = relevanceScore;

  // Independent corroboration is the strongest real interest signal, capped
  // so mass syndication cannot turn trivia into the top story.
  if (distinctPublishers >= 2) {
    score += Math.min((distinctPublishers - 1) * 7, 21);
  }

  switch (sourceCredibility) {
    case "top":
      score += 10;
      break;
    case "mainstream":
      score += 6;
      break;
    case "tabloid":
      score += 1;
      break;
    default:
      score += 0;
      break;
  }

  if (!isRumour) score += 5;
  if (isFollowUp) score += 3;
  if (freshnessCategory === "breaking") score += 8;
  else if (freshnessCategory === "trending") score += 4;

  return Math.round(score);
}

/**
 * Editorial popularity bar. A story is only published when it is genuinely
 * interesting to a large football audience:
 *   - it clears the popularity score, AND
 *   - it is either from a top/mainstream outlet OR independently
 *     corroborated by another publisher.
 */
export function meetsPopularityBar(input: PopularityInput & { computedScore?: number }): {
  passes: boolean;
  score: number;
  reason: string | null;
} {
  const score = input.computedScore ?? popularityScore(input);

  if (score < popularityMinScore()) {
    return { passes: false, score, reason: `below popularity bar (score ${score} < ${popularityMinScore()})` };
  }

  const credible = input.sourceCredibility === "top" || input.sourceCredibility === "mainstream";
  const corroborated = input.distinctPublishers >= CORROBORATION_FOR_LESSER_SOURCE;

  if (!credible && !corroborated) {
    return {
      passes: false,
      score,
      reason: `not popular enough: single source (${input.sourceCredibility}) with no independent corroboration`,
    };
  }

  return { passes: true, score, reason: null };
}
