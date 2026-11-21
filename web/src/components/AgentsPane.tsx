"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Agent, type AgentMeta, type ProjectAgents, type SkillMeta } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { AgentDialog, type AgentDraft, type SkillChoice } from "@/components/AgentDialog";
import { OriginSection, OriginMarker } from "@/components/Origin";
import {
  FACTS, Fact, Tile, LIST_ROW, EmptyRow, Menu, MenuEntry, COLUMN_WIDTH, SYM, Toggle, PagesHeader, RowsArrow, primary,
} from "@/components/CbKit";

// Subagent management. Workspace level: CRUD of workspace agents. Project level: the project's own agents (CRUD) PLUS the
// workspace agents as a switchable list. App-managed, started as an agent type by cbase_agent.
//
// Flat, quiet form (see the Kit, "the form of instances"): rows are rounded and lighten under the pointer; in front a tile
// with the agent glyph (in a project, workspace agents are green = active here, dimmed = off), below it the description and
// the facts model · tools · skills with their symbols. Above the list the summary ("3 subagents · 1 with skills") next to
// "+ Subagent"; the explanatory sentence shows while the list is empty, otherwise as a short info next to it. In a project the
// two origins are sections with a tinted tile (`OriginSection`); an empty group is a quiet row with the way to create one
// (`EmptyRow`).
//
// NEW projects adopt the workspace agents (server: store/toolchain.js wsAgentsInProject); an existing project stays opt-in, so
// the sentence above the list follows THIS project's default (`wsAgentsDefault`), not an assumption.

/** The server's comma list as a list of names — empty stays empty. */
const skillList = (v: string | undefined) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Tools and skills of a definition on ONE line — empty if it names none (the short info next to the facts). */
function metaRow(a: Agent, t: ReturnType<typeof useT>) {
  return [a.tools ? `${t("Tools:")} ${a.tools}` : "", a.skills ? `${t("Skills:")} ${a.skills}` : ""].filter(Boolean).join(" · ");
}

/** The line above the list: how many subagents, how many of them bring skills; in a project own and active inherited ones. */
function summary(proj: boolean, own: Agent[], ws: Agent[], t: ReturnType<typeof useT>): string {
  if (proj) {
    const active = ws.filter((a) => a.enabled).length;
    return [
      t("{n} own", { n: own.length }),
      t("{n} of {m} from the workspace active", { n: active, m: ws.length }),
    ].join(" · ");
  }
  const parts = [ws.length === 1 ? t("1 subagent") : t("{n} subagents", { n: ws.length })];
  const withSkills = ws.filter((a) => skillList(a.skills).length > 0).length;
  if (withSkills) parts.push(t("{n} with skills", { n: withSkills }));
  return parts.join(" · ");
}

export function AgentsPane({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const t = useT();
  const question = useConfirm();
  const [wsAgents, setWsAgents] = useState<Agent[]>([]);
  const [projAgents, setProjAgents] = useState<Agent[]>([]);
  // `null` = not loaded yet. Empty is not unknown: while the answer is missing, no sentence about the workspace agents shows,
  // and an empty list only says "none" after loading.
  const [loaded, setLoaded] = useState(false);
  const [standard, setStandard] = useState<"on" | "off" | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  // The skills an agent can get here: the effective catalog of this place — in a project its own plus the adopted workspace
  // skills, in a workspace all (with origin). Same computation as for a chat's catalog (`effective-skills`), because the
  // start resolves against exactly that.
  const [skills, setSkills] = useState<SkillChoice[]>([]);

  const wsBase = `/api/workspaces/${workspaceId}/agents`;
  const projBase = projectId ? `/api/projects/${projectId}/agents` : null;

  const load = useCallback(async () => {
    if (projectId) {
      const r = await api<ProjectAgents>(`/api/projects/${projectId}/agents`);
      setProjAgents(r.projectAgents || []);
      setWsAgents(r.workspaceAgents || []);
 // An older server does not send the field — the old sentence (opt-in) applies.
      setStandard(r.wsAgentsDefault === "on" ? "on" : "off");
    } else {
      setWsAgents(await api<AgentMeta[]>(wsBase) as Agent[]);
      setProjAgents([]);
      setStandard(null);
    }
    setLoaded(true);
    try {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const list = await api<(SkillMeta & { originProject?: string })[]>(`/api/workspaces/${workspaceId}/effective-skills${q}`);
      setSkills(list.map((s) => ({ name: s.name, description: s.description, originProject: s.originProject || "" })));
    } catch { setSkills([]); } // the list is a convenience — the dialog then shows "no skills"
  }, [workspaceId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLoaded(false); load().catch(console.error); }, [load]);

  async function editAgent(scope: "ws" | "proj", id: string) {
    const base = scope === "proj" ? projBase! : wsBase;
    const ag = await api<Agent>(`${base}/${id}`);
    setDraft({ editing: id, scope, name: ag.name, description: ag.description, tools: ag.tools, model: ag.model, body: ag.body, skills: skillList(ag.skills), mcp: ag.mcp || {} });
  }
  async function saveAgent(d: AgentDraft) {
    const base = d.scope === "proj" ? projBase! : wsBase;
 // Always send `mcp`: the dialog shows the whole choice, so it is the declaration (empty = no server).
    const payload = JSON.stringify({ name: d.name.trim(), description: d.description, tools: d.tools, model: d.model, body: d.body, skills: d.skills, mcp: d.mcp });
    if (d.editing) await api(`${base}/${d.editing}`, { method: "PUT", body: payload });
    else await api(base, { method: "POST", body: payload });
    setDraft(null);
    await load();
  }
  async function delAgent(scope: "ws" | "proj", id: string, name: string) {
    if (!(await question(t("Delete subagent \"{name}\"?", { name }), { ok: t("Delete"), danger: true }))) return;
    const base = scope === "proj" ? projBase! : wsBase;
    await api(`${base}/${id}`, { method: "DELETE" });
    await load();
  }
  async function toggleWs(id: string, on: boolean) {
    if (!projectId) return;
    setToggling(id);
    try {
      await api(`/api/projects/${projectId}/agents/${id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: on }) });
      await load();
    } finally { setToggling(null); }
  }

  const newDraft = (scope: "ws" | "proj"): AgentDraft => ({ editing: null, scope, name: "", description: "", tools: "", model: "", body: "You are a specialized subagent.\n\n", skills: [], mcp: {} });

  // The facts of a definition: model, tools, skills — each with a symbol, only what it names.
  const facts = (a: Agent) => (a.model || a.tools || a.skills) ? (
    <span className={`mt-1 ${FACTS}`} title={metaRow(a, t) || undefined}>
      {a.model && <Fact symbol={SYM.model(12)} className="shrink-0"><span className="font-mono text-[11.5px]">{a.model}</span></Fact>}
      {a.tools && <Fact symbol={SYM.tool(12)}><span className="min-w-0 truncate font-mono text-[11.5px]">{a.tools}</span></Fact>}
      {a.skills && <Fact symbol={SYM.skill(12)}><span className="min-w-0 truncate">{skillList(a.skills).join(", ")}</span></Fact>}
    </span>
  ) : null;

  // One row per own agent: in front the tile, the name (14 px) and the description dimmed over two lines, below it the facts;
  // on the right the ⋯ and the arrow. A click on the row opens editing.
  const row = (a: Agent, scope: "ws" | "proj") => (
    <div
      key={a.id}
      role="button"
      tabIndex={0}
      onClick={() => editAgent(scope, a.id)}
      onKeyDown={(e) => { if (e.key === "Enter") editAgent(scope, a.id); }}
      className={`${LIST_ROW} cursor-pointer items-start hover:bg-hover`}
    >
      <Tile>{SYM.agent(16)}</Tile>
      <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-[14px] font-medium tracking-[-0.01em]">{a.name}</span>
        <span className="mt-0.5 line-clamp-2 max-w-[80ch] text-[12.5px] leading-relaxed text-dim">{a.description || t("(no description)")}</span>
        {facts(a)}
      </div>
      <div className="flex shrink-0 items-center gap-1 self-center">
        <Menu label={t("More")} silent>
          <MenuEntry label={t("Edit")} onClick={() => editAgent(scope, a.id)} />
          <MenuEntry label={t("Delete")} onClick={() => delAgent(scope, a.id, a.name)} danger />
        </Menu>
        <RowsArrow />
      </div>
    </div>
  );

  // The sentence about a project's workspace agents — it states what holds for THIS project.
  const wsHint = standard === "on"
    ? t("New projects adopt them automatically — switch them off for this project here. Edit them at workspace level.")
    : standard === "off"
      ? t("Off by default in the project — enable specifically for this project here. (Edit at the workspace level.)")
      : undefined;

  // Above the list the summary once there is something to count; otherwise (and as a short info next to it) the explanatory sentence.
  const explanation = projectId
    ? t("Agent types the agent in a chat starts as subagents.")
    : t("Agent types the agent in a chat starts as subagents. Available across the workspace and active automatically in new projects — switch them off there one by one.");
  const countable = loaded && (projectId ? projAgents.length + wsAgents.length > 0 : wsAgents.length > 0);
  const under = countable
    ? <span className="tabular-nums" title={explanation} data-agents-summary>{summary(!!projectId, projAgents, wsAgents, t)}</span>
    : explanation;

  return (
    <div className={`${COLUMN_WIDTH} flex min-h-0 flex-col pb-8`}>
      {projectId ? (
        <>
          <PagesHeader title={t("Subagents")} under={under}>
            <button type="button" onClick={() => setDraft(newDraft("proj"))} className={primary}>{t("+ Project subagent")}</button>
          </PagesHeader>

          <div className="flex flex-col gap-8">
          {/* Own first: this project's agents. */}
          <OriginSection kind="project" hint={t("Only in this project's chats and in workspace chats — other projects don't see them.")}>
            {(loaded || projAgents.length > 0) && (
              <div className="flex shrink-0 flex-col gap-0.5">
                {projAgents.length === 0
                  ? <EmptyRow create={() => setDraft(newDraft("proj"))}>{t("No project subagents yet.")}</EmptyRow>
                  : projAgents.map((a) => row(a, "proj"))}
              </div>
            )}
          </OriginSection>

          {/* Inherited below: the workspace agents with their switch for this project — one step quieter. */}
          <OriginSection kind="workspace" hint={wsHint}>
            {(loaded || wsAgents.length > 0) && <div className="flex shrink-0 flex-col gap-0.5">
              {wsAgents.length === 0 && <EmptyRow>{t("No workspace subagents.")}</EmptyRow>}
              {wsAgents.map((a) => (
                <div key={a.id} className={`${LIST_ROW} items-center hover:bg-hover`}>
                  <Tile color={a.enabled ? "text-ok" : "text-dim"} title={a.enabled ? t("Active in project") : t("Inactive in project")}>{SYM.agent(16)}</Tile>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] ${a.enabled ? "text-fg/90" : "text-dim"}`}>{a.name}</span>
                      <OriginMarker kind="workspace" />
                      {a.model && <span className="hidden min-w-0 @md/kit:flex"><Fact symbol={SYM.model(12)} className="text-[12px] text-dim"><span className="truncate font-mono text-[11.5px]">{a.model}</span></Fact></span>}
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-dim">{a.description || t("(no description)")}</div>
                  </div>
                  <Toggle
                    on={!!a.enabled}
                    disabled={toggling === a.id}
                    onClick={() => toggleWs(a.id, !a.enabled)}
                    title={a.enabled ? t("Active in the project — click to disable") : t("Inactive in the project — click to enable")}
                  />
                </div>
              ))}
            </div>}
          </OriginSection>
          </div>
        </>
      ) : (
        <>
          <PagesHeader title={t("Subagents")} under={under}>
            <button type="button" onClick={() => setDraft(newDraft("ws"))} className={primary}>{t("+ Subagent")}</button>
          </PagesHeader>
          {(loaded || wsAgents.length > 0) && (
            <div className="flex shrink-0 flex-col gap-0.5" data-agents-list>
              {wsAgents.length === 0
                ? <EmptyRow create={() => setDraft(newDraft("ws"))}>{t("No subagents yet.")}</EmptyRow>
                : wsAgents.map((a) => row(a, "ws"))}
            </div>
          )}
        </>
      )}

      {draft && <AgentDialog draft={draft} skills={skills} workspaceId={workspaceId} projectId={projectId} onSave={saveAgent} onClose={() => setDraft(null)} />}
    </div>
  );
}
