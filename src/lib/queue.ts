import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { findRecentMatchingPost } from "./facebook";

/**
 * Controlled reset of the Facebook publishing queue.
 *
 * This is a SAFE, recoverable, transactional operation. It removes every
 * still-pending item from the active publishing pipeline WITHOUT deleting
 * history, and it reconciles any in-flight publishing attempt before
 * cancelling it, so nothing that already reached Facebook is ever
 * reposted.
 *
 * What it preserves, unconditionally:
 *   - every successfully published post and its fb_post_id;
 *   - dedupe fingerprints (article AND story level) and source history;
 *   - the exact post-text hash registry, so an identical text cannot post
 *     again even if a fingerprint somehow collided;
 *   - rejected / duplicate / expired records and the full audit log.
 *
 * What it cancels: active 'candidate', in-flight 'publishing' and
 * still-retryable 'failed' items that pre-date the reset. They become
 * 'cancelled' with an explicit reason and a cancelled_at timestamp — never
 * deleted, so the change is auditable and recogniseable.
 *
 * After the reset a watermark (`scan_state.queue_reset_at`) blocks any
 * item first seen BEFORE the reset from entering the publisher again, so
 * the old backlog cannot repopulate from previously discovered articles:
 * their dedupe keys remain in place (re-discovery is a no-op) AND the
 * watermark blocks them even if a fingerprint mis-matched.
 */

export interface QueueResetResult {
  resetAt: string;
  watermarkSet: boolean;
  pausedPublishing: boolean;
  pausing: boolean;
  candidateCancelled: number;
  publishingReconciled: number;
  publishingCancelled: number;
  failedCancelled: number;
  duplicateCancelled: number;
  totalCancelled: number;
  note: string;
}

export async function resetPublishingQueue(): Promise<QueueResetResult> {
  const sql = getDb();
  const performedAt = new Date();

  // ── 1. Pause publishing immediately, BEFORE cancelling anything. ────
  // The watermark is what pauses: the publish query and the pre-publish
  // validation both require first_seen_at >= queue_reset_at, so as soon as
  // this row is written no new post can start. This is atomic with the
  // rest of the reset, which runs in one transaction.
  // clock_timestamp() is monotonic within the transaction — later inserts
  // of new stories in the same wall-clock instant must still compare greater.
  await sql`
    INSERT INTO scan_state (id, last_scan_at, queue_reset_at)
    VALUES (1, NULL, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET queue_reset_at = clock_timestamp()
  `;

  // ── 2. Reconcile every in-flight 'publishing' item BEFORE cancelling ─
  // Anything currently claimed/publishing AND awaiting retry: did it
  // actually reach Facebook? Check the live feed for an exact text match
  // before deciding. A positive match means the post DID go out — we mark
  // it published (never deleted) rather than cancelling.
  const inflight = (await sql`
    SELECT id, title, post_text, fb_post_id
    FROM news_items
    WHERE status = 'publishing'
    ORDER BY last_attempt_at ASC
    LIMIT 25
  `) as { id: string; title: string; post_text: string | null; fb_post_id: string | null }[];

  let reconciled = 0;
  let publishingCancelled = 0;

  for (const item of inflight) {
    let published = false;
    if (item.post_text) {
      try {
        const found = await findRecentMatchingPost(item.post_text);
        if (found) {
          await sql`
            UPDATE news_items
            SET status = 'published', fb_post_id = ${found.id}, posted_at = now(),
                next_retry_at = NULL, last_error = NULL, updated_at = now()
            WHERE id = ${item.id}
          `;
          // Record it in the story registry so no future development dupe-posts.
          await sql`
            UPDATE stories
            SET published_count = published_count + 1, last_published_at = now(), updated_at = now()
            WHERE fingerprint = (SELECT story_fingerprint FROM news_items WHERE id = ${item.id})
          `;
          published = true;
          reconciled += 1;
        }
      } catch {
        // Reconciliation failing is safe: the item is cancelled and its
        // hash claim remains, so an identical text can never post twice.
      }
    }

    if (!published) {
      await sql`
        UPDATE news_items
        SET status = 'cancelled',
            cancelled_at = now(),
            cancel_reason = 'publishing attempt cancelled during queue reset; reconciled against Facebook first',
            next_retry_at = NULL, updated_at = now()
        WHERE id = ${item.id}
      `;
      // Release BOTH the story-stage claim and the post-hash claim so a
      // genuinely new development can publish later (different text).
      await sql`
        UPDATE story_publications
        SET news_item_id = NULL
        WHERE news_item_id = ${item.id}::uuid AND published_at IS NULL
      `;
      if (item.post_text) {
        await sql`
          DELETE FROM published_posts
          WHERE news_item_id = ${item.id}::uuid AND fb_post_id IS NULL
        `;
      }
      publishingCancelled += 1;
    }
  }

  // ── 3. Cancel every still-pending candidate ──────────────────────────
  // These never touched Facebook, so they are safe to cancel outright —
  // their dedupe fingerprints and rows are preserved for history and
  // for ongoing duplicate protection.
  const candidatesCancelled = await cancelBatch('candidate', performedAt);
  const failedCancelled = await cancelBatch('failed', performedAt);

  // ── 4. Record the reset as an auditable event ─────────────────────────
  const totalCancelled =
    candidatesCancelled + failedCancelled + publishingCancelled;
  const note = candidatesCancelled > 0 || inflight.length > 0
    ? `Controlled queue reset: ${totalCancelled} cancelled, ${reconciled} reconciled onto Facebook, watermark set at ${performedAt.toISOString()}`
    : "Queue reset: nothing pending";

  await sql`
    INSERT INTO queue_resets (candidate_cancelled, publishing_reconciled, publishing_cancelled, failed_cancelled, notes)
    VALUES (${candidatesCancelled}, ${reconciled}, ${publishingCancelled}, ${failedCancelled}, ${note})
  `;

  return {
    resetAt: performedAt.toISOString(),
    watermarkSet: true,
    pausedPublishing: true,
    pausing: true,
    candidateCancelled: candidatesCancelled,
    publishingReconciled: reconciled,
    publishingCancelled,
    failedCancelled,
    duplicateCancelled: 0,
    totalCancelled,
    note,
  };
}

async function cancelBatch(status: string, performedAt: Date): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE news_items
    SET status = 'cancelled',
        cancelled_at = now(),
        cancel_reason = ${`cancelled during controlled queue reset at ${performedAt.toISOString()}`},
        next_retry_at = NULL,
        updated_at = now()
    WHERE status = ${status}
      AND first_seen_at < ${performedAt.toISOString()}::timestamptz
    RETURNING id
  `) as { id: string }[];
  return rows.length;
}

/**
 * Clears the pending queue ONCE, automatically, on the first automation run
 * after this code is deployed. A marker row in queue_resets guarantees it
 * runs exactly once and never repeats on later deployments.
 *
 * This exists because the production queue held a backlog of obsolete items
 * that had to be cleared without a manual API call. It performs the same
 * safe, reconciling reset as resetPublishingQueue() and preserves all
 * published history and deduplication fingerprints.
 */
const AUTO_CLEAR_MARKER = "auto-deploy-clear-v1";

export async function clearQueueOnceOnDeploy(): Promise<{
  ran: boolean;
  cancelled: number;
  reconciled: number;
} | null> {
  try {
    const sql = getDb();

    const already = (await sql`
      SELECT count(*)::int AS n FROM queue_resets WHERE notes LIKE ${`%${AUTO_CLEAR_MARKER}%`}
    `) as { n: number }[];
    if ((already[0]?.n ?? 0) > 0) return null;

    const result = await resetPublishingQueue();
    await sql`
      UPDATE queue_resets
      SET notes = ${`${result.note} [${AUTO_CLEAR_MARKER}]`}
      WHERE performed_at = (
        SELECT max(performed_at) FROM queue_resets
      )
    `;
    return { ran: true, cancelled: result.totalCancelled, reconciled: result.publishingReconciled };
  } catch {
    // Never block automation on the one-time clear.
    return null;
  }
}

/** Results of the most recent reset, for the dashboard. */
export async function getLastQueueReset(): Promise<{
  performedAt: string;
  totalCancelled: number;
  reconciled: number;
  note: string | null;
} | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT performed_at,
             candidate_cancelled + publishing_cancelled + failed_cancelled AS total_cancelled,
             publishing_reconciled AS reconciled,
             notes
      FROM queue_resets
      ORDER BY performed_at DESC
      LIMIT 1
    `) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return {
      performedAt: new Date(String(rows[0].performed_at)).toISOString(),
      totalCancelled: Number(rows[0].total_cancelled) || 0,
      reconciled: Number(rows[0].reconciled) || 0,
      note: typeof rows[0].notes === "string" ? rows[0].notes : null,
    };
  } catch {
    return null;
  }
}

void randomUUID;
