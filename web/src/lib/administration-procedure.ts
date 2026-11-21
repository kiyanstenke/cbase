// Two calculations of the Settings → Administration page (components/settings/AdministrationSettings.tsx;
// iOS Settings/AdministrationSettings.swift and Models/AdministrationModels.swift
// `AdministrationProcedure`). A leaf module without imports; guard
// web/test/administration-proofread.test.mjs (runs this file and pins web and iOS to it).
//
// (1) THE DRAFT PER USER. A draft must arise only from an input: merely expanding a row used to
// create a draft (= the saved state), and save/discard reset it to a fixed value. An UNCHANGED draft
// then masked every newer saved state (a second admin, a second device): the row showed the old one,
// and whoever changed a field afterwards and saved wrote the other two fields' foreign values back.
// So: a draft arises only from an input, an input that arrives back at the saved state removes it, and
// save (success) and discard DELETE it — otherwise the current saved state is always what is shown.
//
// (2) AN ACTION WITHOUT AN ANSWER. Restart, start, stop, limits and delete can take longer than a
// deadline on the way: on the web the tunnel (Cloudflare answers after ~100 s with 524 and an HTML
// page), on iOS also the URLSession deadline. The gateway keeps working. Showing "failed" on the row
// and dropping the busy marker would let a second press on "Restart" start the container a second
// time. So: "still running", the marker stays, the page reloads every `RELOAD_MS` until the state
// shows that the action arrived (`arrived`), for at most `gracePeriodMs(what)`.

export type Values = { ramGiB: number; cpuPrio: string; cpuMax: number | null };
export type Drafts<R extends Values> = Readonly<Record<string, R>>;

export const sameValues = (a: Values | null, b: Values | null): boolean =>
  !!a && !!b && a.ramGiB === b.ramGiB && a.cpuPrio === b.cpuPrio && a.cpuMax === b.cpuMax;

function without<R extends Values>(drafts: Drafts<R>, id: string): Drafts<R> {
  if (!(id in drafts)) return drafts;
  const rest: Record<string, R> = { ...drafts };
  delete rest[id];
  return rest;
}

/** After an input: the new draft — or NONE if the input is back at the saved state. */
export function draftAfterInput<R extends Values>(drafts: Drafts<R>, id: string, fresh: R, saved: R | null): Drafts<R> {
  return sameValues(fresh, saved) ? without(drafts, id) : { ...drafts, [id]: fresh };
}

/** After save (success) or discard: the draft drops. `onlyIf`: only this one — an input DURING saving stays. */
export function draftGone<R extends Values>(drafts: Drafts<R>, id: string, onlyIf?: R): Drafts<R> {
  if (onlyIf !== undefined && drafts[id] !== onlyIf) return drafts;
  return without(drafts, id);
}

/** What the editor shows: the draft, otherwise the CURRENT saved state. */
export const displayedStatus = <R extends Values>(drafts: Drafts<R>, id: string, saved: R | null): R | null =>
  drafts[id] ?? saved;

/** How often to reload while an action says "still running". */
export const RELOAD_MS = 5_000;
/** How long to keep checking after the answer fails to appear — the same deadlines iOS gives its requests. */
export function gracePeriodMs(what: string): number {
  return what === "erase" ? 300_000 : 180_000;
}

/** May the action still be in progress? 524: the tunnel gave up (`api()` attaches the status to the error as `httpStatus`). */
export function runningStill(e: unknown): boolean {
  return (e as { httpStatus?: unknown } | null)?.httpStatus === 524;
}

/** The part of an administration user from which one can tell whether an action arrived. */
export type StatusForProcedure = {
  container: { state: string | null; since: string | null };
  resources: Values | null;
  deviating: boolean;
};

/**
 * Does the loaded state show that the action arrived? `now` `null` = the user is no longer in the
 * list. `prior` is the state at the press (for restart: a new start time), `target` the limits sent
 * (only "save").
 */
export function arrived(what: string, prior: StatusForProcedure | null, now: StatusForProcedure | null, target: Values | null): boolean {
  switch (what) {
    case "erase": return now === null;
    case "start": return now?.container.state === "running";
    case "restart": return now?.container.state === "running" && now.container.since !== (prior?.container.since ?? null);
    case "stop": return !!now && now.container.state !== null && now.container.state !== "running";
    case "save": return !!now && sameValues(now.resources, target) && !now.deviating;
    default: return true;
  }
}
