import { isSafeFeedUrl } from "./feed-registry";

/**
 * Article image discovery, download and validation.
 *
 * A URL is not an image. Everything here exists to turn a candidate URL
 * into VERIFIED BINARY BYTES that Facebook will accept, or to fail safely
 * so the story is published as text only.
 *
 * Security and safety:
 *   - only http(s); every redirect hop is re-checked for SSRF (loopback,
 *     private ranges, cloud metadata endpoints are blocked);
 *   - bounded timeout and a hard byte cap, enforced while streaming so an
 *     oversized or endless response can never exhaust memory;
 *   - the real file signature (magic bytes) must match a Facebook-supported
 *     format — a declared Content-Type is never trusted on its own, so HTML
 *     error pages and mislabelled files are rejected;
 *   - bytes live in memory for the duration of one publish attempt only.
 *     Nothing is written to disk and no binary is stored in Neon.
 */

/** Facebook /photos accepts JPEG, BMP, PNG, GIF and TIFF; cap is 10 MB. */
export const MAX_IMAGE_BYTES = 8_000_000;
export const MIN_IMAGE_BYTES = 1_024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "DynaSport/1.0 (+football news monitoring; contact via DynaSport Facebook page)";

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif";

/** Formats Facebook's photos edge accepts directly. */
const FACEBOOK_SUPPORTED: ImageMime[] = ["image/jpeg", "image/png", "image/gif"];

export interface ImageCandidate {
  url: string;
  /** Where the URL came from, for attribution and auditing. */
  origin: "media:content" | "media:thumbnail" | "enclosure" | "og:image" | "twitter:image";
  publisher: string | null;
}

export type ImageStatus =
  | "published_with_image"
  | "none_found"
  | "download_failed"
  | "validation_failed"
  | "unsupported_format"
  | "too_large"
  | "blocked_unsafe"
  | "ok";

export interface DownloadedImage {
  ok: true;
  bytes: Uint8Array;
  mime: ImageMime;
  byteSize: number;
  sourceUrl: string;
  finalUrl: string;
  origin: string;
  publisher: string | null;
}

export interface DownloadFailure {
  ok: false;
  status: Exclude<ImageStatus, "ok" | "published_with_image">;
  reason: string;
  sourceUrl: string;
}

export type DownloadResult = DownloadedImage | DownloadFailure;

/* ------------------------------------------------------------------ */
/* Signature (magic byte) detection                                    */
/* ------------------------------------------------------------------ */

/**
 * Identifies the true format from the file's leading bytes. Returns null
 * for anything that is not a recognised image — including HTML error pages
 * served with an image Content-Type.
 */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }

  // AVIF / HEIF: ftyp box with an "avif"/"heic" brand.
  if (
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand.startsWith("avi") || brand.startsWith("hei") || brand.startsWith("mif")) {
      return "image/avif";
    }
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/** True when Facebook's photos edge accepts this format directly. */
export function isFacebookSupported(mime: ImageMime): boolean {
  return FACEBOOK_SUPPORTED.includes(mime);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/** Image URLs that are decorative rather than editorial. */
const JUNK_IMAGE =
  /(sprite|placeholder|avatar|logo|icon|favicon|blank|pixel|spacer|1x1|transparent|default[-_]?image|share[-_]?image|social[-_]?default)/i;

function plausibleImageUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2_000) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (JUNK_IMAGE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Extracts image candidates from a parsed RSS/Atom item, in priority
 * order: media:content, media:thumbnail, then enclosure.
 */
export function imageCandidatesFromFeedItem(
  record: Record<string, unknown>,
  publisher: string | null,
): ImageCandidate[] {
  const out: ImageCandidate[] = [];

  const push = (url: string | null, origin: ImageCandidate["origin"]) => {
    if (url && !out.some((c) => c.url === url)) out.push({ url, origin, publisher });
  };

  const attrUrl = (value: unknown): string | null => {
    if (!value) return null;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === "string") {
        const direct = plausibleImageUrl(item);
        if (direct) return direct;
        continue;
      }
      if (typeof item === "object" && item !== null) {
        const rec = item as Record<string, unknown>;
        const type = typeof rec["@_type"] === "string" ? rec["@_type"] : "";
        const medium = typeof rec["@_medium"] === "string" ? rec["@_medium"] : "";
        const url = plausibleImageUrl(
          typeof rec["@_url"] === "string" ? rec["@_url"] : undefined,
        );
        if (!url) continue;
        // Only accept entries that are actually images.
        if (type && !type.startsWith("image/")) continue;
        if (!type && medium && medium !== "image") continue;
        if (!type && !medium && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) continue;
        return url;
      }
    }
    return null;
  };

  push(attrUrl(record.content), "media:content");
  push(attrUrl(record.thumbnail), "media:thumbnail");
  push(attrUrl(record.enclosure), "enclosure");

  return out;
}

/**
 * Extracts og:image / twitter:image from article HTML. The HTML must
 * already have been fetched through the robots-respecting article fetcher.
 */
export function imageCandidatesFromHtml(
  html: string,
  baseUrl: string,
  publisher: string | null,
): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const head = html.slice(0, 200_000);

  const metaPattern = /<meta\s+[^>]*>/gi;
  let match: RegExpExecArray | null = metaPattern.exec(head);
  while (match !== null) {
    const tag = match[0];
    const prop = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (prop && content) {
      let origin: ImageCandidate["origin"] | null = null;
      if (prop === "og:image" || prop === "og:image:secure_url" || prop === "og:image:url") {
        origin = "og:image";
      } else if (prop === "twitter:image" || prop === "twitter:image:src") {
        origin = "twitter:image";
      }
      if (origin) {
        let resolved: string | null = null;
        try {
          resolved = plausibleImageUrl(new URL(content, baseUrl).toString());
        } catch {
          resolved = null;
        }
        if (resolved && !out.some((c) => c.url === resolved)) {
          out.push({ url: resolved, origin, publisher });
        }
      }
    }
    match = metaPattern.exec(head);
  }

  // og:image is the publisher's own chosen share image, so prefer it.
  out.sort((a, b) => (a.origin === "og:image" ? -1 : 0) - (b.origin === "og:image" ? -1 : 0));
  return out;
}

/* ------------------------------------------------------------------ */
/* Download + validation                                               */
/* ------------------------------------------------------------------ */

/**
 * Downloads a candidate image as real binary bytes and validates it.
 *
 * Returns verified bytes, or a typed failure explaining exactly which
 * stage rejected it so the dashboard can distinguish "no image found"
 * from "download failed" from "validation rejected".
 */
export async function downloadImage(candidate: ImageCandidate): Promise<DownloadResult> {
  const sourceUrl = candidate.url;

  const safety = isSafeFeedUrl(sourceUrl);
  if (!safety.safe) {
    return { ok: false, status: "blocked_unsafe", reason: `unsafe image URL: ${safety.reason}`, sourceUrl };
  }

  let response: Response;
  let finalUrl = sourceUrl;
  try {
    // Manual redirects so every hop is SSRF-checked.
    let current: Response | null = null;
    let target = sourceUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const hopSafety = isSafeFeedUrl(target);
      if (!hopSafety.safe) {
        return {
          ok: false,
          status: "blocked_unsafe",
          reason: `unsafe redirect target: ${hopSafety.reason}`,
          sourceUrl,
        };
      }
      current = await fetch(target, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          // Only advertise formats the Facebook photos edge accepts.
          // Advertising image/avif made publisher CDNs content-negotiate
          // to AVIF, which Facebook rejects — so it is deliberately absent.
          Accept: "image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (current.status >= 300 && current.status < 400) {
        const location = current.headers.get("location");
        if (!location) break;
        target = new URL(location, target).toString();
        finalUrl = target;
        continue;
      }
      finalUrl = target;
      break;
    }
    if (!current) {
      return { ok: false, status: "download_failed", reason: "no response", sourceUrl };
    }
    response = current;
  } catch (error) {
    return {
      ok: false,
      status: "download_failed",
      reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      sourceUrl,
    };
  }

  if (!response.ok) {
    return { ok: false, status: "download_failed", reason: `HTTP ${response.status}`, sourceUrl };
  }

  // Reject oversized responses before reading them.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: "too_large",
      reason: `declared ${declared} bytes exceeds ${MAX_IMAGE_BYTES}`,
      sourceUrl,
    };
  }

  // Read as BINARY, enforcing the cap while streaming.
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, MAX_IMAGE_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "TOO_LARGE") {
      return { ok: false, status: "too_large", reason: `body exceeded ${MAX_IMAGE_BYTES} bytes`, sourceUrl };
    }
    return { ok: false, status: "download_failed", reason: `read failed: ${message}`, sourceUrl };
  }

  if (bytes.byteLength < MIN_IMAGE_BYTES) {
    return { ok: false, status: "validation_failed", reason: `image too small (${bytes.byteLength} bytes)`, sourceUrl };
  }

  // The real signature decides — a declared Content-Type is never trusted.
  const mime = detectImageMime(bytes);
  if (!mime) {
    const declaredType = (response.headers.get("content-type") ?? "unknown").split(";")[0];
    return {
      ok: false,
      status: "validation_failed",
      reason: `file signature is not a supported image (server declared ${declaredType})`,
      sourceUrl,
    };
  }

  if (!isFacebookSupported(mime)) {
    // WEBP is a real image but the photos edge does not accept it. We do
    // not add a heavy image-processing dependency to transcode; the story
    // falls back to a text-only post instead.
    return {
      ok: false,
      status: "unsupported_format",
      reason: `${mime} is not accepted by the Facebook photos endpoint`,
      sourceUrl,
    };
  }

  return {
    ok: true,
    bytes,
    mime,
    byteSize: bytes.byteLength,
    sourceUrl,
    finalUrl,
    origin: candidate.origin,
    publisher: candidate.publisher,
  };
}

/** Reads a response body as bytes, aborting if it exceeds `limit`. */
async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new Error("TOO_LARGE");
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error("TOO_LARGE");
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Tries each candidate in order and returns the first that downloads and
 * validates. Bounded so one story can never trigger many downloads.
 */
export async function resolveImage(
  candidates: ImageCandidate[],
  maxAttempts = 3,
): Promise<DownloadResult> {
  if (candidates.length === 0) {
    return { ok: false, status: "none_found", reason: "no image candidate found", sourceUrl: "" };
  }
  let lastFailure: DownloadFailure = {
    ok: false,
    status: "none_found",
    reason: "no image candidate found",
    sourceUrl: "",
  };
  for (const candidate of candidates.slice(0, maxAttempts)) {
    const result = await downloadImage(candidate);
    if (result.ok) return result;
    lastFailure = result;
  }
  return lastFailure;
}
