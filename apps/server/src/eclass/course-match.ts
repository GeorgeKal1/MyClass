/**
 * Finding a course from what a student (or the assistant) typed: "Ανάλυση 1", "αναλυση ενα",
 * "ΑΝΑΛΥΣΗ Ι", "Analysis I", "tma117" or "ΤΜΑ117" (Greek capitals) all name the same course.
 * Pure functions, so the catalog search, enrolling and the assistant share one notion of a match.
 */

interface MatchableCourse {
  code: string;
  publicCode?: string;
  title: string;
  numericId?: number;
}

/** Lowercase, no accents or diaeresis, final sigma as sigma. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ς/g, "σ");
}

/** Greek capitals that look like Latin ones, as students type course codes on a Greek keyboard. */
const GREEK_LOOKALIKE: Record<string, string> = {
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};

/** A course code compared as eClass stores it: upper case, Latin letters, no spaces. */
export function codeKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (ch) => GREEK_LOOKALIKE[ch] ?? ch)
    .replace(/\s+/g, "");
}

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
};

const NUMBER_WORDS: Record<string, string> = {
  ενα: "1", ενασ: "1", μια: "1", πρωτο: "1", πρωτη: "1", πρωτοσ: "1", one: "1", first: "1",
  δυο: "2", δευτερο: "2", δευτερη: "2", δευτεροσ: "2", two: "2", second: "2",
  τρια: "3", τριτο: "3", τριτη: "3", τριτοσ: "3", three: "3", third: "3",
  τεσσερα: "4", τεταρτο: "4", τεταρτη: "4", τεταρτοσ: "4", four: "4", fourth: "4",
};

/** Words that never decide which course is meant. */
const STOPWORDS = new Set([
  "και", "στη", "στην", "στο", "στον", "του", "τησ", "των", "τη", "την", "το", "τον", "η", "ο", "οι", "τα", "με", "σε",
  "μαθημα", "μαθηματοσ", "the", "of", "and", "to", "in", "for", "course",
]);

/**
 * Word tokens of a title or query. Roman numerals (Latin I or Greek Ι), digits and number words
 * all become digits, so "Ανάλυση Ι", "Ανάλυση 1" and "ανάλυση ένα" have the same tokens.
 */
export function courseTokens(s: string): string[] {
  return foldText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => {
      const latin = t.replace(/ι/g, "i");
      if (/^[iv]+$/.test(latin) && ROMAN[latin]) return ROMAN[latin];
      if (/^\d+$/.test(t)) return String(Number(t));
      return NUMBER_WORDS[t] ?? t;
    });
}

const isNumeral = (t: string) => /^\d+$/.test(t);

/** A query token matches a title token exactly (numerals) or as the start of the word ("μαθ" → "μαθηματικα"). */
function tokenMatches(queryToken: string, titleToken: string): boolean {
  if (isNumeral(queryToken) || isNumeral(titleToken)) return queryToken === titleToken;
  return titleToken === queryToken || (queryToken.length >= 2 && titleToken.startsWith(queryToken));
}

/** Whether every meaningful word of `query` appears among `text`'s words. */
export function textMatchesQuery(text: string, query: string): boolean {
  const q = courseTokens(query).filter((t) => !STOPWORDS.has(t));
  if (q.length === 0) return false;
  const words = courseTokens(text);
  return q.every((qt) => words.some((w) => tokenMatches(qt, w)));
}

/** Whether a course is named by its code, public code or eClass id. */
export function isCodeMatch(c: MatchableCourse, query: string): boolean {
  const key = codeKey(query.trim());
  if (!key) return false;
  return codeKey(c.code) === key || (!!c.publicCode && codeKey(c.publicCode) === key) || String(c.numericId ?? "") === query.trim();
}

/**
 * Courses `query` names, best first: an exact code first, else titles containing every word of
 * the query. Among title matches, a title with no words beyond the query ("Ανάλυση Ι" for
 * "ανάλυση 1") ranks above longer ones ("Ανάλυση Ι - Ασκήσεις").
 */
export function rankCourseMatches<T extends MatchableCourse>(courses: T[], query: string): T[] {
  const byCode = courses.filter((c) => isCodeMatch(c, query));
  if (byCode.length) return byCode;
  const qTokens = courseTokens(query).filter((t) => !STOPWORDS.has(t));
  if (qTokens.length === 0) return [];
  return courses
    .filter((c) => textMatchesQuery(c.title, query))
    .map((c) => {
      const extra = courseTokens(c.title).filter(
        (w) => !STOPWORDS.has(w) && !qTokens.some((qt) => tokenMatches(qt, w)),
      ).length;
      return { c, extra };
    })
    .sort((a, b) => a.extra - b.extra)
    .map(({ c }) => c);
}

export type CourseResolution<T> =
  | { status: "found"; course: T }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "not_found"; suggestions: T[] };

/**
 * The one course `query` names, or why there isn't one. A single title that matches the query
 * word for word wins over looser matches; several equally good matches are ambiguous.
 */
export function resolveCourse<T extends MatchableCourse>(courses: T[], query: string): CourseResolution<T> {
  const ranked = rankCourseMatches(courses, query);
  if (ranked.length === 1) return { status: "found", course: ranked[0] };
  if (ranked.length > 1) {
    if (ranked.some((c) => isCodeMatch(c, query))) {
      // The same code on two portals is still one course to the student: take the first
      return { status: "found", course: ranked[0] };
    }
    const qTokens = courseTokens(query).filter((t) => !STOPWORDS.has(t));
    const exact = ranked.filter((c) => {
      const words = courseTokens(c.title).filter((w) => !STOPWORDS.has(w));
      return words.every((w) => qTokens.some((qt) => tokenMatches(qt, w)));
    });
    if (exact.length === 1) return { status: "found", course: exact[0] };
    return { status: "ambiguous", candidates: ranked.slice(0, 8) };
  }
  // Nothing matched every word: offer courses sharing a distinctive word as suggestions
  const distinctive = courseTokens(query).filter((t) => !STOPWORDS.has(t) && !isNumeral(t) && t.length >= 4);
  const suggestions = distinctive.length
    ? courses.filter((c) => courseTokens(c.title).some((w) => distinctive.some((d) => tokenMatches(d, w)))).slice(0, 8)
    : [];
  return { status: "not_found", suggestions };
}
