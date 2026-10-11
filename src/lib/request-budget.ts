import { ensureSchema, getDb, type RequestBudgetRow } from "./db";

/**
 * Hard, application-enforced cap on outgoing NewsData.io requests.
 *
 * cron-job.org is configured for an 8-minute interval (up to 180 scheduled
 * runs per 24h at one request per run), leaving a nominal 20-request buffer
 * for manual runs and retries. Every execution path — scheduled, manual, or
 * retried — reserves capacity through the same Neon-backed accounting BEFORE
 * any request leaves this application.
 *
 * Enforcement is layered and conservative:
 *  1. A per-UTC-day counter (`request_budget`, unique day key). The guarded
 *     INSERT ... ON CONFLICT increment is fully serialized by the unique
 *     constraint, so concurrent executions can never overshoot the day cap.
 *  2. A rolling 24-hour event ledger (`request_events`). NewsData.io
 *     documents 200 credits/day for the free plan but does not publicly
 *     document the exact daily reset timezone, and provider-side accounting
 *     cannot be observed directly — so the rolling window guarantees usage
 *     stays within 200 in ANY 24h span under any provider reset semantics.
 *     It can only make the gate more conservative, never more permissive.
 *
 * The free plan's 30-credits-per-15-minutes rate limit is also respected
 * by design: an 8-minute schedule consumes at most ~8 requests per 15 min,
 * and query strings stay well under the plan's 100-character limit.
 *
 * Both checks happen inside ONE statement together with the event insert,
 * so a reservation can never be double-committed. Slots are reserved before
 * sending and never refunded, which means failed or retried requests are
 * counted conservatively too.
 */
export const DAILY_NEWSDATA_REQUEST_LIMIT = 200;

/**
 * UTC day key for the application-level daily counter. The provider's exact
 * daily reset timezone is not publicly documented, so the rolling-24h guard
 * (below) acts as the absolute safety net alongside this window.
 */
export function budgetDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface BudgetReservation {
  allowed: boolean;
  used: number;
  rollingUsed: number;
  day: string;
  blockedReason: "daily_cap" | "rolling_cap" | null;
}

/** Atomically reserves one NewsData.io request slot, or refuses capacity. */
export async function reserveNewsDataRequest(): Promise<BudgetReservation> {
  await ensureSchema();
  const sql = getDb();
  const day = budgetDayKey();

  const rows = (await sql`
    WITH gate AS (
      INSERT INTO request_budget (day, used, updated_at)
      VALUES (${day}, 1, now())
      ON CONFLICT (day) DO UPDATE
        SET used = request_budget.used + 1,
            updated_at = now()
      WHERE request_budget.used < ${DAILY_NEWSDATA_REQUEST_LIMIT}
      RETURNING used
    ),
    rolling AS (
      SELECT count(*)::int AS n
      FROM request_events
      WHERE created_at > now() - interval '24 hours'
    ),
    ev AS (
      INSERT INTO request_events (created_at)
      SELECT now() FROM gate, rolling
      WHERE rolling.n < ${DAILY_NEWSDATA_REQUEST_LIMIT}
      RETURNING id
    ),
    cleanup AS (
      DELETE FROM request_events
      WHERE created_at < now() - interval '3 days'
      RETURNING 1
    )
    SELECT (SELECT used FROM gate) AS daily_used,
           (SELECT n FROM rolling) AS rolling_used,
           (SELECT id FROM ev) AS event_id
  `) as { daily_used: number | null; rolling_used: number | null; event_id: string | null }[];

  const row = rows[0] ?? { daily_used: null, rolling_used: null, event_id: null };
  const rollingUsed = row.rolling_used ?? 0;

  if (row.event_id !== null) {
    return {
      allowed: true,
      used: row.daily_used ?? 1,
      rollingUsed: rollingUsed + 1,
      day,
      blockedReason: null,
    };
  }

  const blockedReason = row.daily_used === null ? "daily_cap" : "rolling_cap";
  if (blockedReason === "daily_cap") {
    // Idempotently record that the daily limit stopped further requests.
    await sql`
      UPDATE request_budget
      SET limit_reached_at = COALESCE(limit_reached_at, now()),
          updated_at = now()
      WHERE day = ${day}
    `;
  }

  return {
    allowed: false,
    used: row.daily_used ?? DAILY_NEWSDATA_REQUEST_LIMIT,
    rollingUsed,
    day,
    blockedReason,
  };
}

export interface BudgetStats {
  day: string;
  used: number;
  limit: number;
  remaining: number;
  rolling24h: number;
  limitReachedAt: string | null;
  resetsAt: string;
}

/** Read-only view of current budget usage for the dashboard. */
export async function getBudgetStats(): Promise<BudgetStats> {
  await ensureSchema();
  const sql = getDb();
  const day = budgetDayKey();

  const rows = (await sql`
    SELECT used, limit_reached_at
    FROM request_budget
    WHERE day = ${day}
  `) as Pick<RequestBudgetRow, "used" | "limit_reached_at">[];

  const rollingRows = (await sql`
    SELECT count(*)::int AS n
    FROM request_events
    WHERE created_at > now() - interval '24 hours'
  `) as { n: number }[];

  const used = rows[0]?.used ?? 0;
  const nextUtcMidnight = new Date(`${day}T00:00:00.000Z`);
  nextUtcMidnight.setUTCDate(nextUtcMidnight.getUTCDate() + 1);

  return {
    day,
    used,
    limit: DAILY_NEWSDATA_REQUEST_LIMIT,
    remaining: Math.max(0, DAILY_NEWSDATA_REQUEST_LIMIT - used),
    rolling24h: rollingRows[0]?.n ?? 0,
    limitReachedAt: rows[0]?.limit_reached_at ?? null,
    resetsAt: nextUtcMidnight.toISOString(),
  };
}
