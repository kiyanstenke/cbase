// Port of: microsoft/vscode src/vs/base/common/search.ts (MIT)
// "Preserve case" when replacing — pure, no DOM. Literally after VS Code `buildReplaceStringWithCasePreserved` (src/vs/base/common/search.ts): the
// replacement takes the casing of the match — all upper, all lower, first letter upper or lower; if both texts are split by `-` or (only)
// `_` into the same number of parts, it applies per part (`foo-bar` → `Foo-Bar`). Used in components/code/search-widget.ts.
//
// Tested EXECUTED in web/test/editor-look.test.mjs (with sabotage).

const hasLarge = (z: string) => z !== z.toLowerCase();

function equalShared(hits: string, pattern: string, character: string): boolean {
  return hits.includes(character) && pattern.includes(character) && hits.split(character).length === pattern.split(character).length;
}
function perPart(hits: string, pattern: string, character: string): string {
  const t = hits.split(character);
  return pattern.split(character).map((m, i) => preserveCase(t[i], m)).join(character);
}

/** The replacement `pattern` in the casing of `hits`. */
export function preserveCase(hits: string, pattern: string): string {
  if (!hits) return pattern;
  const hyphen = equalShared(hits, pattern, "-"), underscore = equalShared(hits, pattern, "_");
  if (hyphen && !underscore) return perPart(hits, pattern, "-");
  if (!hyphen && underscore) return perPart(hits, pattern, "_");
  if (hits.toUpperCase() === hits) return pattern.toUpperCase();
  if (hits.toLowerCase() === hits) return pattern.toLowerCase();
  if (hasLarge(hits[0]) && pattern.length > 0) return pattern[0].toUpperCase() + pattern.slice(1);
  if (hits[0].toUpperCase() !== hits[0] && pattern.length > 0) return pattern[0].toLowerCase() + pattern.slice(1);
  return pattern;
}
