import { createHash } from "node:crypto";

/**
 * Shared deduplication helpers used by every news provider
 * RSS feeds). One canonical implementation — no duplicate provider logic.
 */

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical URL form: lower-case, tracking parameters removed, hash removed. */
export function normalizeUrl(url: string): string {
  const drop = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "fbclid", "gclid", "ref", "ref_src", "cmpid", "ocid", "ns_mchannel",
    "ns_campaign", "ns_linkname", "ns_fee", "ito", "src", "campaign", "at_medium",
  ];
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    for (const key of drop) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable, deterministic deduplication key for a discovered article.
 * Provider article id is preferred; then canonical URL; then a content
 * fingerprint of title + source + publication time.
 */
export function buildArticleDedupeKey(parts: {
  provider: string;
  providerArticleId?: string | null;
  url?: string | null;
  title?: string | null;
  source?: string | null;
  publishedAt?: string | null;
}): string | null {
  const providerArticleId = clean(parts.providerArticleId);
  if (providerArticleId) return `${parts.provider}:id:${providerArticleId}`;

  const url = clean(parts.url);
  if (url) return `${parts.provider}:url:${sha256(normalizeUrl(url))}`;

  const title = clean(parts.title);
  if (!title) return null;
  const source = clean(parts.source) ?? "unknown";
  const publishedAt = clean(parts.publishedAt) ?? "unknown";
  return `${parts.provider}:tps:${sha256(
    `${normalizeText(title)}|${normalizeText(source)}|${publishedAt}`,
  )}`;
}

export function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
