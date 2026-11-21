"use client";

import { useEffect, useMemo, useState } from "react";
import {
  api, changeOuterLoop, createOuterLoop, createOuterLoopChat, outerLoopTakeover, resetOuterLoop,
  type OuterLoopAgent, type OuterLoopTrigger, type OuterLoopInventory, type OuterLoopChatBody,
  type OuterLoopLimits, type OuterLoopBody, type OuterLoopSpan, type Project,
} from "@/lib/api";
import { field, ghost, ghostSm, Hint, Modal, primary, Toggle, select } from "@/components/CbKit";
import { McpToolChoice, normMcp, ToolCatalogChoice } from "@/components/outerloop/ToolChoice";
import { OriginMarker } from "@/components/Origin";
import { ModelChoice } from "@/components/ModelChoice";
import { useConfirm } from "@/components/Prompts";
import { type EffortCatalog, effortEntries, effortPicker, effortStandardLabel } from "@/lib/effort";
import { useT } from "@/lib/i18n";
import { fixedName, upkeepTallyText, ineffectiveText } from "@/components/outerloop/outerLoopText";

// The editor of an outer-loop agent — ONE sheet for all three origins and the summarizer, by portal on the body (kit `Modal`:
// `cb-overlay` + `cb-sheet`).
//
// What an origin lacks is not shown (description = execution): a chat-own agent has no "Default for new chats" (the server answers 400
// otherwise); takeover per project exists only for a saved workspace agent. There is no scope segment (Coding · Managing): only Coding
// chats are observed, and the server ignores the field. The tool choice (outerloop/ToolChoice.tsx) carries the slice of the server
// catalog and the mark "dropped in project chats" (`fenceDropped`); the built-in tools stand as their own list below. The approval marks
// are set by the outer-loop area itself (outerloop/ApprovalMarks.tsx), here they are read-only.
//
// Two agents are fixed: the summarizer and the agenda keeper. What concerns both (mark "fixed", reset, "new template") hangs on `fixed`;
// only the keeper has the toggle "Mark changes" (`markUpkeep` — on any other agent the field would be a 400, so it goes into the body only
// for the keeper) and the tally of its changes (without a tally "Track record unknown" — the rule lives ONCE in `upkeepTallyText`,
// outerLoopText.ts).
//
// An agent is effective only with provider AND model — so there is NO "Default (global)": an empty provider means "not running", and the
// sheet says so.

type ProviderMeta = {
  id: string; label: string; connected: boolean; models: { id: string; label: string; efforts?: string[] }[];
  defaultModel?: string; defaultEffort?: string; caps?: { effort?: boolean };
};

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";
const pane = "cb-kit-pane flex min-w-0 flex-col gap-2 rounded-2xl p-3.5";

// The minutes are RAW TEXT in the draft: clamped only when leaving the field and in `triggerList` (save, compare). Clamping on every
// keystroke would turn "1" (on the way to "15") into the minimum 5 at once — an interval between 10 and 49 was hardly typeable. iOS
// also clamps only in `triggerList`.
type TriggerDraft = {
  quiet: { on: boolean; minutes: string };
  interval: { on: boolean; minutes: string };
  run_end: { on: boolean };
  clockTime: { on: boolean; clockTimes: string[] };
};
type Draft = {
  name: string; job: string; trigger: TriggerDraft;
  provider: string; model: string; effort: string; defaultNew: boolean; enabled: boolean;
  tools: string[]; builtin: string[]; mcp: Record<string, string[]>;
  /** Saved only for the agenda keeper; otherwise unchanged from the agent (false). */
  markUpkeep: boolean;
  /** "Abort on new message" — every agent; off: a trigger during a run queues. */
  abortingTurn: boolean;
};

export type OuterLoopNew =
  | { origin: "workspace" }
  | { origin: "project"; projectId: string }
  | { origin: "chat"; chatId: string };

function triggerDraft(list: OuterLoopTrigger[]): TriggerDraft {
  const e: TriggerDraft = { quiet: { on: false, minutes: "5" }, interval: { on: false, minutes: "60" }, run_end: { on: false }, clockTime: { on: false, clockTimes: [] } };
  for (const a of list) {
    if (a.kind === "quiet") e.quiet = { on: true, minutes: String(a.minutes) };
    else if (a.kind === "interval") e.interval = { on: true, minutes: String(a.minutes) };
    else if (a.kind === "run_end") e.run_end = { on: true };
    else if (a.kind === "clockTime") e.clockTime = { on: true, clockTimes: [...a.times] };
  }
  return e;
}

/** The list for the server — each kind at most once, in a fixed order; the minutes clamped here. */
function triggerList(e: TriggerDraft, g: OuterLoopLimits): OuterLoopTrigger[] {
  const out: OuterLoopTrigger[] = [];
  if (e.quiet.on) out.push({ kind: "quiet", minutes: minutesFrom(e.quiet.minutes, g.quiet) });
  if (e.interval.on) out.push({ kind: "interval", minutes: minutesFrom(e.interval.minutes, g.interval) });
  if (e.run_end.on) out.push({ kind: "run_end" });
  if (e.clockTime.on) out.push({ kind: "clockTime", times: [...e.clockTime.clockTimes].sort() });
  return out;
}

function draftOf(a: OuterLoopAgent | null): Draft {
  if (a) {
    return {
      name: a.name, job: a.job, trigger: triggerDraft(a.trigger),
      provider: a.provider, model: a.model, effort: a.effort, defaultNew: a.defaultNew, enabled: a.enabled,
      tools: [...a.tools], builtin: [...a.builtin], mcp: normMcp(a.mcp), markUpkeep: a.markUpkeep,
      abortingTurn: a.abortingTurn,
    };
  }
  return {
    name: "", job: "", trigger: triggerDraft([{ kind: "quiet", minutes: 5 }]),
    provider: "", model: "", effort: "", defaultNew: false, enabled: true,
    tools: [], builtin: [], mcp: {}, markUpkeep: false, abortingTurn: false,
  };
}

// Tools compared as a SET: the server returns them in catalog order, the choice comes in click order — otherwise "Unsaved changes"
// would show after saving although nothing changed.
const draftKey = (e: Draft, g: OuterLoopLimits) => JSON.stringify({
  ...e, tools: [...e.tools].sort(), builtin: [...e.builtin].sort(), trigger: triggerList(e.trigger, g), mcp: normMcp(e.mcp),
});
/** A name list in the order of a catalog, unknown names sorted behind it (the server computes the set in CATALOG order — a click order
 *  would cost the prompt cache; iOS sends the same order). */
const ordered = (choice: string[], catalog: string[]) => {
  const known = catalog.filter((n, i) => choice.includes(n) && catalog.indexOf(n) === i);
  return [...known, ...choice.filter((n) => !catalog.includes(n)).sort()];
};
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
/** Raw text of a minutes field → number within the range; empty or unreadable is the minimum. */
const minutesFrom = (raw: string, s: OuterLoopSpan) => clamp(raw.trim() === "" ? Number.NaN : Number(raw), s.min, s.max);
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function OuterLoopEditor({ workspaceId, inventory, agent, fresh, projects, onClose, onSaved }: {
  workspaceId: string;
  inventory: OuterLoopInventory;
  /** The agent — `null` for a new one (then `fresh` says where it is created). */
  agent: OuterLoopAgent | null;
  fresh?: OuterLoopNew;
  /** The projects of the workspace — for the takeover of a workspace agent per project. */
  projects?: Project[];
  onClose: () => void;
  onSaved: (a: OuterLoopAgent) => void;
}) {
  const t = useT();
  const question = useConfirm();
  const origin = agent?.origin ?? fresh?.origin ?? "workspace";
  const chatOrigin = origin === "chat";
  const [base, setBase] = useState<OuterLoopAgent | null>(agent);
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [clockTimeNew, setClockTimeNew] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  // Takeover per project: the projects where the workspace agent is switched off (saved at once, its own route).
  const [not, setNot] = useState<string[]>(agent?.notTakenOverIn ?? []);
  const [toggles, setToggles] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ providers: ProviderMeta[] }>("/api/providers")
      .then((d) => { if (!cancelled) setProviders(d.providers || []); })
      .catch(() => { /* without a list only "no model" remains — nothing wrong gets saved */ });
    return () => { cancelled = true; };
  }, []);

  const g = inventory.trigger.limits;
  const dirty = !base || draftKey(draftOf(base), g) !== draftKey(draft, g);
  const list = triggerList(draft.trigger, g);
  const missingClockTime = draft.trigger.clockTime.on && draft.trigger.clockTime.clockTimes.length === 0;
  const lockReason = !draft.name.trim()
    ? t("A name is missing.")
    : list.length === 0
      ? t("At least one trigger.")
      : missingClockTime ? t("Fixed times: at least one time.") : "";

  // Providers: the connected ones — and the saved one, even if it is currently signed out (otherwise it would vanish silently).
  const choice = useMemo(() => providers.filter((p) => p.connected || p.id === draft.provider), [providers, draft.provider]);
  const models = choice.find((p) => p.id === draft.provider)?.models ?? [];
  const catalog: EffortCatalog = providers;
  const levelAvailable = Boolean(draft.provider && draft.model) && catalog.length > 0 && effortPicker(draft.provider, draft.model, catalog);
  const withoutModel = !draft.provider || !draft.model;

  const set = (patch: Partial<Draft>) => { setDone(false); setDraft((e) => ({ ...e, ...patch })); };
  const setTrigger = (patch: Partial<TriggerDraft>) => { setDone(false); setDraft((e) => ({ ...e, trigger: { ...e.trigger, ...patch } })); };

  async function close() {
    if (dirty && base && !(await question(t("Discard unsaved changes?"), { ok: t("Dismiss"), danger: true }))) return;
    if (!base && (draft.name.trim() || draft.job.trim()) && !(await question(t("Discard unsaved changes?"), { ok: t("Dismiss"), danger: true }))) return;
    onClose();
  }

  async function save() {
    if (lockReason) return;
    setBusy(true); setErr("");
    try {
      let a: OuterLoopAgent;
      const mcp = normMcp(draft.mcp);
      const tools = ordered(draft.tools, inventory.catalog.groups.flatMap((x) => x.tools));
      const builtin = ordered(draft.builtin, inventory.catalog.builtin.map((w) => w.name));
      if (chatOrigin) {
        const body: OuterLoopChatBody = {
          name: draft.name.trim(), job: draft.job, trigger: list, provider: draft.provider, model: draft.model,
          effort: draft.effort, tools, builtin, mcp, enabled: draft.enabled, abortingTurn: draft.abortingTurn,
        };
        a = base
          ? await changeOuterLoop(workspaceId, base.id, body)
          : await createOuterLoopChat((fresh as { chatId: string }).chatId, body);
      } else {
        const body: OuterLoopBody = {
          name: draft.name.trim(), job: draft.job, trigger: list, provider: draft.provider,
          model: draft.model, effort: draft.effort, defaultNew: draft.defaultNew, tools, builtin, mcp, enabled: draft.enabled,
          abortingTurn: draft.abortingTurn,
        };
        if (base?.agendaKeeper) body.markUpkeep = draft.markUpkeep;
        if (base) a = await changeOuterLoop(workspaceId, base.id, body);
        else {
          if (fresh?.origin === "project") body.projectId = fresh.projectId;
          a = await createOuterLoop(workspaceId, body);
        }
      }
      setBase(a);
      setDraft(draftOf(a));
      setDone(true);
      onSaved(a);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!base) return;
    const text = base.timeline
      ? t("Reset the timeline agent to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort and “on” stay.")
      : base.agendaKeeper
      ? t("Reset the agenda keeper to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort, “on” and “mark changes” stay.")
      : t("Reset the summarizer to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort and “on” stay.");
    if (!(await question(text, { ok: t("Reset") }))) return;
    setBusy(true); setErr("");
    try {
      const a = await resetOuterLoop(workspaceId, base.id);
      setBase(a);
      setDraft(draftOf(a));
      setDone(true);
      onSaved(a);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function takeover(pid: string, takenOver: boolean) {
    if (!base) return;
    setToggles(pid); setErr("");
    try {
      await outerLoopTakeover(pid, base.id, takenOver);
      setNot((l) => (takenOver ? l.filter((x) => x !== pid) : [...l.filter((x) => x !== pid), pid]));
    } catch (e) { setErr((e as Error).message); }
    finally { setToggles(null); }
  }

  function clockTimeAlongside() {
    const z = clockTimeNew.trim();
    if (!CLOCK_TIME.test(z)) return;
    const l = draft.trigger.clockTime.clockTimes;
    if (l.includes(z) || l.length >= g.clockTimes.max) return;
    setTrigger({ clockTime: { on: true, clockTimes: [...l, z].sort() } });
  }

  const title = base
    ? base.fixed ? fixedName(base, t) || base.name : base.name
    : chatOrigin ? t("New outer-loop agent for this chat") : origin === "project" ? t("New project agent") : t("New outer-loop agent");

  const rowClass = "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2.5 py-2";
  const countField = `${field} w-[84px] py-1 text-right tabular-nums`;

  return (
    <Modal onClose={() => { void close(); }} width={760} className="p-0" label={title}>
      <div className="flex min-h-0 flex-col" data-outerloop-editor={base?.id ?? "fresh"}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/60 px-5 py-3.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{title}</h2>
          {base?.fixed && <span className="shrink-0 rounded-full bg-accent/12 px-1.5 py-[1px] text-[10.5px] font-semibold text-accent">{t("built in")}</span>}
          {(origin === "project" || origin === "workspace") && !base?.fixed && <OriginMarker kind={origin} />}
          {dirty && base && <span className="text-[11px] text-warn">{t("Unsaved changes")}</span>}
          {done && !dirty && <span className="text-[11px] text-ok" role="status">{t("Saved")}</span>}
          <button type="button" onClick={() => { void close(); }} className={ghost}>{t("Close")}</button>
          <button type="button" onClick={() => { void save(); }} disabled={busy || !dirty || Boolean(lockReason)} title={lockReason || undefined} className={primary} data-outerloop-save="">
            {busy ? t("Saving…") : t("Save")}
          </button>
        </div>

        <div className="cb-scroll @container/detail flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
          {base?.summarizer && (
            <p className="text-[12.5px] leading-relaxed text-dim">
              {t("The summarizer is the one built-in outer-loop agent of this workspace: only its notes show up for other agents. It is yours — change it, switch it off, reset it to the template; it cannot be deleted.")}
            </p>
          )}
          {base?.agendaKeeper && (
            <p className="text-[12.5px] leading-relaxed text-dim">
              {t("The agenda keeper is built in, one per workspace: it keeps a watched chat's agenda up to date when the main agent forgets — adding new items, moving a status forward, only in a quiet chat. What the main agent takes back, it does not repeat. It is yours — change it, switch it off, reset it to the template; it cannot be deleted.")}
            </p>
          )}
          {base?.fixed && base.templateNew && (
            <Hint tone="warn">{t("There is a newer cbase template. “Reset to template” takes it over — provider, model, effort and “on” stay.")}</Hint>
          )}
          {chatOrigin && (
            <p className="text-[12.5px] leading-relaxed text-dim">
              {t("A chat-owned agent watches only this chat — alongside the summarizer. It follows the chat: deleted with it, resting in the archive, not copied when forking.")}
            </p>
          )}

          <div className={pane}>
            <label className="flex flex-col gap-1">
              <span className={lab}>{t("Name")}</span>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={field} placeholder={t("e.g. reviewer, test watcher, minutes")} />
            </label>
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <Toggle on={draft.enabled} onClick={() => set({ enabled: !draft.enabled })} title={draft.enabled ? t("On — click to switch off") : t("Off — click to switch on")} />
              <span className="text-[12.5px]">{draft.enabled ? t("On") : t("Off")}</span>
              {!draft.enabled
                ? <span className="text-[11.5px] text-dim">{t("Switched off, it runs on no chat.")}</span>
                : withoutModel && <span className="text-[11.5px] text-warn">{ineffectiveText(!draft.provider ? "without-provider" : "without-model", t)}</span>}
            </div>
          </div>

          {base?.agendaKeeper && (
            <div className={pane} data-outerloop-upkeep="">
              <span className={lab}>{t("Agenda")}</span>
              <div className="flex flex-wrap items-center gap-2.5">
                <Toggle on={draft.markUpkeep} onClick={() => set({ markUpkeep: !draft.markUpkeep })}
                  title={draft.markUpkeep ? t("On — click to switch off") : t("Off — click to switch on")} />
                <span className="text-[12.5px]">{t("Mark changes")}</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-dim">
                {draft.markUpkeep
                  ? t("Items it adds or sets carry a faint ring at their status mark in the agenda — it stays even if the main agent changes them afterwards, and tells what happened since.")
                  : t("Its changes carry no mark. Existing marks stay.")}
              </p>
              <p className="text-[12.5px] tabular-nums" data-outerloop-upkeep-tally="">
                {upkeepTallyText(base.upkeepTally, t)}
              </p>
              <p className="text-[11.5px] leading-relaxed text-dim">{t("“Standing” means: the main agent did not take the change back. “Corrected”: it moved the status back or deleted the added item.")}</p>
            </div>
          )}

          <div className={pane}>
            <span className={lab}>{t("Brief")}</span>
            <p className="text-[11.5px] leading-relaxed text-dim">
              {t("What it should do in each run. It also gets what happened in the chat since its last finished run and its last note; its final answer is the new note.")}
            </p>
            <textarea value={draft.job} onChange={(e) => set({ job: e.target.value })} rows={7} className={`${field} cb-scroll min-h-[6rem] w-full resize-y leading-relaxed`} />
          </div>

          <div className={pane} data-outerloop-trigger="">
            <span className={lab}>{t("Triggers")}</span>
            <p className="text-[11.5px] leading-relaxed text-dim">{t("At least one. Interval and fixed times only run on chats with something new since its last run.")}</p>
            <div className="flex flex-col">
              <label className={`${rowClass} ${draft.trigger.quiet.on ? "bg-accent/8" : ""}`}>
                <input type="checkbox" checked={draft.trigger.quiet.on} onChange={(e) => setTrigger({ quiet: { ...draft.trigger.quiet, on: e.target.checked } })} className="accent-accent" />
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">{t("After quiet")}</span>
                <input type="number" min={g.quiet.min} max={g.quiet.max} value={draft.trigger.quiet.minutes}
                  onChange={(e) => setTrigger({ quiet: { on: true, minutes: e.target.value } })}
                  onBlur={() => setTrigger({ quiet: { ...draft.trigger.quiet, minutes: String(minutesFrom(draft.trigger.quiet.minutes, g.quiet)) } })}
                  className={countField} aria-label={t("Minutes of quiet")} />
                <span className="text-[12px] text-dim">{t("min without a new line")}</span>
              </label>
              <label className={`${rowClass} ${draft.trigger.interval.on ? "bg-accent/8" : ""}`}>
                <input type="checkbox" checked={draft.trigger.interval.on} onChange={(e) => setTrigger({ interval: { ...draft.trigger.interval, on: e.target.checked } })} className="accent-accent" />
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">{t("Interval")}</span>
                <span className="text-[12px] text-dim">{t("all")}</span>
                <input type="number" min={g.interval.min} max={g.interval.max} value={draft.trigger.interval.minutes}
                  onChange={(e) => setTrigger({ interval: { on: true, minutes: e.target.value } })}
                  onBlur={() => setTrigger({ interval: { ...draft.trigger.interval, minutes: String(minutesFrom(draft.trigger.interval.minutes, g.interval)) } })}
                  className={countField} aria-label={t("Interval minutes")} />
                <span className="text-[12px] text-dim">{t("min")}</span>
              </label>
              <label className={`${rowClass} ${draft.trigger.run_end.on ? "bg-accent/8" : ""}`}>
                <input type="checkbox" checked={draft.trigger.run_end.on} onChange={(e) => setTrigger({ run_end: { on: e.target.checked } })} className="accent-accent" />
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">{t("After every run end")}</span>
                <span className="text-[11.5px] text-dim">{t("not after a turn it started itself")}</span>
              </label>
              <div className={`${rowClass} ${draft.trigger.clockTime.on ? "bg-accent/8" : ""}`}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input type="checkbox" checked={draft.trigger.clockTime.on} onChange={(e) => setTrigger({ clockTime: { ...draft.trigger.clockTime, on: e.target.checked } })} className="accent-accent" />
                  <span className="text-[12.5px] font-medium">{t("Fixed times")}</span>
                </label>
                <input type="time" value={clockTimeNew} onChange={(e) => setClockTimeNew(e.target.value)} className={`${field} py-1 tabular-nums`} aria-label={t("Time")} />
                <button type="button" onClick={clockTimeAlongside} disabled={!CLOCK_TIME.test(clockTimeNew) || draft.trigger.clockTime.clockTimes.length >= g.clockTimes.max} className={ghostSm}>{t("Add")}</button>
                {draft.trigger.clockTime.clockTimes.length > 0 && (
                  <div className="flex w-full flex-wrap gap-1.5 pl-7">
                    {draft.trigger.clockTime.clockTimes.map((z) => (
                      <span key={z} className="inline-flex items-center gap-1 rounded-full bg-edge px-2 py-0.5 font-mono text-[11.5px]">
                        {z}
                        <button type="button" aria-label={t("Remove time {time}", { time: z })} className="text-dim hover:text-fg"
                          onClick={() => setTrigger({ clockTime: { ...draft.trigger.clockTime, clockTimes: draft.trigger.clockTime.clockTimes.filter((x) => x !== z) } })}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                {draft.trigger.clockTime.on && <span className="w-full pl-7 text-[11px] text-dim">{t("In the workspace's time zone. If the container sleeps at that time, it runs once on the next tick.")}</span>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 pt-1" data-outerloop-at-turn="">
              <Toggle on={draft.abortingTurn} onClick={() => set({ abortingTurn: !draft.abortingTurn })}
                title={draft.abortingTurn ? t("On — click to switch off") : t("Off — click to switch on")} />
              <span className="text-[12.5px]">{t("Cancel on new message")}</span>
            </div>
            <p className="text-[11.5px] leading-relaxed text-dim">
              {draft.abortingTurn
                ? t("When a new turn starts in the observed chat, it cancels its running run there; the next trigger reads the stretch again.")
                : t("Its run keeps going even while the chat keeps working. A trigger in the meantime is queued and runs afterwards.")}
            </p>
          </div>

          <div className={pane}>
            <span className={lab}>{t("Model")}</span>
            <div className="grid gap-2 @md/detail:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[11.5px] text-dim">{t("Providers")}</span>
                <select value={draft.provider} onChange={(e) => set({ provider: e.target.value, model: "", effort: "" })} className={select} data-outerloop-provider="">
                  <option value="">{t("No provider — does not run")}</option>
                  {choice.map((p) => <option key={p.id} value={p.id}>{p.label}{p.connected ? "" : ` (${t("signed out")})`}</option>)}
                </select>
              </label>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[11.5px] text-dim">{t("Model")}</span>
                {/* The shared model choice with search (components/ModelChoice.tsx) — OpenRouter carries the whole catalog. */}
                <ModelChoice
                  label={t("Model")}
                  value={draft.model}
                  onChoice={(model) => set({ model, effort: "" })}
                  disabled={!draft.provider}
                  top={[
                    { value: "", label: t("No model — does not run") },
                    ...(draft.model && !models.some((m) => m.id === draft.model) ? [{ value: draft.model, label: draft.model, warn: true }] : []),
                  ]}
                  groups={[{ key: draft.provider, label: choice.find((p) => p.id === draft.provider)?.label ?? draft.provider, options: models.map((m) => ({ value: m.id, label: m.label })) }]}
                  data={{ "data-outerloop-model": "" }}
                />
              </div>
            </div>
            {levelAvailable && (
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[11.5px] text-dim">{t("Effort")}</span>
                <select value={draft.effort} onChange={(e) => set({ effort: e.target.value })} className={select} data-outerloop-effort="">
                  {effortEntries(draft.provider, draft.model, catalog, draft.effort, effortStandardLabel(draft.provider, draft.model, catalog, t), t).map((w) => (
                    <option key={w.id || "standard"} value={w.id} title={w.marker}>{w.label}</option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-[11.5px] leading-relaxed text-dim">{t("Without provider and model it does not run — the summarizer too is off until a model is chosen. Codex can be chosen. Costs are booked per run, without a cap.")}</p>
          </div>

          {!chatOrigin && (
            <div className={pane}>
              <span className={lab}>{t("Where it watches")}</span>
              <div className="flex flex-wrap items-center gap-2.5">
                <Toggle on={draft.defaultNew} onClick={() => set({ defaultNew: !draft.defaultNew })} title={t("Default for new chats")} />
                <span className="text-[12.5px]">{t("Default for new chats")}</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-dim">
                {draft.defaultNew
                  ? t("Active on every coding chat created after it took effect — turn it on for older chats one by one in their chat info.")
                  : t("It only runs on chats where you switch it on in the chat info.")}
              </p>
            </div>
          )}

          <ToolCatalogChoice
            areas={inventory.catalog.toolAreas}
            catalog={inventory.catalog.groups}
            cbaseApproval={inventory.catalog.cbaseApproval}
            fenceDropped={inventory.catalog.fenceDropped}
            tools={draft.tools}
            onTools={(tools) => set({ tools })}
          />
          <p className="-mt-1 px-1 text-[11.5px] leading-relaxed text-dim">
            {t("Every run has the analysis tool for the watched chat. Tools with an approval mark are missing in the run — nobody is there to approve. Without chosen tools it runs isolated in an empty folder, never in the project container.")}
            {base?.agendaKeeper && ` ${t("In addition, the agenda keeper has cbase_agenda and cbase_agenda_maintain in every run — fixed, not selectable.")}`}
            {base?.timeline && ` ${t("In addition, the timeline agent has cbase_timeline and cbase_timeline_write in every run — fixed, not selectable. It only runs in chats of a project with the timeline switched on.")}`}
          </p>

          <div className={pane} data-outerloop-builtin="">
            <div className="flex flex-wrap items-center gap-2">
              <span className={lab}>{t("Built-in tools")}</span>
              <span className="text-[11.5px] text-dim">{t("{n} selected", { n: draft.builtin.length })}</span>
              <span className="flex-1" />
              <button type="button" onClick={() => set({ builtin: inventory.catalog.builtin.map((w) => w.name) })} disabled={!inventory.catalog.builtin.length} className={ghostSm}>{t("All")}</button>
              <button type="button" onClick={() => set({ builtin: [] })} disabled={!draft.builtin.length} className={ghostSm}>{t("None")}</button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-dim">{t("The CLI's own tools — including Bash, Edit, Write and web. Chosen ones run without asking; a permission request is denied without a card.")}</p>
            {/* Codex has no allowlist of built-ins (server outerloop/input.js builtinRow, connectors/codex.js) — the run frame says the same; like this hint it also names image view (view_image) and MCP resources. */}
            {draft.provider === "codex" && <p className="text-[11.5px] leading-relaxed text-warn" data-outerloop-codex-hint="">{t("Codex has no individual built-in tools: with a selection the run gets its shell, apply_patch, image viewing and the MCP servers’ resources (writing once Write, Edit, MultiEdit, NotebookEdit or Bash is selected) — the shell reads every file the process may read. Without a selection it has no shell.")}</p>}
            <div className="grid gap-1 @2xl/detail:grid-cols-2">
              {inventory.catalog.builtin.map((w) => {
                const on = draft.builtin.includes(w.name);
                return (
                  <label key={w.name} className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors ${on ? "bg-accent/8" : "hover:bg-hover"}`}>
                    <input type="checkbox" checked={on} onChange={(e) => set({ builtin: e.target.checked ? [...draft.builtin, w.name] : draft.builtin.filter((x) => x !== w.name) })} className="mt-0.5 accent-accent" />
                    <span className="min-w-0">
                      <span className="block font-mono text-[11.5px]">{w.name}</span>
                      {w.description && <span className="block text-[11px] leading-relaxed text-dim">{w.description}</span>}
                    </span>
                  </label>
                );
              })}
              {draft.builtin.filter((n) => !inventory.catalog.builtin.some((w) => w.name === n)).map((n) => (
                <label key={n} className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-accent/8 px-2.5 py-1.5">
                  <input type="checkbox" checked onChange={() => set({ builtin: draft.builtin.filter((x) => x !== n) })} className="mt-0.5 accent-accent" />
                  <span className="font-mono text-[11.5px]">{n} <span className="text-dim">· {t("not in the list")}</span></span>
                </label>
              ))}
            </div>
          </div>

          <McpToolChoice
            server={inventory.catalog.mcpServer}
            mcp={draft.mcp}
            onMcp={(mcp) => set({ mcp })}
            hint={t("Tools from external systems through an MCP server. Creating it and its token live under Coding → MCP; which of its tools THIS outer loop agent gets, you choose here.")}
          />

          {base && origin === "workspace" && projects && projects.length > 0 && (
            <div className={pane} data-outerloop-takeover="">
              <span className={lab}>{t("In projects")}</span>
              <p className="text-[11.5px] leading-relaxed text-dim">{t("A workspace agent counts as adopted in every project — switch it off for single projects here.")}</p>
              <div className="flex flex-col">
                {projects.map((p) => {
                  const on = !not.includes(p.id);
                  return (
                    <div key={p.id} className="flex items-center gap-3 border-b border-edge/60 px-1 py-2 last:border-b-0">
                      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "" : "text-dim"}`}>{p.name}</span>
                      <Toggle on={on} disabled={toggles === p.id} onClick={() => { void takeover(p.id, !on); }}
                        title={on ? t("Adopted in the project — click to switch off") : t("Switched off in the project — click to adopt")} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {base?.fixed && (
            <div className="flex flex-wrap items-center gap-2 px-1">
              <button type="button" onClick={() => { void reset(); }} disabled={busy} className={ghostSm} data-outerloop-reset="">{t("Reset to template")}</button>
              {/* `inventory.template` is the summarizer's template; the keeper has its own version and names the one it comes from. */}
              {base.summarizer
                ? <span className="text-[11.5px] text-dim">{t("Template {n}", { n: inventory.template.revision })}</span>
                : base.templateRevision != null && <span className="text-[11.5px] text-dim">{t("Template {n}", { n: base.templateRevision })}</span>}
            </div>
          )}
          {lockReason && <span className="px-1 text-[11.5px] text-dim">{lockReason}</span>}
          {err && <Hint tone="danger">{err}</Hint>}
        </div>
      </div>
    </Modal>
  );
}
