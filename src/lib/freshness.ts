import { ensureSchema, getDb } from "./db";

/**
 * Freshness policy and timestamp semantics for DynaSport.
 *
 * ── Timestamp meanings (audited, single source of truth) ──────────────────
 *   published_at  the PUBLISHER's original publication time.
 *   first_seen_at when DynaSport first discovered the article.
 *   last_seen_at  the most recent feed observation of the same article.
 *   updated_at    row maintenance time — NEVER treated as publication time.
 *
 * Age is always measured from `published_at`. Re-fetching an old article
 * updates `last_seen_at` only and can never make it look newly published.
 *
 * ── Freshness categories ──────────────────────────────────────────────────
 *   breaking  a confirmed development published within the last few hours.
 *   fresh     an important development published within the last 48 hours.
 *   trending  roughly 2–7 days old AND independently reported by at least two
 *             distinct credible publishers — i.e. there is real evidence the
 *             story is still being discussed. Labelled "trending", never
 *             presented as newly breaking.
 *   older     beyond 7 days: rejected unless it is a materially new
 *             development with its own event fingerprint.
 *
 * There is deliberately NO blanket age cut-off: a widely corroborated story
 * that is several days old can still matter to football fans, while a
 * 3-day-old single-source rumour cannot.
 */

/** Confirmed developments within this window are "breaking". */
export const BREAKING_WINDOW_HOURS = 6;
/** Important developments within this window are "fresh". */
export const FRESH_WINDOW_HOURS = 48;
/** Upper bound for a corroborated story to count as "trending". */
export const TRENDING_WINDOW_DAYS = 7;

/**
 * Distinct credible publishers required before a several-day-old story may be
 * treated as trending. Distinct means different publishers — one outlet
 * publishing five near-copies is breadth of one, not five.
 */
export const TRENDING_MIN_DISTINCT_PUBLISHERS = 2;

/** Minimum relevance score a trending story must already have. */
export const TRENDING_MIN_SCORE = 60;

export type FreshnessCategory = "breaking" | "fresh" | "trending" | "older";

export interface FreshnessVerdict {
  category: FreshnessCategory;
  /** Age of the ORIGINAL article in minutes (null when unknown). */
  ageMinutes: number | null;
  /** True when the story may be published. */
  eligible: boolean;
  /** True when eligibility depends on corroboration evidence. */
  requiresCorroboration: boolean;
  reason: string;
}

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

/* ------------------------------------------------------------------ */
/* Timestamp parsing — one implementation, used by every provider      */
/* ------------------------------------------------------------------ */

/** RFC-822 named zones that V8's Date parser rejects. */
const TZ_OFFSETS: Record<string, string> = {
  UT: "+0000", UTC: "+0000", GMT: "+0000", BST: "+0100", Z: "+0000",
  EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500",
  MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700",
  CET: "+0100", CEST: "+0200", EET: "+0200", EEST: "+0300",
};

const MIN_PLAUSIBLE_YEAR = 2000;

/**
 * Parses a publisher timestamp into a UTC Date, or null when the value is
 * missing or cannot be trusted. Handles RFC-822 (RSS), ISO-8601 (Atom),
 * named time zones, and bare epoch values without confusing seconds with
 * milliseconds.
 */
export function parseTimestamp(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  // Bare epoch values: some feeds emit seconds, others milliseconds.
  // Anything below 1e12 must be seconds (1e12 ms is Sep 2001); anything at
  // or above it is already milliseconds. This prevents a seconds value being
  // read as milliseconds (year 56 000) or vice versa (year 1970).
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return plausibleYearMs(ms) ? new Date(ms) : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{9,14}$/.test(raw)) {
    const numeric = Number.parseInt(raw, 10);
    const ms = raw.length <= 11 ? numeric * 1000 : numeric;
    return plausibleYearMs(ms) ? new Date(ms) : null;
  }

  let normalized = raw;
  const tzMatch = normalized.match(/\b([A-Z]{1,4})$/);
  if (tzMatch && TZ_OFFSETS[tzMatch[1]]) {
    normalized = `${normalized.slice(0, tzMatch.index)}${TZ_OFFSETS[tzMatch[1]]}`;
  }

  let parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    // "YYYY-MM-DD HH:MM:SS" (no zone) is treated as UTC, not local time.
    parsed = new Date(normalized.includes("T") ? normalized : `${normalized.replace(" ", "T")}Z`);
  }
  if (Number.isNaN(parsed.getTime())) return null;
  if (!plausibleYearMs(parsed.getTime())) return null;
  return parsed;
}

function plausibleYearMs(ms: number): boolean {
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_PLAUSIBLE_YEAR && year <= new Date().getUTCFullYear() + 1;
}

/** Age of the original article in minutes, or null when unknown. */
export function ageMinutesFrom(publishedAt: Date | null, now: Date = new Date()): number | null {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  return Math.round((now.getTime() - publishedAt.getTime()) / 60_000);
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export interface FreshnessInput {
  publishedAt: Date | null;
  /** Detected reporting stage rank (5 = official). */
  stageRank: number;
  isRumour: boolean;
  /** Relevance score already computed for the story. */
  score: number;
  /** Distinct credible publishers independently reporting this story. */
  distinctPublishers: number;
}

/**
 * Classifies a story into a freshness category and decides whether it may be
 * published. A story with no trustworthy publication timestamp is never
 * published automatically.
 */
export function evaluateFreshness(
  input: FreshnessInput,
  now: Date = new Date(),
): FreshnessVerdict {
  const { publishedAt, stageRank, isRumour, score, distinctPublishers } = input;
  const ageMinutes = ageMinutesFrom(publishedAt, now);

  if (!publishedAt || ageMinutes === null) {
    return {
      category: "older",
      ageMinutes: null,
      eligible: false,
      requiresCorroboration: false,
      reason: "no trustworthy publication timestamp",
    };
  }

  // A timestamp in the future is a feed error, not a scoop.
  if (ageMinutes < -5) {
    return {
      category: "older",
      ageMinutes,
      eligible: false,
      requiresCorroboration: false,
      reason: "publication timestamp is in the future",
    };
  }

  const ageHours = ageMinutes / 60;

  // ── Breaking: confirmed, very recent. ──────────────────────────────
  if (ageHours <= BREAKING_WINDOW_HOURS) {
    if (!isRumour && stageRank >= 4) {
      return {
        category: "breaking",
        ageMinutes,
        eligible: true,
        requiresCorroboration: false,
        reason: `breaking: confirmed development published ${describeAge(ageMinutes)}`,
      };
    }
    return {
      category: "fresh",
      ageMinutes,
      eligible: true,
      requiresCorroboration: false,
      reason: `fresh: published ${describeAge(ageMinutes)}`,
    };
  }

  // ── Fresh: within 48 hours. ────────────────────────────────────────
  if (ageHours <= FRESH_WINDOW_HOURS) {
    return {
      category: "fresh",
      ageMinutes,
      eligible: true,
      requiresCorroboration: false,
      reason: `fresh: published ${describeAge(ageMinutes)}`,
    };
  }

  // ── Trending: 2–7 days old, but only with real corroboration. ──────
  if (ageHours <= TRENDING_WINDOW_DAYS * 24) {
    const corroborated = distinctPublishers >= TRENDING_MIN_DISTINCT_PUBLISHERS;
    const newsworthy = score >= TRENDING_MIN_SCORE;
    if (corroborated && newsworthy) {
      return {
        category: "trending",
        ageMinutes,
        eligible: true,
        requiresCorroboration: true,
        reason: `trending: published ${describeAge(ageMinutes)} and independently reported by ${distinctPublishers} publishers`,
      };
    }
    return {
      category: "trending",
      ageMinutes,
      eligible: false,
      requiresCorroboration: true,
      reason: corroborated
        ? `published ${describeAge(ageMinutes)} — too old to publish without higher newsworthiness`
        : `published ${describeAge(ageMinutes)} with only ${distinctPublishers} distinct publisher(s) — no evidence it remains widely discussed`,
    };
  }

  // ── Older: beyond the trending window. ─────────────────────────────
  return {
    category: "older",
    ageMinutes,
    eligible: false,
    requiresCorroboration: false,
    reason: `published ${describeAge(ageMinutes)} — background story, only a materially new development can be published`,
  };
}

export function describeAge(ageMinutes: number | null): string {
  if (ageMinutes === null) return "at an unknown time";
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} minutes ago`;
  const hours = ageMinutes / 60;
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}
