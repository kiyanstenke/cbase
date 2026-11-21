// The state of the language service per file in the window: language, state, capabilities, version, last error, interpreter. Read via
// `status { file }` (starts NOTHING) and read fresh on every event `lsp/status` that concerns the target — also after a call that starts
// the server (`diagnostics`) as long as it does not report `ready` (so the state arrives even if an event is missing). Who reads: the
// status line (components/code/LspStatusLine.tsx), the context menu and every extension that runs only where the server reports the
// capability (execution side = description side).
//
// Empty is not unknown: `loaded: false` means "not yet read" — the capabilities are then empty, but not "none"; the status line says
// nothing instead of guessing "off".
import { useCallback, useSyncExternalStore } from "react";
import { subscribeGlobalEvents } from "./api/events.js";
import {
  LSP_DIAGNOSTIC_EVENT, LSP_SEMANTICS_EVENT, LSP_STATUS_EVENT, isNotSupported, lspEventAffects, lspCalls, lspLanguageOf,
  type LspCapability, type LspNotSupported, type LspLanguage, type LspLanguageStatus, type LspTarget,
} from "./api/lsp.js";

export type LspStatusState = Readonly<{
  loaded: boolean;
  /** The language of the file (from the extension) — null: no server for this file. */
  language: LspLanguage | null;
  status: LspLanguageStatus | null;
  /** The server says: this file has no service (e.g. `no_project` at workspace level). */
  not: LspNotSupported | null;
  error: string | null;
  features: ReadonlySet<LspCapability>;
}>;

const EMPTY_FEATURES: ReadonlySet<LspCapability> = new Set();
const WITHOUT: LspStatusState = { loaded: false, language: null, status: null, not: null, error: null, features: EMPTY_FEATURES };
type Entry = { target: LspTarget; path: string; status: LspStatusState; subscribers: Set<() => void>; running: Promise<void> | null; again: boolean };
const ENTRIES = new Map<string, Entry>();
const key = (target: LspTarget, path: string) => JSON.stringify([target.apiBase, target.instance ?? "", path]);
let eventOff: (() => void) | null = null;
let eventTick: ReturnType<typeof setTimeout> | null = null;
const affected = new Set<string>();

function entry(target: LspTarget, path: string): Entry {
  const k = key(target, path);
  let e = ENTRIES.get(k);
  if (!e) {
    const sp = lspLanguageOf(path)?.language ?? null;
    e = { target: { apiBase: target.apiBase, instance: target.instance ?? null }, path, status: { ...WITHOUT, language: sp, loaded: sp === null }, subscribers: new Set(), running: null, again: false };
    ENTRIES.set(k, e);
  }
  return e;
}
function set(e: Entry, part: Partial<LspStatusState>) {
  e.status = { ...e.status, ...part };
  for (const fn of [...e.subscribers]) fn();
}
async function read(e: Entry): Promise<void> {
  if (!e.status.language) return;
  if (e.running) { e.again = true; return e.running; }
  e.running = (async () => {
    do {
      e.again = false;
      try {
        const r = await lspCalls(e.target, "status", { file: e.path });
        if (isNotSupported(r)) { set(e, { loaded: true, status: null, not: r, error: null, features: EMPTY_FEATURES }); continue; }
        const s = (r.languages ?? []).find((x) => x.language === e.status.language) ?? r.languages?.[0] ?? null;
        set(e, { loaded: true, status: s, not: null, error: null, features: new Set(s?.features ?? []) });
      } catch (err) {
        set(e, { loaded: true, status: null, not: null, error: String((err as Error)?.message ?? err), features: EMPTY_FEATURES });
      }
    } while (e.again);
  })().finally(() => { e.running = null; });
  return e.running;
}

function listenEvents() {
  if (eventOff) return;
  eventOff = subscribeGlobalEvents((evt) => {
    if (evt?.type !== LSP_STATUS_EVENT) return;
    for (const [k, e] of ENTRIES) if (e.subscribers.size && lspEventAffects(evt, e.target)) affected.add(k);
    if (!affected.size || eventTick) return;
    eventTick = setTimeout(() => { // batched: a restart reports several changes in quick succession
      eventTick = null;
      for (const k of [...affected]) { const e = ENTRIES.get(k); if (e) void read(e); }
      affected.clear();
    }, 120);
  });
}
function checkEvents() {
  for (const e of ENTRIES.values()) if (e.subscribers.size) return;
  eventOff?.();
  eventOff = null;
}

/** The state now (synchronous, for extensions and menu). */
export function lspStatusOf(target: LspTarget, path: string): LspStatusState {
  return ENTRIES.get(key(target, path))?.status ?? { ...WITHOUT, language: lspLanguageOf(path)?.language ?? null, loaded: !lspLanguageOf(path) };
}
/** Subscribe: the first subscriber reads, and as long as one is there, the state follows the events. */
export function subscribeLspStatus(target: LspTarget, path: string, fn: () => void): () => void {
  const e = entry(target, path);
  const first = e.subscribers.size === 0;
  e.subscribers.add(fn);
  listenEvents();
  // Without subscribers the state followed no event — the first new one reads fresh (the entry stays, its last state holds until then).
  if (first && e.status.language) void read(e);
  return () => {
    e.subscribers.delete(fn);
    checkEvents();
  };
}
/** Read again (after restart/stop; after a call that can start the server, as long as it is not `ready`). */
export function refreshLspStatus(target: LspTarget, path: string, o: { onlyIfNotReady?: boolean } = {}): Promise<void> {
  const e = ENTRIES.get(key(target, path));
  if (!e) return Promise.resolve();
  if (o.onlyIfNotReady && e.status.status?.state === "ready") return Promise.resolve();
  return read(e);
}
/** `lsp/semantic_refresh` (like vscode-languageclient): the server of this language wants new semantic tokens — `fn` for every view
 *  concerned (components/code/lsp-semantics.ts). The same check of project and instance as for the status. */
export function subscribeSemanticsRefresh(target: LspTarget, language: LspLanguage, fn: () => void): () => void {
  return subscribeGlobalEvents((evt) => {
    if (evt?.language === language && lspEventAffects(evt, target, LSP_SEMANTICS_EVENT)) fn();
  });
}
/** `lsp/diagnostic_refresh`: the diagnostics of the server of this language must be asked again (restart after the language switch,
 *  `workspace/diagnostic/refresh`) — `fn` for every view concerned (components/code/lsp-diagnostics.ts). `language` null: every language
 *  of the target (the problems list, components/code/layout-problems.ts). */
export function subscribeDiagnosticRefresh(target: LspTarget, language: LspLanguage | null, fn: () => void): () => void {
  return subscribeGlobalEvents((evt) => {
    if ((language === null || evt?.language === language) && lspEventAffects(evt, target, LSP_DIAGNOSTIC_EVENT)) fn();
  });
}
/** The capabilities of a file now — empty as long as nothing is read or the server is not running. */
export const lspFeatures = (target: LspTarget, path: string): ReadonlySet<LspCapability> => lspStatusOf(target, path).features;

/** React: the state of a file (null = no file). */
export function useLspStatus(target: LspTarget | null, path: string | null): LspStatusState | null {
  const k = target && path ? key(target, path) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subscription = useCallback((fn: () => void) => (target && path ? subscribeLspStatus(target, path, fn) : () => {}), [k]);
  const read = useCallback(() => (k ? ENTRIES.get(k)?.status ?? null : null), [k]);
  return useSyncExternalStore(subscription, read, () => null);
}
