"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { api, type TriggerTestResult, type TriggerView, type WorkflowGraph, type WorkflowNode, type WorkflowTrigger } from "@/lib/api";
import { WorkflowTriggerSettings } from "@/components/workflow/WorkflowTriggerSettings";
import { Info, PlaceholderChips } from "@/components/workflow/PlaceholderChips";
import { WorkflowBadge, icon } from "@/components/workflow/WorkflowBadge";
import { fieldFull, fieldDense, iconBtn, marker } from "@/components/workflow/workflowForm";
import { SlashPalette } from "@/components/SlashPalette";
import { Toggle, Segments, quietDangerSm } from "@/components/CbKit";
import { filterPalette, placeSlash, slashQuery, slashKey, type PaletteEntry } from "@/lib/slash";
import { NODE_COMMANDS, PLACEHOLDER, capFromInput, capField, effectiveCaps, exitTitle, nodeModes, insertPlaceholder, checkCapContinue, checksEffective, rowsFor, type Cap, type WfRule } from "@/lib/workflow-node-form";
import { useT } from "@/lib/i18n";

// The settings of ONE step — the content of the sheet the editor renders around it
// (`<Sheet><WorkflowNodeDialog …/></Sheet>`; the sheet itself stays in the editor because the
// workflow meta sheet and `WorkflowRunsPane` use it too).
//
// Decisions that hold here:
//   · Explanatory text that only explains OPERATION is gone. Text that carries a RULE hangs as a
//     tooltip on the (i) next to the label — native `title`, as the kit toggle does it.
//   · Yes/no is ONE surface with a row per option and the kit `Toggle` on the right; no checkboxes.
//     Dependent fields (the yardstick) unfold as their own row below.
//   · "Check completion", "At the check cap" and "At the round cap" are THREE-VALUED (`Segments`):
//     "As workflow (…)" · On · Off or "As workflow (…)" · Question · Continue. The parenthesis
//     shows the INHERITED value — like the placeholder "5 · default" at the cap. A row only
//     appears where it takes effect (`rowsFor` with the defaults `wf`): the check cap only on a
//     step that effectively checks.
//   · "Rounds per run" appears ONLY on a step that lies on a cycle (`showsCap`): elsewhere the
//     value never takes effect. Empty means "what the cycle dictates", and the placeholder shows
//     the EFFECTIVE value (from `effectiveCaps`: "5 · default" or "20 · from Review").
//   · The command field has a picker like the composer (`SlashPalette`), but with a different
//     stock: only `/clear`, `/compact` and the skills (`NODE_COMMANDS`). Enter and Tab both just
//     insert here — there is nothing to send.
//   · No footer: changes apply at once (`onChange` → `updateNode`); close via × or a click beside.
//
// No import from `WorkflowEditor.tsx` (it imports this file — cycle guard
// web/test/import-cycles.test.mjs): the type name comes as a prop, the badge and the calculations
// from `WorkflowBadge.tsx` and `lib/workflow-node-form.ts`, the form classes (fields, markers,
// icon button) from `workflowForm.ts` — the same as in the editor and the trigger component.
//
// Density: rows `py-1.5`, fields 28 px, option labels 12 px, the card badge (22 px) in the header
// instead of a colour dot — fields and option labels as in the editor's "Workflow settings" sheet
// (whose option rows use `py-1`, its grid markers 11.5 px).

type Limits = { maxVisits: number; maxVisitsLimit: number; maxIterations: number; doneRounds: number };
type SkillShort = { name: string; description: string; originProject?: string };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rowClass = "flex items-center gap-3 px-3 py-1.5";
const labelClass = "flex min-w-0 shrink-0 items-center gap-1.5 text-[12px] font-medium";

const XIcon = () => icon(<><path d="M18 6 6 18M6 6l12 12" /></>);
const TrashIcon = () => icon(<><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></>, 14);

// What the two harness commands say in the picker (the skills bring their own description).
const COMMAND_TEXT: Record<(typeof NODE_COMMANDS)[number], string> = {
  clear: "Clear the context before the step runs",
  compact: "Compact the context before the step runs",
};
// The three placeholders of a step text with their meaning (tooltip per chip).
const PLACEHOLDER_TEXT: Record<(typeof PLACEHOLDER)[number], string> = {
  "{{input}}": "text given when the run starts",
  "{{element}}": "current loop item",
  "{{answer}}": "last answer to a question",
};
// One sentence in the header, only where the type carries a rule that the sheet does not show.
const HEADER_TEXT: Partial<Record<WorkflowNode["type"], string>> = {
  review: "One turn writes the request and the test instructions, then the run waits for you. Findings → back into fixing, approval → onward.",
  parallel: "Every outgoing edge is a branch; all run in ONE turn, one subagent each, and meet at the shared target node.",
  condition: "A small model judges and picks yes or no.",
};

/** One row of the options surface: label (+ (i)) on the left, the control on the right. */
function Row({ label, info, className = "", children }: { label: string; info?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`${rowClass} ${className}`}>
      <span className={labelClass}>{label}{info && <Info text={info} />}</span>
      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end">{children}</div>
    </div>
  );
}

export function WorkflowNodeDialog({ node, graph, trigger, typeLabel, cycle, caps, limits, wf, workspaceId, projectId, onChange, onRemove, onClose, triggerStatus, onTestTrigger }: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  /** The node's trigger, filled with its default by the editor (only `trigger` nodes read it). */
  trigger: WorkflowTrigger;
  typeLabel: string;         // translated, from TYPE (WorkflowBadge.tsx)
  cycle: Set<string>;       // nodesOnCycle(graph)
  caps: Map<string, Cap>; // effectiveCaps(graph, limits.maxVisits, wf)
  limits: Limits;           // doneRounds = run.doneRounds of the editing state
  wf: WfRule;              // the workflow defaults that "As workflow" inherits
  workspaceId: string;      // for effective-skills
  projectId: string | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
  onClose: () => void;
  triggerStatus: TriggerView | null;
  onTestTrigger: () => Promise<TriggerTestResult>;
}) {
  const t = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cmdRef = useRef<HTMLInputElement>(null);
  // Slash picker at the command field: the search behind the leading "/" (null = closed), the
  // highlighted entry and the skills — fetched on OPEN, not on render (see `updateSlash`).
  const [slashQ, setSlashQ] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [skills, setSkills] = useState<SkillShort[]>([]);

  const command = node.command ?? "";
  // WHETHER a row exists for this type is decided by the sheet logic (`rowsFor`, measured in the gate) —
  // per type only the wording (label, placeholder) and the measure (rows of the text field) remain here.
  const z = rowsFor(cycle, node, wf);
  const effective = caps.get(node.id);
  const modes = nodeModes(node);

  // Fetch fresh as soon as the picker opens — as in the composer: a skill that was deleted in the
  // meantime would go to the CLI as "/name", and it would swallow the whole message.
  const loadSkills = useCallback(async () => {
    try { setSkills(await api<SkillShort[]>(`/api/workspaces/${workspaceId}/effective-skills?projectId=${projectId ?? ""}`)); }
    catch { setSkills([]); }
  }, [workspaceId, projectId]);

  // The stock: first the two commands, then the skills (order as in the composer — the commands
  // always sit in the same place, the skills differ per workspace).
  const stock = useMemo<PaletteEntry[]>(() => [
    ...NODE_COMMANDS.map((name) => ({ name, description: t(COMMAND_TEXT[name]), group: "command" as const })),
    ...skills.map((sk) => ({
      name: sk.name,
      description: sk.description || t("This skill has no description."),
      group: "skill" as const,
      origin: sk.originProject || undefined,
    })),
  ], [skills, t]);
  const hits = useMemo(() => (slashQ === null ? [] : filterPalette(stock, slashQ)), [slashQ, stock]);

  function updateSlash(value: string, caret: number) {
    const q = slashQuery(value, caret);
    if (q !== null && slashQ === null) loadSkills();
    setSlashQ(q);
    if (q !== null) setSlashIdx(0);
  }
  function place(e: PaletteEntry) {
    const { text, caret } = placeSlash(command, slashQ, e.name);
    onChange({ command: text });
    setSlashQ(null);
    requestAnimationFrame(() => { const el = cmdRef.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  }
  // A placeholder chip: insert at the caret of the text field (a selection is replaced), caret
  // behind the token, focus back into the field.
  function placeholder(token: string) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? node.text.length;
    const end = ta?.selectionEnd ?? node.text.length;
    const { text, caret } = insertPlaceholder(node.text, start, end, token);
    onChange({ text });
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  }

  // What "As workflow" currently means — the INHERITED value, computed as the run computes it: for
  // the check and the check cap the workflow default, for the round cap the cycle (a neighbour with
  // "Continue"/"Question"), otherwise the default (`effectiveCaps` with "inherit" here).
  const inheritsCheck = checksEffective({ ...node, doneMode: "inherit" }, wf);
  const inheritsCheckCap = checkCapContinue({ ...node, doneCapMode: "inherit" }, wf);
  const inheritsRoundsCap = z.loopCap
    ? effectiveCaps({ nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, loopCapMode: "inherit" } : n)), edges: graph.edges }, limits.maxVisits, wf).get(node.id)?.auto === true
    : false;
  const asWorkflow = (value: string) => t("As workflow ({value})", { value: value });
  const doneModeLabel = t("Check for completion");
  const doneCapLabel = t("At the check cap");
  const loopCapLabel = t("At the round cap");
  const loopCapInfo = exitTitle(graph, node.id)
    ? t("Continue: instead of asking, the run leaves the loop and carries on at \"{exit}\".", { exit: exitTitle(graph, node.id) })
    : t("Continue: instead of asking, the run leaves the loop — this loop has no exit yet, so the run would end there.");
  // The label of the notification row is also the `title` of the toggle: the kit toggle is a
  // `role=switch` without text, and the label beside it is a <span>, not a <label> — without the
  // name a screen reader would read "switch, off" without saying which (as with the toggles on the
  // settings pages, NotificationSettings.tsx). The segments carry it as the group's `aria-label`.
  const notificationLabel = node.type === "review" ? t("Notify when the review is due") : t("Notify on arrival");

  const textLabel = node.type === "condition" ? t("Condition")
    : node.type === "ask" ? t("Question")
    : node.type === "loop" ? t("Build the list from")
    : node.type === "review" ? t("Guidance (optional)")
    : t("Instruction");
  const textPlaceholder = node.type === "condition" ? t("e.g. The tests are green.")
    : node.type === "review" ? t("e.g. Also name the test account.")
    : t("What should happen here?");
  const headerInfo = HEADER_TEXT[node.type];

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
        <WorkflowBadge type={node.type} size={22} t={t} />
        <span className="text-[15px] font-semibold">{typeLabel}</span>
        {headerInfo && <Info text={t(headerInfo)} />}
        <button onClick={onRemove} title={t("Delete step")} className={`ml-auto flex items-center gap-1 ${quietDangerSm}`}>
          <TrashIcon /> {t("Delete")}
        </button>
        <button onClick={onClose} title={t("Close")} aria-label={t("Close")} className={iconBtn}><XIcon /></button>
      </div>
      <div className="cb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-5">
        <label className={marker}>{t("Title")}</label>
        <input
          value={node.title}
          autoFocus={node.type !== "trigger"}
          onChange={(e) => onChange({ title: e.target.value })}
          className={fieldFull}
        />
        {z.trigger && (
          <WorkflowTriggerSettings
            trigger={trigger}
            status={triggerStatus}
            onChange={(patch) => onChange({ trigger: { ...trigger, ...patch } })}
            onTest={onTestTrigger}
          />
        )}
        {z.text && (
          <>
            <label className={`mt-1 ${marker}`}>{textLabel}</label>
            <textarea
              ref={taRef}
              value={node.text}
              onChange={(e) => onChange({ text: e.target.value })}
              rows={node.type === "instruction" || node.type === "parallel" ? 9 : 4}
              placeholder={textPlaceholder}
              // shrink-0: in the sheet's flex box the text field would otherwise shrink as soon as
              // something is added below, instead of the sheet scrolling.
              className={`${fieldFull} min-h-[76px] shrink-0 resize-y`}
            />
            <PlaceholderChips chips={PLACEHOLDER.map((token) => ({ token, title: t(PLACEHOLDER_TEXT[token]) }))} onChoice={placeholder} />
          </>
        )}
        {z.list && (
          <>
            <label className={`mt-1 ${marker}`}>{t("Fixed list")}</label>
            <textarea
              value={(node.items ?? []).join("\n")}
              onChange={(e) => onChange({ items: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
              rows={4}
              placeholder={t("empty = the model builds it")}
              className={`${fieldFull} shrink-0 resize-y`}
            />
            <div className="mt-1 flex items-center gap-3">
              <span className={marker}>{t("Max. items")}</span>
              <input
                type="number" min={1} max={limits.maxIterations}
                value={node.maxIterations ?? 20}
                onChange={(e) => onChange({ maxIterations: clamp(Number(e.target.value) || 1, 1, limits.maxIterations) })}
                className={`${fieldDense} w-24 text-right`}
              />
            </div>
          </>
        )}

        {/* The options: ONE surface, one row per option, hairlines between. Each row has its
            visibility rule; `end` has only the notification, `start`/`trigger` only the command. */}
        <div className="cb-kit-pane mt-2 shrink-0 divide-y divide-edge rounded-xl">
          {z.command && (
            // `relative` + `@container/composer` for the picker (it measures its width on the container).
            // In the composer the picker opens UPWARDS (`bottom-full`); here the row sits at the top of
            // the surface and the sheet scrolls — upwards the panel would run out of the scrollable
            // area and be cut off. The variants turn it downwards; the surface then scrolls along.
            <Row
              label={t("Command first")}
              info={t("Runs first when the step is reached. cbase executes /clear and /compact itself, a /skill loads that skill, anything else goes to the agent as a message. Placeholders allowed.")}
              className="relative @container/composer [&_[data-slash-pop]]:bottom-auto [&_[data-slash-pop]]:top-full [&_[data-slash-pop]]:mb-0 [&_[data-slash-pop]]:mt-1.5 [&_[data-slash-pop]]:origin-top"
            >
              {slashQ !== null && (
                <SlashPalette
                  entries={hits}
                  idx={slashIdx}
                  onIdx={setSlashIdx}
                  onChoice={place}
                  titleCommands={t("Commands")}
                  titleSkills={t("Skills")}
                  emptyText={t("No command and no skill matches.")}
                  identifier="workflow-node"
                />
              )}
              <input
                ref={cmdRef}
                value={command}
                onChange={(e) => { onChange({ command: e.target.value }); updateSlash(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                // The caret alone can also open or close the picker (click behind the space).
                onSelect={(e) => updateSlash(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                onKeyDown={(e) => {
                  if (slashQ === null) return;
                  // The same key rule as in the composer (lib/slash.ts, tested in the gate) — except that
                  // "send" inserts here too: there is nothing to submit on a step.
                  const action = slashKey({ key: e.key, shiftKey: e.shiftKey, hits: hits.length });
                  if (!action) return;
                  e.preventDefault();
                  const selected = hits[Math.min(slashIdx, hits.length - 1)];
                  if (action === "close") setSlashQ(null);
                  else if (action === "down") setSlashIdx((i) => (i + 1) % hits.length);
                  else if (action === "up") setSlashIdx((i) => (i - 1 + hits.length) % hits.length);
                  else place(selected);
                }}
                // Delayed as in the composer: a click on an entry arrives as mousedown BEFORE the focus
                // loss, and without the delay the blur would clear the panel before the click.
                onBlur={() => { setTimeout(() => setSlashQ(null), 120); }}
                placeholder={t("/clear, /compact or a message")}
                spellCheck={false}
                className={`${fieldFull} font-mono`}
              />
            </Row>
          )}
          {z.cap && (
            <Row
              label={t("Rounds per run")}
              info={t("How often this step may run in ONE run. Empty = the largest value set in the cycle, otherwise the default ({n}). What happens at the cap is set in the row \"At the round cap\".", { n: limits.maxVisits })}
            >
              <input
                type="number" min={1} max={limits.maxVisitsLimit}
                value={capField(node)}
                onChange={(e) => onChange({ maxVisits: capFromInput(e.target.value, limits.maxVisitsLimit) })}
                placeholder={effective?.from ? t("{n} · from {from}", { n: effective.cap, from: effective.from }) : t("{n} · default", { n: effective?.cap ?? limits.maxVisits })}
                // Wider than a number field: the placeholder carries a word ("5 · default") or a
                // title ("20 · from Review") — at 96 px it read "5 · defau".
                className={`${fieldDense} w-40 text-right`}
              />
            </Row>
          )}
          {z.loopCap && (
            <Row label={loopCapLabel} info={loopCapInfo}>
              <Segments
                label={loopCapLabel}
                value={modes.loopCapMode}
                onChange={(k) => onChange({ loopCapMode: k as WorkflowNode["loopCapMode"] })}
                items={[
                  { key: "inherit", label: asWorkflow(inheritsRoundsCap ? t("Continue") : t("Question##ask")) },
                  { key: "ask", label: t("Question##ask") },
                  { key: "continue", label: t("Continue") },
                ]}
              />
            </Row>
          )}
          {z.doneMode && (
            <Row
              label={doneModeLabel}
              info={t("After the turn, a model judges whether the step is finished; “not finished” means the same step keeps working. Costs one short model call per round.")}
            >
              <Segments
                label={doneModeLabel}
                value={modes.doneMode}
                onChange={(k) => onChange({ doneMode: k as WorkflowNode["doneMode"] })}
                items={[
                  { key: "inherit", label: asWorkflow(inheritsCheck ? t("on") : t("off")) },
                  { key: "on", label: t("On") },
                  { key: "off", label: t("Off") },
                ]}
              />
            </Row>
          )}
          {z.scale && (
            <div className="flex flex-col gap-1 px-3 py-1.5">
              <span className={marker}>{t("Yardstick (optional)")}</span>
              <textarea
                value={node.doneText ?? ""}
                onChange={(e) => onChange({ doneText: e.target.value })}
                rows={3}
                placeholder={t("Empty = this step's own instruction")}
                className={`${fieldFull} resize-y`}
              />
            </div>
          )}
          {z.doneCap && (
            <Row
              label={doneCapLabel}
              info={t("After {n} check rounds without \"done\": Question means the run stops and asks; Continue means it moves on to the next step without asking. The number is set in the workflow settings.", { n: limits.doneRounds })}
            >
              <Segments
                label={doneCapLabel}
                value={modes.doneCapMode}
                onChange={(k) => onChange({ doneCapMode: k as WorkflowNode["doneCapMode"] })}
                items={[
                  { key: "inherit", label: asWorkflow(inheritsCheckCap ? t("Continue") : t("Question##ask")) },
                  { key: "ask", label: t("Question##ask") },
                  { key: "continue", label: t("Continue") },
                ]}
              />
            </Row>
          )}
          {z.notification && (
            <Row
              label={notificationLabel}
              info={node.type === "review" ? t("Bell and iPhone notification, leads into this chat. Without it the run waits silently.") : t("Bell and iPhone notification, leads into this chat.")}
            >
              <Toggle on={node.notify === true} onClick={() => onChange({ notify: node.notify !== true })} title={notificationLabel} />
            </Row>
          )}
        </div>
      </div>
    </>
  );
}
