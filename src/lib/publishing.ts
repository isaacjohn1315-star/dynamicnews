import { ensureSchema, getDb } from "./db";

/**
 * Facebook publishing governor.
 *
 * Discovering news does not mean publishing it. DynaSport behaves like a
 * selective editorial page:
 *
 *   - target 3-5 quality posts per UTC day;
 *   - HARD cap of 5 ordinary posts per UTC day;
 *   - at most 1 ordinary post per 30 minutes;
 *   - at most 1 post per scheduled run;
 *   - a genuinely major breaking event may use a small emergency
 *     allowance, with an absolute ceiling of 6 posts per day.
 *
 * All counters live in Neon (`publish_state`), keyed by UTC day, and the
 * cooldown is persisted in `next_eligible_publish_at` so redeploys and
 * cold starts cannot reset it. Slots are claimed with a single atomic
 * statement, so simultaneous runs can never exceed the caps.
 */

export const DAILY_ORDINARY_POST_LIMIT = 5;
export const DAILY_TOTAL_POST_LIMIT = 6;
export const POST_COOLDOWN_MINUTES = 30;
export const TARGET_POSTS_PER_DAY = "3-5";

/** Relevance score a story must reach to spend the emergency allowance. */
export const EMERGENCY_SCORE_THRESHOLD = 110;

export function publishDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type SlotRefusal =
  | "daily_ordinary_cap"
  | "daily_total_cap"
  | "cooldown"
  | "no_emergency_justification";

export interface SlotClaim {
  granted: boolean;
  emergency: boolean;
  reason: SlotRefusal | null;
  ordinaryUsed: number;
  emergencyUsed: number;
  nextEligibleAt: string | null;
}

/**
 * Atomically claims a publishing slot. Must be called immediately before
 * posting; `releasePublishSlot` gives it back if the post does not happen.
 */
export async function claimPublishSlot(isEmergency: boolean): Promise<SlotClaim> {
  await ensureSchema();
  const sql = getDb();
  const day = publishDayKey();

  await sql`
    INSERT INTO publish_state (day) VALUES (${day})
    ON CONFLICT (day) DO NOTHING
  `;

  // One statement decides and reserves: cooldown, ordinary cap and total
  // cap are all evaluated inside the UPDATE's WHERE clause.
  const rows = (await sql`
    UPDATE publish_state
    SET ordinary_posts = ordinary_posts + ${isEmergency ? 0 : 1},
        emergency_posts = emergency_posts + ${isEmergency ? 1 : 0},
        last_published_at = now(),
        next_eligible_publish_at = now() + make_interval(mins => ${POST_COOLDOWN_MINUTES}),
        updated_at = now()
    WHERE day = ${day}
      AND (next_eligible_publish_at IS NULL OR next_eligible_publish_at <= now())
      AND (ordinary_posts + emergency_posts) < ${DAILY_TOTAL_POST_LIMIT}
      AND (${isEmergency} OR ordinary_posts < ${DAILY_ORDINARY_POST_LIMIT})
    RETURNING ordinary_posts, emergency_posts, next_eligible_publish_at
  `) as { ordinary_posts: number; emergency_posts: number; next_eligible_publish_at: string | null }[];

  if (rows.length > 0) {
    return {
      granted: true,
      emergency: isEmergency,
      reason: null,
      ordinaryUsed: rows[0].ordinary_posts,
      emergencyUsed: rows[0].emergency_posts,
      nextEligibleAt: rows[0].next_eligible_publish_at,
    };
  }

  const state = await getPublishState();
  let reason: SlotRefusal = "cooldown";
  if (state.ordinaryUsed + state.emergencyUsed >= DAILY_TOTAL_POST_LIMIT) {
    reason = "daily_total_cap";
  } else if (!isEmergency && state.ordinaryUsed >= DAILY_ORDINARY_POST_LIMIT) {
    reason = "daily_ordinary_cap";
  }

  return {
    granted: false,
    emergency: isEmergency,
    reason,
    ordinaryUsed: state.ordinaryUsed,
    emergencyUsed: state.emergencyUsed,
    nextEligibleAt: state.nextEligibleAt,
  };
}

/**
 * Returns an unused slot (e.g. the Facebook call failed). The cooldown is
 * also rewound so a transient failure does not cost 30 minutes of silence.
 */
export async function releasePublishSlot(isEmergency: boolean): Promise<void> {
  try {
    const sql = getDb();
    const day = publishDayKey();
    await sql`
      UPDATE publish_state
      SET ordinary_posts = GREATEST(0, ordinary_posts - ${isEmergency ? 0 : 1}),
          emergency_posts = GREATEST(0, emergency_posts - ${isEmergency ? 1 : 0}),
          next_eligible_publish_at = now() + make_interval(mins => 2),
          updated_at = now()
      WHERE day = ${day}
    `;
  } catch {
    // If this fails the slot simply stays consumed — safe (under-posting).
  }
}

export interface PublishState {
  day: string;
  ordinaryUsed: number;
  emergencyUsed: number;
  ordinaryLimit: number;
  totalLimit: number;
  nextEligibleAt: string | null;
  lastPublishedAt: string | null;
  cooldownMinutes: number;
}

export async function getPublishState(): Promise<PublishState> {
  await ensureSchema();
  const sql = getDb();
  const day = publishDayKey();

  const rows = (await sql`
    SELECT ordinary_posts, emergency_posts, next_eligible_publish_at, last_published_at
    FROM publish_state
    WHERE day = ${day}
  `) as {
    ordinary_posts: number;
    emergency_posts: number;
    next_eligible_publish_at: string | null;
    last_published_at: string | null;
  }[];

  const row = rows[0];
  return {
    day,
    ordinaryUsed: row?.ordinary_posts ?? 0,
    emergencyUsed: row?.emergency_posts ?? 0,
    ordinaryLimit: DAILY_ORDINARY_POST_LIMIT,
    totalLimit: DAILY_TOTAL_POST_LIMIT,
    nextEligibleAt: row?.next_eligible_publish_at ?? null,
    lastPublishedAt: row?.last_published_at ?? null,
    cooldownMinutes: POST_COOLDOWN_MINUTES,
  };
}

/**
 * Only a confirmed, high-scoring official development may use the
 * emergency allowance. Ordinary transfer rumours, routine injuries and
 * minor updates never qualify.
 */
export function qualifiesForEmergency(score: number, stageRank: number, isRumour: boolean): boolean {
  if (isRumour) return false;
  if (stageRank < 5) return false; // "official" only
  return score >= EMERGENCY_SCORE_THRESHOLD;
}
