// The state of an editor view as VS Code `IEditorViewState`: selection, scroll position and folds per file AND group. It moves along
// when splitting and moving (VS Code gives the new editor the old one's state) and survives reloading (VS Code
// `workbench.editor.restoreViewState`) — the pure computation; read and applied in components/code/BufferEditor.tsx, remembered in CodePane.
//
// A remembered state refers to a text that may no longer exist as it was: `matchingFor` clamps it to the length (positions past the end
// fall back to the end, folds outside are dropped). Unreadable is null, never "empty". Tested by EXECUTION in web/test/editor-groups.test.mjs.

/** `top`: the first visible position, `margin`: by how many px the view starts above its line (CodeMirror `scrollSnapshot`: yMargin). */
export type ViewStatus = { selection: { anchor: number; header: number }[]; main: number; top: number; margin: number; folds: [number, number][] };

const count = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pos = (x: unknown): x is number => count(x) && Number.isInteger(x) && x >= 0;

/** A state from unchecked data (localStorage) — null if it is not readable. */
export function stateFrom(raw: unknown): ViewStatus | null {
  const o = raw as Partial<Record<keyof ViewStatus, unknown>> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.selection) || !o.selection.length || !pos(o.main) || !pos(o.top) || !count(o.margin)) return null;
  const selection: ViewStatus["selection"] = [];
  for (const r of o.selection as unknown[]) {
    const x = r as { anchor?: unknown; header?: unknown } | null;
    if (!x || !pos(x.anchor) || !pos(x.header)) return null;
    selection.push({ anchor: x.anchor, header: x.header });
  }
  if (o.main >= selection.length) return null;
  const folds: [number, number][] = [];
  for (const f of Array.isArray(o.folds) ? (o.folds as unknown[]) : []) {
    if (Array.isArray(f) && f.length === 2 && pos(f[0]) && pos(f[1]) && f[0] < f[1]) folds.push([f[0], f[1]]);
  }
  return { selection, main: o.main, top: o.top, margin: o.margin, folds };
}

/** The state for a text of length `length`: positions clamped, folds past the end dropped. */
export function matchingFor(st: ViewStatus, length: number): ViewStatus {
  const k = (n: number) => Math.min(Math.max(0, n), length);
  return {
    selection: st.selection.map((r) => ({ anchor: k(r.anchor), header: k(r.header) })),
    main: Math.min(st.main, st.selection.length - 1),
    top: k(st.top),
    margin: st.margin,
    folds: st.folds.filter(([a, b]) => b <= length && a < b),
  };
}

/** The remembered states of ONE target: per group, per file (buffer key) — at most `CAP` per group, the most recently remembered stay
 *  (VS Code likewise remembers only a limited number). */
export type ViewStatuses = Record<string, Record<string, ViewStatus>>;
export const CAP = 40;
export function rememberStatus(all: ViewStatuses, group: string, file: string, st: ViewStatus): ViewStatuses {
  const old = all[group] ?? {};
  const { [file]: _dropped, ...rest } = old;
  const entries = Object.entries(rest);
  const keep = entries.slice(Math.max(0, entries.length - (CAP - 1)));
  return { ...all, [group]: { ...Object.fromEntries(keep), [file]: st } };
}
/** Only the groups that still exist (a closed group takes its states with it — VS Code likewise). */
export function onlyGroups(all: ViewStatuses, groups: readonly string[]): ViewStatuses {
  const out: ViewStatuses = {};
  for (const g of groups) if (all[g]) out[g] = all[g];
  return out;
}
/** From storage (version 1) — unreadable entries are dropped individually. */
export function statusesFrom(text: string | null | undefined): ViewStatuses {
  if (!text) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return {}; }
  const o = raw as { v?: unknown; g?: unknown } | null;
  if (!o || o.v !== 1 || !o.g || typeof o.g !== "object") return {};
  const out: ViewStatuses = {};
  for (const [g, files] of Object.entries(o.g as Record<string, unknown>)) {
    if (!files || typeof files !== "object") continue;
    for (const [d, st] of Object.entries(files as Record<string, unknown>)) {
      const s = stateFrom(st);
      if (s) (out[g] ??= {})[d] = s;
    }
  }
  return out;
}
export const statusesText = (all: ViewStatuses): string => JSON.stringify({ v: 1, g: all });

/** The remembered keys (groups and states, each `apiBase|instance`) of copies of a target that no longer exist — `copies`
 *  is the LOADED list (an unloaded one must delete nothing: empty is not unknown). The main instance (empty identifier) stays. */
export const REMEMBERED_PREFIXES = ["cbase-code-groups:", "cbase-code-views:"] as const;
export function orphanedKey(key: readonly string[], apiBase: string, copies: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const k of key) {
    const p = REMEMBERED_PREFIXES.find((x) => k.startsWith(`${x}${apiBase}|`));
    if (!p) continue;
    const identifier = k.slice(p.length + apiBase.length + 1);
    if (identifier !== "" && !copies.has(identifier)) out.push(k);
  }
  return out;
}
