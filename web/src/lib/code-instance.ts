// The instance choice of the code tab: the tab chooses main or a copy, and files, search, terminal, git and debugger then run in the
// chosen instance. The server can do this through the parameter `instance=<projectId>/<instance>` on every project route of the code view
// (server/backend/electron/server/devtools/routes.js selectedInstance): a removed copy is 404 `UNKNOWN_INSTANCE`, never a fallback to main.
//
// This is the ONE computation for it (web; iOS twin mobile/CbaseMobile/Code/CodeInstance.swift, bound in
// web/test/code-instance-binding.test.mjs):
//   - There is a choice only for a CONVERTED project with at least one copy in state `ready` (source `/api/projects`,
//     `instance.copies[]` with identifier/state). Otherwise no choice: no parameter, everything as before.
//   - Main carries NO parameter (without `instance=` and without a chat the route is main: byte-equal to before); only a copy sets it.
//   - A remembered copy that no longer exists, or is being removed, or failed (`clearAway`, `error`, any other state), falls back
//     VISIBLY to main (with a hint), never silently a main view under the copy label. Likewise in the middle of editing: a 404
//     `UNKNOWN_INSTANCE` for the chosen copy (`afterError`).
//   - A remembered copy that is only NOT READY RIGHT NOW (`TRANSIENT`: create, start, recreate; `start` stands on every converted row
//     after EVERY start of B, projectbox/restore.js) stays chosen and remembered (hint “transient”): no fallback, no rebuild of the
//     editor, and once it is ready again the tab keeps working there. (The tab used to forget the choice after every restart of B and
//     rebuilt the editor together with its unsaved tabs.)
//   - A fallback WITHOUT the human's action does not rebuild the editor while it has unsaved changes (`holdFallback`): the display
//     stays on the old copy with the hint “held” until the changes are gone or the human switches to main. The hint carries its REASON
//     (otherwise it already said “is gone” during removal), and the remembered choice stays while it is held, so the reason follows the
//     list: “being removed”, then “no longer exists”.
//   - A shown fallback hint is kept up to date on every freshly READ list (`hintBySituation`; it used to freeze at the first fallback
//     and keep saying “not ready (clearAway)” after removal): row gone ⇒ “way”, other state ⇒ that one, selectable again ⇒ outdated.
//     A “way” stays until the human dismisses it: the fallback rebuilt the editor with its tabs, and that should stay explained
//     (unlike the apps page, `fallbackOutdated`: there a fallback to a removed copy without a remaining choice silently disappears,
//     because nothing is rebuilt there).
//   - Empty is not unknown: while the project list is not loaded, a remembered copy is NOT decided (`waiting`); otherwise the tab would
//     briefly show main without a label, or forget the choice because “no copy there” would mean what “not read yet” is. If the list
//     did not come (error), a remembered copy falls back to main with the hint “unchecked” and stays remembered.
//
// A leaf module without imports: the test compiles it with tsc and runs it under Node.

export type CopyRow = { identifier?: string; name?: string; chatId?: string; state?: string };
export type InstanceField = { identifier?: string; state?: string; converted?: boolean; copies?: CopyRow[] | null } | null | undefined;
export type InstanceOption = { identifier: string; kind: "main" | "copy"; name: string };
/** A fallback of the copy (the list or the server says: this copy no longer applies); also the reason of a “held”. */
export type CopyFallback =
  | { kind: "gone"; name: string }
  | { kind: "not-ready"; name: string; state: string };
export type FallbackReason = CopyFallback | { kind: "unchecked"; name: string };
export type InstanceHint =
  | FallbackReason
  | { kind: "transient"; name: string; state: string }
  /** `reason`: why the displayed copy no longer applies; `null` if the new choice names none (then the last held one). */
  | { kind: "held"; name: string; reason: FallbackReason | null };
export type ListSituation = "loading" | "error" | "loaded";
export type InstanceChoice = {
  /** The choice's buttons; empty means no choice (not converted or no ready copy). Otherwise main first. */
  options: InstanceOption[];
  /** The identifier of the chosen instance (main's too), `null` without an instance (not converted, or still open). */
  identifier: string | null;
  /** The value for `instance=`: only for a copy, else `null` (no parameter). */
  param: string | null;
  /** The name of the chosen copy (“k1”), else `null`. */
  copy: string | null;
  /** Why the remembered choice does NOT apply; the tab shows it; `null` without a fallback. */
  hint: InstanceHint | null;
  /** Not decidable yet (list loading, a copy is remembered): the editor waits instead of showing main. */
  waiting: boolean;
  /** What stays remembered afterwards: the copy, main (`null`), or the unchecked copy (with “unchecked”). */
  remember: string | null;
};

export const MAIN = "main";
const COPY = /^copy-(.+)$/;
/** The states of a copy that is only TRANSIENTLY not ready (store/project-instances.js PROJECT_WORK_STATES without `relocation`, which
 *  a copy never carries, and without `clearAway`: the copy is going). The choice then stays. */
export const TRANSIENT: readonly string[] = ["create", "start", "recreate"];

/** The key of the remembered choice per project (web: localStorage, iOS: AppState). */
export const rememberKey = (projectId: string): string => `cbase-code-instance:${projectId}`;

/** Project and instance of an identifier “<projectId>/<instance>”; `null` if it is none. */
export function identifierParts(identifier: string | null | undefined): { projectId: string; instance: string } | null {
  const k = String(identifier ?? "");
  const i = k.lastIndexOf("/");
  if (i <= 0 || i === k.length - 1) return null;
  return { projectId: k.slice(0, i), instance: k.slice(i + 1) };
}

/** The name of a copy from its identifier (“<p>/copy-k1” → “k1”), else `null`. */
export function copyNameOf(identifier: string | null | undefined): string | null {
  const t = identifierParts(identifier);
  const m = t ? COPY.exec(t.instance) : null;
  return m ? m[1] : null;
}

/** The buttons: main and every READY copy of the same project, in list order; empty without a choice. `selected`: this copy counts
 *  even if it is only transiently not ready (`TRANSIENT`); the chosen one stays in the bar. */
export function instanceOptions(instance: InstanceField, selected: string | null = null): InstanceOption[] {
  const main = instance?.identifier ? identifierParts(instance.identifier) : null;
  if (!main || main.instance !== MAIN || instance?.converted !== true) return [];
  const copies: InstanceOption[] = [];
  const seen = new Set<string>();
  for (const k of instance.copies ?? []) {
    const identifier = String(k?.identifier ?? "");
    const name = copyNameOf(identifier);
    const counts = k?.state === "ready" || (selected !== null && identifier === selected && TRANSIENT.includes(String(k?.state ?? "")));
    if (!name || identifierParts(identifier)?.projectId !== main.projectId || !counts || seen.has(identifier)) continue;
    seen.add(identifier);
    copies.push({ identifier, kind: "copy", name });
  }
  if (!copies.length) return [];
  return [{ identifier: String(instance.identifier), kind: "main", name: "" }, ...copies];
}

/**
 * The tab's choice for a project: from the instance field of its row in `/api/projects` (`instance`, undefined without conversion), the
 * remembered identifier and the state of the list. Pure: the same input, the same choice.
 */
export function selectInstance(projectId: string, instance: InstanceField, remembered: string | null | undefined, situation: ListSituation): InstanceChoice {
  const pid = String(projectId);
  const g = String(remembered ?? "");
  const gt = identifierParts(g);
  const rememberedCopy = gt && gt.projectId === pid ? copyNameOf(g) : null; // only a copy of THIS project counts
  const main = (hint: InstanceHint | null, remember: string | null = null): InstanceChoice => {
    const options = situation === "loaded" ? instanceOptions(instance) : [];
    const hk = situation === "loaded" && instance?.converted === true && identifierParts(instance.identifier)?.instance === MAIN ? String(instance.identifier) : null;
    return { options, identifier: hk, param: null, copy: null, hint, waiting: false, remember };
  };
  if (situation === "loading") {
    if (rememberedCopy) return { options: [], identifier: null, param: null, copy: null, hint: null, waiting: true, remember: g };
    return main(null);
  }
  if (situation === "error") return rememberedCopy ? main({ kind: "unchecked", name: rememberedCopy }, g) : main(null);
  const options = instanceOptions(instance);
  if (!rememberedCopy) return main(null);
  const hits = options.find((o) => o.kind === "copy" && o.identifier === g);
  if (hits) return { options, identifier: hits.identifier, param: hits.identifier, copy: hits.name, hint: null, waiting: false, remember: hits.identifier };
  const row = (instance?.copies ?? []).find((k) => String(k?.identifier ?? "") === g);
  if (row && instance?.converted === true) {
    const state = String(row.state ?? "");
    // Only not ready right now: the choice stays (parameter, label, remembered), the editor is not rebuilt.
    if (TRANSIENT.includes(state)) {
      return { options: instanceOptions(instance, g), identifier: g, param: g, copy: rememberedCopy, hint: { kind: "transient", name: rememberedCopy, state }, waiting: false, remember: g };
    }
    return main({ kind: "not-ready", name: rememberedCopy, state });
  }
  return main({ kind: "gone", name: rememberedCopy });
}

/**
 * Holds the DISPLAYED copy while the editor has unsaved changes and the choice would change without the human's action (fallback:
 * gone, removed, failed, 404): the editor would otherwise be rebuilt and the changes lost. The display then stays the old choice with
 * the hint “held” (saving no longer works there; the human reads or copies what is needed and switches). `displayed`: what the editor
 * shows right now; a switch the HUMAN chooses asks first and comes with `unsaved` 0 or without `displayed`, so it is never held. Pure.
 */
export function holdFallback(displayed: InstanceChoice | null | undefined, fresh: InstanceChoice, unsaved: number): InstanceChoice {
  if (!displayed?.param || !displayed.copy || !(unsaved > 0) || fresh.param === displayed.param) return fresh;
  // The reason: that of the new choice, else the last held one. A choice WITHOUT a hint (main after a forgotten marker) knows nothing
  // about the copy, and “is no longer there” would be a guess.
  const prior = displayed.hint?.kind === "held" ? displayed.hint.reason : null;
  const h = fresh.hint;
  const reason: FallbackReason | null = h && (h.kind === "gone" || h.kind === "not-ready" || h.kind === "unchecked") ? h : prior;
  return { ...displayed, hint: { kind: "held", name: displayed.copy, reason }, waiting: false };
}

/**
 * A held fallback of the copy, kept up to date on a freshly READ list: the same object if nothing changes (the page then does not
 * re-render). The copy's row gone ⇒ “way”; another state ⇒ that one; selectable again (ready) ⇒ `null`, the hint is outdated (the apps
 * page's rule, `fallbackOutdated` in lib/instance-state.ts, for “not ready”). A “way” stays even if a copy of the same name stands
 * there again: it may come from a 404 while the list still carries the removed copy for one more tick (as there). Shared with the bar
 * (lib/bar-instance.ts `barHintBySituation`). Pure.
 */
export function fallbackBySituation(h: CopyFallback, field: InstanceField): CopyFallback | null {
  if (h.kind === "gone") return h;
  if (instanceOptions(field).some((o) => o.kind === "copy" && o.name === h.name)) return null;
  const row = (field?.copies ?? []).find((k) => copyNameOf(k?.identifier) === h.name);
  if (!row) return { kind: "gone", name: h.name };
  const state = String(row.state ?? "");
  if (state === "ready") return null;
  return state === h.state ? h : { kind: "not-ready", name: h.name, state };
}

/** The code tab's fallback hint kept up to date on the list (`fallbackBySituation`); only on a read list (`situation` “da”) and only
 *  “way”/“not-ready”: “transient” and “unchecked” the choice itself leads, “held” the display. Pure. */
export function hintBySituation(h: InstanceHint | null | undefined, field: InstanceField, situation: ListSituation): InstanceHint | null {
  if (!h) return null;
  if (situation !== "loaded" || (h.kind !== "gone" && h.kind !== "not-ready")) return h;
  return fallbackBySituation(h, field);
}

/**
 * A route error in the middle of editing: if the server names the CHOSEN copy unknown (404 `UNKNOWN_INSTANCE`, removed), that is the
 * visible fallback to main: the new choice with a hint. Any other error (a locked copy 409, network) is none: `null`, the error stays
 * what it is.
 */
export function afterError(choice: InstanceChoice, error: unknown): InstanceChoice | null {
  const o = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (!choice.param || !choice.copy || o.code !== "UNKNOWN_INSTANCE") return null;
  if (typeof o.identifier === "string" && o.identifier !== choice.param) return null;
  const hk = choice.options.find((x) => x.kind === "main")?.identifier ?? null;
  const options = choice.options.filter((x) => x.identifier !== choice.param);
  return { options: options.length > 1 ? options : [], identifier: hk, param: null, copy: null, hint: { kind: "gone", name: choice.copy }, waiting: false, remember: null };
}

/** `url` with `instance=<param>`, only with a copy; otherwise unchanged (main carries no parameter). */
export function instancePath(url: string, param: string | null | undefined): string {
  if (!param) return url;
  const i = url.indexOf("#");
  const [header, anchor] = i >= 0 ? [url.slice(0, i), url.slice(i)] : [url, ""];
  return `${header}${header.includes("?") ? "&" : "?"}instance=${encodeURIComponent(param)}${anchor}`;
}
