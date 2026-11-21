"use client";

import { useEffect, useMemo, useState } from "react";
import type { TriggerView, WorkflowLock, WorkflowProblem, WorkflowRunSettings } from "@/lib/api";
import { icon } from "@/components/workflow/WorkflowBadge";
import { fieldFull, fieldDense } from "@/components/workflow/workflowForm";
import { Hint, Overline, Toggle, Segments, ghostSm, pillSm } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";
import { MAX_FALLBACK, STAGES_FALLBACK, Choice, tokenText, useAutocompactGlobal } from "@/components/Autocompact";
import { BAR_ACTION_CLASS, BAR_HEADER_CLASS, BAR_TITLE_CLASS, badgeText } from "@/lib/chat-bar";
import { LOCK_AREAS, WFE_CATEGORIES, WFE_TAB_KEY, isWfeTab, checkRoundsChoice, type LockArea, type WfeTab } from "@/lib/workflow-settings";
import { effortEntries, effortPicker, effortStandardLabel } from "@/lib/effort";
import { ModelChoice } from "@/components/ModelChoice";
import { useT } from "@/lib/i18n";

// The "Workflow settings" modal — the CONTENT; the editor renders the sheet around it
// (`<Sheet height={560}><WorkflowSettings …/></Sheet>`), as with the node dialog.
//
// The form is that of the right chat bar (ChatRightSidebar.tsx), just mirrored: on the left a 40 px
// icon rail (`border-r`, because it is on the left) with 36 px buttons, the accent mark at the left
// edge, badges and a `title` tooltip; on the right the panel with the 32 px header from
// lib/chat-bar.ts. The rows are those of the settings (`Row`/`Group` from SettingsKit: title on the
// left, control on the right, hint below clamped to three lines, ONE surface per group with
// hairlines).
//
// Decisions that hold here:
//   · The tabs are defined ONCE in lib/workflow-settings.ts (`WFE_CATEGORIES`, bound to iOS); here
//     only icon and badge per key — a `Record`, so that a new tab without an icon is a type error.
//   · State and saving stay in the editor ("Save" in the header bar saves graph and settings in ONE
//     go). Every change here goes out as a callback, the editor sets `dirty`; the footer says so
//     ("Unsaved changes"), because the header bar sits behind the scrim.
//   · Arming is the ONE action that saves at once (the server checks the trigger). Its error shows
//     IN the tab — the editor's hint sits under the header bar, where nobody sees it behind the
//     scrim.
//   · Escape closes through its own listener: the editor's returns early on select/input.
//   · Own identifiers `data-wfe-*` — NEVER `data-bar-*` (test benches and chat-bar.test bind those
//     to the chat bar).
//
// No import from `WorkflowEditor.tsx` (it imports this file — cycle guard
// web/test/import-cycles.test.mjs).

/** A provider from /api/providers, as the editor and modal need it. */
export type WfeProvider = { id: string; label: string; connected: boolean; models: { id: string; label: string; efforts?: string[] }[]; defaultModel?: string; caps?: { effort?: boolean } };
/** One row of the trigger list — the editor computes title and summary (it knows the trigger configuration). */
export type WfeTrigger = { id: string; title: string; summary: string; status: TriggerView | null };

// Concurrency: what makes two runs exclude each other? Order = LOCK_AREAS.
const LOCK_TEXT: Record<LockArea, { label: string; hint: string }> = {
  project: { label: "One run per project/repo", hint: "Recommended: within the same repo the second run waits, different repos still run in parallel." },
  workflow: { label: "One run per workflow", hint: "This workflow only ever runs once at a time — no matter which repo is affected." },
  event: { label: "One run per issue/MR", hint: "Never the same subject twice. Different issues will then run at the same time in the same folder, though." },
  custom: { label: "Custom key", hint: "A template with the same placeholders as a step's text." },
  off: { label: "No lock", hint: "Everything may run at once — only sensible if the runs don't touch anything shared." },
};

// Run settings: the same values as in a chat's composer (there PERM_MODES and the effort choice
// from lib/effort.ts). "" = "as usual" — the global provider, its default model or the chat's setting.
const PERM_OPTIONS: { id: WorkflowRunSettings["permissionMode"]; label: string }[] = [
  { id: "", label: "As in the chat" },
  { id: "bypassPermissions", label: "Full access" },
  { id: "acceptEdits", label: "Auto-edit" },
  { id: "plan", label: "Plan (read-only)" },
  { id: "default", label: "Ask" },
];
// The effort levels are deliberately NOT a fixed list here: they depend on the chosen model and come
// with it from /api/providers (`efforts` per model, see lib/effort.ts) — gpt-5.5, for one, rejects
// "max" with HTTP 400.

// The choices of the rows: on the right of the row, a fixed width so the column stays calm.
const selection = `${fieldDense} w-[220px] min-w-0`;

// Icons of the rail (18 px as in the chat bar).
const ICON: Record<WfeTab, React.ReactNode> = {
  general: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" /></>, 18),
  execution: icon(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9.5 9.5h5v5h-5z" /><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" /></>, 18),
  context: icon(<><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12.5 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>, 18),
  check: icon(<><path d="M12 3 19 6v5.5c0 4.3-2.9 7.7-7 9.5-4.1-1.8-7-5.2-7-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></>, 18),
  concurrency: icon(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></>, 18),
  trigger: icon(<><path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" /></>, 18),
};
const XIcon = () => icon(<><path d="M18 6 6 18M6 6l12 12" /></>, 14);
const OpenIcon = () => icon(<><path d="m9 18 6-6-6-6" /></>, 14);

export function WorkflowSettings({
  name, description, run, lock, providers, activeProvider, steps, problems, holding, active, trigger, doneRoundsMax,
  dirty, saving, onName, onDescription, onRun, onLock, onArm, onOpenStep, onClose,
}: {
  name: string;
  description: string;
  run: WorkflowRunSettings;
  lock: WorkflowLock;
  providers: WfeProvider[];   // ALL providers — the levels ask the unfiltered list (see below)
  activeProvider: string;   // the GLOBALLY active one (`active` from /api/providers) — "Default (global)" is computed with it
  steps: number;             // the editor's step counter
  problems: WorkflowProblem[]; // from the SERVER state (re-checked on save)
  holding: { key: string }[];
  active: boolean;           // trigger armed (server state)
  trigger: WfeTrigger[]; // trigger nodes of the EDITING STATE
  doneRoundsMax: number;     // limits.doneRoundsMax (10)
  dirty: boolean;
  saving: boolean;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onRun: (patch: Partial<WorkflowRunSettings>) => void;
  onLock: (l: WorkflowLock) => void;
  /** Saves the whole state with `active` flipped; returns "" or the error message. */
  onArm: () => Promise<string>;
  onOpenStep: (nodeId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const global = useAutocompactGlobal();
  // The last open tab. Read in the initialiser: the modal only comes into being on a click, so never
  // while hydrating the statically built page — and so it does not first jump to "General" on
  // opening. Every access in try/catch: a private window or blocked data must not kill the modal.
  const [tab, setTab] = useState<WfeTab>(() => {
    try {
      const v = typeof window === "undefined" ? null : localStorage.getItem(WFE_TAB_KEY);
      return isWfeTab(v) ? v : "general";
    } catch { return "general"; }
  });
  const [armError, setArmError] = useState("");
  const selectTab = (k: WfeTab) => {
    setTab(k);
    try { localStorage.setItem(WFE_TAB_KEY, k); } catch { /* only a convenience */ }
  };

  // Escape closes — also from within a field (the editor's listener returns early there).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Provider/model are chosen only among the CONNECTED ones — a run on a logged-out provider would not
  // start. The effort levels, by contrast, come from the UNFILTERED list (see `run.effort` below):
  // which levels a model carries depends on the model, not on the login. Filtering them too would
  // make the old choice permanent for a disconnected provider, e.g. "Max" for gpt-5.5 (HTTP 400).
  const connected = useMemo(() => providers.filter((p) => p.connected), [providers]);

  const category = WFE_CATEGORIES.find((k) => k.key === tab) ?? WFE_CATEGORIES[0];
  // Badges: the number of hints at "General", a dot at "Trigger" while armed.
  const badge: Record<WfeTab, string> = {
    general: badgeText(problems.length),
    execution: "",
    context: "",
    check: "",
    concurrency: "",
    trigger: active ? "•" : "",
  };

  async function arm() {
    setArmError("");
    setArmError(await onArm());
  }

  const globalPercent = global?.percent ?? 0;
  const globalMax = global?.maxTokens ?? 0;
  const questionContinue = [
    { key: "ask", label: t("Question##ask") },
    { key: "continue", label: t("Continue") },
  ];

  let content: React.ReactNode;
  if (tab === "general") {
    content = (
      <>
        <Group>
          <Row title={t("Name")} wide>
            <input
              data-wfe-fieldFull="name"
              value={name}
              onChange={(e) => onName(e.target.value)}
              className={`${fieldFull} font-semibold`}
              placeholder={t("Workflow name")}
            />
          </Row>
          <Row title={t("Description")} wide>
            <textarea
              data-wfe-fieldFull="description"
              value={description}
              onChange={(e) => onDescription(e.target.value)}
              rows={4}
              className={`${fieldFull} min-h-[96px] resize-y`}
              placeholder={t("What is this workflow for? (description)")}
            />
          </Row>
        </Group>
        <div className="mt-2 px-1 text-[11.5px] text-dim">{t("{n} steps", { n: steps })}</div>
        {problems.length > 0 && (
          <section data-wfe-hints className="mt-5 flex flex-col gap-1.5">
            <Overline>{t("Notes##hints")}</Overline>
            {problems.map((p, i) => (
              <Hint key={i} tone={p.level === "error" ? "danger" : "warn"}>{p.text}</Hint>
            ))}
            <p className="px-1 text-[11px] text-dim">{t("Notes are re-checked when you save.")}</p>
          </section>
        )}
      </>
    );
  } else if (tab === "execution") {
    content = (
      // What does the agent work with in this workflow? A triggered run has no composer in which
      // to set model or permissions.
      <Group hint={t("Apply to EVERY run of this workflow — including triggered ones, which have no user. Empty means “as usual”. A manual run switches its chat accordingly.")}>
        <Row title={t("Provider")}>
          <select
            data-wfe-fieldFull="provider"
            value={run.provider}
            onChange={(e) => onRun({ provider: e.target.value, model: "" })}
            className={selection}
          >
            <option value="">{t("Default (global)")}</option>
            {connected.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Row>
        <Row title={t("Model")}>
          {/* The shared model choice with search (components/ModelChoice.tsx). A model determines its provider
              too — otherwise a Codex model would run on the Claude connector (and vice versa); the provider is the row's group. */}
          <ModelChoice
            label={t("Model")}
            value={run.model}
            onChoice={(model, g) => onRun({ model, provider: model && g ? g.key : run.provider })}
            top={[{ value: "", label: t("Provider's default") }]}
            groups={(run.provider ? connected.filter((p) => p.id === run.provider) : connected).map((p) => ({
              key: p.id, label: p.label, options: p.models.map((m) => ({ value: m.id, label: m.label })),
            }))}
            base={selection}
            data={{ "data-wfe-fieldFull": "model" }}
          />
        </Row>
        {/* No choice where there are no levels (model without levels, provider with `caps.effort` off);
            the decision lives in the building block (`effortPicker`). */}
        {effortPicker(run.provider, run.model, providers, activeProvider) && (
        <Row title={t("Effort")}>
          {/* The UNFILTERED list (`providers`, not `connected`) — and an empty model resolves
              `effortSelection` via `defaultModel`: "Provider default" is a statement, not an unknown.
              A level the model does not carry stays visible and marked (it is stored, after all), and
              the mark names the SUBSTITUTE (`effortEntryLabel`, "Max · runs as X-High"). WHO rejects
              is in the title. The entries including the empty entry are built by the ONE block
              `effortEntries`. Empty transfers NOTHING: a manual start in an existing chat thinks with
              that chat's level, only a fresh run chat with the default level — labelled
              "As the chat · new: <level>" (`effortStandardLabel`, variant `asChat`). */}
          <select
            data-wfe-fieldFull="effort"
            value={run.effort}
            onChange={(e) => onRun({ effort: e.target.value as WorkflowRunSettings["effort"] })}
            className={selection}
          >
            {effortEntries(run.provider, run.model, providers, run.effort, effortStandardLabel(run.provider, run.model, providers, t, activeProvider, true), t, activeProvider).map((o) => (
              <option key={o.id} value={o.id} title={o.marker}>{o.label}</option>
            ))}
          </select>
        </Row>
        )}
        {/* Ultracode: the chat's switch, for EVERY step — independent of the level above. */}
        <Row title="Ultracode" hint={t("Every step runs with Ultracode: multi-agent orchestration without asking — the effort above applies unchanged.")}>
          <span data-wfe-fieldFull="ultracode" className="contents">
            <Toggle on={run.ultracode} onClick={() => onRun({ ultracode: !run.ultracode })} title="Ultracode" />
          </span>
        </Row>
        <Row title={t("Permissions")}>
          <select
            data-wfe-fieldFull="permissionMode"
            value={run.permissionMode}
            onChange={(e) => onRun({ permissionMode: e.target.value as WorkflowRunSettings["permissionMode"] })}
            className={selection}
          >
            {PERM_OPTIONS.map((o) => <option key={o.id} value={o.id}>{t(o.label)}</option>)}
          </select>
        </Row>
      </Group>
    );
  } else if (tab === "context") {
    content = (
      <Group
        title={t("Auto-compact")}
        hint={t("Default means: the chat's setting, otherwise the global one. Compaction only happens between two steps.")}
      >
        <Row title={t("Share of the window")} hint={t("Measured against the window of the model the chat runs on.")}>
          <span data-wfe-fieldFull="autocompact" className="contents">
            <Choice
              value={run.autocompact}
              stages={global?.stages ?? STAGES_FALLBACK}
              text={(s) => `${s} %`}
              standardText={globalPercent > 0 ? `${globalPercent} %` : t("off")}
              onSelect={(w) => onRun({ autocompact: w })}
              label={t("Share of the window")}
              identifier="workflow-percent"
            />
          </span>
        </Row>
        <Row title={t("No later than")} hint={t("Absolute cap in tokens. Compaction happens at the earlier of the two points; \"Off\" for both means: never automatically in this workflow.")}>
          <span data-wfe-fieldFull="autocompactMax" className="contents">
            <Choice
              value={run.autocompactMax}
              stages={global?.maxStages ?? MAX_FALLBACK}
              text={tokenText}
              standardText={globalMax > 0 ? tokenText(globalMax) : t("off")}
              onSelect={(w) => onRun({ autocompactMax: w })}
              label={t("No later than")}
              identifier="workflow-max"
            />
          </span>
        </Row>
      </Group>
    );
  } else if (tab === "check") {
    content = (
      <>
        <Group title={t("Check for completion")}>
          <Row
            title={t("Check every work step")}
            hint={t("After the turn of an instruction or parallel step, a model judges whether the step is done; \"not done\" means the same step keeps working. A step can deviate in its own dialog.")}
          >
            <span data-wfe-fieldFull="doneAll" className="contents">
              <Toggle on={run.doneAll} onClick={() => onRun({ doneAll: !run.doneAll })} title={t("Check every work step")} />
            </span>
          </Row>
          {/* The verdict is a oneshot of its own with its own model: whether a small model can measure
              an output against its yardstick depends on the workflow. ONE field — the model
              determines its provider too, as with the chat model. */}
          <Row
            title={t("Check model")}
            hint={t("Judges, at steps with “Check completion”, whether the step is finished after the turn — independent of the agent's model. Conditions and lists are still judged by the internal task “Workflow verdicts”.")}
          >
            <ModelChoice
              label={t("Check model")}
              value={run.doneModel}
              onChoice={(doneModel, g) => onRun({ doneModel, doneProvider: doneModel && g ? g.key : "" })}
              top={[{ value: "", label: t("Internal task “Workflow verdicts” (Settings → Models)") }]}
              groups={connected.map((p) => ({ key: p.id, label: p.label, options: p.models.map((m) => ({ value: m.id, label: m.label })) }))}
              base={selection}
              data={{ "data-wfe-fieldFull": "doneModel" }}
            />
          </Row>
          <Row title={t("Check rounds")} hint={t("How often a step may keep working after \"not done\" before the check cap applies.")}>
            <select
              data-wfe-fieldFull="doneRounds"
              value={String(run.doneRounds)}
              onChange={(e) => onRun({ doneRounds: Number(e.target.value) })}
              aria-label={t("Check rounds")}
              className={`${fieldDense} w-20 text-right`}
            >
              {checkRoundsChoice(doneRoundsMax).map((n) => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </Row>
          <Row title={t("At the check cap")} hint={t("Question: the run stops and asks you. Continue: it moves on to the next step without asking.")}>
            <span data-wfe-fieldFull="doneCapAuto" className="contents">
              <Segments
                items={questionContinue}
                value={run.doneCapAuto ? "continue" : "ask"}
                onChange={(k) => onRun({ doneCapAuto: k === "continue" })}
                label={t("At the check cap")}
              />
            </span>
          </Row>
        </Group>
        <Group title={t("Cycles")}>
          <Row title={t("At the round cap")} hint={t("When a step on a cycle has reached its rounds per run. Continue: the run leaves the loop without asking. The number is set on the step.")}>
            <span data-wfe-fieldFull="loopCapAuto" className="contents">
              <Segments
                items={questionContinue}
                value={run.loopCapAuto ? "continue" : "ask"}
                onChange={(k) => onRun({ loopCapAuto: k === "continue" })}
                label={t("At the round cap")}
              />
            </span>
          </Row>
        </Group>
      </>
    );
  } else if (tab === "concurrency") {
    // Two runs triggered at the same time work in the same folder — without a lock they overwrite
    // each other's files, git index and branch.
    content = (
      <>
        <Group hint={t("Every run holds a lock. Whoever doesn't get it waits until the holder is done: triggered events queue up by themselves, a manual start is rejected.")}>
          {LOCK_AREAS.map((scope) => {
            const o = LOCK_TEXT[scope];
            const selected = lock.scope === scope;
            return (
              <label key={scope} data-wfe-fieldFull={`lock-${scope}`} className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-colors hover:bg-hover/60">
                <input
                  type="radio"
                  name="wf-lock-scope"
                  checked={selected}
                  onChange={() => onLock({ ...lock, scope })}
                  className="mt-[3px] accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] leading-snug">{t(o.label)}</span>
                  <span className="mt-0.5 block text-[12px] leading-[1.45] text-dim">{t(o.hint)}</span>
                  {scope === "custom" && selected && (
                    <input
                      data-wfe-fieldFull="lock-template"
                      value={lock.template}
                      onChange={(e) => onLock({ ...lock, template: e.target.value })}
                      placeholder="{{project}}-{{branch}}"
                      className={`${fieldFull} mt-2 font-mono`}
                    />
                  )}
                </span>
              </label>
            );
          })}
        </Group>
        {holding.length > 0 && (
          <div className="mt-2 px-1 text-[11.5px] text-warn">
            {t("Currently locked: {keys}", { keys: holding.map((h) => h.key).join(", ") })}
          </div>
        )}
      </>
    );
  } else {
    content = trigger.length === 0 ? (
      <Group>
        <Row
          title={t("No trigger")}
          hint={t("This workflow starts by hand. For a trigger, drag a \"GitLab trigger\" from the library onto the canvas and connect it to the first step.")}
        />
      </Group>
    ) : (
      <>
        <Group title={t("Status")}>
          <Row
            title={<span className={active ? "font-medium text-accent" : ""}>{active ? t("Active") : t("Inactive")}</span>}
            hint={active
              ? t("The server polls the triggers; a new event starts a run.")
              : t("Arming saves the whole state. Only events from now on count.")}
          >
            <button
              type="button"
              data-wfe-fieldFull="active"
              onClick={arm}
              disabled={saving}
              title={active ? t("Turn the trigger off") : t("Arm the trigger (only events from now on count)")}
              className={`${ghostSm} disabled:opacity-40`}
            >
              {active ? t("Turn off") : t("Arm")}
            </button>
          </Row>
        </Group>
        {armError && <div className="mt-2"><Hint tone="danger">{armError}</Hint></div>}
        <Group title={t("Triggers")}>
          {trigger.map((a) => (
            <button
              key={a.id}
              type="button"
              data-wfe-fieldFull={`trigger-${a.id}`}
              onClick={() => onOpenStep(a.id)}
              title={t("Open the trigger's settings")}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] leading-snug">{a.title}</span>
                <span className="mt-0.5 block truncate text-[12px] text-dim">{a.summary}</span>
                {a.status && (
                  <span className="mt-0.5 block text-[11.5px] text-dim">
                    {t("triggered {n}×", { n: a.status.fires })}
                    {a.status.lastFireAt ? ` · ${t("last {when}", { when: new Date(a.status.lastFireAt).toLocaleString() })}` : ""}
                  </span>
                )}
                {a.status?.lastError && <span className="mt-0.5 block text-[11.5px] text-warn">{a.status.lastError}</span>}
              </span>
              <span className="shrink-0 text-dim"><OpenIcon /></span>
            </button>
          ))}
        </Group>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1" aria-label={t("Workflow settings")}>
      {/* The icon rail: 40 px, full height, on the left. Order = WFE_CATEGORIES; `aria-pressed`
          means "the panel shows this tab". */}
      <nav data-wfe-rail aria-label={t("Workflow settings categories")} className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-edge bg-bg pt-2">
        {WFE_CATEGORIES.map((k) => {
          const isActive = tab === k.key;
          const title = t(k.title);
          const b = badge[k.key];
          const count = k.key === "general" && problems.length > 0;
          return (
            <button
              key={k.key}
              type="button"
              data-wfe-tab={k.key}
              aria-pressed={isActive}
              aria-label={count ? `${title} · ${problems.length}` : b ? `${title} · ${t("Active")}` : title}
              title={title}
              onClick={() => selectTab(k.key)}
              className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors hover:bg-hover ${isActive ? "text-fg" : "text-dim hover:text-fg"}`}
            >
              {isActive && <span data-wfe-active aria-hidden className="absolute inset-y-0 left-0 w-0.5 rounded-r-full bg-accent" />}
              {ICON[k.key]}
              {b && (count ? (
                <span
                  data-wfe-badge={k.key}
                  aria-hidden
                  className={`absolute right-0.5 top-0.5 grid min-w-3.5 place-items-center rounded-full px-0.5 text-[9px] font-semibold leading-[14px] text-white ${problems.some((p) => p.level === "error") ? "bg-danger" : "bg-accent"}`}
                >
                  {b}
                </span>
              ) : (
                <span data-wfe-badge={k.key} aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
              ))}
            </button>
          );
        })}
      </nav>

      {/* The panel: 32 px header with the tab title, scrolling content, footer with "Done". */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header data-wfe-header className={`${BAR_HEADER_CLASS} border-b border-edge/60`}>
          <h2 className={BAR_TITLE_CLASS}>{t(category.title)}</h2>
          <button type="button" onClick={onClose} title={t("Close")} aria-label={t("Close")} className={BAR_ACTION_CLASS}><XIcon /></button>
        </header>
        <div key={tab} className="cb-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3.5">
          {content}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-edge/60 px-4 py-2">
          {dirty && (
            <span
              title={t("Changes are saved with \"Save\" in the header bar.")}
              className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn"
            >
              {t("Unsaved changes")}
            </span>
          )}
          <button type="button" onClick={onClose} className={`ml-auto ${pillSm} bg-dark text-white hover:opacity-90`}>{t("Done")}</button>
        </footer>
      </section>
    </div>
  );
}
