"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INSTRUCTION_SCOPES, changeInstruction, instructionsError, loadInstructions, createInstruction, deleteInstruction, arrangeInstructions,
  setInstructionTakeover, subscribeGlobalEvents,
  type AgentSection, type InstructionFields, type InstructionScope, type InstructionsStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { OriginSection } from "@/components/Origin";
import {
  Hint, Tile, LIST_ROW, EmptyRow, Modal, COLUMN_WIDTH, SYM, Toggle, PagesHeader, Segments, Word, field, ghost, ghostSm,
  primary, quietDanger,
} from "@/components/CbKit";

// Instructions for agents: the third kind in the "Agents" tab (outerloop/AgentsTab.tsx). Per workspace and per project an ordered
// list of sections (title, text, on/off, scope) that every agent receives in its system prompt according to its scope (`all` =
// main, sub and workflow agent, `main` = main run only, `sub` = subagents and workflow agents only). They replaced the personas.
//
// Workspace level (`projectId` null): the workspace sections, editable. Project level: on top the workspace sections, read-only,
// with the toggle "Apply in this project" (opt-out), below them the project sections with the same controls. The order on the
// page is the order in the prompt: workspace first, then project.
//
// The quiet page form (CbKit: `PagesHeader`, `LIST_ROW` with tile, `OriginSection` in the project, `EmptyRow`) as in
// AgentsPane.tsx; the editor is a kit `Modal` (portal at the body). Conflict (409): the server sends the current state along; the
// editor keeps the input and offers both: load the new state, or deliberately save one's own version over it.
// After every write the server emits the global event `instructions` { workspaceId }; the page reloads (also for changes from
// another window or from iOS).

type Draft = InstructionFields & {
  /** `null` = new section. */
  id: string | null;
  /** The level: `null` = workspace. */
  projectId: string | null;
  version: number;
  /** The server's state after a 409; while set, the editor shows the conflict hint. */
  conflict: AgentSection | null;
};

const newDraft = (projectId: string | null): Draft => ({ id: null, projectId, title: "", text: "", scope: "all", enabled: true, version: 0, conflict: null });
const draftFrom = (a: AgentSection, projectId: string | null): Draft => ({
  id: a.id, projectId, title: a.title, text: a.text, scope: a.scope, enabled: a.enabled, version: a.version, conflict: null,
});
const fieldsOf = (a: InstructionFields): InstructionFields => ({ title: a.title.trim(), text: a.text, scope: a.scope, enabled: a.enabled });

export function AgentInstructions({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const t = useT();
  const question = useConfirm();
  // `null` = not loaded yet (empty is not unknown: the empty row shows only after the answer).
  const [status, setStatus] = useState<InstructionsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The answer to an older request must not overwrite a younger one (project switch, fast events).
  const turn = useRef(0);

  const load = useCallback(async () => {
    const mine = ++turn.current;
    try {
      const s = await loadInstructions(workspaceId, projectId);
      if (mine !== turn.current) return;
      setStatus(s);
      setError(null);
    } catch (e) {
      if (mine === turn.current) setError(instructionsError(e));
    }
  }, [workspaceId, projectId]);

  useEffect(() => { setStatus(null); setHint(null); void load(); }, [load]);
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type === "instructions" && String(evt.workspaceId ?? "") === workspaceId) void load();
  }), [workspaceId, load]);

  const scopeName = (g: InstructionScope) => (g === "main" ? t("Main agent only") : g === "sub" ? t("Subagents only") : t("For all agents"));
  const scopeShort = (g: InstructionScope) => (g === "main" ? t("Main agent") : g === "sub" ? t("Subagents") : t("All agents"));
  const scopeExplanation = (g: InstructionScope) => (g === "main"
    ? t("Only the main agent of a chat receives this section.")
    : g === "sub"
      ? t("Only subagents and workflow agents receive this section, not the main agent.")
      : t("The main agent, subagents and workflow agents receive this section."));

  /** A write path with shared error handling: the error shows as a row above the list; always reload afterwards. */
  async function write(key: string, work: () => Promise<void>) {
    setBusy(key);
    setHint(null);
    try { await work(); setError(null); } catch (e) { setError(instructionsError(e)); } finally {
      setBusy(null);
      void load();
    }
  }

  const conflictHint = () => setHint(t("The section has changed in the meantime — the new version is loaded."));

  function toggleOn(a: AgentSection) {
    void write(a.id, async () => {
      const r = await changeInstruction(workspaceId, a.id, { ...fieldsOf(a), enabled: !a.enabled }, a.version);
      if (!r.ok) conflictHint();
    });
  }

  function move(level: AgentSection[], levelProject: string | null, i: number, direction: -1 | 1) {
    const j = i + direction;
    if (j < 0 || j >= level.length) return;
    const ids = level.map((a) => a.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // Show at once what the server is about to confirm (the answer comes again with the event anyway).
    setStatus((s) => {
      if (!s) return s;
      const fresh = ids.map((id) => level.find((a) => a.id === id)!).filter(Boolean);
      return levelProject ? { ...s, project: fresh } : { ...s, workspace: fresh };
    });
    void write(`order:${level[i].id}`, async () => { await arrangeInstructions(workspaceId, levelProject, ids); });
  }

  function takeOver(a: AgentSection) {
    if (!projectId || a.takenOver === null) return;
    const target = !a.takenOver;
    void write(a.id, async () => { await setInstructionTakeover(workspaceId, a.id, projectId, target); });
  }

  async function erase(e: Draft) {
    if (!e.id) return;
    if (!(await question(t("Delete section “{title}”? Agents stop receiving it from the next turn on.", { title: e.title || t("(untitled)") }), { ok: t("Delete"), danger: true }))) return;
    const id = e.id;
    setBusy(id);
    try {
      const r = await deleteInstruction(workspaceId, id, e.version);
      if (r.ok) setDraft(null);
      else if (r.conflict) setDraft({ ...e, conflict: r.conflict });
      else { setDraft(null); conflictHint(); }
    } catch (err) {
      setError(instructionsError(err));
      setDraft(null);
    } finally {
      setBusy(null);
      void load();
    }
  }

  /** Save from the editor. → an error text for the editor, or `null` (closed or conflict shown). */
  async function save(e: Draft): Promise<string | null> {
    try {
      if (!e.id) {
        await createInstruction(workspaceId, e.projectId, fieldsOf(e));
        setDraft(null);
      } else {
        const r = await changeInstruction(workspaceId, e.id, fieldsOf(e), e.version);
        if (r.ok) setDraft(null);
        else if (r.conflict) setDraft({ ...e, conflict: r.conflict });
        else return t("The section has changed in the meantime — reload.");
      }
      return null;
    } catch (err) {
      return instructionsError(err);
    } finally {
      void load();
    }
  }

  const cap = status?.cap;

  // One row of an editable section: tile, title and scope, below it the first line of the text; on the right up/down and the
  // on/off toggle. A click on the row opens the editor.
  const row = (a: AgentSection, i: number, level: AgentSection[], levelProject: string | null) => (
    <div
      key={a.id}
      role="button"
      tabIndex={0}
      onClick={() => setDraft(draftFrom(a, levelProject))}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setDraft(draftFrom(a, levelProject)); }}
      className={`${LIST_ROW} cursor-pointer items-center hover:bg-hover`}
      data-instruction={a.id}
    >
      <Tile color={a.enabled ? "text-fg/80" : "text-dim"}>{SYM.block(16)}</Tile>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] ${a.enabled ? "" : "text-dim"}`}>{a.title || t("(untitled)")}</span>
          <Word title={scopeExplanation(a.scope)}>{scopeShort(a.scope)}</Word>
          {!a.enabled && <Word>{t("off")}</Word>}
        </div>
        <span className="mt-0.5 line-clamp-1 max-w-[80ch] text-[12.5px] leading-relaxed text-dim">{preview(a.text) || t("(no text)")}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <ArrowButton direction="up" label={t("Move Up")} disabled={i === 0 || busy !== null} onClick={() => move(level, levelProject, i, -1)} />
        <ArrowButton direction="down" label={t("Move Down")} disabled={i === level.length - 1 || busy !== null} onClick={() => move(level, levelProject, i, 1)} />
        <span className="ml-1.5">
          <Toggle
            on={a.enabled}
            disabled={busy === a.id}
            onClick={() => toggleOn(a)}
            title={a.enabled ? t("On — click to switch off") : t("Off — click to switch on")}
          />
        </span>
      </div>
    </div>
  );

  // One level with its rows, or the empty row.
  const levelList = (level: AgentSection[], levelProject: string | null, empty: string) => (
    <div className="flex shrink-0 flex-col gap-0.5" data-instructions-level={levelProject ? "project" : "workspace"}>
      {level.length === 0
        ? <EmptyRow create={() => setDraft(newDraft(levelProject))}>{empty}</EmptyRow>
        : level.map((a, i) => row(a, i, level, levelProject))}
    </div>
  );

  const full = (level: AgentSection[] | null | undefined) => !!cap && (level?.length ?? 0) >= cap.sections;
  const createButton = (level: AgentSection[] | null | undefined, levelProject: string | null) => (
    <button
      type="button"
      onClick={() => setDraft(newDraft(levelProject))}
      disabled={!status || full(level)}
      title={full(level) ? t("At most {n} sections per level.", { n: cap?.sections ?? 0 }) : undefined}
      className={`${primary} disabled:opacity-50`}
    >
      {t("+ Section")}
    </button>
  );

  const explanation = t("Sections every agent receives in its system prompt according to their scope — main agent, subagents and workflow agents of every provider (Claude, Codex, OpenRouter). They are present in every turn, also after compacting; the repo's CLAUDE.md/AGENTS.md applies in addition.");

  return (
    <div className={`${COLUMN_WIDTH} flex min-h-0 flex-col pb-8`} data-agents-instructions>
      <PagesHeader title={t("Instructions")} under={explanation}>
        {createButton(projectId ? status?.project : status?.workspace, projectId)}
      </PagesHeader>

      {(error || hint) && (
        <div className="mb-4 flex flex-col gap-2">
          {error && <Hint tone="danger">{error}</Hint>}
          {hint && <Hint tone="warn">{hint}</Hint>}
        </div>
      )}

      {status && (projectId ? (
        <div className="flex flex-col gap-8">
          {/* Workspace first (the order in the prompt too): read-only, apply or opt out per section. */}
          <OriginSection kind="workspace" hint={t("Apply in every project unless it opts out. They are edited at workspace level.")}>
            <div className="flex shrink-0 flex-col gap-0.5" data-instructions-level="from-workspace">
              {status.workspace.length === 0 && <EmptyRow>{t("The workspace has no instructions.")}</EmptyRow>}
              {status.workspace.map((a) => {
                const applies = a.enabled && a.takenOver !== false;
                return (
                  <div key={a.id} className={`${LIST_ROW} items-center hover:bg-hover`} data-instruction={a.id}>
                    <Tile color={applies ? "text-ok" : "text-dim"} title={applies ? t("Applies in this project") : t("Does not apply in this project")}>{SYM.block(16)}</Tile>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] ${applies ? "text-fg/90" : "text-dim"}`}>{a.title || t("(untitled)")}</span>
                        <Word title={scopeExplanation(a.scope)}>{scopeShort(a.scope)}</Word>
                        {!a.enabled && <Word title={t("Turned off in the workspace — applies nowhere until it is turned on there again.")}>{t("off in the workspace")}</Word>}
                      </div>
                      <div className="mt-0.5 line-clamp-2 max-w-[80ch] whitespace-pre-line text-[12px] leading-snug text-dim">{preview(a.text, 2) || t("(no text)")}</div>
                    </div>
                    {a.takenOver !== null && (
                      <Toggle
                        on={a.takenOver}
                        disabled={busy === a.id}
                        onClick={() => takeOver(a)}
                        title={a.takenOver ? t("Adopted in this project — click to opt out") : t("Opted out in this project — click to adopt")}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </OriginSection>

          <OriginSection kind="project" hint={t("Apply only in chats of this project — after the workspace sections.")}>
            {levelList(status.project ?? [], projectId, t("This project has no instructions of its own yet."))}
          </OriginSection>
        </div>
      ) : levelList(status.workspace, null, t("No instructions yet. A section then appears in the system prompt of every agent in this workspace.")))}

      {draft && cap && (
        <InstructionEditor
          draft={draft}
          setDraft={setDraft}
          cap={cap}
          scopeName={scopeName}
          scopeExplanation={scopeExplanation}
          deletesCurrently={busy === draft.id}
          onSave={save}
          onDelete={() => void erase(draft)}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/** The first lines of a text for the preview on the row; blank lines are dropped. */
function preview(text: string, rows = 1): string {
  return text.split("\n").map((z) => z.trim()).filter(Boolean).slice(0, rows).join("\n");
}

function ArrowButton({ direction, label, disabled, onClick }: { direction: "up" | "down"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-md text-dim transition-colors hover:bg-edge hover:text-fg disabled:pointer-events-none disabled:opacity-30"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {direction === "up" ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
      </svg>
    </button>
  );
}

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

function InstructionEditor({ draft: e, setDraft, cap, scopeName, scopeExplanation, deletesCurrently, onSave, onDelete, onClose }: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  cap: InstructionsStatus["cap"];
  scopeName: (g: InstructionScope) => string;
  scopeExplanation: (g: InstructionScope) => string;
  deletesCurrently: boolean;
  onSave: (e: Draft) => Promise<string | null>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const [saves, setSaves] = useState(false);
  const set = (part: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...part } : d));
  const titleLength = e.title.trim().length;
  const textTooLong = e.text.length > cap.text;
  const titleWrong = titleLength === 0 || titleLength > cap.title;
  const k = e.conflict;

  async function save(d: Draft) {
    setSaves(true);
    setErr(null);
    const errorText = await onSave(d);
    setSaves(false);
    if (errorText) setErr(errorText);
  }

  return (
    <Modal onClose={onClose} width={760} className="h-[min(760px,100%)] p-0" label={e.id ? t("Edit section") : t("New section")}>
      <div className="shrink-0 px-6 pt-6">
        <h2 className="text-[15px] font-semibold tracking-tight">{e.id ? t("Edit section") : t("New section")}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-dim">
          {e.projectId ? t("Applies in chats of this project.") : t("Applies in all chats of this workspace — each project can opt out.")}
        </p>
        {k && (
          <div className="mt-3">
            <Hint tone="warn">
              <div>{t("The section has changed in the meantime (now “{title}”). Your input is not saved yet.", { title: k.title || t("(untitled)") })}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={ghostSm} onClick={() => set({ ...draftFrom(k, e.projectId) })}>{t("Load new version")}</button>
                <button type="button" className={ghostSm} onClick={() => void save({ ...e, version: k.version, conflict: null })}>{t("Save my version over it")}</button>
              </div>
            </Hint>
          </div>
        )}
        <label className="mt-4 flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={lab}>{t("Title")}</span>
            <span className={`text-[11px] tabular-nums ${titleLength > cap.title ? "text-danger" : "text-dim"}`}>{titleLength} / {cap.title}</span>
          </span>
          <input
            value={e.title}
            onChange={(ev) => set({ title: ev.target.value })}
            placeholder={t("e.g. working style, language, skills")}
            className={`${field} w-full`}
            autoFocus={!e.id}
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segments
            label={t("Scope")}
            items={INSTRUCTION_SCOPES.map((g) => ({ key: g, label: scopeName(g), title: scopeExplanation(g), data: { "data-instruction-scope": g } }))}
            value={e.scope}
            onChange={(g) => set({ scope: g as InstructionScope })}
          />
          <label className="flex items-center gap-2 text-[12.5px] text-dim">
            <Toggle on={e.enabled} onClick={() => set({ enabled: !e.enabled })} title={e.enabled ? t("On — click to switch off") : t("Off — click to switch on")} />
            {e.enabled ? t("On") : t("Off")}
          </label>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-dim">{scopeExplanation(e.scope)}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-6 pb-4 pt-3">
        <span className="mb-1 flex items-baseline justify-between gap-2">
          <span className={lab}>{t("Text")}</span>
          <span className={`text-[11px] tabular-nums ${textTooLong ? "text-danger" : "text-dim"}`}>
            {e.text.length.toLocaleString()} / {cap.text.toLocaleString()}
          </span>
        </span>
        <textarea
          value={e.text}
          onChange={(ev) => set({ text: ev.target.value })}
          placeholder={t("What should every agent know or follow? Tone, language, working style, skills to load …")}
          spellCheck={false}
          className={`${field} min-h-[240px] w-full flex-1 resize-none font-mono text-[12.5px] leading-relaxed`}
        />
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-6 py-4">
        {err && <span className="min-w-0 flex-1 truncate text-[12px] text-danger" title={err}>{err}</span>}
        {e.id && !err && (
          <button type="button" onClick={onDelete} disabled={deletesCurrently} className={`${quietDanger} mr-auto disabled:opacity-50`}>{t("Delete")}</button>
        )}
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button
          type="button"
          onClick={() => void save(e)}
          disabled={saves || titleWrong || textTooLong || !!k}
          title={k ? t("Resolve the conflict above first.") : undefined}
          className={`${primary} disabled:opacity-50`}
        >
          {saves ? t("Saving…") : t("Save")}
        </button>
      </div>
    </Modal>
  );
}
