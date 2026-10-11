import { toPlainPostText } from "./text";
import type { StoryStage } from "./story";

/**
 * DynaSport post composition.
 *
 * Every post has four parts:
 *
 *   🚩 <headline>
 *   <blank line>
 *   <explanation: why it matters / what is actually known>
 *   <blank line>
 *   Source: <real publisher>
 *
 * The headline and explanation are derived ONLY from the publisher's own
 * headline and summary. Nothing is invented: no fees, quotes, statistics,
 * motives or outcomes are added. The explanation states the certainty
 * level of the report and the limits of what is known, which is derived
 * from the detected stage — not from speculation.
 *
 * If the source material does not support an accurate, useful explanation,
 * composition fails and the story is rejected rather than published with
 * generic filler.
 */

export interface ComposedPost {
  headline: string;
  explanation: string;
  message: string;
}

const MAX_HEADLINE = 150;
const MAX_EXPLANATION = 260;
const MAX_TOTAL = 480;

/** Certainty wording tied strictly to the detected reporting stage. */
const STAGE_CAVEAT: Record<StoryStage, string | null> = {
  official: null,
  agreement:
    "An agreement is not the same as a completed move, which is only final once the clubs confirm it.",
  bid: "A bid alone does not mean a deal is agreed, and the selling club can still turn it down.",
  talks: "Talks do not guarantee an agreement, and no deal is in place while negotiations continue.",
  rumour:
    "This is a report rather than a confirmed move, and interest alone does not mean an offer has been made.",
  general: null,
};

/**
 * Hedging language a publisher may already use in their own summary. When
 * the detail sentence already carries it, the stage caveat is shortened so
 * the post does not hedge the same thing twice.
 */
const HEDGED_ALREADY =
  /\b(according to reports?|reports? claim|reportedly|it is (?:claimed|reported)|understood to|are said to|is said to|have reportedly|has reportedly|rumou?rs?|sources? (?:say|claim)|claims? the)\b/i;

/**
 * Builds the explanation. Prefers the publisher's own summary sentence
 * (which carries real reported detail), then appends the certainty caveat
 * for unconfirmed stages. Returns null when neither is usable.
 */
export function buildExplanation(
  description: string | null,
  headline: string,
  stage: StoryStage,
  isRumour: boolean,
): string | null {
  const baseCaveat = isRumour ? (STAGE_CAVEAT[stage] ?? STAGE_CAVEAT.rumour) : STAGE_CAVEAT[stage];
  const detail = extractDetailSentence(description, headline);

  // Avoid hedging twice when the publisher's own summary already signals
  // that the claim is a report.
  const caveat =
    detail && baseCaveat && HEDGED_ALREADY.test(detail) && stage !== "official"
      ? "Nothing has been confirmed by the clubs involved yet."
      : baseCaveat;

  if (detail && caveat) {
    const combined = `${detail} ${caveat}`;
    return combined.length <= MAX_EXPLANATION ? combined : caveat;
  }
  if (detail) return detail;
  if (caveat) return caveat;

  // Confirmed stories with no usable summary get a factual, non-speculative
  // framing only when the headline itself states an official development.
  if (stage === "official") {
    return "The move has now been confirmed by the parties involved, ending the speculation around it.";
  }
  return null;
}

/**
 * Picks the first substantive sentence from the publisher's summary that
 * genuinely adds information beyond the headline.
 */
function extractDetailSentence(description: string | null, headline: string): string | null {
  if (!description) return null;
  const text = toPlainPostText(description);
  if (text.length < 40) return null;

  const headlineWords = new Set(
    headline.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= MAX_EXPLANATION);

  for (const sentence of sentences) {
    if (/^(by |read more|click|subscribe|sign up|follow us|get the latest|watch:|listen)/i.test(sentence)) {
      continue;
    }
    if (/https?:\/\/|www\.|#\w/.test(sentence)) continue;

    const words = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3);
    // Four meaningful words is enough for a genuine publisher summary; the
    // previous six-word floor rejected legitimate short wire-style lines.
    if (words.length < 4) continue;
    // Require genuinely new information rather than a restated headline.
    const overlap = words.filter((w) => headlineWords.has(w)).length / words.length;
    if (overlap > 0.7) continue;

    return sentence.endsWith(".") || sentence.endsWith("!") || sentence.endsWith("?")
      ? sentence
      : `${sentence}.`;
  }
  return null;
}

/**
 * Assembles the final Facebook message. Returns null when the result would
 * breach the format rules — the caller then rejects the story.
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
  if (!body || body.length < 30 || body.length > MAX_EXPLANATION) return null;
  if (!source || source.length > 80) return null;

  // Never leak links or hashtags into the message.
  if (/https?:\/\/|www\.|#\w/.test(`${headline} ${body}`)) return null;

  const message = `🚩 ${headline}\n\n${body}\n\nSource: ${source}`;
  if (message.length > MAX_TOTAL) return null;

  return { headline, explanation: body, message };
}
