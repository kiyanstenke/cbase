"use client";

// The Code tab with its instance choice. Editor (`CodePane`) and git column (`GitSidebar`) of a project work in the chosen
// instance: main or a ready copy. The logic lives in lib/code-instance.ts (choice, fallback, parameter); this file only loads,
// remembers and shows:
//   - The source is `/api/projects` (`instance.copies[]`), fresh on open, on every `project/instance` event of this project and
//     when the window regains focus. While the list loads and a copy is remembered, the editor waits (empty is not unknown).
//   - The choice is remembered per project in localStorage (`rememberKey`, every access in try/catch; without storage main applies).
//   - If the choice falls back (copy removed, failed, 404 `UNKNOWN_INSTANCE` mid-edit), a hint appears above the editor and
//     editor and git column are REBUILT (key per instance); never a main view under the copy label.
//     If the copy is only NOT READY right now (start after each backend restart, create, recreate), the choice stays (hint
//     "transient", no rebuild).
//   - Switching with unsaved tabs asks first (they belong to the old instance). A fallback WITHOUT user action does not rebuild
//     the editor with unsaved tabs (`holdFallback`): it stays with the "held" hint until the tabs are gone or the human confirms
//     "Switch to main". While held, the choice stays REMEMBERED (otherwise it is forgotten at the moment of fallback and after
//     remounting main shows without a hint), and the hint names the reason according to the list: "is being removed", then
//     "no longer exists".
//   - A shown fallback hint is updated on EVERY list load (`hintBySituation`), and states appear as a word (`stateWord`,
//     lib/instance-state.ts), never as an identifier like "clearAway".
//   - `active`: the page no longer unmounts the tab on tab switch (workspaces/page.tsx), it hides it, so unsaved tabs and
//     "held" survive. While hidden, the timers of editor and git column pause.
//   - A jump from the "Instances" tab ("Code"/"Terminal" on an instance, lib/code-show.ts) sets the choice: on mount the
//     pending target wins over the remembered one (and is remembered); a mounted area switches via `select`, with the
//     same confirmation for unsaved tabs as a click on the segment bar.
// At workspace level there is no instance: the area is shown plainly.
//
// Layout: the area sits borderless on the stage (no page padding, app/workspaces/page.tsx), editor and git column side by
// side without gap; the git column carries a hairline on its left (GitSidebar.tsx). The instance choice and its hint sit in a
// row of their own with padding above the editor, with a hairline below.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeGlobalEvents } from "@/lib/api";
import { CODE_INSTANCE_EVENT, takeInstanceTarget } from "@/lib/code-show";
import type { ProjectWithInstance } from "@/lib/services-status";
import { hintBySituation, rememberKey, afterError, holdFallback, selectInstance, type InstanceField, type InstanceHint, type InstanceChoice, type ListSituation, type FallbackReason } from "@/lib/code-instance";
import { stateWord } from "@/lib/instance-state";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { Hint, Placeholder, Segments, ghostSm } from "@/components/CbKit";
import { CodePane } from "@/components/CodePane";
import { GitSidebar } from "@/components/GitSidebar";
import { orphanedKey } from "@/lib/view-status";

const readRemembered = (pid: string): string | null => {
  try { return localStorage.getItem(rememberKey(pid)) || null; } catch { return null; }
};
const writeRemembered = (pid: string, identifier: string | null) => {
  try {
    if (identifier) localStorage.setItem(rememberKey(pid), identifier);
    else localStorage.removeItem(rememberKey(pid));
  } catch { /* without storage main applies on the next open */ }
};

export function CodeArea({ workspaceId, workspaceName, project, active = true }: {
  workspaceId: string;
  workspaceName: string;
  project: { id: string; name: string } | null;
  /** The tab is visible; hidden it stays mounted and its timers pause. */
  active?: boolean;
}) {
  if (!project) {
    return (
      <>
        <CodePane key={`ws:${workspaceId}`} apiBase={`/api/workspaces/${workspaceId}`} projectName={workspaceName} active={active} />
        <GitSidebar key={`git-code:ws:${workspaceId}`} apiBase={`/api/workspaces/${workspaceId}`} flush active={active} />
      </>
    );
  }
  return <CodeAreaProject key={project.id} project={project} active={active} />;
}

function CodeAreaProject({ project, active }: { project: { id: string; name: string }; active: boolean }) {
  const t = useT();
  const question = useConfirm();
  const pid = project.id;
  const [situation, setSituation] = useState<ListSituation>("loading");
  const [field, setField] = useState<InstanceField>(undefined);
  // A pending jump from the "Instances" tab wins over the remembered choice (and is remembered).
  const [remembered, setRemembered] = useState<string | null>(() => {
    const target = takeInstanceTarget(pid);
    if (target === undefined) return readRemembered(pid);
    writeRemembered(pid, target);
    return target;
  });
  const [hint, setHint] = useState<InstanceHint | null>(null);
  const [unsaved, setUnsaved] = useState(0);

  const load = useCallback(async () => {
    try {
      const list = await api<ProjectWithInstance[]>("/api/projects");
      if (!Array.isArray(list)) throw new Error("no list");
      const fresh = (list.find((p) => String(p?.id) === pid)?.instance ?? undefined) as InstanceField;
      setField(fresh);
      setSituation("loaded");
      // Groups and view states of deleted copies are dropped from storage (only after a list that contained this project was read).
      if (fresh) {
        try {
          const all = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
          const present = new Set((fresh.copies ?? []).map((k) => String(k?.identifier ?? "")).filter(Boolean));
          for (const k of orphanedKey(all, `/api/projects/${pid}`, present)) localStorage.removeItem(k);
        } catch { /* without storage there is nothing to clean */ }
      }
      // A shown fallback follows the freshly read list; otherwise it froze at the first fallback.
      setHint((h) => hintBySituation(h, fresh, "loaded"));
    } catch {
      // A list read once stays as it was; only with no answer at all is the situation "error".
      setSituation((l) => (l === "loaded" ? l : "error"));
    }
  }, [pid]);

  useEffect(() => {
    void load();
    const off = subscribeGlobalEvents((evt) => { if (evt.type === "project/instance" && String(evt.projectId ?? "") === pid) void load(); });
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { off(); window.removeEventListener("focus", focus); };
  }, [load, pid]);

  // `raw`: the choice by list and remembered value; `choice`: what the editor shows, the same unless a fallback without user
  // action would hit unsaved tabs (`holdFallback`: then the displayed copy stays). `displayed` is the choice of the last render.
  const raw = useMemo(() => selectInstance(pid, field, remembered, situation), [pid, field, remembered, situation]);
  const displayed = useRef<InstanceChoice | null>(null);
  const choice = holdFallback(displayed.current, raw, unsaved);
  useEffect(() => { displayed.current = choice; });
  const held = choice.hint?.kind === "held" ? choice.hint : null;
  const getsHeld = held !== null;

  // A fallback is shown and the choice forgotten (except "unchecked": then it stays remembered for the next attempt), but not
  // while the displayed copy is held: then the reason keeps following the list, and a remount would find the choice.
  useEffect(() => {
    // If a copy applies again (the list arrived after "unchecked"), an old fallback hint is obsolete.
    if (raw.hint) setHint(raw.hint);
    else if (raw.param) setHint(null);
    if (!raw.waiting && raw.remember !== remembered && !getsHeld) { setRemembered(raw.remember); writeRemembered(pid, raw.remember); }
  }, [raw, remembered, pid, getsHeld]);

  // Mid-edit: 404 `UNKNOWN_INSTANCE` for the chosen copy => visibly fall back to main, reread the list.
  const onError = useCallback((e: unknown) => {
    const r = afterError(choice, e);
    if (!r) return;
    setHint(r.hint);
    setRemembered(null);
    writeRemembered(pid, null);
    void load();
  }, [choice, pid, load]);

  // After "Switch anyway?" the unmounted editor discards its unsaved content (otherwise it would sit in the window without an
  // owner, and Alt+Cmd+S would write it later after all). Read on unmount; reset once the new one stands (effects run after
  // the old one's cleanup).
  const dismiss = useRef(false);
  useEffect(() => { dismiss.current = false; }, [choice.param]);
  const select = useCallback(async (identifier: string) => {
    const target = choice.options.find((o) => o.identifier === identifier);
    if (!target || identifier === (choice.param ?? choice.options[0]?.identifier)) return;
    if (unsaved > 0 && !(await question(t("{n} file(s) with unsaved changes — they are lost when you switch the instance. Switch anyway?", { n: unsaved }), { ok: t("Switch"), danger: true }))) return;
    if (unsaved > 0) dismiss.current = true;
    const fresh = target.kind === "copy" ? target.identifier : null;
    setHint(null);
    setUnsaved(0);
    setRemembered(fresh);
    writeRemembered(pid, fresh);
  }, [choice, unsaved, question, t, pid]);

  // A jump from the "Instances" tab while the area is already mounted: same path as a click on the segment bar (`select` asks
  // about unsaved tabs). Main is `null` there; it is chosen via its identifier (first option). Without a choice (no ready
  // copy) the area shows main anyway.
  const selectRef = useRef(select);
  selectRef.current = select;
  const optionsRef = useRef(choice.options);
  optionsRef.current = choice.options;
  useEffect(() => {
    const jump = (e: Event) => {
      if ((e as CustomEvent<{ projectId?: string }>).detail?.projectId !== pid) return;
      const target = takeInstanceTarget(pid);
      if (target === undefined) return;
      const identifier = target ?? optionsRef.current[0]?.identifier;
      if (identifier) void selectRef.current(identifier);
    };
    window.addEventListener(CODE_INSTANCE_EVENT, jump);
    return () => window.removeEventListener(CODE_INSTANCE_EVENT, jump);
  }, [pid]);

  // Let go of the held copy, after confirmation; the tabs are lost.
  const release = useCallback(async () => {
    if (!(await question(t("{n} file(s) with unsaved changes will be lost. Switch to the main instance?", { n: unsaved }), { ok: t("Switch"), danger: true }))) return;
    dismiss.current = true;
    setUnsaved(0);
  }, [question, t, unsaved]);

  // The reason of a "held": taken from the choice; if it names none (a 404 mid-edit forgets the remembered value at once),
  // from the shown fallback of the same copy.
  const holdReason = (h: Extract<InstanceHint, { kind: "held" }>): FallbackReason | null =>
    h.reason ?? (hint && hint.name === h.name && (hint.kind === "gone" || hint.kind === "not-ready" || hint.kind === "unchecked") ? hint : null);
  const heldText = (h: Extract<InstanceHint, { kind: "held" }>) => {
    const g = holdReason(h);
    if (g?.kind === "not-ready" && g.state === "clearAway") return t("The copy {name} is being removed — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", { name: h.name, n: unsaved });
    if (g?.kind === "not-ready") return t("The copy {name} is not ready ({state}) — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", { name: h.name, state: stateWord(g.state, t), n: unsaved });
    if (g?.kind === "gone") return t("The copy {name} no longer exists — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", { name: h.name, n: unsaved });
    return t("The copy {name} is gone — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", { name: h.name, n: unsaved });
  };
  const hintText = (h: InstanceHint) =>
    h.kind === "gone" ? t("The copy {name} no longer exists — the editor shows the main instance again.", { name: h.name })
      : h.kind === "not-ready" ? t("The copy {name} is not ready ({state}) — the editor shows the main instance.", { name: h.name, state: stateWord(h.state, t) })
        : h.kind === "transient" ? t("The copy {name} is not ready right now ({state}) — the editor stays with it and continues once it is ready.", { name: h.name, state: stateWord(h.state, t) })
          : h.kind === "held" ? heldText(h)
            : t("The project list could not be loaded — whether the copy {name} still exists is unknown. The editor shows the main instance.", { name: h.name });
  const showHint = held ?? hint;

  const key = choice.param ?? "main";
  const name = choice.copy ? `${project.name} · ${t("Copy {name}", { name: choice.copy })}` : project.name;
  return (
    // `min-w-0`: without it the column reports the width of its tabs upward as minimum width, and the row pushed the git
    // column, blame and save past the right edge.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-code-area={pid}>
      {(choice.options.length > 0 || showHint) && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-edge px-3 py-2">
          {choice.options.length > 0 && (
            <Segments
              label={t("Instance")}
              value={choice.param ?? choice.options[0].identifier}
              onChange={(k) => { void select(k); }}
              items={choice.options.map((o) => ({
                key: o.identifier,
                label: o.kind === "main" ? t("Main") : t("Copy {name}", { name: o.name }),
                data: { "data-code-instance-choice": o.kind === "main" ? "main" : o.name },
              }))}
            />
          )}
          {showHint && (
            <div className="flex items-start gap-2" data-code-instance-hint={showHint.kind}>
              <div className="min-w-0 flex-1"><Hint tone="warn">{hintText(showHint)}</Hint></div>
              {held
                ? <button type="button" className={ghostSm} onClick={() => { void release(); }}>{t("Switch to main")}</button>
                : <button type="button" className={ghostSm} onClick={() => setHint(null)}>{t("Dismiss##hide")}</button>}
            </div>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {choice.waiting ? (
          <div className="flex min-h-0 flex-1 items-center justify-center"><Placeholder title={t("Loading…##inline")} /></div>
        ) : (
          <>
            <CodePane
              key={`proj:${pid}:${key}`}
              apiBase={`/api/projects/${pid}`}
              projectName={name}
              instance={choice.param}
              copy={choice.copy}
              onError={onError}
              onUnsaved={setUnsaved}
              dismiss={() => dismiss.current}
              active={active}
            />
            <GitSidebar key={`git-code:proj:${pid}:${key}`} apiBase={`/api/projects/${pid}`} instance={choice.param} flush active={active} />
          </>
        )}
      </div>
    </div>
  );
}
