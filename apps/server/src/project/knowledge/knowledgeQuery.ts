/**
 * Turns free text into an FTS5 MATCH expression. User text never reaches
 * MATCH directly: only quoted terms made of letters, combining marks, digits
 * and underscores do. Compounds such as `AC-01`, `0927-project` or `docs/plan.md` stay one
 * quoted phrase, which FTS5 matches as consecutive tokens.
 */

/** Every term widens the matches bm25 scores, so a long question keeps its first 16. */
const MAX_TERMS = 16;

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my no not of on or our please should so than that the their them then there these they this to was we " +
    "were what when where which while who why will with would you your about after all also any before between " +
    "both each few more most other over same some such through under until up very just only own again once"
  ).split(" "),
);

/** Combining marks belong to the word, as vowel signs do in Devanagari or Thai. */
const COMPOUND = /[\p{L}\p{M}\p{N}_]+(?:[-./:#][\p{L}\p{M}\p{N}_]+)*/gu;

export function knowledgeMatchExpression(text: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of text.normalize("NFKC").matchAll(COMPOUND)) {
    const term = match[0].toLowerCase();
    const compound = /[-./:#]/.test(term);
    // Length counts letters and digits, not code units or the marks on them.
    const length = [...term.replace(/\p{M}/gu, "")].length;
    if (!compound && (length < 2 || STOPWORDS.has(term))) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    // Terms hold only letters, marks, digits, underscores and joiners, so quoting needs no escaping.
    terms.push(`"${term}"`);
    if (terms.length === MAX_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" OR ");
}
