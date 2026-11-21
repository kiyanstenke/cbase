// The pure calculations of the agenda bar ("Agenda" section of the right chat bar,
// components/chat/AgendaPanel.tsx): which rows of the tree are visible and at which stage, collapsing
// and its memo, progress, what "empty" means, which revision wins when a load response and an event
// cross, and the "updated … ago" time text. No React, no DOM — web/test/agenda.test.mjs compiles this
// file with tsc and runs it; the Swift twin is mobile/CbaseMobile/Chat/Agenda.swift, bound to this
// version in web/test/agenda-binding.test.mjs. The shape of the data (types, `normAgenda`) lives in the
// leaf `lib/api/agenda.ts`.
//
// It is a tree: the groups In progress · Open · Done are gone — the tree in its own order is the view,
// fully finished subtrees start collapsed. The UI shows as little text as possible, headings only.
import { normAgenda, type Agenda, type AgendaUpkeep, type AgendaUpkeepAfterwards, type AgendaStep, type AgendaStatus } from "./api/agenda.js";

/** The bar indents no deeper: level 4 and deeper sit at stage 3 (the bar is only 280 px wide). */
export const AGENDA_STAGES = 3;

/** The memo of collapsing per device and chat — ONLY the deviations from the default ({id: open}). */
export type AgendaDeviations = Record<string, boolean>;

/** Under this key (localStorage; iOS UserDefaults, same wording) lie a chat's deviations. */
export const foldKey = (chatId: string): string => `cbase-agenda-fold:${chatId}`;

export interface AgendaRow {
  point: AgendaStep;
  /** Indentation: min(depth, AGENDA_STAGES). */
  stage: number;
  /** Expanded — only a point with sub-points can be; a leaf is never "open". */
  open: boolean;
}

/** The default of collapsing: a point with sub-points stands open as long as its (computed) status is not "done". */
export function foldDefault(p: AgendaStep): boolean {
  return p.status !== "done";
}

/**
 * The visible rows in agenda order (pre-order). A point is invisible if its parent is collapsed or
 * itself invisible — so the whole subtree of a collapsed point is missing. Reading goes via `parent`
 * (in pre-order the parent always comes first), not via depth: an unknown parent hides nothing. A
 * deviation beats the default; on a leaf it means nothing.
 */
export function visibleRows(steps: readonly AgendaStep[], deviations: AgendaDeviations): AgendaRow[] {
  const hidden = new Set<string>();
  const rows: AgendaRow[] = [];
  for (const p of steps) {
    if (p.parent !== null && hidden.has(p.parent)) { hidden.add(p.id); continue; }
    const deviation = deviations[p.id];
    const open = p.subitems > 0 && (typeof deviation === "boolean" ? deviation : foldDefault(p));
    if (p.subitems > 0 && !open) hidden.add(p.id);
    rows.push({ point: p, stage: Math.min(p.depth, AGENDA_STAGES), open });
  }
  return rows;
}

/**
 * The memo after a click on a row's arrow: only what deviates from the default is remembered — whoever
 * collapses a point back to the default deletes its entry. Entries of points that no longer exist drop
 * out (ids are never reused, so they would only be ballast). On a leaf nothing changes.
 */
export function toggleFold(deviations: AgendaDeviations, row: AgendaRow, steps: readonly AgendaStep[]): AgendaDeviations {
  if (row.point.subitems === 0) return deviations;
  const present = new Set(steps.map((s) => s.id));
  const fresh: AgendaDeviations = {};
  for (const [id, open] of Object.entries(deviations)) if (id !== row.point.id && present.has(id)) fresh[id] = open;
  const open = !row.open;
  if (open !== foldDefault(row.point)) fresh[row.point.id] = open;
  return fresh;
}

/** The memo from storage: only a JSON object of booleans counts; anything else (missing, broken, foreign shape) is
 *  the default — a read error must not collapse the agenda. */
export function readDeviations(raw: string | null | undefined): AgendaDeviations {
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AgendaDeviations = {};
  for (const [id, open] of Object.entries(value as Record<string, unknown>)) {
    if (id && id !== "__proto__" && typeof open === "boolean") out[id] = open;
  }
  return out;
}

/** Progress of the whole agenda: only leaves are counted (as the server's counter does) — a parent is not a step. */
export function agendaProgress(a: Agenda | null): { done: number; total: number } {
  let done = 0, total = 0;
  for (const s of a?.steps ?? []) {
    if (s.subitems > 0) continue;
    total += 1;
    if (s.status === "done") done += 1;
  }
  return { done, total };
}

/** Is a LEAF in progress? (The dot on the header button on iOS.) A parent is already "in progress" when one of its leaves
 *  is done — it would otherwise say "work is going on" where it is only half finished. */
export function agendaInWork(a: Agenda | null): boolean {
  return (a?.steps ?? []).some((s) => s.subitems === 0 && s.status === "in_work");
}

/** Empty: no title, no description, no step (whitespace alone does not count) — then the bar shows the empty state. */
export function agendaEmpty(a: Agenda | null): boolean {
  return !a || (!a.title.trim() && !a.description.trim() && a.steps.length === 0);
}

/**
 * Which revision wins: the one with the higher version. A load response and an event cross — a load that
 * started BEFORE a change arrives after its event and would carry the old state back. Same version: the
 * existing one stays (no redraw). A revision of ANOTHER chat never applies (the chat was switched, the
 * response is late).
 */
export function effectiveAgenda(old: Agenda | null, fresh: Agenda | null, chatId: string): Agenda | null {
  if (!fresh || fresh.chatId !== chatId) return old && old.chatId === chatId ? old : null;
  if (!old || old.chatId !== chatId) return fresh;
  return fresh.version > old.version ? fresh : old;
}

/** The agenda from an event of the chat stream — only `harness/agenda` of this chat, otherwise null. */
export function agendaFromEvent(evt: Record<string, unknown> | null | undefined, chatId: string): Agenda | null {
  if (!evt || evt.type !== "harness" || evt.subtype !== "agenda") return null;
  if (typeof evt.chatId !== "string" || evt.chatId !== chatId) return null;
  return normAgenda(evt.agenda, chatId);
}

/** "updated … ago" — a key for t() and the number for it. Under a minute "just now"; a clock that runs slow
 *  (timestamp in the future) is also "just now" and never "−3 min ago". */
export function sinceText(ms: number | null, now: number): { key: string; n: number } | null {
  if (!ms) return null;
  const min = Math.floor(Math.max(0, now - ms) / 60_000);
  if (min < 1) return { key: "just now", n: 0 };
  if (min < 60) return { key: "{n} min ago", n: min };
  const std = Math.floor(min / 60);
  if (std < 24) return { key: "{n} h ago", n: std };
  const days = Math.floor(std / 24);
  return { key: days === 1 ? "1 day ago" : "{n} days ago", n: days };
}

/** The word of a status as a key for t() — the same words as the bar (`sr-only` before each point). */
export const STATUS_WORD: Record<AgendaStatus, string> = { open: "Open##state", in_work: "In progress", done: "Done" };

/** What happened after the mark, as a key — `open` and unknown (`null`) say nothing about it. The same words in iOS
 *  (`Chat/Agenda.swift`, bound in web/test/agenda-binding.test.mjs). */
export const UPKEEP_AFTERWARDS_WORD: Record<AgendaUpkeepAfterwards, string | null> = {
  open: null,
  confirmed: "edited by the main agent afterwards",
  corrected: "taken back by the main agent afterwards",
  outdated: "taken over by the main agent afterwards",
};

/** The explanation behind the agenda keeper's mark: “Added by the agenda keeper · 4 min ago” or “Set by the agenda keeper ·
 *  before: In progress · 4 min ago”, with what happened afterwards (the ring stays): “… · 4 min ago · taken back by the main
 *  agent afterwards”. Everything as keys — translated in the caller (`prior` is itself a key from `STATUS_WORD`); the time
 *  via `sinceText`, none without a timestamp. */
export function upkeepExplanation(p: AgendaUpkeep, now: number): {
  key: string;
  prior: string | null;
  since: { key: string; n: number } | null;
  afterwards: string | null;
} {
  const prior = p.kind === "status" && p.prior ? STATUS_WORD[p.prior] : null;
  const key = p.kind === "fresh"
    ? "Added by the agenda keeper"
    : prior ? "Set by the agenda keeper · before: {prior}" : "Set by the agenda keeper";
  return { key, prior, since: sinceText(p.at || null, now), afterwards: p.afterwards ? UPKEEP_AFTERWARDS_WORD[p.afterwards] : null };
}
