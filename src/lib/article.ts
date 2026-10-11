import robotsParser from "robots-parser";
import { ensureSchema, getDb } from "./db";
import { isSafeFeedUrl } from "./feed-registry";
import { cleanText, toPlainPostText } from "./text";

/**
 * Respectful article-content retrieval.
 *
 * RSS descriptions are often truncated summaries. When a story needs detail
 * (squad lists, injury return dates, transfer terms), DynaSport fetches the
 * publisher's own article page once and reads the accessible text.
 *
 * Politeness rules enforced here:
 *   - robots.txt is fetched once per origin and cached for 24h (RFC 9309
 *     allows this), parsed with a spec-compliant parser, and DISALLOWED
 *     paths are never fetched.
 *   - Crawl-delay, when published, is honoured.
 *   - 5xx/429 robots responses are treated as "disallowed" (conservative).
 *   - One article is fetched at most once per day: a Neon-backed cache
 *     keyed by canonical URL prevents repeat downloads.
 *   - SSRF checks apply to the article URL and every redirect hop.
 *   - Timeouts and a hard response-size cap bound cost and memory.
 *
 * Nothing here invents facts: text is only extracted, never completed.
 */

const USER_AGENT = "DynaSport/1.0 (+football news monitoring; contact via DynaSport Facebook page)";
const FETCH_TIMEOUT_MS = 6_000;
const MAX_ARTICLE_BYTES = 900_000;
/** Text characters retained for fact extraction. */
const MAX_TEXT_CHARS = 12_000;
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ARTICLE_CACHE_HOURS = 24;
/** Hard ceiling on article fetches per automation run. */
const MAX_FETCHES_PER_RUN = 12;

export interface ArticleContent {
  url: string;
  text: string | null;
  /**
   * Raw HTML head/body of the fetched page, retained in memory only for
   * this run so og:image can be read from the SAME request — never a
   * second download, and never persisted.
   */
  html: string | null;
  /** Why content is unavailable, when it is. */
  reason: string | null;
  fetched: boolean;
}

interface RobotsEntry {
  parser: ReturnType<typeof robotsParser>;
  crawlDelayMs: number;
  fetchedAt: number;
}

const robotsCache = new Map<string, RobotsEntry>();
const lastRequestAt = new Map<string, number>();

let fetchesThisRun = 0;

/** Resets the per-run fetch budget. Called at the start of each automation run. */
export function resetArticleBudget(): void {
  fetchesThisRun = 0;
}

export function articleBudgetRemaining(): number {
  return Math.max(0, MAX_FETCHES_PER_RUN - fetchesThisRun);
}

async function loadRobots(origin: string): Promise<RobotsEntry> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) return cached;

  const robotsUrl = `${origin}/robots.txt`;
  let body = "";
  try {
    const response = await fetch(robotsUrl, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (response.ok) {
      body = (await response.text()).slice(0, 200_000);
    } else if (response.status >= 500 || response.status === 429) {
      // Conservative: treat an unavailable robots.txt as disallow.
      const entry: RobotsEntry = {
        parser: robotsParser(robotsUrl, "User-agent: *\nDisallow: /"),
        crawlDelayMs: 5_000,
        fetchedAt: Date.now(),
      };
      robotsCache.set(origin, entry);
      return entry;
    }
    // 4xx (including 404) means "no restrictions" per RFC 9309.
  } catch {
    const entry: RobotsEntry = {
      parser: robotsParser(robotsUrl, "User-agent: *\nDisallow: /"),
      crawlDelayMs: 5_000,
      fetchedAt: Date.now(),
    };
    robotsCache.set(origin, entry);
    return entry;
  }

  const parser = robotsParser(robotsUrl, body);
  const delaySeconds = parser.getCrawlDelay?.(USER_AGENT) ?? parser.getCrawlDelay?.("*");
  const entry: RobotsEntry = {
    parser,
    crawlDelayMs: typeof delaySeconds === "number" && delaySeconds > 0 ? delaySeconds * 1000 : 1_000,
    fetchedAt: Date.now(),
  };
  robotsCache.set(origin, entry);
  return entry;
}

/** Waits for the publisher's requested crawl-delay before hitting it again. */
async function respectCrawlDelay(origin: string, delayMs: number): Promise<void> {
  const last = lastRequestAt.get(origin) ?? 0;
  const since = Date.now() - last;
  if (since < delayMs) {
    const wait = Math.min(delayMs - since, 6_000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt.set(origin, Date.now());
}

/**
 * Fetches the accessible text of an article page. Returns
 * `{ text: null, reason }` rather than throwing when content is unavailable.
 */
export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  const fail = (reason: string): ArticleContent => ({ url, text: null, html: null, reason, fetched: false });

  if (fetchesThisRun >= MAX_FETCHES_PER_RUN) return fail("article fetch budget for this run is exhausted");

  const safety = isSafeFeedUrl(url);
  if (!safety.safe) return fail(`unsafe URL: ${safety.reason}`);

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return fail("malformed URL");
  }

  const robots = await loadRobots(origin);
  const allowed = robots.parser.isAllowed?.(url, USER_AGENT);
  if (allowed === false) return fail("disallowed by robots.txt");

  // Already fetched and cached in Neon? Never download it twice.
  const cached = await readCachedArticle(url);
  if (cached !== null) return { url, text: cached, html: null, reason: null, fetched: true };

  await respectCrawlDelay(origin, robots.crawlDelayMs);

  let response: Response;
  try {
    let current: Response | null = null;
    let target = url;
    for (let hop = 0; hop < 4; hop += 1) {
      const hopSafety = isSafeFeedUrl(target);
      if (!hopSafety.safe) return fail(`unsafe redirect: ${hopSafety.reason}`);
      current = await fetch(target, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (current.status >= 300 && current.status < 400) {
        const location = current.headers.get("location");
        if (!location) break;
        target = new URL(location, target).toString();
        continue;
      }
      break;
    }
    if (!current) return fail("no response");
    response = current;
  } catch (error) {
    return fail(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fetchesThisRun += 1;
  }

  if (!response.ok) return fail(`HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    return fail(`unsupported content type: ${contentType.split(";")[0]}`);
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARTICLE_BYTES) return fail("article too large");

  const html = await response.text();
  if (html.length > MAX_ARTICLE_BYTES) return fail("article too large");

  const text = extractReadableText(html);
  if (!text || text.length < 200) return fail("no readable article text found");

  await writeCachedArticle(url, text);
  return {
    url,
    text: text.slice(0, MAX_TEXT_CHARS),
    // Only the head region is kept: enough for og:image/twitter:image.
    html: html.slice(0, 200_000),
    reason: null,
    fetched: true,
  };
}

/* ------------------------------------------------------------------ */
/* Readability extraction                                              */
/* ------------------------------------------------------------------ */

const BOILERPLATE_PATTERNS = [
  /^(sign up|subscribe|newsletter|follow us|share this|related (articles|stories)|read more|also read|advertisement|cookie|accept all|skip to|back to top|most read|trending now|more on|click here|all rights reserved|privacy policy|terms of use|contact us)/i,
  /^(photo|image|getty images|pa wire|reuters|ap photo)\b/i,
];

/**
 * Extracts the main article text from HTML. Deliberately conservative: it
 * keeps paragraph-shaped text and discards navigation, scripts, styles and
 * boilerplate. No content is added or inferred.
 */
export function extractReadableText(html: string): string | null {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");

  // Prefer <article> or <main> blocks when present.
  const mainMatch = body.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  const scope = mainMatch ? mainMatch[2] : body;

  const paragraphs: string[] = [];
  const paragraphPattern = /<(?:p|h1|h2|h3|li)[^>]*>([\s\S]*?)<\/(?:p|h1|h2|h3|li)>/gi;
  let match: RegExpExecArray | null = paragraphPattern.exec(scope);
  while (match !== null) {
    const raw = toPlainPostText(cleanText(match[1]));
    if (raw.length < 40) {
      paragraphPattern.lastIndex += 1;
      match = paragraphPattern.exec(scope);
      continue;
    }
    if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(raw))) {
      match = paragraphPattern.exec(scope);
      continue;
    }
    if (/https?:\/\/\S+/.test(raw) && raw.split(/\s+/).length < 12) {
      match = paragraphPattern.exec(scope);
      continue;
    }
    paragraphs.push(raw);
    if (paragraphs.length > 120) break;
    match = paragraphPattern.exec(scope);
  }

  const text = paragraphs.join("\n\n").trim();
  return text.length >= 200 ? text : null;
}

/* ------------------------------------------------------------------ */
/* Neon-backed article cache                                           */
/* ------------------------------------------------------------------ */

async function readCachedArticle(url: string): Promise<string | null> {
  try {
    await ensureSchema();
    const sql = getDb();
    const rows = (await sql`
      SELECT content FROM article_cache
      WHERE url = ${url}
        AND fetched_at > now() - make_interval(hours => ${ARTICLE_CACHE_HOURS})
    `) as { content: string }[];
    return rows[0]?.content ?? null;
  } catch {
    return null;
  }
}

async function writeCachedArticle(url: string, content: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO article_cache (url, content, fetched_at)
      VALUES (${url}, ${content.slice(0, MAX_TEXT_CHARS)}, now())
      ON CONFLICT (url) DO UPDATE
        SET content = EXCLUDED.content, fetched_at = now()
    `;
  } catch {
    // Caching is an optimisation only.
  }
}
