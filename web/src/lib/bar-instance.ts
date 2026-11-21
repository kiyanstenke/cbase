// The instance choice of the git section in the right chat bar. Without a choice the section shows and controls THE CHAT's instance
// (its copy if it has moved in, otherwise the main; the server decides via `?chat=`, lib/chat-instance.ts). With a choice, the main or
// another ready copy of the same project, and everything the panel can do (stage, commit, pull/push, branch, diff, stash) then acts
// THERE.
//
// The one calculation for it lives here (web; iOS twin mobile/CbaseMobile/Chat/BarInstance.swift, bound in
// web/test/bar-instance-binding.test.mjs):
//   - The target carries EXACTLY ONE of: the chat (`chatId`, default) or the choice. A copy as `instance=<identifier>`, the main
//     WITHOUT any parameter (without a chat the route is the main). Never `?chat=` and `?instance=` together: if they mean different
//     instances, that is 400 (devtools/routes.js withSelectedInstance), and with a locked own copy (409 BEFORE `instance=` is read) the
//     main would not be selectable either.
//   - A choice equal to the own instance is none (normalized): chat mode; otherwise two states (lib/git-state.ts) and the "this chat"
//     mark would be missing.
//   - Only the chat-bound tree knows the own instance (`git.tree.instance`); during a choice nobody reads it. So the choice remembers
//     it (`own`, the server's truth at the time of the choice) plus the signature of this chat's copy rows from the project list
//     (`ownSignature`: only the identifiers, not the state; `start` after every restart of the backend is no move-in or move-out). If
//     the signature changes (the chat moved in or out), the choice drops and the bar follows the chat again (hint "own"). Likewise if
//     the remembered own COPY has no row anymore: a child chat of a graph run works in its parent chat's copy, no row carries its
//     chatId, the signature stays empty; if the copy drops, it returns to the main, and only its missing row says so. The list is
//     reloaded on `project/instance` AND `project/copy` (the clean-up route deletes the instance row silently and afterwards reports
//     only `project/copy` → removed).
//   - A chat's binding lives in `chats.instance`, not on the copy row; `copies[].chatId` only means "created by". A switch in the chat
//     header (`PATCH {instance}`) or via `cbase_switch_instance` changes NO copy row and triggers no `project/*`; the signature
//     therefore carries the binding (`binding`, the value of `chat.instance`): if it changes, the choice drops as with a move-in or
//     move-out (otherwise after a switch to the chosen copy the menu would say "Main · this chat", and a tap on it would show and
//     commit in the copy). Without a copy binding (main) the signature stays what it was.
//   - The chosen copy gone, cleaned up, failed ⇒ back to THE CHAT's instance (not to the main as in the code tab), visibly (hint).
//     Only temporarily not ready (`TRANSIENT`) ⇒ the choice stays. So does a 404 `UNKNOWN_INSTANCE` from the server (`afterErrorBar`).
//   - The own copy is ALWAYS among the options (even if not ready; the server keeps binding the chat to it), taken from `own`, never from
//     the list: the list does not see child chats of a graph run at all.
//   - Empty is not unknown: as long as the own instance is not read (`ownFromServer` undefined) or the list loads, there is no choice;
//     a choice already made stays during loading (not deciding is not discarding) and drops only on a READ list.
//   - The hint of a dropped choice is kept current on every read list (`barHintBySituation`): the same calculation as in the code tab.
//
// A leaf: it imports only lib/code-instance.ts (itself a leaf); the test compiles both with tsc and runs them under Node.
import { MAIN, TRANSIENT, identifierParts, copyNameOf, fallbackBySituation, type InstanceField, type ListSituation } from "./code-instance.js";

/** A chat's remembered choice (module map of the bar, not localStorage: after a reload the own instance is unknown, and a forgotten
 *  choice makes a commit in the wrong container more likely). */
export type BarChoice = {
  /** The chosen instance: `<projectId>/main` or `<projectId>/copy-<name>`. */
  identifier: string;
  projectId: string;
  /** The chat's own instance at the time of the choice: the name of its copy ("k1") or `null` (the main). */
  own: string | null;
  /** `ownSignature` of the list at the time of the choice. */
  signature: string;
};
export type BarOption = { identifier: string; kind: "main" | "copy"; name: string; own: boolean };
export type BarHint =
  | { kind: "gone"; name: string }
  | { kind: "not-ready"; name: string; state: string }
  | { kind: "transient"; name: string; state: string }
  | { kind: "own" };
export type BarTarget = { chatId: string | null; instance: string | null };
export type BarStatus = {
  /** The menu's entries; empty means: no choice (fewer than two instances, no chat, not converted, not read yet). */
  options: BarOption[];
  /** Where git goes: EXACTLY the chat (default) OR the choice (`chatId` null; `instance` only for a copy). */
  target: BarTarget;
  /** The shown instance (`<p>/main` or `<p>/copy-…`); `null` while unknown or the project is not converted. */
  shown: string | null;
  /** The name of the shown copy, `null` for the main. */
  shownName: string | null;
  /** What is shown is NOT this chat's instance (`foreign`). */
  foreign: boolean;
  /** Why a choice dropped or is currently not ready; `null` otherwise. */
  hint: BarHint | null;
  /** What stays remembered: the choice, or `null` (chat mode). If it differs from the input, the bar writes it back. */
  remember: BarChoice | null;
};

/** A chat's binding (`chats.instance`) for the signature: `copy-<name>` or `null` (main: NULL, empty or "main"). */
function bindingOf(binding: string | null | undefined): string | null {
  const b = typeof binding === "string" ? binding.trim() : "";
  return b && b !== MAIN ? b : null;
}

/** This chat's copy rows in the list (only their identifiers, sorted) and its binding (`chats.instance`) if it works in a copy
 *  (`#copy-<name>` appended). A move-in or move-out and an instance switch change it, a `start` does not. */
export function ownSignature(field: InstanceField, chatId: string | null | undefined, binding: string | null | undefined): string {
  if (!chatId) return "";
  const rows = (field?.copies ?? [])
    .filter((k) => String(k?.chatId ?? "") === String(chatId))
    .map((k) => String(k?.identifier ?? ""))
    .filter(Boolean)
    .sort()
    .join("|");
  const b = bindingOf(binding);
  return b ? `${rows}#${b}` : rows;
}

const copyIdentifier = (projectId: string, name: string) => `${projectId}/copy-${name}`;

/**
 * The bar's choice. `ownFromServer`: the chat's copy as its chat-bound tree names it (`copyNameOf(git.tree?.instance)`), `null` for the
 * main, `undefined` while that tree is not read (the bar passes it in only in chat mode). `binding`: the value of `chat.instance`
 * (signature, see header). Pure.
 */
export function barGitChoice(e: {
  projectId: string | null | undefined;
  field: InstanceField;
  situation: ListSituation;
  chatId: string | null | undefined;
  binding: string | null | undefined;
  ownFromServer: string | null | undefined;
  choice: BarChoice | null | undefined;
}): BarStatus {
  const pid = String(e.projectId ?? "");
  const chatId = e.chatId ? String(e.chatId) : null;
  const choice = e.choice && pid && chatId && e.choice.projectId === pid ? e.choice : null; // a choice of another project does not apply
  const field = e.field;
  const mainIdentifier = pid && field?.converted === true && identifierParts(field.identifier)?.instance === MAIN && identifierParts(field.identifier)?.projectId === pid
    ? String(field.identifier) : null;
  const own = choice ? choice.own : e.ownFromServer;
  const ownIdentifier = own === undefined || !pid ? null : own === null ? mainIdentifier : copyIdentifier(pid, own);

  const chatState = (hint: BarHint | null): BarStatus => ({
    options: optionsFor(null),
    target: { chatId, instance: null },
    shown: ownIdentifier,
    shownName: own ?? null,
    foreign: false,
    hint,
    remember: null,
  });
  const optionsFor = (selected: string | null): BarOption[] => {
    if (!chatId || !mainIdentifier || own === undefined || e.situation !== "loaded") return [];
    const list: BarOption[] = [{ identifier: mainIdentifier, kind: "main", name: "", own: own === null }];
    const seen = new Set<string>([mainIdentifier]);
    if (own !== null) {
      const k = copyIdentifier(pid, own);
      list.push({ identifier: k, kind: "copy", name: own, own: true });
      seen.add(k);
    }
    for (const z of field?.copies ?? []) {
      const k = String(z?.identifier ?? "");
      const name = copyNameOf(k);
      const state = String(z?.state ?? "");
      const counts = state === "ready" || (k === selected && TRANSIENT.includes(state));
      if (!name || identifierParts(k)?.projectId !== pid || !counts || seen.has(k)) continue;
      seen.add(k);
      list.push({ identifier: k, kind: "copy", name, own: false });
    }
    return list.length > 1 ? list : [];
  };

  if (!choice) return chatState(null);
  if (choice.identifier === ownIdentifier) return chatState(null); // normalized: the own instance is chat mode
  const gName = copyNameOf(choice.identifier);
  const selectedStatus = (hint: BarHint | null, options: BarOption[]): BarStatus => ({
    options,
    target: { chatId: null, instance: gName ? choice.identifier : null },
    shown: choice.identifier,
    shownName: gName,
    foreign: true,
    hint,
    remember: choice,
  });
  // Empty is not unknown: on a list not (yet) read, the choice is not decided; it stays.
  if (e.situation !== "loaded") return selectedStatus(null, []);
  if (ownSignature(field, chatId, e.binding) !== choice.signature) return chatState({ kind: "own" });
  // The own copy has no row anymore ⇒ the chat no longer works in it. The signature never sees this for a child chat of a graph run: its
  // copy is its parent chat's (no row carries its chatId), and if it drops, it returns to the main; mark, hint and browser would
  // otherwise stay on the old copy.
  const ownRow = choice.own === null ? null : copyIdentifier(pid, choice.own);
  if (ownRow && !(field?.copies ?? []).some((z) => String(z?.identifier ?? "") === ownRow)) return chatState({ kind: "own" });
  if (!gName) return choice.identifier === mainIdentifier ? selectedStatus(null, optionsFor(null)) : chatState({ kind: "gone", name: "" });
  const row = (field?.copies ?? []).find((z) => String(z?.identifier ?? "") === choice.identifier);
  if (!row || !mainIdentifier) return chatState({ kind: "gone", name: gName });
  const state = String(row.state ?? "");
  if (state === "ready") return selectedStatus(null, optionsFor(choice.identifier));
  if (TRANSIENT.includes(state)) return selectedStatus({ kind: "transient", name: gName, state }, optionsFor(choice.identifier));
  return chatState({ kind: "not-ready", name: gName, state });
}

/** The choice a click on `identifier` remembers; `null` for the own instance (chat mode) or an unknown option. */
export function selectInBar(status: BarStatus, identifier: string, e: { projectId: string; field: InstanceField; chatId: string; binding: string | null | undefined }): BarChoice | null {
  const o = status.options.find((x) => x.identifier === identifier);
  const own = status.options.find((x) => x.own);
  if (!o || !own || o.own) return null;
  return { identifier: o.identifier, projectId: e.projectId, own: own.kind === "main" ? null : own.name, signature: ownSignature(e.field, e.chatId, e.binding) };
}

/**
 * A server error during a choice: if it names the CHOSEN copy unknown (404 `UNKNOWN_INSTANCE`) or the choice invalid (400
 * `INSTANCE_INVALID`), the choice drops (back to the chat, with a hint). Any other error (409 of a paused instance, network) is none:
 * `null`.
 */
export function afterErrorBar(choice: BarChoice | null | undefined, error: unknown): BarHint | null {
  const o = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (!choice || (o.code !== "UNKNOWN_INSTANCE" && o.code !== "INSTANCE_INVALID")) return null;
  if (typeof o.identifier === "string" && o.identifier && o.identifier !== choice.identifier) return null;
  return { kind: "gone", name: copyNameOf(choice.identifier) ?? "" };
}

/**
 * The hint of a dropped choice, kept current on a freshly READ list: "not ready" becomes "gone" as soon as the row is missing, carries a
 * new state, or drops when the copy is ready again; "gone", "own" and "transient" stay. The same object if nothing changes. The calculation
 * is the code tab's (`fallbackBySituation`). Pure.
 */
export function barHintBySituation(h: BarHint | null | undefined, field: InstanceField, situation: ListSituation): BarHint | null {
  if (!h) return null;
  if (situation !== "loaded" || (h.kind !== "gone" && h.kind !== "not-ready")) return h;
  return fallbackBySituation(h, field);
}
