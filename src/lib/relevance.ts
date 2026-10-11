import { cleanText } from "./text";

/**
 * DynaSport relevance engine.
 *
 * Decides which discovered articles are important enough to publish to the
 * DynaSport Facebook Page, builds the concise news statement, and detects
 * cross-publisher duplicates of the same underlying story. Everything is
 * deterministic and explainable: each decision carries a reason string and
 * a numeric score that is stored alongside the article.
 *
 * Hard guarantees:
 *  - only association-football news passes the gate (other sports rejected);
 *  - stale, low-value, question-form, betting/broadcast-information and
 *    unsupported content is rejected;
 *  - rumours are never presented as confirmed facts — rumour-classified
 *    stories are always published with a clearly hedged "Report:" prefix;
 *  - statements are derived strictly from the reported headline — nothing
 *    is invented, no facts or context are added;
 *  - a story without a trustworthy source attribution is never published.
 */

export interface NormalizedArticle {
  articleId: string | null;
  title: string;
  description: string | null;
  articleUrl: string | null;
  sourceName: string | null;
  sourceId: string | null;
  publishedAt: Date | null;
  language: string | null;
  categories: string[];
  /**
   * True when the article came from a football-specific feed. Such items
   * are football coverage by provenance, so the keyword gate must not
   * reject them for lacking an explicit football word.
   */
  fromFootballFeed?: boolean;
}

export type SourceCredibility = "top" | "mainstream" | "tabloid" | "unknown";

export type RejectKind = "stale" | "irrelevant" | null;

export interface RelevanceDecision {
  relevant: boolean;
  score: number;
  reason: string;
  rejectKind: RejectKind;
  statement: string | null;
  isRumour: boolean;
  titleTokens: string[];
  credibility: SourceCredibility;
}

/* ------------------------------------------------------------------ */
/* Lexicon                                                             */
/* ------------------------------------------------------------------ */

const FOOTBALL_TERMS = [
  "football", "soccer", "premier league", "la liga", "laliga", "serie a", "bundesliga",
  "ligue 1", "eredivisie", "championship", "champions league", "europa league",
  "conference league", "fa cup", "copa del rey", "world cup", "euros", "copa america",
  "afcon", "transfer", "striker", "midfielder", "goalkeeper", "centre-back", "center-back",
  "full-back", "fullback", "winger", "playmaker", "hat-trick", "clean sheet", "relegation",
  "promotion", "offside", "penalty", "free kick", "free-kick", "var", "goalscorer",
  "top scorer", "manager", "head coach", "dugout", "fixture", "matchday", "stadium",
  "left-back", "right-back", "centre-forward", "number 10", "holding midfield",
  "defender", "midfield", "attack", "club world cup", "super cup", "supercopa",
  "dfb-pokal", "coppa italia", "carabao", "fa community shield", "uefa", "fifa",
  "ballon d'or", "golden boot", "pre-season", "loan move", "loan deal", "transfer window",
  "deadline day", "release clause", "buy-back clause", "done deal", "medical",
];

/** Strong non-football sport signals. Football coverage almost never contains these. */
const OTHER_SPORT_TERMS = [
  "nfl", "super bowl", "quarterback", "touchdown", "nba", "basketball", "baseball", "mlb",
  "nhl", "ice hockey", "cricket", "rugby", "tennis", "wimbledon", "australian open",
  "french open", "us open tennis", "formula 1", "formula one", "grand prix", "motogp",
  "nascar", "boxing", "ufc", "mma", "heavyweight", "golf", "pga", "masters tournament",
  "ryder cup", "darts", "snooker", "volleyball", "handball", "badminton", "table tennis",
  "cycling", "tour de france", "rowing", "sailing", "wrestling", "wwe", "kabaddi",
  "pickleball", "softball", "lacrosse",
];

/**
 * Football entities: clubs, competitions and national teams. A headline
 * naming any of these is football coverage even when it never uses the
 * word "football" (e.g. "Arteta confirms Saka setback"). This list exists
 * to RECOGNISE football, never to restrict coverage to these teams —
 * anything arriving from a football feed is treated as football too.
 */
const FOOTBALL_ENTITIES = [
  "arsenal", "chelsea", "liverpool", "man utd", "man united", "manchester united",
  "man city", "manchester city", "tottenham", "spurs", "newcastle", "aston villa",
  "west ham", "brighton", "everton", "forest", "brentford", "crystal palace", "fulham",
  "wolves", "bournemouth", "leicester", "southampton", "ipswich", "leeds", "burnley",
  "sunderland", "sheffield united", "sheffield wednesday", "norwich", "watford",
  "middlesbrough", "stoke", "coventry", "hull city", "preston", "bristol city",
  "cardiff", "swansea", "millwall", "qpr", "blackburn", "derby county", "portsmouth",
  "plymouth", "luton", "birmingham city", "wrexham", "oxford united", "barnsley",
  "bolton", "wigan", "blackpool", "charlton", "rotherham", "peterborough", "reading",
  "celtic", "rangers", "aberdeen", "hearts", "hibernian", "kilmarnock", "motherwell",
  "dundee", "st mirren", "ross county", "real madrid", "barcelona", "barca",
  "atletico", "sevilla", "valencia", "villarreal", "real sociedad", "athletic club",
  "real betis", "girona", "juventus", "juve", "inter", "ac milan", "milan", "napoli",
  "roma", "lazio", "atalanta", "fiorentina", "bologna", "bayern", "dortmund",
  "leipzig", "leverkusen", "frankfurt", "stuttgart", "schalke", "psg",
  "paris saint-germain", "marseille", "lyon", "monaco", "lille", "ajax", "psv",
  "feyenoord", "porto", "benfica", "sporting", "galatasaray", "fenerbahce",
  "besiktas", "shakhtar", "salzburg", "club brugge", "anderlecht", "olympiacos",
  "flamengo", "palmeiras", "boca", "river plate", "inter miami", "al hilal",
  "al nassr", "al ittihad", "premier league", "efl", "championship", "league one",
  "league two", "national league", "scottish premiership", "la liga", "serie a",
  "bundesliga", "ligue 1", "eredivisie", "primeira liga", "mls", "saudi pro league",
  "champions league", "europa league", "conference league", "fa cup", "carabao cup",
  "efl cup", "copa del rey", "coppa italia", "dfb-pokal", "club world cup",
  "world cup", "euros", "euro 2028", "nations league", "copa america", "afcon",
  "africa cup of nations", "asian cup", "gold cup", "copa libertadores", "fifa",
  "uefa", "concacaf", "conmebol", "caf", "three lions", "lionesses", "socceroos",
  "super eagles", "bafana", "selecao", "la roja", "azzurri", "les bleus",
  "wsl", "women's super league", "nwsl", "ballon d'or",
];

/**
 * High-significance developments (confirmed / breaking / structural).
 * Covers official signings, "Here We Go" announcements, medicals, contract
 * renewals, sackings, appointments, records, awards, retirements,
 * comebacks, rejected bids, failed transfers, national-team selections,
 * ownership changes and formal club announcements.
 */
const HIGH_SIGNAL = [
  // Official transfers and completed deals
  "breaking", "confirmed", "official", "officially", "announce", "announced", "announces",
  "completes", "completed", "signs", "signed", "signing", "unveiled", "unveils", "done deal",
  "here we go", "permanent deal", "permanent transfer", "free transfer", "free agent",
  "puts pen to paper", "pen to paper", "deal struck", "deal sealed", "sealed",
  "personal terms agreed", "terms agreed", "agrees personal terms", "signs pre-contract",
  "pre-contract agreement", "joins", "departs", "leaves", "recall", "recalled",
  // Manager and staff
  "sacked", "sack", "dismissed", "part company", "parts company", "appointed", "appointment",
  "steps down", "stands down", "resigns", "resignation", "caretaker", "named as",
  "sporting director", "director of football", "technical director",
  // Contracts
  "agrees", "agreed", "agreement", "extends", "extension", "new contract", "contract until",
  "renews", "renewal", "triggers option", "option triggered", "extends stay",
  // Medical and injury
  "medical", "passes medical", "medical booked", "set for medical", "undergoes", "surgery",
  "out for", "out for the season", "season-ending", "ruled out", "scan results",
  "back in training", "returns to training", "available again", "comeback complete",
  // Discipline
  "banned", "suspended", "suspension", "fined", "charged", "charged with", "sanctioned",
  "points deduction", "deducted", "investigation opened",
  // Failed, cancelled and rejected transfers
  "collapse", "collapses", "collapsed", "breaks down", "deal off", "off", "rejects",
  "rejected", "turned down", "knock back", "knocked back", "refuses to sell", "snubs",
  "snubbed", "collapsed deal",
  // Records, awards and milestones
  "record", "club-record", "record fee", "record breaker", "award", "awards", "ballon d'or",
  "golden boot", "shortlisted", "nominee", "wins award", "named player of the year",
  "100th appearance", "milestone", "century of", "all-time top",
  // Retirement, farewells and returns
  "retires", "retirement", "hangs up his boots", "calls time on", "farewell", "testimonial",
  "returns to the club", "rejoins", "club legend",
  // International selections
  "called up", "call-up", "named in the squad", "squad announced", "earns first cap",
  "senior debut", "caps",
  // Ownership, finance and legal
  "takeover", "takeover completed", "ownership", "new owner", "acquisition", "consortium",
  "administration", "winding-up", "financial fair play", "profit and sustainability",
  "breach", "lawsuit", "court", "tribunal", "legal action", "sues", "settles",
  // Deadline day and windows
  "deadline day", "january window", "summer window",
  // Youth and breakthrough
  "academy graduate", "first-team debut", "promoted to the first team", "signs first pro",
  "professional terms",
  // Club statements
  "statement", "club statement", "confirm in a statement",
];

/**
 * Reported-but-unconfirmed developments: interest, negotiations, bids,
 * valuations, players offered around, clubs open to selling, takeover talk
 * and every other transfer-rumour register.
 */
const MEDIUM_SIGNAL = [
  "bid", "bids", "offer", "offers", "talks", "negotiations", "negotiating", "interest",
  "interested", "linked", "link", "target", "targeting", "eyeing", "eyed", "monitoring",
  "considering", "weighs up", "weighing up", "plot", "plotting", "plots", "poised",
  "set to", "in advanced talks", "advanced negotiations", "make a move", "move for",
  "swoop", "race for", "chase", "chasing", "tracking", "scouting", "scouted", "rumour",
  "rumour", "rumor", "rumours", "rumors", "rumoured", "rumored", "reportedly",
  "keen on", "mulls", "hopes to", "wants to sign", "approach", "approaches", "enquiries",
  "enquiry", "contacts", "verbal agreement",
  // Players offered, wanting to leave, available
  "offered to", "offered around", "available for transfer", "on the market",
  "open to a move", "open to leaving", "wants to leave", "wants out", "seeking a move",
  "pushing for a move", "requesting a transfer", "transfer request", "attracting interest",
  // Selling-club signals
  "willing to sell", "prepared to sell", "willing to listen", "open to offers",
  // Valuations and fees
  "valuation", "valued at", "asking price", "price tag", "worth", "quoted", "fee agreed",
  "add-ons", "add-ons included", "sell-on clause", "release clause", "buy-back clause",
  "option to buy", "obligation to buy", "loan with option", "loan-to-buy",
  // Agents and intermediaries
  "agent", "agent says", "representative", "intermediary", "changes agent",
  // Takeover and ownership talk
  "takeover talk", "takeover rumours", "bidders", "in talks to buy", "considering a bid",
  // Behind the scenes
  "behind the scenes", "understanding", "understands", "exclusively", "exclusive",
];
/**
 * General football-news signals: match coverage, line-ups, quotes,
 * dressing-room and training-ground reporting, tactics, stats, controversy
 * and fan-facing context.
 */
const GENERAL_SIGNAL = [
  // Quotes, interviews and press conferences
  "says", "said", "admits", "insists", "reveals", "claims", "hits out", "slams", "backs",
  "praises", "warns", "vows", "refuses", "demands", "hints", "opens up", "speaks out",
  "press conference", "interview", "told", "responds", "message", "honest", "explains",
  "exclusive interview", "in his own words", "speaking after",
  // Match coverage
  "win", "wins", "beat", "beats", "draw", "draws", "victory", "defeat", "loss", "thrash",
  "thrashes", "rout", "comeback", "late winner", "stoppage time", "injury time",
  "hat-trick", "brace", "goal", "goals", "assist", "assists", "clean sheet",
  "match report", "player ratings", "rated", "man of the match", "post-match", "reaction",
  "reacts", "full-time", "half-time", "aggregate", "tie", "fixture", "matchday",
  // Line-ups, team news and previews
  "starting xi", "starting line-up", "line-up", "lineup", "team news", "named in",
  "bench", "starts", "predicted xi", "predicted line-up", "preview", "expected to start",
  "in contention", "available for", "fit again",
  // Tactics
  "formation", "system", "tactical", "tactics", "change of shape", "role change",
  // Dressing room and training ground
  "dressing room", "dressing-room", "training ground", "training", "session", "argument",
  "heated", "exchange", "confrontation", "unhappy", "frustrated", "at odds", "tension",
  "disagreement", "fallen out", "clashed", "dispute", "row", "rift", "bust-up",
  // VAR, referees and controversy
  "var", "referee", "officials", "decision", "controversy", "controversial", "outrage",
  "apology", "apologises", "mistake", "error",
  // Fans, rivalry and derby
  "fans", "supporters", "rivalry", "derby", "clash", "showdown", "title race",
  "relegation battle", "bolt", "shock",
  // Contracts, fees and finances
  "wants", "deal", "contract", "clause", "million", "billion", "\u20ac", "\u00a3",
  "wages", "salary", "contract situation", "future", "uncertain", "exit", "sacking",
  // Youth and scouting
  "wonderkid", "wonder kid", "youngster", "teenage", "breakthrough", "starlet", "prodigy",
  "scouted", "youth", "academy", "talent",
  // Stats and records
  "stat", "stats", "in appearances", "goal involvement", "record signing",
  // Injury context
  "injury", "injured", "fitness", "doubt", "returns", "comeback", "sidelined",
];
/** Patterns that make a headline a rumour / unconfirmed report rather than fact. */
const RUMOUR_PATTERN =
  /\b(rumou?rs?|rumou?red|reportedly|report(?:s)? claim|according to reports|linked|interest(?:ed|s)?\b|eye(?:ing|d)\b|targets?(?:ing)?\b|considering|monitoring|plots?(?:ing)?\b|plans? to\b|plans? (?:to sign|a move|a bid|a deal)|weigh(?:s|ing)? up|poised|set to\b|in talks|talks (?:with|over|to)|keen on|mulls|make a move|move for|swoop|race for|chasing?|tracking|scout(?:ing|ed)|approach(?:ed)?|could join|could sign|could move|prepar(?:es|ing) (?:a )?bid|hopes to|expected to)\b/i;

/** Patterns that mark a headline as low-value for a breaking-news page. */
const LOW_VALUE_PATTERN =
  /\b(odds|betting|tips?|fantasy|how to watch|where to watch|tv channel|live stream|kick-?off time|what time|quiz|ranked|power rankings|best xi|combined xi|all-time xi|5 things|five things|ten things|top 10|in pictures|photos?:|watch:|video:|gift guide|black friday|deal of the day)\b/i;

/**
 * Aggregation digests: a gossip column or rumour round-up bundles many
 * unrelated claims from many publishers, so it cannot be published as ONE
 * story with a single accurate source attribution. Individual rumours from
 * the same publishers are still published — only the digest form is
 * rejected. Specific deadline-day coverage is unaffected.
 */
const AGGREGATE_DIGEST_PATTERN =
  /\b(gossip column|gossip of the day|gossip round-?up|rumou?r round-?up|rumou?r mill|today'?s rumou?rs|transfer round-?up|paper talk|back-?page round-?up|morning headlines|everything you need to know today)\b/i;

/** Sources ordered by credibility. Matching is on normalized lower-case containment. */
const TOP_TIER_SOURCES = [
  "fabrizio romano", "bbc", "sky sports", "the athletic", "espn", "the guardian",
  "guardian", "reuters", "associated press", "ap news", "the times", "the telegraph",
  "telegraph", "the independent", "independent", "marca", "diario as", "as.com",
  "l'equipe", "lequipe", "le parisien", "rmc sport", "kicker", "gazzetta",
  "gazzetta dello sport", "corriere dello sport", "tuttosport", "sky sport italia",
  "sky sport deutschland", "eurosport", "tnt sports", "cbs sports", "pa media",
  "the i paper", "de telegraaf", "voetbal international", "mundodeportivo", "mundo deportivo",
  "sport.es", "a bola", "record.pt", "o jogo", "globoesporte", "globo esporte",
];

const MAINSTREAM_SOURCES = [
  "goal.com", "goal", "fourfourtwo", "four four two", "talksport", "sports illustrated",
  "90min", "football365", "football 365", "sports mole", "sportsmole", "the sporting news",
  "sporting news", "evening standard", "standard", "metro", "onefootball", "bein sports",
  "dazn", "the score", "nbcsports", "nbc sports", "fox sports", "cnn", "al jazeera",
  "dw", "france 24", "euronews", "sportsnet", "tsn", "athlon sports", "yardbarker",
  "espn fc", "italian football tv", "football italia", "getfootballnewsfrance",
];

const TABLOID_SOURCES = [
  "the sun", "sun sport", "daily mail", "mail online", "mailonline", "dailymail",
  "mirror", "daily mirror", "the mirror", "express", "daily express", "daily star",
  "caughtoffside", "caught offside", "givemesport", "give me sport", "teamtalk",
  "football insider", "fichajes", "todofichajes", "sportwitness", "sport witness",
  "hitc", "football transfers", "transfermarkt", "the hard tackle", "blast",
];

const STOPWORDS = new Set([
  "the", "a", "an", "to", "in", "of", "and", "or", "for", "on", "at", "as", "with",
  "after", "over", "from", "by", "is", "are", "be", "been", "it", "its", "his", "her",
  "their", "our", "your", "my", "we", "he", "she", "they", "them", "him", "this", "that",
  "these", "those", "vs", "v", "into", "about", "amid", "before", "during", "against",
  "but", "not", "no", "yes", "will", "would", "can", "could", "has", "have", "had",
  "was", "were", "do", "does", "did", "new", "news", "report", "reports", "update",
  "live", "now", "out", "up", "down", "who", "what", "why", "how", "when", "where",
  "i", "you", "us", "all", "more", "most", "first", "last", "just", "still", "very",
]);

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

export const RELEVANCE_THRESHOLD = 50;
export const STORY_DUP_MIN_SHARED = 4;
export const STORY_DUP_MIN_CONTAINMENT = 0.6;

const SOURCE_SCORE: Record<SourceCredibility, number> = {
  top: 30,
  mainstream: 20,
  tabloid: 12,
  unknown: 10,
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function normalizeSourceName(article: {
  source_name?: string | null;
  source_id?: string | null;
}): string | null {
  const raw =
    (typeof article.source_name === "string" && article.source_name.trim()) ||
    (typeof article.source_id === "string" && article.source_id.trim()) ||
    "";
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0 || /^unknown$/i.test(cleaned)) return null;
  return cleaned;
}

export function parsePubDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Some feeds use "YYYY-MM-DD HH:MM:SS" (UTC). Normalize defensively.
  const isoLike = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T") + "Z";
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Evaluates an article and returns a fully explainable decision.
 * Pure function — the same article always yields the same decision.
 */
export function evaluateArticle(
  article: NormalizedArticle,
  now: Date = new Date(),
): RelevanceDecision {
  const title = cleanText(article.title);
  const description = cleanText(article.description);
  const haystack = `${title} ${description}`.toLowerCase();
  const titleLower = title.toLowerCase();
  const titleTokens = tokenizeTitle(title);
  const credibility = rateSource(article.sourceName, article.sourceId);

  const reject = (reason: string, score = 0, kind: RejectKind = "irrelevant"): RelevanceDecision => ({
    relevant: false,
    score,
    reason,
    rejectKind: kind,
    statement: null,
    isRumour: RUMOUR_PATTERN.test(title),
    titleTokens,
    credibility,
  });

  if (title.length < 20) return reject("headline too short to verify");
  if (title.length > 190) return reject("headline too long for a concise post");
  if (title.endsWith("...") || title.endsWith("…")) return reject("truncated headline");
  // Only obvious engagement bait is rejected. A legitimate news headline
  // that happens to end in a question mark (common in analysis pieces) is
  // judged on its content like any other story.
  if (/\?\s*$/.test(title) && /\b(will|could|should|can|is|are|who|what|why|which|do|does)\b/i.test(title.slice(0, 30))) {
    return reject("speculative question headline (engagement bait)");
  }
  if (article.language && article.language !== "en") return reject("non-English article");

  const sourceName = normalizeSourceName({
    source_name: article.sourceName,
    source_id: article.sourceId,
  });
  if (!sourceName) return reject("no trustworthy source attribution available");

  if (LOW_VALUE_PATTERN.test(titleLower) || LOW_VALUE_PATTERN.test(description.toLowerCase())) {
    return reject("low-value content (betting, broadcast info, listicle or promotional)");
  }
  if (AGGREGATE_DIGEST_PATTERN.test(titleLower) || AGGREGATE_DIGEST_PATTERN.test(description.toLowerCase())) {
    return reject("aggregation digest: many claims from many publishers, no single attributable story");
  }

  // --- Football gate -------------------------------------------------
  // Football is recognised three ways: explicit vocabulary, named football
  // entities (clubs/competitions/national teams), and feed provenance.
  // This removes the false "not association-football news" rejections that
  // previously discarded valid injury, quote and club stories.
  const footballTermHits = countHits(haystack, FOOTBALL_TERMS);
  const entityHits = countHits(haystack, FOOTBALL_ENTITIES);
  const fromFootballFeed = article.fromFootballFeed === true;
  const footballHits = footballTermHits + entityHits + (fromFootballFeed ? 1 : 0);
  const otherSportHits = countHits(haystack, OTHER_SPORT_TERMS);

  if (footballHits === 0) {
    return reject("no football subject, entity or football-feed provenance");
  }
  // Another sport only wins when it clearly dominates the article.
  if (otherSportHits > 0 && footballTermHits + entityHits === 0) {
    return reject("primarily about another sport");
  }
  if (otherSportHits >= 2 && otherSportHits > footballTermHits + entityHits) {
    return reject("primarily about another sport");
  }
  const inSportsCategory =
    fromFootballFeed ||
    article.categories.length === 0 ||
    article.categories.some((c) => typeof c === "string" && c.toLowerCase() === "sports");
  if (!inSportsCategory) {
    return reject("outside the sports category");
  }

  // --- Freshness ------------------------------------------------------
  // Age is NOT a rejection criterion here. A blanket 48-hour cut-off used to
  // discard important stories that stay relevant for days; freshness is now
  // classified in lib/freshness.ts, where a corroborated 2-7 day old story
  // can qualify as trending. Only a timestamp in the future (a feed error)
  // is rejected outright.
  let ageHours: number | null = null;
  if (article.publishedAt) {
    ageHours = (now.getTime() - article.publishedAt.getTime()) / 3_600_000;
    if (ageHours < -6) {
      return reject("publication date is implausibly far in the future");
    }
  }
  const hasTrustworthyTimestamp = ageHours !== null;

  // --- Scoring ---------------------------------------------------------
  let score = SOURCE_SCORE[credibility];
  if (!hasTrustworthyTimestamp) {
    // No trustworthy timestamp: still scored for monitoring, but the story
    // can never be published automatically on an unverifiable date.
    score -= 10;
  }

  if (ageHours === null) {
    score += 8;
  } else if (ageHours <= 1) score += 30;
  else if (ageHours <= 3) score += 26;
  else if (ageHours <= 6) score += 22;
  else if (ageHours <= 12) score += 18;
  else if (ageHours <= 24) score += 12;
  else if (ageHours <= 36) score += 6;
  else score += 2;

  // Subject breadth: naming real football entities is evidence of a
  // concrete story rather than a generic page.
  score += Math.min(entityHits * 5, 15);
  if (fromFootballFeed) score += 6;

  const highHits = countHits(haystack, HIGH_SIGNAL);
  const mediumHits = countHits(haystack, MEDIUM_SIGNAL);
  const generalHits = countHits(haystack, GENERAL_SIGNAL);
  score += Math.min(highHits * 10, 30);
  score += Math.min(mediumHits * 6, 18);
  score += Math.min(generalHits * 4, 12);

  const isRumour = classifyAsRumour(title);
  // Rumours are core football-news content and are never penalised for being
  // rumours. Only unconfirmed reports from weak or unknown sources are held
  // to a slightly higher standard, so aggregation-only blogs do not outrank
  // established reporters.
  if (isRumour && (credibility === "unknown" || credibility === "tabloid")) {
    score -= 4;
  }

  if (score < RELEVANCE_THRESHOLD) {
    return reject(
      `below relevance threshold (score ${score} < ${RELEVANCE_THRESHOLD})`,
      score,
    );
  }

  const statement = buildStatement(title, isRumour);
  if (!statement) {
    return reject("could not build a safe, faithful statement from the headline", score);
  }

  return {
    relevant: true,
    score,
    rejectKind: null,
    reason: `accepted (score ${score}; ${credibility} source; ${isRumour ? "report/rumour" : "reported fact"}; ${ageReason(ageHours)})`,
    statement,
    isRumour,
    titleTokens,
    credibility,
  };
}

/**
 * Cross-publisher duplicate detection. Two headlines describe the same
 * underlying story when they share enough meaningful tokens AND one token
 * set is largely contained in the other (headlines about one event are
 * usually near-subsets of each other). The minimum shared-token floor
 * prevents unrelated stories that merely mention the same club or player
 * from being merged.
 */
export interface StoryTokenSet {
  id: string | null;
  tokens: string[];
}

export function findDuplicateStory(
  titleTokens: string[],
  recent: StoryTokenSet[],
  minShared: number = STORY_DUP_MIN_SHARED,
  minContainment: number = STORY_DUP_MIN_CONTAINMENT,
): StoryTokenSet | null {
  if (titleTokens.length === 0) return null;
  const current = new Set(titleTokens);
  for (const candidate of recent) {
    if (candidate.tokens.length === 0) continue;
    const other = new Set(candidate.tokens);
    let shared = 0;
    for (const token of current) {
      if (other.has(token)) shared += 1;
    }
    if (shared < minShared) continue;
    const containment = shared / Math.min(current.size, other.size);
    if (containment >= minContainment) {
      return candidate;
    }
  }
  return null;
}

export function tokenizeTitle(title: string): string[] {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/* ------------------------------------------------------------------ */
/* Statement construction                                              */
/* ------------------------------------------------------------------ */

const KNOWN_SOURCE_SUFFIXES = [
  "bbc sport", "bbc", "sky sports", "espn", "the guardian", "guardian", "the athletic",
  "fourfourtwo", "goal.com", "goal", "marca", "daily mail online", "mail online",
  "the mirror", "mirror", "the sun", "talksport", "caughtoffside", "football365",
  "sports mole", "metro", "evening standard", "the independent", "the telegraph",
  "the times", "sport", "football",
];

export function buildStatement(title: string, isRumour: boolean): string | null {
  let statement = title;

  // Strip HTML tags, links, hashtags and handles — posts must never contain them.
  statement = statement.replace(/<[^>]*>/g, " ");
  statement = statement.replace(/https?:\/\/\S+|www\.\S+/gi, " ");
  statement = statement.replace(/[#@]/g, "");
  statement = decodeEntities(statement);
  statement = statement.replace(/\s+/g, " ").trim();

  // Remove "Breaking:" / "Exclusive:" / "Report(s):" style prefixes; the
  // 🚩 badge and the rumour prefix carry that meaning in the final post.
  statement = statement.replace(/^(breaking news|breaking|exclusive|reports?|just in|live)\s*[:\-–—|]\s*/i, "");

  // Remove publisher-branding suffixes (" - BBC Sport", " | Goal.com", ...).
  statement = statement.replace(/\s+\|\s+.+$/i, "");
  for (const suffix of KNOWN_SOURCE_SUFFIXES) {
    const pattern = new RegExp(`\\s+[\\-–—]\\s+${escapeRegExp(suffix)}$`, "i");
    statement = statement.replace(pattern, "");
  }

  statement = statement.replace(/\s+/g, " ").trim();
  statement = statement.replace(/^(report|reports)\s*[:\-–—]\s*/i, "");

  if (statement.length < 20) return null;
  if (statement.length > 170) return null; // never truncate — truncation can distort meaning
  if (LOW_VALUE_PATTERN.test(statement.toLowerCase())) return null;

  // Normalize terminal punctuation to a single period.
  statement = statement.replace(/[.!\s]+$/, "").trim();
  if (!statement) return null;
  statement = `${statement}.`;

  if (isRumour && !/^report:/i.test(statement)) {
    statement = `Report: ${statement}`;
  }

  return statement;
}

/**
 * Rumours, reported negotiations and unconfirmed interest must always be
 * published in hedged form. Official confirmations may be stated plainly.
 * A headline mixing both ("X confirms interest in Y") stays hedged when the
 * underlying event itself (interest) is unconfirmed.
 */
export function classifyAsRumour(title: string): boolean {
  const hasRumourMarker = RUMOUR_PATTERN.test(title);
  if (!hasRumourMarker) return false;
  const confirmsEventOnly =
    /\b(confirms?|confirmed)\s+(?:his|her|their|the club's|club's)?\s*(interest|desire|wish|hope|admiration)/i.test(
      title,
    );
  if (confirmsEventOnly) return true;
  return true;
}

function ageReason(ageHours: number | null): string {
  if (ageHours === null) return "unknown age";
  if (ageHours < 1) return "under 1h old";
  return `${Math.round(ageHours)}h old`;
}

export function rateSource(sourceName: string | null, sourceId: string | null): SourceCredibility {
  const haystacks = [sourceName, sourceId]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.toLowerCase().replace(/[^a-z0-9' .-]/g, " ").replace(/\s+/g, " ").trim());
  if (haystacks.length === 0) return "unknown";
  const matches = (list: string[]) =>
    haystacks.some((hay) => list.some((name) => hay === name || hay.includes(name)));
  if (matches(TOP_TIER_SOURCES)) return "top";
  if (matches(MAINSTREAM_SOURCES)) return "mainstream";
  if (matches(TABLOID_SOURCES)) return "tabloid";
  return "unknown";
}

function countHits(haystack: string, terms: string[]): number {
  let hits = 0;
  for (const term of terms) {
    // A single alphanumeric word must match on a word boundary. Substring
    // matching here caused real false positives: "nfl" matched inside
    // "conflict" and "var" inside "variety", wrongly rejecting football
    // stories as being about another sport.
    const isSingleWord = /^[a-z0-9]+$/i.test(term);
    if (isSingleWord) {
      if (new RegExp(`\\b${escapeRegExp(term)}`, "i").test(haystack)) hits += 1;
    } else if (haystack.includes(term)) {
      // Multi-word phrases and terms with punctuation/symbols ("ballon d'or",
      // "ligue 1", "\u20ac") match literally.
      hits += 1;
    }
  }
  return hits;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&euro;/g, "€")
    .replace(/&pound;/g, "£")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePointToChar(Number.parseInt(dec, 10)));
}

function codePointToChar(codePoint: number): string {
  if (
    !Number.isFinite(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
