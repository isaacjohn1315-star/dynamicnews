import { sha256 } from "./dedupe";

/**
 * Story-level identity for DynaSport.
 *
 * An "article" is one publisher's write-up. A "story" is the underlying
 * real-world event (a transfer, an appointment, an injury, a statement).
 * Many publishers report one story, so DynaSport identifies the story
 * itself and publishes it at most once.
 *
 * Everything here is deterministic: the same headline always produces the
 * same entities, event kind, stage and fingerprint. Nothing is inferred
 * beyond what the headline text literally states.
 */

/* ------------------------------------------------------------------ */
/* Event stage — rumour ... official                                   */
/* ------------------------------------------------------------------ */

export type StoryStage = "general" | "rumour" | "talks" | "bid" | "agreement" | "official";

export const STAGE_RANK: Record<StoryStage, number> = {
  general: 0,
  rumour: 1,
  talks: 2,
  bid: 3,
  agreement: 4,
  official: 5,
};

/**
 * A follow-up post is only allowed when the story advances to a materially
 * different stage: a concrete bid, an agreement, or an official
 * confirmation. Drifting from "rumour" to "talks" is not material enough.
 */
export const MIN_FOLLOWUP_STAGE_RANK = STAGE_RANK.bid;
export const MAX_FOLLOWUPS_PER_STORY = 2;

const STAGE_PATTERNS: { stage: StoryStage; pattern: RegExp }[] = [
  {
    stage: "official",
    pattern:
      /\b(official(?:ly)?|confirm(?:s|ed)?|announce(?:s|d|ment)?|complete[ds]?\s+(?:the\s+)?(?:signing|move|transfer|deal)|has\s+(?:signed|joined|left|departed)|signs?\s+for\b|joins?\s+\w+\s+on\b|unveil(?:s|ed)|presented as|sacked|dismissed|appoint(?:s|ed)?|steps? down|resigns?|has been (?:sacked|appointed|named)|named (?:as )?(?:new )?(?:head coach|manager|boss)|medical (?:completed|done)|deal done|done deal|here we go)\b/i,
  },
  {
    stage: "agreement",
    pattern:
      /\b(agree(?:s|d|ment)?\b|reach(?:es|ed) (?:an )?agreement|personal terms (?:agreed|settled)|verbal agreement|green light|accept(?:s|ed) (?:the )?(?:bid|offer)|set for a medical|to undergo (?:a )?medical|terms agreed)\b/i,
  },
  {
    stage: "bid",
    pattern:
      /\b(bids?\b|bidding|offers?\b|submits?|submitted|tabled?|lodge[ds]?|prepare[ds]?\s+(?:a|an)\s+(?:bid|offer)|readies? (?:a|an) (?:bid|offer)|approach(?:es|ed)?\b|proposal)\b/i,
  },
  {
    stage: "talks",
    pattern:
      /\b(talks?\b|negotiat(?:e|es|ing|ions?)|in discussions?|discussions? (?:with|over)|contact(?:s|ed)? (?:with|over)|meeting (?:with|over)|advanced stages)\b/i,
  },
  {
    stage: "rumour",
    pattern:
      /\b(rumou?rs?|rumou?red|reportedly|report(?:s)? claim|according to reports|linked|interest(?:ed|s)?\b|eye(?:ing|d)\b|targets?(?:ing)?\b|considering|monitoring|plots?|plans? to\b|plans? (?:to sign|a move|a bid|a deal)|weigh(?:s|ing)? up|keen on|wants? to sign|could (?:sign|join|move)|set to\b|expected to|hopes? to|race for|chas(?:e|es|ing)|tracking|scout(?:ing|ed)|shortlist(?:ed)?)\b/i,
  },
];

export function classifyStage(text: string): StoryStage {
  for (const { stage, pattern } of STAGE_PATTERNS) {
    if (pattern.test(text)) return stage;
  }
  return "general";
}

/* ------------------------------------------------------------------ */
/* Event kind                                                          */
/* ------------------------------------------------------------------ */

export type EventKind =
  | "here_we_go"
  | "medical"
  | "transfer"
  | "loan"
  | "contract"
  | "manager"
  | "injury"
  | "comeback"
  | "discipline"
  | "legal"
  | "finance"
  | "quote"
  | "match"
  | "lineup"
  | "dressing_room"
  | "youth"
  | "retirement"
  | "agent"
  | "award"
  | "international"
  | "competition"
  | "club"
  | "other";

const EVENT_KIND_PATTERNS: { kind: EventKind; pattern: RegExp }[] = [
  // "Here we go" announcements — the strongest single signal in football news
  {
    kind: "here_we_go",
    pattern: /\b(here we go|here we actually go|done deal|deal sealed|deal struck)\b/i,
  },
  // Medicals are a distinct, high-interest stage of a transfer
  {
    kind: "medical",
    pattern:
      /\b(medical(?:s)?\b|passes medical|medical booked|set for a medical|undergo(?:es|ing)? a medical|medical tests)\b/i,
  },
  {
    kind: "manager",
    pattern:
      /\b(manager|head coach|boss|sacked|sack|dismissed|appointed|appointment|caretaker|interim|steps? down|resigns?|successor|dugout|part(?:s|ed)? company|sporting director|director of football|technical director)\b/i,
  },
  {
    kind: "comeback",
    pattern:
      /\b(returns? to (?:training|action|the squad)|back in (?:training|contention)|comeback|fit again|available again|recovery|setback after|returns? from injury)\b/i,
  },
  {
    kind: "injury",
    pattern:
      /\b(injur(?:y|ed|ies)|fitness|surgery|operation|ruled out|sidelined|out for|hamstring|acl|ankle|knee|calf|groin|scan)\b/i,
  },
  {
    kind: "legal",
    pattern:
      /\b(lawsuit|court|tribunal|legal(?:ly)? |legal action|sues|sued|settles?|police|charged with|prosecut|winding-?up)\b/i,
  },
  {
    kind: "finance",
    pattern:
      /\b(financial fair play|profit and sustainability|ffp|points deduction|administration|winding-?up|debt|accounts|wages? bill|losses|breach|takeover|ownership|owner|investor|bidders?|consortium|acquisition)\b/i,
  },
  {
    kind: "loan",
    pattern: /\b(loan(?:s|ed|ing| deal| move| spell| with option|\-to\-buy)?|option to buy|obligation to buy|recall(?:ed)?)\b/i,
  },
  {
    kind: "contract",
    pattern:
      /\b(contract|new deal|extension|extends?|renew(?:s|al|ed)?|terms until|release clause|buy-?back clause|pre\-contract|personal terms|triggers? option|contract situation|wages|salary|pay rise)\b/i,
  },
  {
    kind: "transfer",
    pattern:
      /\b(transfer|signing|signs?|sign\b|bid|offer|move for|moves? to|joins?|fee|deadline day|swap deal|buy-?back|free agent|free transfer|departure|exit|sold|sell|purchase|recruit|rejected|turned down|collapse[ds]?|deal off)\b/i,
  },
  {
    kind: "retirement",
    pattern:
      /\b(retires?|retirement|hangs? up (?:his|her) boots|calls? time on|farewell|testimonial|one\-club man)\b/i,
  },
  {
    kind: "agent",
    pattern:
      /\b(agent|agents|representative|intermediary|mino raiola|jorge mendes|changes? agent)\b/i,
  },
  {
    kind: "lineup",
    pattern:
      /\b(starting xi|starting line-?up|line-?up|lineup|team news|predicted xi|named in the (?:squad|starting)|bench|in contention|expected to start)\b/i,
  },
  {
    kind: "match",
    pattern:
      /\b(match report|player ratings|man of the match|win|wins|beat|beats|draw|victory|defeat|thrash|rout|late winner|stoppage time|injury time|hat-?trick|brace|clean sheet|post\-match|full\-time|half\-time|aggregate|matchday|preview|reaction|highlights)\b/i,
  },
  {
    kind: "dressing_room",
    pattern:
      /\b(dressing(?: |\-)room|training ground|fallen out|clashed?|at odds|disagreement|dispute|heated (?:exchange|argument)|confrontation|unhappy|frustrated|tension|row|rift|bust\-up)\b/i,
  },
  {
    kind: "youth",
    pattern:
      /\b(wonderkid|wonder kid|youngster|teenage|starlet|prodigy|academy|youth|breakthrough|first\-team debut|scholarship|signs first pro)\b/i,
  },
  {
    kind: "award",
    pattern:
      /\b(ballon d'or|golden boot|award(?:s)?|nominee|shortlist(?:ed)?|player of the (?:year|month)|team of the (?:year|season)|record(?:s| holder)?|milestone|100th)\b/i,
  },
  {
    kind: "international",
    pattern:
      /\b(called up|call\-up|national team|internationals?|squad announced|caps?|euro|world cup|nations league|friendly|qualifier)\b/i,
  },
  {
    kind: "quote",
    pattern:
      /\b(says?|said|admits?|insists?|reveals?|claims?|hits? out|slams?|warns?|vows?|praises?|refuses?|demands?|hints?|opens? up|speaks? out|press conference|interview|responds?|told)\b/i,
  },
  {
    kind: "competition",
    pattern:
      /\b(champions league|europa league|conference league|world cup|euros?|afcon|copa|final|semi-?final|quarter-?final|draw|group stage|play-?off|title race|relegation|promotion|fixture|trophy|cup)\b/i,
  },
  {
    kind: "club",
    pattern:
      /\b(club statement|statement|stadium|board|rebrand|sponsorship|announce(?:s|d|ment)?)\b/i,
  },
];

export function classifyEventKind(text: string): EventKind {
  for (const { kind, pattern } of EVENT_KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "other";
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

/**
 * Generic football vocabulary that describes the ACTION rather than the
 * subject. Removing it from the token set leaves the story's actors
 * (clubs, players, managers, competitions) without hard-coding any names.
 */
const ACTION_VOCABULARY = new Set([
  "transfer", "transfers", "signing", "signings", "sign", "signs", "signed", "deal", "deals",
  "bid", "bids", "offer", "offers", "move", "moves", "moving", "join", "joins", "joined",
  "loan", "fee", "fees", "contract", "contracts", "extension", "renewal", "clause",
  "talks", "negotiation", "negotiations", "agreement", "agreed", "agree", "agrees",
  "official", "officially", "confirm", "confirms", "confirmed", "announce", "announces",
  "announced", "announcement", "complete", "completes", "completed", "unveil", "unveiled",
  "rumour", "rumours", "rumor", "rumors", "rumoured", "rumored", "reportedly", "report",
  "reports", "reported", "linked", "link", "links", "interest", "interested", "target",
  "targets", "targeting", "eyeing", "eyed", "monitoring", "considering", "plot", "plots",
  "plotting", "poised", "set", "race", "chase", "chasing", "track", "tracking", "swoop",
  "manager", "managers", "coach", "coaches", "boss", "head", "sacked", "sack", "sacking",
  "dismissed", "appointed", "appointment", "named", "successor", "caretaker", "interim",
  "injury", "injured", "injuries", "fitness", "surgery", "ruled", "sidelined", "setback",
  "ban", "banned", "suspended", "suspension", "charged", "fined", "sanction",
  "says", "said", "admits", "insists", "reveals", "claims", "hits", "slams", "backs",
  "praises", "warns", "vows", "refuses", "demands", "hints", "speaks", "explains", "denies",
  "star", "ace", "wonderkid", "sensation", "hero", "legend", "giant", "giants", "side",
  "club", "clubs", "team", "teams", "squad", "player", "players", "signing", "striker",
  "midfielder", "defender", "goalkeeper", "winger", "forward", "centre", "back", "left",
  "right", "season", "summer", "winter", "january", "window", "future", "latest", "breaking",
  "exclusive", "update", "updates", "news", "match", "game", "games", "win", "loss", "draw",
  "goal", "goals", "assist", "assists", "point", "points", "league", "cup", "final",
  "million", "billion", "worth", "value", "price", "wages", "salary", "want", "wants",
  "wanted", "ready", "close", "near", "could", "would", "make", "makes", "making", "new",
  "old", "big", "huge", "massive", "major", "top", "best", "worst", "next", "last", "first",
  "after", "before", "amid", "ahead", "following", "despite", "over", "under", "into",
]);

const ENTITY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "his", "her", "its", "their", "our",
  "are", "was", "were", "has", "have", "had", "been", "will", "can", "but", "not", "all",
  "out", "off", "own", "who", "why", "how", "when", "where", "what", "there", "here",
  "than", "then", "them", "they", "him", "she", "you", "your", "any", "may", "might",
  "hold", "holds", "held", "plan", "plans", "planning", "bring", "brings", "take", "takes",
  "give", "gives", "put", "puts", "set", "sets", "keep", "keeps", "let", "lets", "amid",
  "ahead", "after", "before", "during", "against", "between", "over", "under", "about",
  "via", "per", "due", "still", "just", "now", "already", "only", "also", "more", "most",
  "very", "much", "many", "some", "such", "each", "both", "another", "other", "others",
]);

export function extractEntities(title: string): string[] {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[-']+|[-']+$/g, ""))
    .filter(
      (token) =>
        token.length >= 3 && !ACTION_VOCABULARY.has(token) && !ENTITY_STOPWORDS.has(token),
    );

  const unique = [...new Set(tokens)];
  // Distinctive tokens first (longer tokens are usually names), then
  // alphabetical for a deterministic, order-independent fingerprint.
  unique.sort((a, b) => (b.length - a.length) || a.localeCompare(b));
  return unique.slice(0, 5).sort();
}

/* ------------------------------------------------------------------ */
/* Fingerprint                                                         */
/* ------------------------------------------------------------------ */

export interface StoryIdentity {
  entities: string[];
  eventKind: EventKind;
  stage: StoryStage;
  stageRank: number;
  fingerprint: string;
}

/**
 * Deterministic story fingerprint: the actors plus the kind of event, but
 * deliberately NOT the stage — so a rumour and its later official
 * confirmation map to the same story and can be compared.
 */
export function buildStoryIdentity(title: string, description: string | null): StoryIdentity {
  const haystack = `${title} ${description ?? ""}`;
  const entities = extractEntities(title);
  const eventKind = classifyEventKind(haystack);
  const stage = classifyStage(haystack);

  return {
    entities,
    eventKind,
    stage,
    stageRank: STAGE_RANK[stage],
    fingerprint: fingerprintOf(entities, eventKind),
  };
}

export function fingerprintOf(entities: string[], eventKind: EventKind): string {
  const basis = entities.length > 0 ? [...entities].sort().join("|") : "unknown";
  return sha256(`${eventKind}::${basis}`);
}

/**
 * Decides whether a newly discovered report about an already-published
 * story is a legitimate follow-up (materially new development) or just
 * another rewrite of the same news.
 */
export function isMaterialFollowUp(
  publishedStageRank: number,
  candidateStageRank: number,
  followUpsSoFar: number,
): boolean {
  if (followUpsSoFar >= MAX_FOLLOWUPS_PER_STORY) return false;
  if (candidateStageRank <= publishedStageRank) return false;
  return candidateStageRank >= MIN_FOLLOWUP_STAGE_RANK;
}
