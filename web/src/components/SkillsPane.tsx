"use client";

import { useEffect, useMemo, useState } from "react";
import {
  changeSkill, loadSkill, setUpSkill,
  type SkillArea, type SkillOwner, type SkillMeta, type SkillProjectName,
} from "@/lib/api";
import { SkillDialog, type SkillDraft } from "@/components/SkillDialog";
import { OriginSection, OriginMarker } from "@/components/Origin";
import {
  AgentsWriteToggle, DeletedSkills, SkillChangeFacts, SkillRequestCard, SkillHistorySection, useSkillsEvent,
} from "@/components/SkillHistory";
import { useConfirm } from "@/components/Prompts";
import {
  FACTS, Fact, Hint, Tile, LIST_ROW, EmptySentence, EmptyRow, Menu, MenuEntry, MenuSeparator, RemoveButton, COLUMN, SYM, Toggle,
  PagesHeader, primary,
} from "@/components/CbKit";
import { hiddenText, tokenShort, covered } from "@/lib/skills";
import { SKILLS_BEGINNING, skillsProcedure, type CatalogStatus, type SkillsProcedure, type SkillsState } from "@/lib/skills-procedure";
import { useT } from "@/lib/i18n";

// Coding → Skills — in the left coding bar right after Credentials, and by the SAME principle as Credentials
// (VarsPane.tsx):
//
//  · Workspace level: ONLY the workspace coding skills, per row read-only "Hidden in: A, B" — hiding happens only in the
//    project view, not here;
//  · Project level: on top the project's own skills (create, edit, delete), below them those of the workspace with a
//    switch per row — opt-out: a workspace skill applies in every project until it is hidden there;
//  · above each level the cost line "In the catalogue here: n skills · ~X tokens per request", computed on the SERVER for
//    exactly this level (`skill-catalog`, the same computation as the catalogue in the system prompt) — the client estimates nothing.
//
// Nothing is ever moved: created in the wrong place means delete and create anew.
//
// The main agents of the coding chats write skills themselves: per row "changed by agent · <chat> · <time>" and
// "Deletion requested", in the dialog the "History" tab with undo and the request card, under the list "Recently
// deleted", in the header of the workspace level the switch "Agents may change skills". The building blocks are in
// SkillHistory.tsx; every mutation sends the `skills` event, on which the page reloads.
//
// The old top-level page `/skills` is only a redirect here (app/skills/page.tsx).
export function SkillsPane({ workspaceId, projectId = null }: { workspaceId: string; projectId?: string | null }) {
  const t = useT();
  // Loading, hiding, deleting and the cost line run in lib/skills-procedure.ts (without React, run in the gate): an error
  // survives the reload it triggers; the cost line takes only the latest response; "in flight" is a set.
  // `own`/`workspace` are `null` until loaded — an empty list BEFORE loading is not "there are none".
  const { status: state, procedure } = useSkillsProcedure("coding", workspaceId, projectId);
  const { own, workspace: wsSkills, busy } = state;
  const upkeep = useSkillUpkeep("coding", procedure, workspaceId);
  // Every mutation of the workspace (human, agent, undo, request, decision) sends `skills`: the list reloads.
  useSkillsEvent(workspaceId, () => { procedure.load({ keepError: true }).catch(() => {}); });

  const inProject = Boolean(projectId);
  const owner: SkillOwner = projectId ? { kind: "project", projectId } : { kind: "workspace", workspaceId };
  const location = inProject ? t("Coding · project skill") : t("Coding · workspace skill");
  const list = own ?? [];
  const obscured = covered(list, wsSkills ?? []);
  const hiddenCount = list.filter((s) => (s.hiddenIn?.length ?? 0) > 0).length;

  const explanation = inProject
    ? t("Instructions for this project only, with the workspace's below. A workspace skill applies in every project until it is hidden here; with the same name, the project skill wins.")
    : t("Instructions for recurring tasks. A workspace skill applies in every project of this workspace until a project hides it. The catalogue sits in every coding chat's system prompt; the agent fetches the instructions via cbase_skill.");
  const summary = inProject
    ? [
        t("{n} own", { n: list.length }),
        t("{n} of {m} from the workspace available", { n: (wsSkills ?? []).filter((s) => s.enabled === true).length, m: (wsSkills ?? []).length }),
      ].join(" · ")
    : [
        list.length === 1 ? t("1 skill") : t("{n} skills", { n: list.length }),
        ...(hiddenCount > 0 ? [t("{n} hidden in individual projects", { n: hiddenCount })] : []),
      ].join(" · ");
  const something = list.length + (wsSkills?.length ?? 0) > 0;

  const ownRows = own === null ? null : list.length === 0 ? (
    inProject
      ? <EmptyRow>{t("No project skills yet.")}</EmptyRow>
      : (
        <EmptySentence title={t("No skills yet.")}>
          {t("A skill is a reusable instruction. Create the first one — it applies in every project of this workspace until a project hides it.")}
        </EmptySentence>
      )
  ) : (
    <SkillRows list={list} onOpen={(s) => upkeep.open(owner, location, s)} onDelete={(s) => upkeep.erase(owner, s)} />
  );

  return (
    <div className={`${COLUMN} flex min-h-0 flex-col pb-8`} data-skills-level={inProject ? "project" : "workspace"}>
      <PagesHeader
        title={inProject ? t("Project skills") : t("Skills")}
        under={<>
          {something
            ? <span className="tabular-nums" title={explanation} data-skills-summary>{summary}</span>
            : <span>{explanation}</span>}
          <SkillCost
            catalog={state.catalog}
            who={inProject
              ? t("A chat in this project sees its own skills and the workspace's that are not hidden — name and purpose of each in the system prompt; the agent fetches the instructions only when it needs them.")
              : t("A workspace chat sees the workspace skills and the skills of every project — name and purpose of each in the system prompt; the agent fetches the instructions only when it needs them.")}
          />
        </>}
      >
        {!inProject && <AgentsWriteToggle workspaceId={workspaceId} />}
        <button type="button" onClick={() => upkeep.fresh(owner, location)} className={`${primary} flex items-center gap-1.5`} data-skill-new>
          {t("+ Skill")}
        </button>
      </PagesHeader>

      <SkillError error={state.error} onClose={() => procedure.setError(null)} />

      <div className="flex flex-col gap-8">
        {inProject ? <OriginSection kind="project">{ownRows}</OriginSection> : ownRows}

        {/* Project: the workspace coding skills with a switch per row (opt-out) — the same pattern as the workspace
            credentials in VarsPane. Hiding happens ONLY here, addressed by skill id. */}
        {inProject && (
          <OriginSection
            kind="workspace"
            hint={t("Available in every project by default — including a newly created workspace skill. Hide it here for this project specifically; it is edited in the workspace.")}
          >
            <div className="flex shrink-0 flex-col gap-0.5">
              {wsSkills === null ? null : wsSkills.length === 0 ? (
                <EmptyRow>{t("No workspace skills.")}</EmptyRow>
              ) : (
                wsSkills.map((s) => (
                  <div key={s.id} className={`${LIST_ROW} items-center hover:bg-hover`} data-skill-workspace={s.name}>
                    <Tile color={s.enabled === true ? "text-ok" : "text-dim"}>{SYM.skill(16)}</Tile>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`min-w-0 truncate font-mono text-[13px] font-medium ${s.enabled === false ? "text-dim" : "text-fg/90"}`}>{s.name}</span>
                        <OriginMarker kind="workspace" />
                      </div>
                      <div className={`${FACTS} mt-0.5`}>
                        {s.enabled === false && <span className="shrink-0">{t("hidden in this project")}</span>}
                        {s.enabled === true && obscured.has(s.name) && (
                          <span className="shrink-0" title={t("With the same name, the project skill wins — only it appears in this project's catalogue.")}>
                            {t("overridden by the project skill of the same name")}
                          </span>
                        )}
                        {s.description && <span className="min-w-0 truncate">{s.description}</span>}
                        <SkillChangeFacts s={s} />
                      </div>
                    </div>
                    {/* `enabled: null` = the server did not report the state (a missing field is not a statement): no
                        switch that claimed "off" and on click set a state nobody knew. */}
                    {s.enabled === null ? (
                      <span
                        className="shrink-0 text-[12px] text-dim"
                        title={t("The server did not say whether this skill is hidden here — reload the page; if it stays like this, the server is older than this interface.")}
                        data-skill-status-unknown
                      >
                        {t("state unknown")}
                      </span>
                    ) : (
                      <Toggle
                        on={s.enabled}
                        onClick={() => { procedure.toggle(s).catch(() => {}); }}
                        disabled={busy.includes(s.id)}
                        title={s.enabled ? t("Available — click to hide") : t("Hidden — click to show")}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          </OriginSection>
        )}

        <DeletedSkills workspaceId={workspaceId} projectId={projectId} onRestored={() => { procedure.load().catch(() => {}); }} />
      </div>

      {upkeep.dialog}
    </div>
  );
}

// ── The building blocks of the skills page ───────────────────────────────────────────────────────────────────────────────────────────

/** State and procedure of a skills page. Pages hang on workspace and project via `key` — a switch is a new state. */
export function useSkillsProcedure(area: SkillArea, workspaceId: string, projectId: string | null): { status: SkillsState; procedure: SkillsProcedure } {
  const [status, setStatus] = useState<SkillsState>(SKILLS_BEGINNING);
  const procedure = useMemo(() => skillsProcedure({ area, workspaceId, projectId }, setStatus), [area, workspaceId, projectId]);
  useEffect(() => { procedure.load().catch(() => {}); }, [procedure]);
  return { status, procedure };
}

/**
 * Create, edit, delete — ONE path. The area is fixed here (by where the page sits), the dialog never chooses it. Errors
 * and reloading go through the page's procedure (lib/skills-procedure.ts): a failed delete reloads anyway and keeps its message.
 */
export function useSkillUpkeep(area: SkillArea, procedure: SkillsProcedure, historyIn: string | null = null) {
  const t = useT();
  const question = useConfirm();
  // `rev` counts the reloads of the open skill (after an undo in the "History" tab): the dialog holds its draft itself
  // and is rebuilt via the key. `requestId` = the open delete request from the list row.
  const [openDraft, setOpen] = useState<{ draft: SkillDraft; owner: SkillOwner; location: string; requestId: string | null; rev: number } | null>(null);

  const startNew = (owner: SkillOwner, location: string) =>
    setOpen({ draft: { editing: null, name: "", description: "", body: "# \n" }, owner, location, requestId: null, rev: 0 });

  async function open(owner: SkillOwner, location: string, s: SkillMeta) {
    try {
      const full = await loadSkill(owner, s.id);
      setOpen({ draft: { editing: s.id, name: full.name, description: full.description, body: full.body }, owner, location, requestId: s.openRequest?.id ?? null, rev: 0 });
    } catch (e) { procedure.setError((e as Error).message); }
  }

  /** After an undo: read the skill afresh. If it is gone (a create was undone), the dialog closes. */
  async function fresh() {
    procedure.load().catch(() => {});
    const o = openDraft;
    if (!o?.draft.editing) return;
    try {
      const full = await loadSkill(o.owner, o.draft.editing);
      setOpen((x) => (x && x.draft.editing === full.id
        ? { ...x, draft: { editing: full.id, name: full.name, description: full.description, body: full.body }, rev: x.rev + 1 }
        : x));
    } catch { setOpen(null); }
  }

  async function erase(owner: SkillOwner, s: SkillMeta) {
    if (!(await question(t("Delete skill “{name}”?", { name: s.name }), { ok: t("Delete"), danger: true }))) return;
    await procedure.erase(owner, s.id);
  }

  const skillId = openDraft?.draft.editing ?? null;
  const dialog = openDraft ? (
    <SkillDialog
      key={`${skillId ?? "fresh"}:${openDraft.rev}`}
      draft={openDraft.draft}
      location={openDraft.location}
      top={historyIn && openDraft.requestId ? <SkillRequestCard requestId={openDraft.requestId} onDecided={(x) => { procedure.load().catch(() => {}); if (x?.status === "approved") setOpen(null); }} /> : undefined}
      history={historyIn && skillId ? <SkillHistorySection workspaceId={historyIn} skillId={skillId} onBack={() => { fresh().catch(() => {}); }} /> : undefined}
      onClose={() => setOpen(null)}
      onSave={async (d) => {
        if (d.editing) await changeSkill(openDraft.owner, d.editing, d);
        else await setUpSkill(openDraft.owner, area, d);
        setOpen(null);
        procedure.load().catch(() => {});
      }}
    />
  ) : null;

  return { fresh: startNew, open, erase, dialog };
}

/** The own skills of a level: rounded rows without hairlines (the shape of instances, kit), the spark tile in front,
 *  edit and delete behind the ⋯. A coding workspace skill names, read-only, the projects that hide it. */
export function SkillRows({ list, onOpen, onDelete }: {
  list: (SkillMeta & { hiddenIn?: SkillProjectName[] | null })[];
  onOpen: (s: SkillMeta) => void;
  onDelete: (s: SkillMeta) => void;
}) {
  const t = useT();
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      {list.map((s) => {
        const hidden = hiddenText(s.hiddenIn ?? null);
        return (
          <div key={s.id} className={`${LIST_ROW} items-center hover:bg-hover`} data-skill={s.name}>
            <Tile>{SYM.skill(16)}</Tile>
            <button type="button" onClick={() => onOpen(s)} title={t("Edit")} className="min-w-0 flex-1 cursor-pointer text-left">
              <div className="truncate font-mono text-[13.5px] font-medium">{s.name}</div>
              <div className={`${FACTS} mt-0.5`}>
                <span className="min-w-0 truncate">{s.description || t("(no description)")}</span>
                <SkillChangeFacts s={s} />
                {hidden && (
                  <Fact symbol={SYM.project(12)} data={{ "data-skill-hidden": "" }} title={t("Hiding happens in the project view (enter the project → Skills).")}>
                    <span className="min-w-0 truncate">{t("Hidden in")}: {hidden}</span>
                  </Fact>
                )}
              </div>
            </button>
            <Menu label={t("More")} silent>
              <MenuEntry label={t("Edit")} onClick={() => onOpen(s)} />
              <MenuSeparator />
              <MenuEntry label={t("Delete")} danger onClick={() => onDelete(s)} />
            </Menu>
          </div>
        );
      })}
    </div>
  );
}

/** The cost line: count and tokens of THIS level's catalogue, computed by the server. While loading it is silent; if it
 *  fails it says so dimmed (message in the tooltip) — silence would otherwise mean two things, and an invented 0 would
 *  claim an empty catalogue. */
export function SkillCost({ catalog, who }: { catalog: CatalogStatus; who: string }) {
  const t = useT();
  if (catalog.kind === "loading") return null;
  if (catalog.kind === "error") {
    return (
      <span className="text-dim/70" title={catalog.text ?? t("The response carried no numbers.")} data-skill-catalog-error>
        {t("Catalogue not readable")}
      </span>
    );
  }
  const { count, token: raw } = catalog.value;
  const token = tokenShort(raw);
  return (
    <span className="tabular-nums" title={who} data-skill-catalog={`${count}:${raw}`}>
      {count === 1
        ? t("In the catalogue here: 1 skill · ~{token} tokens per request", { token })
        : t("In the catalogue here: {n} skills · ~{token} tokens per request", { n: count, token })}
    </span>
  );
}

/** An error line under the header, closable. */
export function SkillError({ error, onClose }: { error: string | null; onClose: () => void }) {
  const t = useT();
  if (!error) return null;
  return (
    <div className="mb-4 shrink-0">
      <Hint tone="danger">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <RemoveButton label={t("Close")} onClick={onClose} />
        </div>
      </Hint>
    </div>
  );
}
