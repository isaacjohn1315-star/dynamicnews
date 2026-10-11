import { toPlainPostText } from "./text";
import type { StoryStage } from "./story";

/**
 * Context-aware post composition.
 *
 * The length of a post follows the amount of verified information the source
 * actually contains — it is never padded to a word count and never truncated
 * to fit a limit.
 *
 *   Simple confirmation, few details ......... ~30-60 words
 *   Story needing real explanation ........... ~60-120 words
 *   Squad lists, injuries, interviews ........ ~80-160 words
 *
 * Hard rules:
 *   - A post never ends mid-sentence or with an ellipsis. If a detail
 *     sentence is truncated in the source, it is dropped, not carried over.
 *   - No invented names, quotes, fees, dates or statuses. Only text the
 *     publisher actually wrote is used.
 *   - If the available material cannot support a complete, useful post, the
 *     story is rejected rather than padded with filler.
 */

/** Word-count guidance per detail tier (defaults, not rigid limits). */
export const LENGTH_POLICY = {
  simple: { min: 20, max: 70 },
  explained: { min: 40, max: 130 },
  detailed: { min: 50, max: 175 },
} as const;

/** Hard safety ceiling for the whole message (Facebook allows 63,206). */
const ABSOLUTE_MAX_TOTAL = 2_400;
const MAX_HEADLINE = 150;

/** Certainty wording tied strictly to the detected reporting stage. */
export const CAVEAT_SENTENCES: string[] = [
  "An agreement is not the same as a completed move, which is only final once the clubs confirm it.",
  "A bid alone does not mean a deal is agreed, and the selling club can still turn it down.",
  "Talks do not guarantee an agreement, and no deal is in place while negotiations continue.",
  "This is a report rather than a confirmed move, and interest alone does not mean an offer has been made.",
  "Nothing has been confirmed by the clubs involved yet.",
  "The move has now been confirmed by the parties involved, ending the speculation around it.",
];

const STAGE_CAVEAT: Record<StoryStage, string | null> = {
  official: null,
  agreement: "An agreement is not the same as a completed move, which is only final once the clubs confirm it.",
  bid: "A bid alone does not mean a deal is agreed, and the selling club can still turn it down.",
  talks: "Talks do not guarantee an agreement, and no deal is in place while negotiations continue.",
  rumour: "This is a report rather than a confirmed move, and interest alone does not mean an offer has been made.",
  general: null,
};

const HEDGED_ALREADY =
  /\b(according to reports?|reports? claim|reportedly|it is (?:claimed|reported)|understood to|are said to|is said to|have reportedly|has reportedly|rumou?rs?|sources? (?:say|claim)|claims? the)\b/i;

/** Boilerplate sentences that add nothing to a football post. */
const NON_CONTENT =
  /^(by |read more|click|subscribe|sign up|follow us|get the latest|watch:|listen|share this|also read|related|advertisement|photo|image |getty|pa wire|this article|continue reading|read the full|view this)/i;

export interface ComposedPost {
  headline: string;
  explanation: string;
  message: string;
  wordCount: number;
  tier: keyof typeof LENGTH_POLICY;
}

/** Splits source text into sentences, discarding any that are cut short. */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when a sentence ends mid-thought: the source cut it off with an
 * ellipsis, a dangling conjunction, or no terminal punctuation while more
 * text clearly followed.
 */
function isTruncated(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (/(?:\.{3}|\u2026|…)$/.test(trimmed)) return true;
  // Unfinished trailing fragment without terminal punctuation.
  if (!/[.!?"""']$/.test(trimmed)) return true;
  // Dangling connectors strongly imply the sentence continues.
  if (/\b(and|or|but|with|including|as well as|plus|before|after|while)\s*$/i.test(trimmed)) return true;
  return false;
}

interface ScoredSentence {
  sentence: string;
  novelRatio: number;
}

/**
 * Collects every complete, informative sentence from the source, ranked by
 * how much new information it adds over the headline.
 */
function collectDetailSentences(source: string, headline: string): ScoredSentence[] {
  const headlineWords = new Set(
    headline.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );

  const scored: ScoredSentence[] = [];
  for (const sentence of splitSentences(source)) {
    if (sentence.length < 25) continue;
    if (NON_CONTENT.test(sentence)) continue;
    if (/https?:\/\/|www\.|#\w/.test(sentence)) continue;
    // A sentence the source cut short must never reach the post.
    if (isTruncated(sentence)) continue;

    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length < 4) continue;

    const overlap = words.filter((w) => headlineWords.has(w)).length / words.length;
    scored.push({ sentence, novelRatio: 1 - overlap });
  }

  // Keep source order (publishers front-load facts) but drop pure restatements.
  return scored.filter((s) => s.novelRatio >= 0.25);
}

/** Chooses the detail tier from how much verified detail exists. */
function chooseTier(
  detailSentences: ScoredSentence[],
  stage: StoryStage,
): keyof typeof LENGTH_POLICY {
  const detailWords = detailSentences.reduce((sum, s) => sum + countWords(s.sentence), 0);
  if (detailWords >= 90) return "detailed";
  if (detailWords >= 35) return "explained";
  if (detailSentences.length > 0) return "simple";
  // No usable detail: only a caveat exists, so keep it short.
  return stage === "official" ? "simple" : "simple";
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Builds the explanation body from complete sentences only, up to the
 * chosen tier's word budget, always stopping at a sentence boundary.
 */
export function buildExplanation(
  source: string | null,
  headline: string,
  stage: StoryStage,
  isRumour: boolean,
): string | null {
  const text = source ? toPlainPostText(source) : "";
  const sentences = collectDetailSentences(text, headline);
  const tier = chooseTier(sentences, stage);
  const budget = LENGTH_POLICY[tier].max;

  const parts: string[] = [];
  let words = 0;
  for (const { sentence } of sentences) {
    const sentenceWords = countWords(sentence);
    if (words + sentenceWords > budget && parts.length > 0) break;
    if (words + sentenceWords > budget + 40) break;
    parts.push(sentence);
    words += sentenceWords;
    if (words >= budget) break;
  }

  const baseCaveat = isRumour ? (STAGE_CAVEAT[stage] ?? STAGE_CAVEAT.rumour) : STAGE_CAVEAT[stage];
  // Do not hedge twice when the publisher already frames it as a report.
  const caveat =
    parts.length > 0 && baseCaveat && HEDGED_ALREADY.test(parts[parts.length - 1]) && stage !== "official"
      ? "Nothing has been confirmed by the clubs involved yet."
      : baseCaveat;

  if (parts.length === 0) {
    // No usable detail from the source. A caveat-only body would be a generic
    // explanation that adds nothing beyond the headline, so the story is
    // rejected rather than padded. The caller then reports that no accurate,
    // useful explanation could be produced.
    return null;
  }

  if (caveat && words + countWords(caveat) <= budget + 45) {
    return `${parts.join(" ")} ${caveat}`;
  }
  return parts.join(" ");
}

/**
 * Assembles the final Facebook message and applies the pre-publish quality
 * gate. Returns null when the post would break any rule.
 */
export function composePost(
  statement: string,
  explanation: string,
  sourceName: string,
): ComposedPost | null {
  const headline = toPlainPostText(statement);
  const body = toPlainPostText(explanation);
  const source = toPlainPostText(sourceName);

  if (!headline || headline.length < 20 || headline.length > MAX_HEADLINE) return null;
  if (!source || source.length > 80) return null;
  if (/https?:\/\/|www\.|#\w/.test(`${headline} ${body}`)) return null;

  // The explanation must be a set of complete sentences.
  if (!body || body.length < 20) return null;
  if (/(?:\.{3}|\u2026|…)\s*$/.test(body)) return null;
  for (const sentence of splitSentences(body)) {
    if (isTruncated(sentence)) return null;
  }

  const message = `🚩 ${headline}\n\n${body}\n\nSource: ${source}`;
  if (message.length > ABSOLUTE_MAX_TOTAL) return null;

  return {
    headline,
    explanation: body,
    message,
    wordCount: countWords(body),
    tier: countWords(body) >= LENGTH_POLICY.explained.min
      ? (countWords(body) >= LENGTH_POLICY.detailed.min ? "detailed" : "explained")
      : "simple",
  };
}

/**
 * Final editorial check before anything is sent to Facebook.
 * Every question in the checklist maps to one explicit test here.
 */
export interface QualityCheck {
  ok: boolean;
  problems: string[];
}

export function finalQualityCheck(
  post: ComposedPost,
  context: { sourceText: string | null; headline: string },
): QualityCheck {
  const problems: string[] = [];
  const { message, explanation } = post;
  const bodySentences = splitSentences(explanation);

  if (bodySentences.length === 0) problems.push("explanation contains no complete sentence");
  if (/(?:\.{3}|\u2026|…)\s*$/.test(message)) problems.push("post ends with an ellipsis");
  if (!/[.!?]$/.test(explanation.trim())) problems.push("post does not end with a complete sentence");

  // Does it add value beyond the headline?
  const headlineWords = new Set(
    context.headline.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
  const bodyWords = explanation
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (bodyWords.length > 0) {
    const overlap = bodyWords.filter((w) => headlineWords.has(w)).length / bodyWords.length;
    if (overlap > 0.85) problems.push("explanation only repeats the headline");
  }

  // Unnecessarily long for a simple confirmation?
  if (post.wordCount > LENGTH_POLICY.detailed.max + 60) {
    problems.push(`post is ${post.wordCount} words, longer than any supported tier`);
  }

  // No placeholder text may ever leak out.
  if (/\[(?:[^\]]{0,60})\]|\bplaceholder\b|TODO|XXX|<[^>]+>/.test(message)) {
    problems.push("post contains placeholder or markup text");
  }

  // Claims must be supported by the material we actually read. DynaSport's
  // own certainty labelling (rumour/confirmed caveats) is editorial framing,
  // not a factual claim sourced from the article, so it is exempt.
  if (context.sourceText) {
    const source = toPlainPostText(context.sourceText).toLowerCase();
    const caveats = CAVEAT_SENTENCES.map((c) => c.toLowerCase());
    for (const sentence of bodySentences) {
      if (caveats.some((c) => sentence.toLowerCase().trim() === c)) continue;
      const probe = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 4);
      if (probe.length === 0) continue;
      const present = probe.filter((w) => source.includes(w)).length / probe.length;
      if (present < 0.6) {
        problems.push("a sentence is not supported by the available source material");
        break;
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
