// The number of problems per file in the window (explorer and editor styled like VS Code):
// ONE store for the color of a tab name (error red, warning yellow), the ⓧ/⚠ counters of the status bar and the color of a file in the
// explorer (components/code/explorer/tree-problems.ts). Keyed like the buffer (lib/buffer.ts `bufferKey`): the same file in Coding → Files and in
// a chat has ONE number.
//
// It is filled by the places that fetch diagnostics: the editor's linter (components/code/lsp-diagnostics.ts — the visible file
// after every change), the "Problems" panel (components/code/layout-problems.ts — all open tabs while it is open) and the
// visible explorer (tree-problems.ts — all open tabs after every pause); cleared when the buffer closes, and carried along when it is
// renamed (components/code/StatusBar.tsx registers both once per window). A file without an entry is UNKNOWN
// (`null`), not "without problems" — empty is not unknown.
//
// Pure (no imports): tested in web/test/editor-status.test.mjs.

/** `infos`: the badge on the PROBLEMS tab counts like VS Code `ActivityUpdater` errors + warnings + infos; hints never. */
export type DiagnosticCount = { error: number; warnings: number; infos?: number };

const STATE = new Map<string, DiagnosticCount>();
const LISTENERS = new Set<() => void>();
let version = 0;

/** Counts diagnostics by severity: LSP count (1 error, 2 warning, 3 info) or word ("error", "warning", "info"); anything else does not count. */
export function countSeverity(list: readonly { severity?: unknown }[]): DiagnosticCount {
  let error = 0, warnings = 0, infos = 0;
  for (const d of list) {
    const s = d?.severity;
    if (s === 1 || s === "error") error++;
    else if (s === 2 || s === "warning") warnings++;
    else if (s === 3 || s === "info") infos++;
  }
  return { error, warnings, infos };
}

/** Sets the number of a file (null: forget). Reports only a real change. */
export function setDiagnostics(key: string, z: DiagnosticCount | null): void {
  const old = STATE.get(key);
  if (z === null) { if (!old) return; STATE.delete(key); }
  else {
    if (old && old.error === z.error && old.warnings === z.warnings && (old.infos ?? 0) === (z.infos ?? 0)) return;
    STATE.set(key, { error: Math.max(0, z.error | 0), warnings: Math.max(0, z.warnings | 0), infos: Math.max(0, (z.infos ?? 0) | 0) });
  }
  version++;
  for (const fn of [...LISTENERS]) fn();
}

/** The number of a file — null: unknown (never asked or closed). */
export const diagnosticsOf = (key: string): DiagnosticCount | null => STATE.get(key) ?? null;

/** The sum over files (the status bar: all open tabs of the view); unknown ones do not count — `known` says how many of the
 *  (distinct) files have a number, `files` how many there are: 0 known is UNKNOWN, not "no problems". */
export function sumDiagnostics(key: Iterable<string>): DiagnosticCount & { infos: number; known: number; files: number } {
  let error = 0, warnings = 0, infos = 0, known = 0, files = 0;
  for (const k of new Set(key)) { files++; const z = STATE.get(k); if (z) { known++; error += z.error; warnings += z.warnings; infos += z.infos ?? 0; } }
  return { error, warnings, infos, known, files };
}

/** A buffer moves (renaming a file or a folder): its number moves with it. `projection` gives the new key
 *  or null (not affected); a target that already has a number stays untouched (like the buffer itself). */
export function relocateDiagnostics(projection: (key: string) => string | null): void {
  const relocation: [string, string, DiagnosticCount][] = [];
  for (const [k, z] of STATE) { const k2 = projection(k); if (k2 !== null && k2 !== k && !STATE.has(k2)) relocation.push([k, k2, z]); }
  if (!relocation.length) return;
  for (const [k] of relocation) STATE.delete(k);
  for (const [, k2, z] of relocation) STATE.set(k2, z);
  version++;
  for (const fn of [...LISTENERS]) fn();
}

export function subscribeDiagnostics(fn: () => void): () => void { LISTENERS.add(fn); return () => { LISTENERS.delete(fn); }; }
/** Grows with every change (for useSyncExternalStore). */
export const diagnosticVersion = (): number => version;
