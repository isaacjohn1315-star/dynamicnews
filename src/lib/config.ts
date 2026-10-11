/**
 * DynaSport runtime configuration.
 *
 * Every tunable lives here and is read from the environment, so behaviour can
 * be changed on Vercel without a code change. Nothing is hardcoded in the
 * application logic — each value below has a documented default used only
 * when the matching variable is absent.
 *
 * Optional variables (all have safe defaults):
 *   CRON_INTERVAL_MINUTES   how often cron-job.org calls the automation
 *                           endpoint. Used for capacity maths and the
 *                           dashboard. Default 2.
 *   MAX_POSTS_PER_HOUR      anti-flood ceiling per rolling hour. Default 4.
 *   MIN_SPACING_MINUTES     minimum minutes between two posts. Default 6.
 *   POPULARITY_MIN_SCORE    editorial bar a story must clear. Default 65.
 *   FEED_BATCH_SIZE         feeds claimed per run. Default 180.
 *   FEED_CONCURRENCY        simultaneous outbound feed requests. Default 40.
 *   RUN_DEADLINE_MS         hard ceiling on one automation run, kept well
 *                           inside cron-job.org's 30-second abort. Default 22000.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export interface DynaSportConfig {
  /** How often the cron endpoint is expected to fire. */
  cronIntervalMinutes: number;
  /** Anti-flood: maximum posts in any rolling hour (NOT a daily cap). */
  maxPostsPerHour: number;
  /** Anti-flood: minimum minutes between consecutive posts. */
  minSpacingMinutes: number;
  /** Editorial popularity bar a story must clear to be published. */
  popularityMinScore: number;
  /** Feeds claimed per automation run. */
  feedBatchSize: number;
  /** Global cap on simultaneous outbound feed requests. */
  feedConcurrency: number;
  /** Hard ceiling on a single automation run, in milliseconds. */
  runDeadlineMs: number;
}

let cached: DynaSportConfig | null = null;

/** Returns the effective configuration, reading the environment once. */
export function getConfig(): DynaSportConfig {
  if (cached) return cached;
  cached = {
    cronIntervalMinutes: num("CRON_INTERVAL_MINUTES", 2, 1, 60),
    maxPostsPerHour: num("MAX_POSTS_PER_HOUR", 4, 1, 60),
    minSpacingMinutes: num("MIN_SPACING_MINUTES", 6, 0, 120),
    popularityMinScore: num("POPULARITY_MIN_SCORE", 65, 0, 200),
    feedBatchSize: num("FEED_BATCH_SIZE", 180, 10, 1000),
    feedConcurrency: num("FEED_CONCURRENCY", 40, 1, 200),
    runDeadlineMs: num("RUN_DEADLINE_MS", 22_000, 5_000, 28_000),
  };
  return cached;
}

/** Expected automation runs per day given the configured interval. */
export function runsPerDay(): number {
  return Math.floor((24 * 60) / getConfig().cronIntervalMinutes);
}

/** Resets the cache (used by tests). */
export function resetConfigCache(): void {
  cached = null;
}
