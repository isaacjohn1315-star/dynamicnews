import { getDb } from "./db";
import type { EventKind } from "./story";
import type { StoryStage } from "./story";

/**
 * Time-sensitive publishing lifecycle.
 *
 * Football news has a shelf life that depends on WHAT the story is, not one
 * universal deadline. A starting lineup dies at kickoff; an injury report
 * stays useful for a day or two; a transfer rumour ages out in hours. The
 * rules below are configurable defaults, deliberately conservative, and
 * every timestamp is stored and compared in UTC.
 *
 * Nothing here invents kickoff times: `event_at` is only set when a source
 * actually gives the fixture time. When it is unknown, time-sensitive
 * categories fall back to short windows so stale lineups cannot slip out.
 */

export type NewsCategory =
  | "lineup"
  | "squad"
  | "breaking"
  | "transfer"
  | "match"
  | "injury"
  | "interview"
  | "contract"
  | "club"
  | "international"
  | "news";

export interface LifecyclePolicy {
  /** Hours the story stays publishable from its original publication time. */
  ttlHours: number;
  /** Normalised priority 0-100 used to order the queue. */
  basePriority: number;
  /** True when the story dies at kickoff/event start if `event_at` is known. */
  expiresAtEvent: boolean;
  /** Fallback window used when `event_at` is unknown, in hours. */
  eventFallbackHours: number | null;
}

/** Configurable defaults — change these to tune publishing behaviour. */
export const CATEGORY_POLICY: Record<NewsCategory, LifecyclePolicy> = {
  lineup: { ttlHours: 12, basePriority: 80, expiresAtEvent: true, eventFallbackHours: 3 },
  squad: { ttlHours: 24, basePriority: 74, expiresAtEvent: true, eventFallbackHours: 6 },
  breaking: { ttlHours: 6, basePriority: 95, expiresAtEvent: false, eventFallbackHours: null },
  transfer: { ttlHours: 24, basePriority: 66, expiresAtEvent: false, eventFallbackHours: null },
  match: { ttlHours: 12, basePriority: 52, expiresAtEvent: false, eventFallbackHours: null },
  injury: { ttlHours: 48, basePriority: 60, expiresAtEvent: false, eventFallbackHours: null },
  interview: { ttlHours: 48, basePriority: 50, expiresAtEvent: false, eventFallbackHours: null },
  contract: { ttlHours: 48, basePriority: 58, expiresAtEvent: false, eventFallbackHours: null },
  club: { ttlHours: 36, basePriority: 55, expiresAtEvent: false, eventFallbackHours: null },
  international: { ttlHours: 36, basePriority: 60, expiresAtEvent: false, eventFallbackHours: null },
  news: { ttlHours: 24, basePriority: 50, expiresAtEvent: false, eventFallbackHours: null },
};

/** Transfer rumours expire faster than confirmed deals. */
export const TRANSFER_RUMOUR_TTL_HOURS = 12;
/** Confirmed deals stay publishable longer. */
export const TRANSFER_OFFICIAL_TTL_HOURS = 48;

const SQUAD_PATTERN =
  /\b(squad list|squads? announced?|matchday squad|travelling squad|unavailable|ruled out for|doubtful for|fitness doubt|out of (?:the )?(?:squad|game|match)|miss (?:the )?(?:game|match|tie|fixture)|without (?:the )?\w+|still without)/i;
const LINEUP_PATTERN =
  /\b(starting (?:xi|line-?up)|line-?ups? out|team news in full|here'?s the (?:team|xi)|named (?:in|to) (?:the )?(?:starting|side)|predicted (?:xi|line-?ups?))/i;
const BREAKING_PATTERN =
  /\b(breaking|just in|confirmed|official\b|announced|here we go|done deal|urgent)\b/i;

/** Detects the lifecycle category from the headline and event kind. */
export function detectCategory(
  title: string,
  eventKind: EventKind,
  stage: StoryStage,
  score: number,
): NewsCategory {
  if (LINEUP_PATTERN.test(title)) return "lineup";
  if (SQUAD_PATTERN.test(title)) return "squad";
  if (BREAKING_PATTERN.test(title) && score >= 75) return "breaking";

  switch (eventKind) {
    case "lineup":
      return "lineup";
    case "dressing_room":
      return "squad";
    case "transfer":
    case "here_we_go":
    case "medical":
    case "loan":
    case "agent":
      return "transfer";
    case "manager":
      return stage === "official" ? "breaking" : "club";
    case "match":
      return "match";
    case "injury":
    case "comeback":
      return "injury";
    case "quote":
      return "interview";
    case "contract":
      return "contract";
    case "international":
      return "international";
    case "award":
    case "finance":
    case "legal":
    case "club":
    case "youth":
    case "retirement":
    case "competition":
      return "club";
    default:
      return "news";
  }
}

export interface LifecycleComputation {
  category: NewsCategory;
  priorityScore: number;
  expiresAt: Date | null;
  eventFallbackApplied: boolean;
}

/**
 * Computes category, priority and expiry for a story.
 *
 * `referenceTime` is the ORIGINAL publication time when trustworthy,
 * otherwise first-seen time — never a row maintenance time. Re-fetching an
 * old article can therefore never extend its publishing window.
 */
export function computeLifecycle(
  title: string,
  eventKind: EventKind,
  stage: StoryStage,
  isRumour: boolean,
  score: number,
  publishedAt: Date | null,
  firstSeenAt: Date,
  eventAt: Date | null = null,
): LifecycleComputation & { eventAt: Date | null } {
  const category = detectCategory(title, eventKind, stage, score);
  const policy = CATEGORY_POLICY[category];

  const referenceTime = publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : firstSeenAt;

  let ttlHours = policy.ttlHours;
  if (category === "transfer" && isRumour) ttlHours = TRANSFER_RUMOUR_TTL_HOURS;
  if (category === "transfer" && !isRumour) ttlHours = TRANSFER_OFFICIAL_TTL_HOURS;

  let expiresAt = new Date(referenceTime.getTime() + ttlHours * 3_600_000);
  let eventFallbackApplied = false;

  // Time-sensitive categories die at kickoff. With no verified kickoff — a
  // value is only ever stored when a source actually provides one — a short
  // fallback window applies so a stale lineup can never slip out after the
  // match has realistically started.
  if (policy.expiresAtEvent) {
    if (eventAt && eventAt < expiresAt) {
      expiresAt = eventAt;
    } else if (policy.eventFallbackHours !== null) {
      const fallback = new Date(referenceTime.getTime() + policy.eventFallbackHours * 3_600_000);
      if (fallback < expiresAt) {
        expiresAt = fallback;
        eventFallbackApplied = true;
      }
    }
  }

  // Priority: category base adjusted by stage certainty and score strength.
  let priorityScore = policy.basePriority;
  if (stage === "official" || stage === "agreement") priorityScore += 8;
  if (isRumour) priorityScore -= 6;
  priorityScore += Math.round((score - 60) / 10);
  priorityScore = Math.max(10, Math.min(99, priorityScore));

  return { category, priorityScore, expiresAt, eventAt, eventFallbackApplied };
}

/* ------------------------------------------------------------------ */
/* Expiry sweep                                                        */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  expired: number;
}

/**
 * Cancels all queued items whose publishing window has closed. Runs before
 * every publish attempt, so a previously valid item can never sneak out
 * after its window closed — including items awaiting retry.
 */
export async function sweepExpired(): Promise<SweepResult> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE news_items
    SET status = 'expired',
        cancelled_at = now(),
        cancel_reason = encode('publishing window expired', 'escape'),
        updated_at = now()
    WHERE status = 'candidate'
      AND (
        (expires_at IS NOT NULL AND expires_at <= now())
        OR (
          event_at IS NOT NULL AND event_at <= now()
          AND event_category IN ('lineup', 'squad')
        )
      )
    RETURNING id
  `) as { id: string }[];
  return { expired: rows.length };
}

/* ------------------------------------------------------------------ */
/* Pre-publish validation                                              */
/* ------------------------------------------------------------------ */

export interface ValidationFailure {
  valid: false;
  reason: string;
  markStatus: "expired" | "superseded" | "cancelled" | "duplicate";
}

export interface ItemForValidation {
  id: string;
  status: string;
  story_fingerprint: string | null;
  story_stage_rank: number | null;
  post_text: string | null;
  fb_post_id: string | null;
  expires_at: Date | null;
  event_at: Date | null;
  event_category: string | null;
  first_seen_at: Date;
}

/**
 * Immediately before ANY Facebook call — including retries — every one of
 * these checks runs. A queued item receives no exemption.
 */
export async function validateBeforePublish(item: ItemForValidation): Promise<ValidationFailure | null> {
  const now = new Date();

  if (item.status !== "candidate") {
    return { valid: false, reason: `item is no longer a candidate (status=${item.status})`, markStatus: "cancelled" };
  }
  if (item.expires_at && item.expires_at <= now) {
    return { valid: false, reason: "publishing window expired", markStatus: "expired" };
  }
  if (
    item.event_at &&
    item.event_at <= now &&
    (item.event_category === "lineup" || item.event_category === "squad")
  ) {
    return { valid: false, reason: "fixture already started — pre-match news is obsolete", markStatus: "expired" };
  }
  if (!item.post_text) {
    return { valid: false, reason: "no post text generated", markStatus: "cancelled" };
  }
  if (item.fb_post_id) {
    return { valid: false, reason: "Facebook post id already recorded", markStatus: "duplicate" };
  }

  const sql = getDb();

  // Already published by DynaSport (story level + exact post hash)?
  if (item.story_fingerprint) {
    const publishedStory = (await sql`
      SELECT count(*)::int AS n FROM story_publications
      WHERE fingerprint = ${item.story_fingerprint}
        AND stage_rank = ${item.story_stage_rank ?? 0}
        AND published_at IS NOT NULL
    `) as { n: number }[];
    if ((publishedStory[0]?.n ?? 0) > 0) {
      return { valid: false, reason: "story already published by DynaSport", markStatus: "duplicate" };
    }
  }

  // Superseded: a newer candidate or publication exists for this story.
  if (item.story_fingerprint) {
    const newer = (await sql`
      SELECT count(*)::int AS n FROM news_items
      WHERE story_fingerprint = ${item.story_fingerprint}
        AND id <> ${item.id}::uuid
        AND (
          (status IN ('candidate', 'publishing', 'published') AND published_at > ${item.first_seen_at.toISOString()}::timestamptz)
          OR (status = 'published')
        )
    `) as { n: number }[];
    if ((newer[0]?.n ?? 0) > 0) {
      return { valid: false, reason: "superseded by a newer development of the same story", markStatus: "superseded" };
    }
  }

  return null;
}

/** Marks an item with the final lifecycle status and a readable reason. */
export async function markInvalid(
  id: string,
  markStatus: "expired" | "superseded" | "cancelled" | "duplicate",
  reason: string,
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE news_items
      SET status = ${markStatus === "duplicate" ? "duplicate" : markStatus},
          cancelled_at = CASE WHEN ${markStatus} = 'duplicate' THEN cancelled_at ELSE now() END,
          cancel_reason = ${reason},
          next_retry_at = NULL,
          updated_at = now()
      WHERE id = ${id}
    `;
  } catch {
    // Terminal bookkeeping must never break the pipeline.
  }
}
