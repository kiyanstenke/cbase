// The coordinates of a view: ONE buffer per file in the window, also across LEVELS. The same file opened in Coding → Files at workspace
// level (`/api/workspaces/<wid>`, path relative to the workspace folder: `orbit-2/frontend/x.tsx`) and as a code tab of a project chat
// (`/api/projects/<pid>`, path relative to the project folder: `frontend/x.tsx`) is ONE buffer: typing, the “unsaved” dot, saving, the
// language service's `buffer`/`version` and rename are the same in both places.
//
// THE CUT: the buffer (lib/buffer.ts) speaks only CANONICALLY. If a file lies in the folder of a project of the workspace, its identity
// is (project, main, path relative to the project); otherwise (a workspace-level file without a project, a target outside every
// instance) it stays what the view says. Loading, saving (`basis`/409), `checkBack`, the language service (lib/api/lsp.ts), WorkspaceEdits
// (lib/lsp-change.ts), peek and line preview thus speak only canonically, and their results (locations, files) are relative to the
// target of the asking buffer. ONLY the edge of a view speaks its own coordinates: tree, tabs, path line, opening from tree or search, a
// hit as a tab, and history (components/code/navigation-connection.tsx). The mapping in between is `Coordinates`: ONE per view, computed
// here and nowhere else: at workspace level the folder of the project (the same rule as the server, lib/commandPalette.ts
// `projectOfTheFile`: the longest path wins), at project level the identity, except for a deeper project (see “Nested”). The instance of
// a workspace-level file is always the main one (the server assigns it the same way, devtools/code-route.js `lspTargetFor`); a copy stays
// its own buffer, and its view is always the identity.
//
// SAME PATHS: comparison uses the server's form (`path.resolve`). Workspace and project folders are normalized when the card is built,
// relative paths in `toCanon`/`ofCanon` (lib/commandPalette.ts `normPath`): `a//b`, `a/./b` and a trailing slash are no second buffer.
// LIMIT: the web does not resolve symlinks; a file reached over two symlink paths stays two buffers, and `basis`/409 still protects
// between them (as between two windows).
//
// EMPTY IS NOT UNKNOWN: while the workspace's projects are not read, the workspace-level mapping is `ready: false`; `toCanon` returns
// null and nobody creates a buffer (it would be a second one once the list arrives); the tabs wait (with the read error, if there was
// one). Project level does not wait: without a card it is the identity, and when the card arrives its buffers relocate (see below).
//
// THE LIST: ONE loader reads `/api/workspaces` (`loadCards`, plus the page itself, app/workspaces/page.tsx). Every read first takes a
// number (`beginReading`), and an older answer arriving after a younger one does not count (otherwise it would restore the old card
// and the buffers would move back). If reading fails, the error stands (`cardsError`) and it is read again at growing intervals
// (`repeatGap`, capped at 30 s) as long as a view is looking; also on focus and on stream events that report a new layout of the
// projects (`cardsStale`; the server does NOT report deleting or moving a project, only the next focus sees that).
//
// WHEN THE LIST CHANGES (a project created, deleted, nested): open buffers lose no text, they RELOCATE (`relocate`, via lib/buffer.ts
// `renameBuffer` with a new target), computed at the file's absolute location: a workspace-level one whose file now lies in a project
// becomes the project's; one of a project that no longer exists becomes that of the next project above or of the workspace level; one
// of a project that stays, stays (its identity does not hang on its folder), unless its file now belongs to a deeper project. If the new
// target already has a buffer (a chat opened the file before the list arrived), the old one merges into it (lib/buffer.ts supersede):
// its unsaved text becomes the new one's if that stands clean on the same disk; if both carry their own, the old one stays visible
// (⌥⌘S, and the tab holding it keeps it, `tabBufferFor`), never silently discarded.
//
// NESTED (the server does not forbid a project inside another's folder): the file belongs to the INNERMOST project, at workspace level
// as in the outer project's view (only in the main; a copy stays separate). Checked on the server: in the main both project routes read
// and write in B under `proj.path` (devtools/routes.js → code-route.js `readProjectFile`; the `fileLimit` boundary of the respective
// instance contains the inner folder), so the same file on the same disk; only the language server changes: the inner project's
// answers, as at workspace level. ANOTHER project with an equally long folder takes nothing over (the view stays its own project).
//
// A leaf module except for buffer.ts, the server's rule, api/core and (for the root names) the leaf chat-tabs.ts;
// web/test/buffer-coordinates.test.mjs runs it together with buffers, language service and WorkspaceEdit, with counter-checks.
import { api } from "./api/core.js";
import { allBuffers, findBuffer, sameTarget, buffer, bufferKey, renameBuffer, type Buffer, type BufferTarget, type Transport } from "./buffer.js";
import { normPath, projectOfTheFile } from "./commandPalette.js";
import { copyOf, targetIdentifier } from "./chat-tabs.js";

/** The identity of a file: target and path, as the buffer carries them. */
export type CanonLocation = { target: BufferTarget; path: string };
/** The projects of a workspace as `/api/workspaces` names them: its folder and per project its folder (absolute, as the server sees them). */
export type WorkspaceCard = { readonly wsPath: string; readonly projects: readonly { readonly id: string; readonly path: string }[] };
/** A workspace row of `/api/workspaces` (only what the mapping needs; the names are for `rootName`). */
export type WorkspaceRow = { id: string; path: string; name?: string; projects?: readonly { id: string; path: string; name?: string }[] | null };

export interface Coordinates {
  /** The view's target: the route of its tree and file operations. */
  readonly target: BufferTarget;
  /** false: the workspace's projects are not read yet; `toCanon` then returns null. */
  readonly ready: boolean;
  /** Changes when the mapping changes (for hook dependencies). */
  readonly state: string;
  /** A path of the view → the identity of its file; null: not known yet (create NOTHING). */
  toCanon(path: string): CanonLocation | null;
  /** An identity → the path in this view; null: the file does not lie here (other project, other instance, outside). */
  ofCanon(target: BufferTarget, path: string): string | null;
}

const WS = /^\/api\/workspaces\/([^/?#]+)$/;
const PROJ = /^\/api\/projects\/([^/?#]+)$/;
/** The workspace identifier of a workspace-level view; null at project level (and with an instance). */
export const workspaceOf = (z: BufferTarget): string | null => (z.instance ? null : WS.exec(z.apiBase)?.[1] ?? null);
/** The project of a project-level view in the main; null at workspace level and in a copy. */
export const projectOf = (z: BufferTarget): string | null => (z.instance ? null : PROJ.exec(z.apiBase)?.[1] ?? null);
/** The canonical target of a project (main), the same form as CodeArea.tsx and lib/chat-tabs.ts `chatTarget`. */
export const projectTarget = (id: string): BufferTarget => ({ apiBase: `/api/projects/${id}`, instance: null });
/** A target outside every instance names an absolute path: it is the same in every view and has no canonical form. */
const absolute = (path: string) => path.startsWith("/");
/** `abs` relative to `root` (both normalized); null: does not lie below it. */
const under = (root: string, abs: string): string | null => (abs === root ? "" : root !== "/" && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null);
const connection = (root: string, rel: string) => normPath(`${root}/${rel}`);
/** The card in the server's form. */
const normCard = (k: WorkspaceCard): WorkspaceCard => ({ wsPath: normPath(k.wsPath), projects: k.projects.map((p) => ({ id: p.id, path: normPath(p.path) })) });
/** The innermost project of the card above an absolute location (lib/commandPalette.ts `projectOfTheFile` with an empty root: `abs` is absolute). */
const projectAt = (k: WorkspaceCard, abs: string) => projectOfTheFile("", k.projects, abs);

/** The mapping of a view: workspace level via the card (not ready without a card); project level in the main the identity, except for a
 *  file of a deeper project of the card; a copy the identity. Relative paths normalized. */
export function coordinatesFrom(target: BufferTarget, cardRaw: WorkspaceCard | null | undefined, state = ""): Coordinates {
  const z: BufferTarget = { apiBase: target.apiBase, instance: target.instance ?? null };
  const own = (k: BufferTarget, path: string) => (sameTarget(k, z) ? path : null);
  const identity = (ready: boolean): Coordinates => ({
    target: z, ready, state, ofCanon: own,
    toCanon: ready ? (path) => ({ target: z, path: absolute(path) ? path : normPath(path) }) : () => null,
  });
  const wid = workspaceOf(z), pid = projectOf(z);
  const card = cardRaw ? normCard(cardRaw) : null;
  // The view's root in the card and from which length a project folder counts as “deeper” (workspace level: every project).
  const root = !card ? null : wid ? card.wsPath : card.projects.find((x) => x.id === pid)?.path ?? null;
  if (!wid && !pid) return identity(true);
  if (!card || root === null) return identity(!wid); // workspace level waits for the card; a project without a card is the identity
  const deeper = wid ? -1 : root.length;
  return {
    target: z, ready: true, state,
    toCanon(path) {
      if (absolute(path)) return { target: z, path };
      const rel = normPath(path), abs = connection(root, rel);
      if (under(root, abs) === null) return { target: z, path: rel }; // leads outside: the server rejects it, nothing is mapped
      const p = projectAt(card, abs);
      const r = p && p.path.length > deeper ? under(p.path, abs) : null;
      return p && r !== null ? { target: projectTarget(p.id), path: r } : { target: z, path: rel };
    },
    ofCanon(k, path) {
      if (sameTarget(k, z)) return path;
      if (absolute(path)) return null;
      const p = card.projects.find((x) => sameTarget(projectTarget(x.id), k)); // only the main; a copy lies in no view of the main
      return p ? under(root, connection(p.path, path)) : null;
    },
  };
}

/** A path from a language-service result or a buffer (relative to `target`) as a path of the view; a target outside every instance
 *  (absolute) stays as it is. null: it does not lie in this view. */
export const inView = (k: Coordinates, target: BufferTarget, path: string): string | null => (absolute(path) ? path : k.ofCanon(target, path));
/** The buffer key for a path of the view (lib/buffer.ts `bufferKey`); null: not known yet. */
export function keyInView(k: Coordinates, path: string): string | null {
  const o = k.toCanon(path);
  return o ? bufferKey(o.target, o.path) : null;
}
/** The buffer of a file of the view, created if the window has none; null: the mapping is not known yet. */
export function bufferFor(k: Coordinates, path: string): Buffer | null {
  const o = k.toCanon(path);
  return o ? buffer(o.target, o.path) : null;
}
/** The buffer of a file of the view, if there is one. */
export function findInView(k: Coordinates, path: string): Buffer | null {
  const o = k.toCanon(path);
  return o ? findBuffer(o.target, o.path) : null;
}

/** Does a tab switch from `old` to the canonical `c` without unsaved text leaving sight? Only to a loaded one, and `old` carries nothing
 *  of its own, or its text already stands in `c` (lib/buffer.ts supersede). */
const switches = (old: Buffer, c: Buffer): boolean => c.status.state === "loaded" && (!old.dirty || (old.superseded === c && old.text === c.text));
/** The buffer a tab of the view should hold for `path`. Principle: the canonical one. `held` (what the tab holds): it stays as long as
 *  a switch would take unsaved text out of sight (if the mapping changes, the tab would otherwise hold a second buffer of the same
 *  file). Without `held` (the tab reaches for it): the canonical one is created if it does not exist, unless a superseded one still lies
 *  there with its own text for exactly this path; that one shows until it is saved or discarded. null: the mapping is not known yet. */
export function tabBufferFor(k: Coordinates, path: string, held: Buffer | null = null): Buffer | null {
  if (held) {
    const c = findInView(k, path);
    return c && c !== held && switches(held, c) ? c : held;
  }
  const c = bufferFor(k, path);
  if (!c) return null;
  const stale = allBuffers().find((p) => p !== c && p.superseded === c && p.dirty && inView(k, p.target, p.path) === path) ?? null;
  return stale && !switches(stale, c) ? stale : c;
}

/** A file or folder of the view was renamed (tree, adopted layout): the buffers below it move along, also across a project boundary
 *  (into one, out of one, a project folder itself or one below it). */
export function renameInView(k: Coordinates, old: string, fresh: string): void {
  if (!old || old === fresh) return;
  const a = k.toCanon(old), n = k.toCanon(fresh);
  if (!a || !n) return;
  renameBuffer(a.target, a.path, n.path, n.target);
  // Buffers of OTHER targets whose path in the view lies under `old` (a project folder under the renamed folder), one by one.
  for (const p of allBuffers()) {
    if (sameTarget(p.target, a.target)) continue;
    const pf = k.ofCanon(p.target, p.path);
    if (pf === null || (pf !== old && !pf.startsWith(`${old}/`))) continue;
    const z = k.toCanon(fresh + pf.slice(old.length));
    if (z) renameBuffer(p.target, p.path, z.path, z.target);
  }
}

// ── The window: the cards per workspace ──────────────────────────────────────────────────────────────
const CARDS = new Map<string, { card: WorkspaceCard; seq: number }>();
const LISTENERS = new Set<() => void>();
const BETWEEN = new Map<string, Coordinates>();
let counter = 0;
const sameCard = (a: WorkspaceCard, b: WorkspaceCard): boolean =>
  a.wsPath === b.wsPath && a.projects.length === b.projects.length && a.projects.every((p, i) => p.id === b.projects[i].id && p.path === b.projects[i].path);
const reportListeners = () => { for (const fn of [...LISTENERS]) { try { fn(); } catch { /* one listener does not stop the others */ } } };

let begun = 0, applied = 0;
/** A read of `/api/workspaces` begins: its number goes to `reportWorkspaces`; an older answer arriving after a younger one does not
 *  count. */
export const beginReading = (): number => ++begun;

/** The read list of workspaces (`/api/workspaces`): per workspace the card. If it changes, open buffers relocate (`relocate`). `seq`: the
 *  number of the read (`beginReading` BEFORE the request); if missing, the list counts as the youngest. false: an older read, discarded. */
export function reportWorkspaces(list: readonly WorkspaceRow[] | null | undefined, seq: number = beginReading()): boolean {
  if (seq <= applied) return false; // the answer of an older read arrived after a younger one's: it would restore the old card
  applied = seq;
  let changed = false;
  for (const w of list ?? []) {
    rememberNames(w);
    if (!w || typeof w.id !== "string" || typeof w.path !== "string" || !Array.isArray(w.projects)) continue; // without a list: unknown, not empty
    const projects = w.projects.filter((p) => p && typeof p.id === "string" && typeof p.path === "string" && p.path).map((p) => ({ id: p.id, path: p.path }));
    const fresh = normCard({ wsPath: w.path, projects });
    const old = CARDS.get(w.id);
    if (old && sameCard(old.card, fresh)) continue;
    CARDS.set(w.id, { card: fresh, seq: ++counter });
    relocate(w.id, old?.card ?? null, fresh);
    changed = true;
  }
  if (changed) reportListeners();
  return true;
}
// ── The root names ───────────────────────────────────────────────────────────────────────────────────
// A comparison of two files from two targets names each side's root (lib/chat-tabs.ts `withRoot`, VS Code “{root} • {path}”). The names
// come from the SAME read as the cards: no second way to `/api/workspaces`.
const NAMES = new Map<string, string>();
function rememberNames(w: WorkspaceRow | null | undefined): void {
  if (!w || typeof w.id !== "string") return;
  if (typeof w.name === "string" && w.name) NAMES.set(`/api/workspaces/${w.id}`, w.name);
  for (const p of Array.isArray(w.projects) ? w.projects : []) if (p && typeof p.id === "string" && typeof p.name === "string" && p.name) NAMES.set(`/api/projects/${p.id}`, p.name);
}
/** What a root is called: the name of the project or workspace (a copy with its name in brackets); before the first read the identifier. */
export function rootName(z: BufferTarget): string {
  const n = NAMES.get(z.apiBase);
  if (!n) return targetIdentifier({ apiBase: z.apiBase, instance: z.instance ?? null });
  const k = copyOf({ apiBase: z.apiBase, instance: z.instance ?? null });
  return k ? `${n} (${k})` : n;
}
/** The card of a workspace; null: not read yet. */
export const cardOf =(wid: string | null): WorkspaceCard | null => (wid ? CARDS.get(wid)?.card ?? null : null);
/** The card entry in which a project stands; undefined: no read card knows it. */
const entryWith = (pid: string) => [...CARDS.values()].find((e) => e.card.projects.some((p) => p.id === pid));
/** Does a read card know this project? */
export const cardWithProject = (pid: string | null): boolean => Boolean(pid && entryWith(pid));
/** The mapping for a view by the current card (the same object as long as nothing changes). */
export function coordinatesOf(target: BufferTarget): Coordinates {
  const wid = workspaceOf(target), pid = projectOf(target);
  const e = wid ? CARDS.get(wid) : pid ? entryWith(pid) : undefined;
  const state = e ? String(e.seq) : "";
  const k = JSON.stringify([target.apiBase, target.instance ?? ""]);
  const present = BETWEEN.get(k);
  if (present && present.state === state) return present;
  const fresh = coordinatesFrom(target, e?.card ?? null, state);
  BETWEEN.set(k, fresh);
  return fresh;
}
/** On every change of a card (and of the read error). */
export function subscribeCards(fn: () => void): () => void { LISTENERS.add(fn); return () => { LISTENERS.delete(fn); }; }
/** For tests only: forget all cards, reads and errors. */
export function forgetCards(): void { CARDS.clear(); BETWEEN.clear(); NAMES.clear(); begun = 0; applied = 0; errorText = null; failedAttempts = 0; scheduled = false; running = null; again = false; }

/** The card of a workspace changed: buffers whose identity is then a different one relocate. Computed at the file's absolute location;
 *  a project that stays, under its NEW folder. */
function relocate(wid: string, old: WorkspaceCard | null, fresh: WorkspaceCard): void {
  const wsZ: BufferTarget = { apiBase: `/api/workspaces/${wid}`, instance: null };
  for (const p of allBuffers()) {
    if (!p.open || p.readonly || absolute(p.path) || p.target.instance) continue;
    const own = sameTarget(p.target, wsZ), pid = projectOf(p.target);
    const stays = pid ? fresh.projects.find((x) => x.id === pid) ?? null : null;
    const root = own ? fresh.wsPath : (stays ?? (pid ? old?.projects.find((x) => x.id === pid) : undefined))?.path;
    if (root === undefined) continue; // does not belong to this workspace
    const abs = connection(root, p.path);
    if (under(root, abs) === null) continue; // leads outside: nothing to map
    // The new target: the innermost project; for a project that stays, only a DEEPER one. If the project is gone and no other lies above
    // it, the workspace level (outside the workspace folder the buffer stays where it is; its text is not lost).
    const r = projectAt(fresh, abs);
    const rel = r && (!stays || r.path.length > stays.path.length) ? under(r.path, abs) : null;
    const wsRel = !r || rel === null ? (own || stays ? null : under(fresh.wsPath, abs)) : null;
    const z: CanonLocation | null = r && rel !== null ? { target: projectTarget(r.id), path: rel } : wsRel !== null ? { target: wsZ, path: wsRel } : null;
    if (!z || (sameTarget(z.target, p.target) && z.path === p.path)) continue;
    renameBuffer(p.target, p.path, z.path, z.target);
    // Occupied: a chat already held the file under the new target; the old one merges into it without losing text.
    const t = findBuffer(z.target, z.path);
    if (t && t !== p) p.supersede(t);
  }
}

// ── The loader ─────────────────────────────────────────────────────────────────────────────────────
/** Schedules the re-read; `fn` returns the run it kicks off (the test waits for it instead of the clock). */
type Planner = (fn: () => Promise<void> | undefined, ms: number) => void;
const CLOCK: Planner = (fn, ms) => { setTimeout(() => { void fn(); }, ms); };
let cardsTransport: Transport = api;
let planner: Planner = CLOCK;
/** For tests only: replace the way to the server and the retry clock (null = `api` resp. `setTimeout` again). */
export function setCardsTransport(t: Transport | null, p: Planner | null = null): void { cardsTransport = t ?? api; planner = p ?? CLOCK; }
let running: Promise<void> | null = null, again = false, failedAttempts = 0, scheduled = false;
let errorText: string | null = null;
/** The error of the last read; null: it worked (or never ran). While a view waits, it shows it (components/code/coordinates.ts). */
export const cardsError = (): string | null => errorText;
const REPEAT_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** The gap before the n-th re-read after an error (0-based): growing, capped at 30 s. */
export const repeatGap = (n: number): number => REPEAT_MS[Math.min(Math.max(0, Math.floor(n)), REPEAT_MS.length - 1)];

/** Read `/api/workspaces` and report: ONE run for all views; whoever triggers meanwhile gets one more afterwards (the running one may
 *  have begun before the change that caused the trigger). */
export function loadCards(): Promise<void> {
  if (running) { again = true; return running; }
  const run = (async () => { do { again = false; await onceRead(); } while (again); })().finally(() => { if (running === run) running = null; });
  running = run;
  return run;
}
async function onceRead(): Promise<void> {
  const seq = beginReading();
  try {
    const l = await cardsTransport<unknown>("/api/workspaces");
    if (!Array.isArray(l)) throw new Error("Answer without a list");
    failedAttempts = 0;
    const wasError = errorText !== null;
    errorText = null;
    reportWorkspaces(l as WorkspaceRow[], seq);
    if (wasError) reportListeners();
  } catch (e) {
    const text = String((e as Error)?.message ?? e) || "Error";
    if (text !== errorText) { errorText = text; reportListeners(); }
    planeRepetition();
  }
}
/** Read once more after an error, only while a view is looking (otherwise the next one reads itself), never two retries. */
function planeRepetition(): void {
  if (scheduled || LISTENERS.size === 0) return;
  scheduled = true;
  planner(() => { scheduled = false; return LISTENERS.size ? loadCards() : undefined; }, repeatGap(failedAttempts++));
}

/** Does an event of the global stream report a new layout of the projects (lib/api/events.ts)? An adopted layout, or any `project/*`
 *  event of a project that no read card knows (created since the read; project creation reports `project/setup` right after
 *  creating). Deleting and moving the server does not report. */
export function cardsStale(evt: { type?: unknown; kind?: unknown; projectId?: unknown } | null | undefined): boolean {
  const type = typeof evt?.type === "string" ? evt.type : "";
  if (!type.startsWith("project/")) return false;
  if (type === "project/layout") return evt?.kind === "finished";
  const pid = typeof evt?.projectId === "string" ? evt.projectId : "";
  return Boolean(pid && CARDS.size > 0 && !entryWith(pid));
}
