// The state of an instance as a word and the fallback hint of the instance choice: `WORK`, `stateWord` and `fallbackOutdated` stand
// here unchanged from web/src/app/apps/page.tsx, because more than one view needs the same answer (apps page, services pill, code tab,
// right chat bar) — two places for the same list would be two answers. A leaf module: only types and the pure decomposition of the
// identifier from code-instance.ts.
import { copyNameOf, type InstanceField, type InstanceHint, type InstanceChoice, type ListSituation } from "./code-instance.js";

type Translator = (key: string, params?: Record<string, string | number>) => string;

export const WORK: Record<string, string> = {
  create: "being created", start: "starting", recreate: "being recreated", relocation: "migrating",
};

/** The state of an instance as a word for humans ("being removed", never the identifier `clearAway`) — for the addition and tooltip of
 *  the choice. The states of the instance row (store/project-instances.js): create · start · ready · recreate · relocation · clearAway ·
 *  error. An identifier that is not listed here reads "unknown" instead of passing through raw. The build phase is named the same in the
 *  short info of the chat list (`copyText`, lib/chat-tooltip.ts). */
export function stateWord(z: string | null | undefined, t: Translator): string {
  if (!z) return "?";
  if (WORK[z]) return t(WORK[z]);
  if (z === "ready") return t("ready");
  if (z === "clearAway") return t("being removed");
  if (z === "error") return t("Error");
  return t("unknown");
}

/**
 * Is a held fallback (the remembered copy no longer applies, the page shows the main one) outdated? Yes, as soon as a copy applies
 * again, the named copy is selectable again (it is under `options` — only for "not ready": a "gone" also comes from a 404 of the
 * server while the list still lists the copy as ready for one tick, and would otherwise fall unseen), or it is gone and no choice is
 * offered any more — then it refers to nothing, and the page stands like a project with one instance. As long as the copy is still
 * there (error, removed by another hand) and not selectable, it stays: it says why the page shows the main one. Before the first
 * project list nothing is outdated (empty is not unknown). Twin: `AppsModel.fallbackOutdated` (iOS).
 */
export function fallbackOutdated(h: InstanceHint, w: InstanceChoice, field: InstanceField, situation: ListSituation): boolean {
  if (w.param) return true;
  if (h.kind !== "gone" && w.options.some((o) => o.kind === "copy" && o.name === h.name)) return true;
  if (situation !== "loaded") return false;
  const stands = (field?.copies ?? []).some((k) => copyNameOf(k?.identifier) === h.name);
  return !stands && w.options.length === 0;
}
