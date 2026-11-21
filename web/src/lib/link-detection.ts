// Port of: microsoft/vscode src/vs/editor/common/languages/linkComputer.ts (MIT)
// Links in EVERY file as in VS Code: VS Code registers a link provider for every model for all languages (`'*'`, editorWorkerService.ts
// `WorkerBasedDocumentLinkProvider`) that finds addresses in the text — `LinkComputer.computeLinks`: a state machine recognizes `http://`,
// `https://` and `file://` (case-insensitive), then the link runs up to a separator (whitespace, `<>'"|`, `…` and the wide punctuation);
// parentheses, square and curly brackets and quotes end it only if they were not opened within the link; `.,;:` at the end do not
// belong to it, nor does a bracket that closes exactly the one before the link. Per line, as there (1.143.1: `computeLinks`,
// `_createLink`, the state table and the character classes).
// A leaf module without imports (the guard web/test/link-detection.test.mjs runs it).

export type DetectedLink = { from: number; to: number; url: string };

const enum Z { Invalid = 0, Start = 1, H = 2, HT = 3, HTT = 4, HTTP = 5, F = 6, FI = 7, FIL = 8, BeforeColon = 9, AfterColon = 10, AlmostThere = 11, End = 12, Accept = 13 }
const enum K { None = 0, ForceTermination = 1, CannotEndIn = 2 }

/** The transitions (`[from, character, to]`) like linkComputer.ts `getStateMachine`. */
const TRANSITIONS: readonly (readonly [number, number, number])[] = [
  [Z.Start, 104, Z.H], [Z.Start, 72, Z.H], [Z.Start, 102, Z.F], [Z.Start, 70, Z.F],
  [Z.H, 116, Z.HT], [Z.H, 84, Z.HT], [Z.HT, 116, Z.HTT], [Z.HT, 84, Z.HTT], [Z.HTT, 112, Z.HTTP], [Z.HTT, 80, Z.HTTP],
  [Z.HTTP, 115, Z.BeforeColon], [Z.HTTP, 83, Z.BeforeColon], [Z.HTTP, 58, Z.AfterColon],
  [Z.F, 105, Z.FI], [Z.F, 73, Z.FI], [Z.FI, 108, Z.FIL], [Z.FI, 76, Z.FIL], [Z.FIL, 101, Z.BeforeColon], [Z.FIL, 69, Z.BeforeColon],
  [Z.BeforeColon, 58, Z.AfterColon], [Z.AfterColon, 47, Z.AlmostThere], [Z.AlmostThere, 47, Z.End],
];
const next = (() => {
  const t = new Map<number, number>();
  for (const [a, c, b] of TRANSITIONS) t.set(a * 65536 + c, b);
  return (z: number, c: number) => t.get(z * 65536 + c) ?? Z.Invalid;
})();

const SEPARATOR = " \t<>'\"、。｡､，．：；‘〈「『〔（［｛｢｣｝］）〕』」〉’｀～…|";
const kind = (c: number): K => (SEPARATOR.includes(String.fromCharCode(c)) ? K.ForceTermination : ".,;:".includes(String.fromCharCode(c)) ? K.CannotEndIn : K.None);

/** `_createLink`: `.,;:` at the end drop; if the last character closes the bracket directly before the link, it drops too. */
function link(row: string, start: number, end: number): DetectedLink {
  let last = end - 1;
  do {
    if (kind(row.charCodeAt(last)) !== K.CannotEndIn) break;
    last--;
  } while (last > start);
  if (start > 0) {
    const before = row.charCodeAt(start - 1), after = row.charCodeAt(last);
    if ((before === 40 && after === 41) || (before === 91 && after === 93) || (before === 123 && after === 125)) last--;
  }
  return { from: start, to: last + 1, url: row.substring(start, last + 1) };
}

/** The links of a line (offsets in the line, `to` exclusive) — `computeLinks` for one line. */
export function linksOfTheRow(row: string): DetectedLink[] {
  const out: DetectedLink[] = [];
  const n = row.length;
  let i = 0, start = 0, prior = 0, z: number = Z.Start;
  let round = false, square = false, inSquare = false, curly = false;
  while (i < n) {
    let fresh = false;
    const c = row.charCodeAt(i);
    if (z === Z.Accept) {
      let k: K;
      switch (c) {
        case 40: round = true; k = K.None; break;
        case 41: k = round ? K.None : K.ForceTermination; break;
        case 91: inSquare = true; square = true; k = K.None; break;
        case 93: inSquare = false; k = square ? K.None : K.ForceTermination; break;
        case 123: curly = true; k = K.None; break;
        case 125: k = curly ? K.None : K.ForceTermination; break;
        case 39: case 34: case 96: k = prior === c ? K.ForceTermination : prior === 39 || prior === 34 || prior === 96 ? K.None : K.ForceTermination; break;
        case 42: k = prior === 42 ? K.ForceTermination : K.None; break;
        case 32: k = inSquare ? K.None : K.ForceTermination; break;
        default: k = kind(c);
      }
      if (k === K.ForceTermination) { out.push(link(row, start, i)); fresh = true; }
    } else if (z === Z.End) {
      let k: K;
      if (c === 91) { square = true; k = K.None; } else k = kind(c);
      if (k === K.ForceTermination) fresh = true; else z = Z.Accept;
    } else {
      z = next(z, c);
      if (z === Z.Invalid) fresh = true;
    }
    if (fresh) { z = Z.Start; round = false; square = false; curly = false; start = i + 1; prior = c; }
    i++;
  }
  if (z === Z.Accept) out.push(link(row, start, n));
  return out;
}

/** The link containing the character at `offset` — or null. */
export function linkAtPlace(row: string, offset: number): DetectedLink | null {
  return linksOfTheRow(row).find((l) => l.from <= offset && offset < l.to) ?? null;
}
