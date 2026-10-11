import { createHash } from "node:crypto";
import { getDb } from "./db";
import { facebookAppCredentials, facebookPageAccessToken, facebookPageId } from "./env";

/**
 * Meta Graph API integration (server-only).
 *
 * Publishes text posts to the DynaSport Page via POST /{page-id}/feed using
 * the existing Page access token. There is deliberately no automatic token
 * refresh: the configured Page token is used exactly as provided, errors
 * fail safely, and tokens are never logged or exposed. FACEBOOK_APP_ID and
 * FACEBOOK_APP_SECRET are only used by the official /debug_token
 * introspection flow for read-only health monitoring on the dashboard.
 */

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";
const REQUEST_TIMEOUT_MS = 10_000;
/** Photo uploads carry bytes, so they get a longer budget. */
const PHOTO_TIMEOUT_MS = 20_000;

/**
 * The DynaSport post format is exact and intentional:
 *
 *   🚩 <headline>
 *   <blank line>
 *   <explanation of why it matters / what is actually known>
 *   <blank line>
 *   Source: <real publisher>
 *
 * No article links. No hashtags. Exactly one blank line between each part.
 */
/** The explanation can be several sentences, so it spans multiple lines. */
const POST_PATTERN = /^🚩 [^\n]{15,}\n\n[\s\S]{25,2000}\n\nSource: [^\n]{1,80}$/;
const FORBIDDEN_IN_POST = /(https?:\/\/|www\.|#\w)/i;
/** Raw markup or escaped character codes must never reach Facebook. */
const RESIDUAL_MARKUP = /<[a-zA-Z/][^>]*>|&[a-zA-Z]{2,8};|&#\d{2,6};?/;

export function buildFacebookPostText(
  headline: string,
  explanation: string,
  sourceName: string,
): string {
  const cleanHeadline = headline.replace(/\s+/g, " ").trim();
  const cleanExplanation = explanation.replace(/\s+/g, " ").trim();
  const cleanSource = sourceName.replace(/\s+/g, " ").trim();
  return `🚩 ${cleanHeadline}\n\n${cleanExplanation}\n\nSource: ${cleanSource}`;
}

/** Verifies every format invariant before anything is sent to Meta. */
export function isValidPostText(text: string): boolean {
  if (!POST_PATTERN.test(text)) return false;
  if (FORBIDDEN_IN_POST.test(text)) return false;
  if (RESIDUAL_MARKUP.test(text)) return false;

  const parts = text.split("\n");
  // headline, blank, body (>=1 line), blank, source
  if (parts.length < 5) return false;
  if (parts[1] !== "" || parts[parts.length - 2] !== "") return false;
  if (!parts[0].startsWith("🚩 ")) return false;
  const body = parts.slice(2, parts.length - 2).join(" ").trim();
  if (body.length < 25) return false;
  // No unfinished sentences and no ellipsis hiding missing information.
  if (/\.{3}|\u2026|…/.test(body)) return false;
  if (!/[.!?]$/.test(body)) return false;
  const source = parts[parts.length - 1];
  if (!source.startsWith("Source: ") || source.length <= "Source: ".length) return false;
  return true;
}

export class FacebookPublishError extends Error {
  readonly code: number | null;
  /**
   * "uncertain" means the request may have reached Meta but the outcome was
   * not observed (network failure, timeout, malformed reply). Callers must
   * reconcile before retrying so a retry cannot create a duplicate post.
   * Explicit Meta API error responses are certain failures.
   */
  readonly uncertain: boolean;

  constructor(message: string, code: number | null = null, uncertain: boolean = true) {
    super(message);
    this.name = "FacebookPublishError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

/**
 * Publishes a text post to /{page-id}/feed. Returns the new post id.
 * Throws FacebookPublishError (with any token material redacted) on failure.
 */
export async function publishToFacebook(message: string): Promise<{ id: string }> {
  if (!isValidPostText(message)) {
    throw new FacebookPublishError("Post text failed DynaSport format validation");
  }

  // STRICT duplicate protection at the last possible moment: the exact
  // message text can never be published twice, regardless of which
  // discovery path produced it.
  const hash = createHash("sha256").update(message, "utf8").digest("hex");
  const sql = getDb();
  const claimed = (await sql`
    INSERT INTO published_posts (post_hash) VALUES (${hash})
    ON CONFLICT (post_hash) DO NOTHING
    RETURNING post_hash
  `) as { post_hash: string }[];
  if (claimed.length === 0) {
    throw new FacebookPublishError("This exact post has already been published", null, false);
  }

  const pageId = facebookPageId();
  const token = facebookPageAccessToken();

  const body = new URLSearchParams({ message, access_token: token });

  let response: Response;
  try {
    response = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new FacebookPublishError(
      `Network error while posting to Facebook: ${redact(errorMessage(error), token)}`,
      null,
      true,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new FacebookPublishError(
      `Meta Graph API returned non-JSON body (HTTP ${response.status})`,
      null,
      true,
    );
  }

  const record = payload as { id?: unknown; error?: { message?: unknown; code?: unknown } } | null;

  if (!response.ok || (record && typeof record === "object" && record.error)) {
    const metaError = record && typeof record === "object" ? record.error : undefined;
    const message =
      metaError && typeof metaError.message === "string"
        ? metaError.message
        : `HTTP ${response.status}`;
    const code = metaError && typeof metaError.code === "number" ? metaError.code : null;
    // Meta answered with a structured error: the post did not go through.
    throw new FacebookPublishError(
      `Meta Graph API error${code !== null ? ` ${code}` : ""}: ${redact(message, token)}`,
      code,
      false,
    );
  }

  if (!record || typeof record.id !== "string" || record.id.length === 0) {
    throw new FacebookPublishError("Meta Graph API did not return a post id", null, true);
  }

  return { id: record.id };
}

/**
 * Publishes a PHOTO POST: validated image bytes plus the football-news
 * caption in ONE combined Facebook post (never a photo and a separate
 * text post).
 *
 * Uses POST /{page-id}/photos with the image attached as multipart
 * form-data under the documented `source` field. The response carries the
 * photo id and `post_id`, the id of the resulting Page post — we store the
 * latter when present so the dashboard links to the real post.
 *
 * The same strict duplicate guard as text posts applies: the exact caption
 * text is hashed and claimed before upload, so a photo post and a text
 * post of the same story can never both go out.
 */
export async function publishPhotoToFacebook(
  message: string,
  image: { bytes: Uint8Array; mime: string },
): Promise<{ id: string; postId: string | null }> {
  if (!isValidPostText(message)) {
    throw new FacebookPublishError("Post text failed DynaSport format validation", null, false);
  }

  const hash = createHash("sha256").update(message, "utf8").digest("hex");
  const sql = getDb();
  const claimed = (await sql`
    INSERT INTO published_posts (post_hash) VALUES (${hash})
    ON CONFLICT (post_hash) DO NOTHING
    RETURNING post_hash
  `) as { post_hash: string }[];
  if (claimed.length === 0) {
    throw new FacebookPublishError("This exact post has already been published", null, false);
  }

  const pageId = facebookPageId();
  const token = facebookPageAccessToken();

  const extension = image.mime === "image/png" ? "png" : image.mime === "image/gif" ? "gif" : "jpg";
  const form = new FormData();
  // Copy into a fresh ArrayBuffer so Blob gets exactly the image bytes.
  const copy = new Uint8Array(image.bytes.byteLength);
  copy.set(image.bytes);
  form.append("source", new Blob([copy], { type: image.mime }), `dynasport.${extension}`);
  form.append("caption", message);
  form.append("access_token", token);

  let response: Response;
  try {
    // Content-Type is intentionally NOT set: fetch adds the multipart
    // boundary itself, and overriding it breaks the upload.
    response = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/photos`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    // Uncertain: the upload may have reached Meta. The caller reconciles.
    throw new FacebookPublishError(
      `Network error while uploading photo: ${redact(errorMessage(error), token)}`,
      null,
      true,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new FacebookPublishError(
      `Meta Graph API returned non-JSON body (HTTP ${response.status})`,
      null,
      true,
    );
  }

  const record = payload as
    | { id?: unknown; post_id?: unknown; error?: { message?: unknown; code?: unknown } }
    | null;

  if (!response.ok || (record && typeof record === "object" && record.error)) {
    const metaError = record && typeof record === "object" ? record.error : undefined;
    const message2 =
      metaError && typeof metaError.message === "string" ? metaError.message : `HTTP ${response.status}`;
    const code = metaError && typeof metaError.code === "number" ? metaError.code : null;
    // Release the hash claim: this exact caption did NOT publish, so it
    // must stay eligible (for a retry, or for a text-only fallback).
    await releasePostHash(hash);
    throw new FacebookPublishError(
      `Meta Graph API photo error${code !== null ? ` ${code}` : ""}: ${redact(message2, token)}`,
      code,
      false,
    );
  }

  if (!record || typeof record.id !== "string" || record.id.length === 0) {
    throw new FacebookPublishError("Meta Graph API did not return a photo id", null, true);
  }

  return {
    id: record.id,
    postId: typeof record.post_id === "string" ? record.post_id : null,
  };
}

/** Releases an unused post-hash claim so the text can be published later. */
export async function releasePostHash(hash: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`DELETE FROM published_posts WHERE post_hash = ${hash} AND fb_post_id IS NULL`;
  } catch {
    // Non-fatal: at worst this exact text stays blocked, never duplicated.
  }
}

/** Hash used by the duplicate guard, exposed so callers can release it. */
export function postHashOf(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/**
 * Reconciliation helper used after an UNCERTAIN publish outcome: reads the
 * Page's very recent posts and looks for an exact copy of the message. If
 * found, the post actually went through and the caller can mark the story
 * as published instead of retrying into a duplicate. Uses the existing Page
 * token and the official API; fails safely to null on any problem.
 */
export async function findRecentMatchingPost(message: string): Promise<{ id: string } | null> {
  try {
    const pageId = facebookPageId();
    const token = facebookPageAccessToken();
    const params = new URLSearchParams({
      fields: "message,created_time",
      limit: "15",
      access_token: token,
    });

    const response = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json().catch(() => null)) as {
      data?: { id?: unknown; message?: unknown; created_time?: unknown }[];
    } | null;
    if (!payload || !Array.isArray(payload.data)) return null;

    const cutoff = Date.now() - 45 * 60_000;
    for (const post of payload.data) {
      if (
        post &&
        typeof post.id === "string" &&
        post.message === message &&
        typeof post.created_time === "string" &&
        new Date(post.created_time).getTime() >= cutoff
      ) {
        return { id: post.id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface PageTokenHealth {
  status: "valid" | "invalid" | "expired" | "unknown";
  expiresAt: string | null;
  scopes: string[] | null;
  detail: string | null;
}

/**
 * Read-only token introspection via the official /debug_token flow, which
 * requires an app access token ("{app-id}|{app-secret}") — the only place
 * FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are used. Fails safely: any problem
 * yields status "unknown" and never affects normal posting.
 */
export async function checkPageTokenHealth(): Promise<PageTokenHealth> {
  const unknown = (detail: string): PageTokenHealth => ({
    status: "unknown",
    expiresAt: null,
    scopes: null,
    detail,
  });

  try {
    const app = facebookAppCredentials();
    if (!app) {
      return unknown("Meta app credentials are not configured");
    }
    let token: string;
    try {
      token = facebookPageAccessToken();
    } catch {
      return unknown("Page access token is not configured");
    }

    const appAccessToken = `${app.appId}|${app.appSecret}`;
    const params = new URLSearchParams({
      input_token: token,
      access_token: appAccessToken,
    });

    const response = await fetch(`${GRAPH_API_BASE}/debug_token?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as {
      data?: { is_valid?: unknown; expires_at?: unknown; scopes?: unknown };
      error?: { message?: unknown };
    } | null;

    if (!response.ok || !payload || typeof payload !== "object" || !payload.data) {
      const message =
        payload && payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : `HTTP ${response.status}`;
      return unknown(`Token check unavailable: ${redact(message, appAccessToken)}`);
    }

    const data = payload.data;
    const isValid = data.is_valid === true;
    const expiresAt =
      typeof data.expires_at === "number" && data.expires_at > 0
        ? new Date(data.expires_at * 1000).toISOString()
        : null;
    const scopes = Array.isArray(data.scopes)
      ? data.scopes.filter((s): s is string => typeof s === "string")
      : null;

    if (!isValid) {
      return { status: "invalid", expiresAt, scopes, detail: "Meta reports the Page token is not valid" };
    }
    if (expiresAt !== null && new Date(expiresAt).getTime() < Date.now()) {
      return { status: "expired", expiresAt, scopes, detail: "Page token has expired" };
    }
    return { status: "valid", expiresAt, scopes, detail: null };
  } catch (error) {
    return unknown(`Token check failed: ${errorMessage(error)}`);
  }
}

function redact(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
