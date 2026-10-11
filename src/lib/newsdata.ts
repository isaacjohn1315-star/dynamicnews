import { buildArticleDedupeKey, clean } from "./dedupe";
import { newsdataApiKey } from "./env";
import { reserveNewsDataRequest } from "./request-budget";

/**
 * NewsData.io client (server-only).
 *
 * Uses the documented "latest" endpoint, which returns articles from the
 * past 48 hours. Exactly one request is made per automation run — no
 * pagination, no per-article detail fetches — so the 8-minute cron
 * schedule plus the shared hard budget keeps usage within the daily limit.
 * Every outgoing request is counted via reserveNewsDataRequest() before
 * it is sent, including requests that later fail.
 */
export const NEWSDATA_LATEST_ENDPOINT = "https://newsdata.io/api/1/latest";

export interface NewsDataArticle {
  article_id?: string | null;
  title?: string | null;
  link?: string | null;
  description?: string | null;
  pubDate?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  language?: string | null;
  category?: string[] | null;
  keywords?: string[] | null;
}

export type NewsDataFetchResult =
  | { kind: "ok"; articles: NewsDataArticle[]; received: number }
  | { kind: "limit_reached" }
  | { kind: "error"; error: string };

export async function fetchLatestFootballNews(): Promise<NewsDataFetchResult> {
  const apiKey = newsdataApiKey();
  if (!apiKey) {
    // No key configured: do not consume budget, there is nothing to send.
    return { kind: "error", error: "NEWSDATA_API_KEY is not configured" };
  }

  // Count the request BEFORE it is made. When the daily limit is reached,
  // no request leaves this application at all.
  const reservation = await reserveNewsDataRequest();
  if (!reservation.allowed) {
    return { kind: "limit_reached" };
  }

  const params = new URLSearchParams({
    apikey: apiKey,
    q: "football OR soccer",
    category: "sports",
    language: "en",
  });

  let response: Response;
  try {
    response = await fetch(`${NEWSDATA_LATEST_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (error) {
    return { kind: "error", error: `NewsData.io request failed: ${errorMessage(error)}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "error", error: `NewsData.io returned non-JSON body (HTTP ${response.status})` };
  }

  if (!response.ok) {
    return { kind: "error", error: `NewsData.io HTTP ${response.status}: ${extractProviderMessage(payload)}` };
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { status?: unknown }).status !== "success" ||
    !Array.isArray((payload as { results?: unknown }).results)
  ) {
    return { kind: "error", error: `NewsData.io unexpected payload: ${extractProviderMessage(payload)}` };
  }

  const articles = (payload as { results: NewsDataArticle[] }).results;
  return { kind: "ok", articles, received: articles.length };
}

/** Stable, deterministic deduplication key for an article. */
export function buildDedupeKey(article: NewsDataArticle): string | null {
  return buildArticleDedupeKey({
    provider: "newsdata",
    providerArticleId: clean(article.article_id),
    url: clean(article.link),
    title: clean(article.title),
    source: clean(article.source_name) ?? clean(article.source_id),
    publishedAt: clean(article.pubDate),
  });
}

function extractProviderMessage(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const results = record.results;
    if (typeof results === "object" && results !== null) {
      const message = (results as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  }
  return "unrecognized response";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
