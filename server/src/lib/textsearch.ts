/**
 * CJK-friendly full-text search done in app code (works on any Postgres incl. Neon, no extensions/parsers).
 *
 * Postgres' `simple` parser treats a whole run of Han characters as one "word", so `知識庫` never matches `知識`.
 * Instead we tokenize here and store the result as a tsvector LITERAL (`'tok':1,4 'tok2':2`), which Postgres
 * parses without any dictionary/parser — lexemes are taken verbatim:
 *   - Latin / digits: NFKC + lower-cased words (split on non-letters; `_` and `'` break words).
 *   - CJK (Han, Kana, Hangul): overlapping bigrams of each run, plus unigrams (so 1-char queries still work).
 * Queries are tokenized the same way and cast to tsquery: bigrams for CJK runs ≥ 2 chars, words for Latin
 * (prefix `:*` in AND mode for type-ahead search). Ranking uses ts_rank_cd over the stored positions.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDISH = /[\p{L}\p{N}]/u;

export interface Token {
  t: string;
  /** true for CJK unigrams (indexed, but not used in multi-char queries) */
  uni?: boolean;
}

/** Raw runs: { cjk: boolean, text } */
function runs(input: string): { cjk: boolean; text: string }[] {
  const s = input.normalize("NFKC").toLowerCase();
  const out: { cjk: boolean; text: string }[] = [];
  let cur = "";
  let curCjk = false;
  const push = () => {
    if (cur) out.push({ cjk: curCjk, text: cur });
    cur = "";
  };
  for (const ch of s) {
    if (CJK.test(ch)) {
      if (!curCjk) push();
      curCjk = true;
      cur += ch;
    } else if (WORDISH.test(ch)) {
      if (curCjk) push();
      curCjk = false;
      cur += ch;
    } else push();
  }
  push();
  return out;
}

const MAX_WORD = 60;

/** Document tokens in order (positions = index + 1). */
export function documentTokens(text: string): string[] {
  const out: string[] = [];
  for (const r of runs(text)) {
    if (!r.cjk) {
      if (r.text.length <= MAX_WORD) out.push(r.text);
      continue;
    }
    const chars = [...r.text];
    for (let i = 0; i < chars.length; i++) {
      out.push(chars[i]);
      if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/** Query terms: CJK bigrams (or the single char), Latin words. De-duplicated. */
export function queryTerms(q: string): { term: string; latin: boolean }[] {
  const seen = new Set<string>();
  const out: { term: string; latin: boolean }[] = [];
  const add = (term: string, latin: boolean) => {
    if (!term || seen.has(term)) return;
    seen.add(term);
    out.push({ term, latin });
  };
  for (const r of runs(q)) {
    if (!r.cjk) {
      if (r.text.length <= MAX_WORD) add(r.text, true);
      continue;
    }
    const chars = [...r.text];
    if (chars.length === 1) add(chars[0], false);
    for (let i = 0; i + 1 < chars.length; i++) add(chars[i] + chars[i + 1], false);
  }
  return out.slice(0, 64);
}

const quote = (lexeme: string) => `'${lexeme.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

const MAX_POS = 16383;
const MAX_POSITIONS_PER_LEXEME = 64;
const MAX_TSV_CHARS = 512 * 1024;

/** tsvector literal for a document (cast with `::tsvector`). Empty string for no tokens. */
export function toTsvectorLiteral(text: string): string {
  const pos = new Map<string, number[]>();
  const toks = documentTokens(text);
  for (let i = 0; i < toks.length; i++) {
    const p = Math.min(MAX_POS, i + 1);
    const arr = pos.get(toks[i]);
    if (!arr) pos.set(toks[i], [p]);
    else if (arr.length < MAX_POSITIONS_PER_LEXEME && arr[arr.length - 1] !== p) arr.push(p);
  }
  let out = "";
  for (const [t, ps] of pos) {
    const piece = `${quote(t)}:${ps.join(",")}`;
    if (out.length + piece.length + 1 > MAX_TSV_CHARS) break;
    out += (out ? " " : "") + piece;
  }
  return out;
}

/**
 * tsquery literal (cast with `::tsquery`), or null when the query has no searchable terms.
 * `and`: every term must match (conversation search; Latin words prefix-matched).
 * `or`: any term may match, ranking does the rest (hybrid retrieval recall).
 */
export function toTsqueryLiteral(q: string, mode: "and" | "or"): string | null {
  const terms = queryTerms(q);
  if (!terms.length) return null;
  return terms.map(({ term, latin }) => quote(term) + (latin && mode === "and" ? ":*" : "")).join(mode === "and" ? " & " : " | ");
}
