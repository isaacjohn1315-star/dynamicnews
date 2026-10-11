import { ensureSchema, getDb } from "./db";

/**
 * "Newly published only" gate.
 *
 * A story may be published to Facebook only when its ORIGINAL publication
 * timestamp is genuinely new since the previous successful discovery scan.
 * A short recovery window absorbs temporary feed/automation outages, but
 * nothing older than that window can ever become a publishing candidate.
 *
 * Rules enforced here:
 *  - missing, unparseable or untrustworthy timestamps are never published;
 *  - future-dated items are rejected (clock games / bad feeds);
 *  - items older than the recovery window are stored for deduplication but
 *    are not publishing candidates;
 *  - all timestamps are handled and stored in UTC;
 *  - NewsData.io items are never treated as breaking because of the free
 *    plan's delayed delivery.
 */

/** Maximum age, in minutes, for an item to still count as newly published. */
export const RECOVERY_WINDOW_MINUTES = 60;

export type FreshnessVerdict =
  | { publishable: true; ageMinutes: number; reason: string }
  | { publishable: false; ageMinutes: number | null; reason: string };

export interface ScanState {
  lastScanAt: string | null;
  lastSuccessfulScanAt: string | null;
}

export async function getScanState(): Promise<ScanState> {
  await ensureSchema();
  const sql = getDb();
  const rows = (await sql`
    SELECT last_scan_at, last_successful_scan_at FROM scan_state WHERE id = 1
  `) as { last_scan_at: string | null; last_successful_scan_at: string | null }[];
  return {
    lastScanAt: rows[0]?.last_scan_at ?? null,
    lastSuccessfulScanAt: rows[0]?.last_successful_scan_at ?? null,
  };
}

export async function recordScan(successful: boolean): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO scan_state (id, last_scan_at, last_successful_scan_at)
      VALUES (1, now(), ${successful ? "now()" : null}::timestamptz)
      ON CONFLICT (id) DO UPDATE
        SET last_scan_at = now(),
            last_successful_scan_at = CASE
              WHEN ${successful} THEN now()
              ELSE scan_state.last_successful_scan_at
            END
    `;
  } catch {
    // Checkpoint bookkeeping must never break a run.
  }
}

/**
 * Decides whether an article counts as newly published.
 *
 * `lastSuccessfulScanAt` is the checkpoint of the previous good scan. The
 * effective cut-off is the later of (checkpoint) and (now - recovery
 * window), so a long outage cannot flood the Page with hours-old stories.
 */
export function evaluateFreshness(
  publishedAt: Date | null,
  provider: "newsdata" | "rss",
  _lastSuccessfulScanAt: string | null,
  now: Date = new Date(),
): FreshnessVerdict {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
    return { publishable: false, ageMinutes: null, reason: "no trustworthy publication timestamp" };
  }

  const ageMs = now.getTime() - publishedAt.getTime();
  const ageMinutes = Math.round(ageMs / 60_000);

  if (ageMinutes < -5) {
    return { publishable: false, ageMinutes, reason: "publication timestamp is in the future" };
  }

  // The NewsData free plan can deliver items ~12h late; such items are kept
  // for deduplication and context but are never published as news.
  if (provider === "newsdata") {
    return {
      publishable: false,
      ageMinutes,
      reason: "NewsData.io free-plan delivery is delayed and is not used as a publishing source",
    };
  }

  // The recovery window is the gate. Taking the previous-scan checkpoint as
  // the cutoff instead made the effective window only as long as the cron
  // interval (~10 minutes), which silently discarded any article whose feed
  // lagged by more than that — most feeds lag 10-30 minutes. Articles
  // already seen in an earlier cycle are already excluded by the
  // deduplication key, so widening the gate to the documented 60-minute
  // window does not cause repeat posts; it only stops real news being lost.
  const cutoff = now.getTime() - RECOVERY_WINDOW_MINUTES * 60_000;

  if (publishedAt.getTime() < cutoff) {
    return {
      publishable: false,
      ageMinutes,
      reason: `published ${ageMinutes} min ago, before the ${RECOVERY_WINDOW_MINUTES}-minute freshness window`,
    };
  }

  return {
    publishable: true,
    ageMinutes,
    reason: `newly published ${Math.max(0, ageMinutes)} min ago`,
  };
}
