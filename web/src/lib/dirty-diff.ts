// The changes of a file against the INDEX as blocks for the editor margin (explorer and editor styled like VS Code, "dirty diff": like VS Code Quick Diff
// against the index, not against HEAD): green = new lines, blue = changed, a red triangle = deleted. The margin recomputes
// 200 ms after the last key (components/code/git-gutter.ts, `MARGIN_WAIT_MS`), so: common start and common end drop out first, the lines become numbers,
// and the line diff (Myers, O(ND)) has a cap — above it the whole middle becomes ONE block (it says so instead of being silently wrong). Above
// `SIZE_MAX` lines there is no margin (null).
//
// "Reset" of a block (clicking the margin shows the old lines): `reset` yields the ONE change that puts the block in the
// text back to the base (the index) — applied in the BUFFER of the file (through the editor), not saved.
//
// Plus what a view does for its base (`baseJob` — an inactive one nothing), and the shared inventory of the bases
// (`BaseInventory`, forgotten when a buffer closes or moves).
//
// Pure: EXECUTED in web/test/dirty-diff.test.mjs (each computation with a sabotage). The only import: `norm` (lib/file-status.ts).
import { norm } from "./file-status.js";

export type DiffBlock = {
  kind: "fresh" | "changed" | "deleted";
  /** First and last affected row in the current text (1-based). "deleted": from = until = the row BELOW which it was deleted (0: before
   *  the first row). */
  from: number;
  until: number;
  /** The rows that stood here in HEAD (empty for "fresh"). */
  old: string[];
};

/** The margin does not compute more rows (both sides together). */
export const SIZE_MAX = 60_000;
/** The cap of the edit distance — above it the middle is ONE block. */
export const STEPS_MAX = 1_000;

type Chunk = { aOf: number; aTo: number; bOf: number; bTo: number };

/** The pieces in which the row sequences differ (half-open ranges), in order. */
export function rowsChunks(a: readonly string[], b: readonly string[], cap = STEPS_MAX): Chunk[] {
  let beginning = 0;
  while (beginning < a.length && beginning < b.length && a[beginning] === b[beginning]) beginning++;
  let end = 0;
  while (end < a.length - beginning && end < b.length - beginning && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const aM = a.slice(beginning, a.length - end), bM = b.slice(beginning, b.length - end);
  if (!aM.length && !bM.length) return [];
  if (!aM.length || !bM.length) return [{ aOf: beginning, aTo: beginning + aM.length, bOf: beginning, bTo: beginning + bM.length }];
  // Rows → numbers (equal ⇔ same number).
  const ids = new Map<string, number>();
  const id = (z: string) => { let n = ids.get(z); if (n === undefined) { n = ids.size; ids.set(z, n); } return n; };
  const A = aM.map(id), B = bM.map(id);
  const N = A.length, M = B.length;
  // Myers: V[k] = the furthest x on diagonal k; per step d a copy (range −d…d) for the way back.
  const offset = cap + 1;
  const V = new Int32Array(2 * offset + 1);
  const lane: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= cap; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1]) ? V[offset + k + 1] : V[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[offset + k] = x;
    }
    lane.push(V.slice(offset - d, offset + d + 1));
    // At the end? (on diagonal N − M with x = N)
    const kEnd = N - M;
    if (Math.abs(kEnd) <= d && (d - kEnd) % 2 === 0 && V[offset + kEnd] >= N) { found = d; break; }
  }
  if (found < 0) return [{ aOf: beginning, aTo: beginning + N, bOf: beginning, bTo: beginning + M }]; // above the cap: ONE block
  // Way back: per step a deletion (a) or insertion (b); equal rows in between.
  const ops: ("-" | "+")[] = [];
  const opsA: number[] = [], opsB: number[] = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const before = lane[d - 1];
    const at = (k: number) => before[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const kBefore = down ? k + 1 : k - 1;
    const xBefore = at(kBefore), yBefore = xBefore - kBefore;
    while (x > (down ? xBefore : xBefore + 1) && y > (down ? yBefore + 1 : yBefore)) { x--; y--; }
    if (down) { ops.push("+"); opsA.push(xBefore); opsB.push(yBefore); } else { ops.push("-"); opsA.push(xBefore); opsB.push(yBefore); }
    x = xBefore; y = yBefore;
  }
  // Forward to pieces: consecutive steps without equal rows in between belong together.
  const chunks: Chunk[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const aI = opsA[i], bI = opsB[i];
    const aN = ops[i] === "-" ? aI + 1 : aI, bN = ops[i] === "+" ? bI + 1 : bI;
    const last = chunks[chunks.length - 1];
    if (last && last.aTo === aI && last.bTo === bI) { last.aTo = aN; last.bTo = bN; }
    else chunks.push({ aOf: aI, aTo: aN, bOf: bI, bTo: bN });
  }
  return chunks.map((s) => ({ aOf: s.aOf + beginning, aTo: s.aTo + beginning, bOf: s.bOf + beginning, bTo: s.bTo + beginning }));
}

/** The rows of a text — an empty text has NONE (otherwise every row of a new file would be "changed" instead of "fresh"). */
const rowsOf = (t: string): string[] => { const n = norm(t); return n === "" ? [] : n.split("\n"); };

/** The blocks of the margin: HEAD (`base`) against the current text. null: too large (no margin). */
export function dirtyDiff(base: string, now: string): DiffBlock[] | null {
  const a = rowsOf(base), b = rowsOf(now);
  if (a.length + b.length > SIZE_MAX) return null;
  return rowsChunks(a, b).map((s): DiffBlock => {
    const old = a.slice(s.aOf, s.aTo);
    if (s.aTo === s.aOf) return { kind: "fresh", from: s.bOf + 1, until: s.bTo, old: [] };
    if (s.bTo === s.bOf) return { kind: "deleted", from: s.bOf, until: s.bOf, old };
    return { kind: "changed", from: s.bOf + 1, until: s.bTo, old };
  });
}

/** The change that puts a block back to HEAD: `{ from, to, insert }` in characters of the (normalized) current text — the smallest,
 *  so cursor and history touch only the block. */
export function reset(now: string, block: DiffBlock): { from: number; to: number; insert: string } {
  const text = norm(now);
  const rows = rowsOf(text);
  const start = block.kind === "deleted" ? block.from : block.from - 1;
  const end = block.kind === "deleted" ? block.from : block.until;
  const fresh = [...rows.slice(0, start), ...block.old, ...rows.slice(end)].join("\n");
  let p = 0;
  while (p < text.length && p < fresh.length && text[p] === fresh[p]) p++;
  let s = 0;
  while (s < text.length - p && s < fresh.length - p && text[text.length - 1 - s] === fresh[fresh.length - 1 - s]) s++;
  return { from: p, to: text.length - s, insert: fresh.slice(p, fresh.length - s) };
}

/** How long the margin waits after the last key before it recomputes (VS Code Quick Diff: `ThrottledDelayer(200)`). */
export const MARGIN_WAIT_MS = 200;

/** The base for the margin from the answer of `POST …/git/diff { staged: false, content: true }` (lib/diff-tab.ts `normContent`): the INDEX
 *  (stage 0) as text — like VS Code Quick Diff, which compares against the index; otherwise null — a file in conflict (VS Code
 *  shows no margin there), untracked (not in the index), binary, too large, a submodule, a symbolic link (120000 — its "text" is the
 *  path it points to; "reset" would write the path into the file): no margin. */
export function gitBaseFrom(response: { prior: { kind: string; text?: string; reference?: boolean }; after: { kind: string }; conflict?: boolean } | null): string | null {
  if (!response || response.conflict) return null;
  const v = response.prior;
  if (v.kind === "text" && v.reference) return null;
  if (v.kind === "text" && typeof v.text === "string") return norm(v.text);
  return null;
}

/** What a view should do for the base of its file (`useGitBase`): an INACTIVE view does nothing — the
 *  inventory is shared (the same file in Coding → Files and in the chat), and its `null` would otherwise delete the margin of the active one; without a repo,
 *  outside, untracked, in conflict or with a changed type in the working tree (`xy` Y = "T": a file in the index, a link in the working tree):
 *  no base; otherwise fetch (index, `staged: false`). A file that starts with "-" goes as "./-…" (the server never takes a path
 *  with "-" in front as a switch). */
export type BaseJob = { kind: "nothing" } | { kind: "no"; key: string } | { kind: "fetch"; key: string; body: { repo: string; file: string; staged: false; content: true } };
export function baseJob(o: { active: boolean; key: string | null; path: string | null; relRepo: string | null; gitKind: string | null; xy?: string | null }): BaseJob {
  if (!o.active) return { kind: "nothing" };
  if (!o.key) return { kind: "nothing" };
  if (!o.path || o.relRepo === null || o.path.startsWith("/")) return { kind: "no", key: o.key };
  if (o.gitKind === "untracked" || o.gitKind === "conflict" || o.xy?.[1] === "T") return { kind: "no", key: o.key };
  const file = o.relRepo ? (o.path.startsWith(`${o.relRepo}/`) ? o.path.slice(o.relRepo.length + 1) : null) : o.path;
  if (!file) return { kind: "no", key: o.key };
  return { kind: "fetch", key: o.key, body: { repo: o.relRepo, file: file.startsWith("-") ? `./${file}` : file, staged: false, content: true } };
}

/** The inventory of the bases in the window (per buffer key; null = no margin): shared by all views of the same file, forgotten when their
 *  buffer closes or moves (otherwise it would grow with every file ever opened). Reports only a real change. */
export class BaseInventory {
  private readonly bases = new Map<string, string | null>();
  private readonly listeners = new Set<() => void>();
  set(key: string, base: string | null): void {
    if (this.bases.has(key) && this.bases.get(key) === base) return;
    this.bases.set(key, base);
    this.report();
  }
  from(key: string): string | null { return this.bases.get(key) ?? null; }
  forget(key: string): void { if (this.bases.delete(key)) this.report(); }
  /** Forgets every key for which `hits` is true (a renamed folder). */
  forgetWhere(hits: (key: string) => boolean): void {
    let dropped = false;
    for (const k of [...this.bases.keys()]) if (hits(k)) { this.bases.delete(k); dropped = true; }
    if (dropped) this.report();
  }
  get size(): number { return this.bases.size; }
  listen(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private report(): void { for (const fn of [...this.listeners]) fn(); }
}
