/**
 * Shared text normalisation for DynaSport.
 *
 * Feed titles arrive with HTML entities, double-encoded entities, malformed
 * entities with a missing "&" or ";" (e.g. "&8216;" seen on live Metro
 * headlines), CDATA wrappers, HTML tags and irregular whitespace. Every
 * headline and description passes through `cleanText()` BEFORE scoring,
 * storage, dashboard display and Facebook publishing, so no raw markup or
 * escaped character code can ever reach the Page.
 *
 * Legitimate names, accents, punctuation and currency symbols are
 * preserved exactly.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  sbquo: "\u201A", bdquo: "\u201E", ndash: "\u2013", mdash: "\u2014",
  hellip: "\u2026", prime: "\u2032", Prime: "\u2033", bull: "\u2022",
  middot: "\u00B7", deg: "\u00B0", plusmn: "\u00B1", times: "\u00D7",
  divide: "\u00F7", frac12: "\u00BD", frac14: "\u00BC", frac34: "\u00BE",
  euro: "\u20AC", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2",
  dollar: "$", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  laquo: "\u00AB", raquo: "\u00BB", eacute: "\u00E9", egrave: "\u00E8",
  ecirc: "\u00EA", agrave: "\u00E0", aacute: "\u00E1", acirc: "\u00E2",
  atilde: "\u00E3", auml: "\u00E4", aring: "\u00E5", ccedil: "\u00E7",
  iacute: "\u00ED", icirc: "\u00EE", iuml: "\u00EF", ntilde: "\u00F1",
  oacute: "\u00F3", ocirc: "\u00F4", otilde: "\u00F5", ouml: "\u00F6",
  oslash: "\u00F8", uacute: "\u00FA", ucirc: "\u00FB", uuml: "\u00FC",
  uring: "\u016F", scaron: "\u0161", zcaron: "\u017E", ccaron: "\u010D",
  szlig: "\u00DF", Eacute: "\u00C9", Aacute: "\u00C1", Oacute: "\u00D3",
  Uacute: "\u00DA", Ntilde: "\u00D1", Ouml: "\u00D6", Uuml: "\u00DC",
  Auml: "\u00C4", Aring: "\u00C5", Oslash: "\u00D8", Ccedil: "\u00C7",
};

/** Safe code-point conversion: rejects invalid, control and surrogate values. */
function codePointToChar(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "";
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
  // Control characters (except tab/newline) carry no display meaning.
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) return " ";
  if (codePoint === 0x7f) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/** One decoding pass over named, decimal and hexadecimal entities. */
function decodeOnce(value: string): string {
  return value
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_m, hex: string) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => codePointToChar(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name: string) => {
      const direct = NAMED_ENTITIES[name];
      if (direct !== undefined) return direct;
      const lower = NAMED_ENTITIES[name.toLowerCase()];
      return lower !== undefined ? lower : match;
    });
}

/**
 * Repairs malformed entities that publishers emit with a missing
 * ampersand, e.g. "&8216;" rendered as "8216;" after a bad decode, or
 * "#8217;" with no leading "&". Only numeric sequences in the Unicode
 * punctuation ranges are repaired, so real numbers are never touched.
 */
function repairMalformedEntities(value: string): string {
  return value
    // "#8217;" -> "&#8217;"
    .replace(/(^|[^&])#(\d{2,6});/g, (_m, prefix: string, dec: string) => `${prefix}&#${dec};`)
    // bare "8217;" directly attached to a word character (e.g. "Neville8217;s")
    .replace(/([A-Za-z])(\d{4,6});/g, (match, letter: string, dec: string) => {
      const code = Number.parseInt(dec, 10);
      if (code >= 0x2000 && code <= 0x203a) return `${letter}&#${dec};`;
      return match;
    });
}

/**
 * Full clean-up: CDATA, malformed entities, repeated decoding passes
 * (handles double-encoding such as "&amp;#8217;"), HTML tags, leftover
 * entity fragments and whitespace normalisation.
 */
export function cleanText(input: string | null | undefined): string {
  if (typeof input !== "string") return "";
  let value = input;

  value = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  // Decode first so genuinely double-encoded input ("&amp;#8217;") unwraps
  // correctly, THEN repair entities that are malformed in the source, then
  // decode again. Repairing first would corrupt double-encoded sequences.
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = decodeOnce(value);
    if (decoded === value) break;
    value = decoded;
  }
  const repaired = repairMalformedEntities(value);
  if (repaired !== value) {
    value = repaired;
    for (let pass = 0; pass < 2; pass += 1) {
      const decoded = decodeOnce(value);
      if (decoded === value) break;
      value = decoded;
    }
  }

  // Strip any HTML that survived decoding (decoded "&lt;b&gt;" -> "<b>").
  value = value.replace(/<[^>]{1,200}>/g, " ");

  // Remove leftover invalid entity fragments that never resolved.
  value = value.replace(/&[a-zA-Z][a-zA-Z0-9]{1,31};/g, (match) =>
    NAMED_ENTITIES[match.slice(1, -1)] !== undefined ? match : " ",
  );
  value = value.replace(/&#?[0-9a-zA-Z]{0,8};/g, " ");
  value = value.replace(/&(?![a-zA-Z#])/g, "&");

  // Normalise whitespace and invisible characters.
  value = value.replace(/[\u00a0\u2007\u202f]/g, " ");
  value = value.replace(/[\u200b-\u200d\ufeff]/g, "");
  value = value.replace(/\s+/g, " ").trim();

  return value;
}

/**
 * Converts typographic characters that are fine on the web but noisy in a
 * plain-text Facebook post. Accents and currency symbols are preserved.
 */
export function toPlainPostText(input: string): string {
  return cleanText(input)
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the text still contains raw markup or escaped character codes. */
export function hasResidualMarkup(value: string): boolean {
  return /<[a-zA-Z/][^>]*>|&#?[0-9a-zA-Z]{1,8};|&#\d/.test(value);
}
