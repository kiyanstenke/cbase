// The rules of the ⌘ hover: pure, no DOM; drawn in components/code/cmd-hover.ts.
//
// - `modPressed`: ⌘ on the Mac, else Ctrl, without ⌥ and ⇧ (⌥⌘ shortcuts are other commands).
// - `responseApplies`: an answer of the language service only counts for the question asked last, and only while the text is the same
//   and the view is still mounted; otherwise a slow server would show the link at the wrong word or in a closed editor.
// - `LocationsStorage`: per word only NON-EMPTY answers are remembered, and only briefly (VALID_MS): an empty answer or an error
//   (server still loading, 5xx, timeout) is asked again on the next hold, and a remembered location goes stale when the target file
//   was changed elsewhere. The source text changes ⇒ `empty()`.
// - `looksLikeTarget`: a leaf of the syntax tree that is an identifier (…Name, …Definition, …Identifier): there the ⌘ hover underlines
//   IMMEDIATELY and takes the underline back if the language service knows no definition (the answer travels through gateway and
//   container, so waiting for it would feel late). Keywords, strings, comments, numbers: only after the answer.
//
// Tested by execution in web/test/editor-look.test.mjs (with sabotage).

export const VALID_MS = 5000;

export const modPressed = (e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean =>
  (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;

export type Question = { seq: number; doc: unknown };
export const responseApplies = (question: Question, now: Question & { mounted: boolean }): boolean =>
  question.seq === now.seq && question.doc === now.doc && now.mounted;

export const looksLikeTarget = (node: string): boolean => /(?:Name|Definition|Identifier)$/.test(node);

export class LocationsStorage<T> {
  private readonly m = new Map<string, { locations: readonly T[]; until: number }>();
  constructor(readonly validMs = VALID_MS) {}
  fetch(key: string, now: number): readonly T[] | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (now >= e.until) { this.m.delete(key); return undefined; }
    return e.locations;
  }
  remember(key: string, locations: readonly T[], now: number): void {
    if (locations.length) this.m.set(key, { locations, until: now + this.validMs });
    else this.m.delete(key);
  }
  empty(): void { this.m.clear(); }
}
