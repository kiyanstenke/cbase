"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  changeOuterLoop, outerLoopInventory, deleteOuterLoop, outerLoopProject, outerLoopTakeover, resetOuterLoop,
  subscribeGlobalEvents, type OuterLoopAgent, type OuterLoopInventory, type Project,
} from "@/lib/api";
import {
  Section, FACTS, Fact, Hint, Tile, LIST_ROW, EmptyRow, Menu, MenuEntry, MenuSeparator, COLUMN_WIDTH, SYM, primary, Toggle,
  PagesHeader, RowsArrow,
} from "@/components/CbKit";
import { OriginSection, OriginMarker } from "@/components/Origin";
import { useConfirm } from "@/components/Prompts";
import { useT } from "@/lib/i18n";
import { OuterLoopEditor, type OuterLoopNew } from "@/components/outerloop/OuterLoopEditor";
import { OuterLoopRuns } from "@/components/outerloop/OuterLoopRuns";
import { ApprovalMarksSection } from "@/components/outerloop/ApprovalMarks";
import { triggerRow, fixedName, upkeepTallyText, ineffectiveText, toolCount } from "@/components/outerloop/outerLoopText";

// Coding → Agents → Outer loop. The user-managed background agents that watch chats and write a note per run, in the quiet form of the
// subagents page (AgentsPane), like the projects page (kit parts in CbKit.tsx): no surface per group, rounded rows, lighter under the
// pointer; in front the tile (eye, summarizer: lines, chat-own: speech bubble) in the color of its state — green on, accent during a run,
// yellow cannot run (no model/provider), dimmed off or switched off in the project. On the name only state words that are not the normal
// case; role, project, chat, trigger, tools, scope, default and model as facts with icons. Each group is a `Section` (origin:
// `OriginSection`), an empty one an `EmptyRow`; above the list the summary ("4 agents · 3 on · 1 running"). At the end of an editable row
// the arrow to the editor. Editor, runs and chat info are not touched by this.
//
// The fixed group holds the summarizer and below it the agenda keeper (tile: checkmark in a box) with the tally of its changes as a fact.
// What "fixed" means — no delete, "Reset to template", "new template" — hangs on `fixed`, not on `summarizer`.
//
// Workspace level: fixed (summarizer, agenda keeper — no delete, "Reset to template") · Workspace · Projects · Chats (with a jump into the
// chat; chat-own agents are created only in the chat info). The switch on the row is the agent's `enabled`.
// In a project: first the project's own agents, below them the workspace agents including the summarizer with the TAKEOVER switch for this
// project (no row = taken over) — they are edited on the workspace level.
//
// "Not loaded yet" (`null`) never shows "none" (empty is not unknown). Reloaded on the `outer_loop` event (every state change of a run) —
// so the "running" mark follows without a polling timer.

/** The tile color: yellow if it should run and cannot (no model, no provider); dimmed if it is off (or switched off in the project);
 *  accent while a run is running; green if it is on. */
function tileColor(a: OuterLoopAgent, retired: boolean): string {
  if (retired) return "text-dim";
  if (!a.effective) return a.ineffectiveReason === "off" || !a.ineffectiveReason ? "text-dim" : "text-warn";
  if (a.running > 0) return "text-accent";
  return "text-ok";
}

/** The line above the list: how many agents, how many on, how many running now; in a project own and taken over. */
function summary(items: OuterLoopAgent[], projectWs: (OuterLoopAgent & { takenOver: boolean })[] | null, projectId: string | null, t: ReturnType<typeof useT>): string {
  if (projectId) {
    const own = items.filter((a) => a.origin === "project" && a.projectId === projectId);
    const ws = projectWs ?? [];
    return [
      t("{n} own", { n: own.length }),
      t("{n} of {m} from the workspace active", { n: ws.filter((a) => a.takenOver).length, m: ws.length }),
    ].join(" · ");
  }
  const parts = [items.length === 1 ? t("1 agent") : t("{n} agents", { n: items.length }), t("{n} on", { n: items.filter((a) => a.enabled).length })];
  const run = items.filter((a) => a.running > 0).length;
  if (run) parts.push(t("{n} running", { n: run }));
  return parts.join(" · ");
}

/** "To chat": a Coding chat opens here in Coding (ChatPane picks up `cbase-open-chat`). The jump is offered only for a chat of the kind
 *  "normal" (`chatKind`) — ChatPane would otherwise open any other kind in the Coding area. */
function openChat(chatId: string) {
  window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: chatId }));
}

export function OuterLoopPane({ workspaceId, projectId, projects }: {
  workspaceId: string;
  projectId: string | null;
  projects?: Project[];
}) {
  const t = useT();
  const question = useConfirm();
  const [inventory, setInventory] = useState<OuterLoopInventory | null>(null);
  const [projectWs, setProjectWs] = useState<(OuterLoopAgent & { takenOver: boolean })[] | null>(null);
  const [err, setErr] = useState("");
  const [editor, setEditor] = useState<{ agent: OuterLoopAgent | null; fresh?: OuterLoopNew } | null>(null);
  const [runs, setRuns] = useState<OuterLoopAgent | null>(null);
  const [toggles, setToggles] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([outerLoopInventory(workspaceId), projectId ? outerLoopProject(projectId) : Promise.resolve(null)]);
      setInventory(b);
      setProjectWs(p ? p.items : null);
      setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, [workspaceId, projectId]);
  useEffect(() => { setInventory(null); setProjectWs(null); void load(); }, [load]);
  useEffect(() => subscribeGlobalEvents((evt) => { if (evt.type === "outer_loop") void load(); }), [load]);

  const groups = useMemo(() => {
    const items = inventory?.items ?? [];
    return {
      summarizer: items.find((a) => a.summarizer) ?? null,
      keeper: items.find((a) => a.agendaKeeper) ?? null,
      timeline: items.find((a) => a.timeline) ?? null,
      workspace: items.filter((a) => a.origin === "workspace" && !a.fixed),
      project: items.filter((a) => a.origin === "project" && (!projectId || a.projectId === projectId)),
      chat: items.filter((a) => a.origin === "chat"),
    };
  }, [inventory, projectId]);

  async function toggleOn(a: OuterLoopAgent) {
    setToggles(a.id); setErr("");
    try { await changeOuterLoop(workspaceId, a.id, { enabled: !a.enabled }); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setToggles(null); }
  }
  async function toggleTakeover(a: OuterLoopAgent & { takenOver: boolean }) {
    if (!projectId) return;
    setToggles(a.id); setErr("");
    try { await outerLoopTakeover(projectId, a.id, !a.takenOver); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setToggles(null); }
  }
  async function erase(a: OuterLoopAgent) {
    const text = a.running > 0
      ? t("Delete outer-loop agent “{name}”? It is running right now — the run is ended. Its notes and runs go with it.", { name: a.name })
      : t("Delete outer-loop agent “{name}”? Its notes and runs go with it.", { name: a.name });
    if (!(await question(text, { ok: t("Delete"), danger: true }))) return;
    try { await deleteOuterLoop(workspaceId, a.id); await load(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function reset(a: OuterLoopAgent) {
    const text = a.timeline
      ? t("Reset the timeline agent to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort and “on” stay.")
      : a.agendaKeeper
      ? t("Reset the agenda keeper to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort, “on” and “mark changes” stay.")
      : t("Reset the summarizer to the cbase template? Name, task, triggers and tools come from the template; provider, model, effort and “on” stay.");
    if (!(await question(text, { ok: t("Reset") }))) return;
    try { await resetOuterLoop(workspaceId, a.id); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  // One row: in front the tile (eye, for the summarizer the lines, for a chat-own agent the speech bubble) in the color of its state,
  // the name with the state words (only what is not the normal case), the task dimmed on two lines, below it the facts with icons
  // (role, project, chat, trigger, tools, default, model). There is no scope any more: the server does not send it, and an agent with
  // the dead column "managing" shows here without assignment — it is available on no chat (server outerloop/activation.js areaMatches).
  // `right`: the row's switch (on or takeover); `editable`: a click opens the editor; `retired`: not taken over in the project (the
  // tile dimmed).
  const row = (a: OuterLoopAgent, opts: { right?: React.ReactNode; editable: boolean; quieter?: boolean; retired?: boolean }) => {
    const meta = [
      triggerRow(a.trigger, t),
      t("{n} tools", { n: toolCount(a) }),
      a.origin !== "chat" && a.defaultNew ? t("Default for new chats") : "",
    ].filter(Boolean).join(" · ");
    const edit = () => { if (opts.editable) setEditor({ agent: a }); };
    const ineffective = !a.effective ? ineffectiveText(a.ineffectiveReason, t) || t("off") : "";
    return (
      <div
        key={a.id}
        role={opts.editable ? "button" : undefined}
        tabIndex={opts.editable ? 0 : undefined}
        onClick={edit}
        onKeyDown={(e) => { if (e.key === "Enter") edit(); }}
        data-outerloop-agent={a.id}
        className={`${LIST_ROW} items-start hover:bg-hover ${opts.editable ? "cursor-pointer" : ""}`}
      >
        <Tile color={tileColor(a, !!opts.retired)} title={ineffective || (a.running > 0 ? t("running") : undefined)}>
          {a.summarizer ? SYM.summarize(16) : a.agendaKeeper ? SYM.check(16) : a.timeline ? SYM.project(16) : a.origin === "chat" ? SYM.chat(16) : SYM.eye(16)}
        </Tile>
        <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] ${opts.quieter && !a.enabled ? "text-dim" : ""}`}>{a.name || t("(no name)")}</span>
            {opts.quieter && <span className="self-center"><OriginMarker kind="workspace" /></span>}
            {ineffective && <span className={`shrink-0 text-[12px] ${a.ineffectiveReason === "off" || !a.ineffectiveReason ? "text-dim" : "text-warn"}`}>{ineffective}</span>}
            {a.running > 0 && <span className="shrink-0 text-[12px] text-accent">{t("running")}</span>}
            {a.fixed && a.templateNew && <span className="shrink-0 text-[12px] text-dim" title={t("There is a newer cbase template")}>{t("new template")}</span>}
          </div>
          <div className="mt-0.5 line-clamp-2 max-w-[80ch] text-[12.5px] leading-relaxed text-dim">{a.job || t("(no task)")}</div>
          <span className={`mt-1 ${FACTS}`} title={meta}>
            {a.summarizer && <Fact symbol={SYM.summarize(12)} className="shrink-0">{fixedName(a, t)}</Fact>}
            {a.agendaKeeper && <Fact symbol={SYM.check(12)} className="shrink-0">{fixedName(a, t)}</Fact>}
            {a.timeline && <Fact symbol={SYM.project(12)} className="shrink-0">{fixedName(a, t)}</Fact>}
            {a.agendaKeeper && a.upkeepTally && (
              <span className="shrink-0 tabular-nums" title={t("Changes by the agenda keeper: standing = not taken back by the main agent")} data-outerloop-upkeep-tally="">
                {upkeepTallyText(a.upkeepTally, t)}
              </span>
            )}
            {a.origin === "project" && !projectId && a.projectName && <Fact symbol={SYM.project(12)}><span className="min-w-0 truncate">{a.projectName}</span></Fact>}
            {a.origin === "chat" && <Fact symbol={SYM.chat(12)} title={t("Chat")}><span className="min-w-0 truncate">{a.chatTitle || t("(deleted chat)")}</span></Fact>}
            <Fact symbol={SYM.blitz(12)}><span className="min-w-0 truncate">{triggerRow(a.trigger, t)}</span></Fact>
            <Fact symbol={SYM.tool(12)} className="shrink-0 tabular-nums">{t("{n} tools", { n: toolCount(a) })}</Fact>
            {a.origin !== "chat" && a.defaultNew && <span className="shrink-0">{t("Default for new chats")}</span>}
            {a.model && <span className="hidden min-w-0 @md/kit:flex"><Fact symbol={SYM.model(12)}><span className="truncate font-mono text-[11.5px]">{a.model}</span></Fact></span>}
          </span>
        </div>
        {/* Switch and menu catch click and Enter themselves — otherwise every switch click would open the editor. The arrow sits
            outside: a click on it opens the editor like the row. */}
        <div className="flex shrink-0 items-center gap-1 self-center">
        <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {opts.right}
          <Menu label={t("More")} silent>
            {opts.editable && <MenuEntry label={t("Edit")} onClick={() => setEditor({ agent: a })} />}
            <MenuEntry label={t("runs")} onClick={() => setRuns(a)} />
            {a.origin === "chat" && a.chatId && a.chatKind === "normal" && <MenuEntry label={t("Back to chat")} onClick={() => openChat(a.chatId!)} />}
            {opts.editable && a.fixed && <MenuEntry label={t("Reset to template")} onClick={() => { void reset(a); }} />}
            {opts.editable && !a.fixed && (
              <>
                <MenuSeparator />
                <MenuEntry label={t("Delete")} onClick={() => { void erase(a); }} danger />
              </>
            )}
          </Menu>
        </span>
        {opts.editable && <RowsArrow />}
        </div>
      </div>
    );
  };

  const enableToggle = (a: OuterLoopAgent) => (
    <Toggle on={a.enabled} disabled={toggles === a.id} onClick={() => { void toggleOn(a); }}
      title={a.enabled ? t("On — click to switch off") : t("Off — click to switch on")} />
  );

  const newWs = () => setEditor({ agent: null, fresh: { origin: "workspace" } });
  const newProject = () => { if (projectId) setEditor({ agent: null, fresh: { origin: "project", projectId } }); };
  // No surface, no hairlines: the rows stand rounded one below the other.
  const list = "flex shrink-0 flex-col gap-0.5";

  // Above the list the summary once the data is there; before that (and as a short info on it) the explanatory sentence.
  const explanation = t("Background agents that watch chats and write a note per run. The summarizer is built in — only its notes are visible to other agents.");

  return (
    <div className={`${COLUMN_WIDTH} flex min-h-0 flex-col pb-8`} data-outerloop-pane="">
      <PagesHeader
        title={t("Outer loop")}
        under={inventory && (inventory.items.length > 0 || (projectId && projectWs))
          ? <span className="tabular-nums" title={explanation} data-outerloop-summary>{summary(inventory.items, projectWs, projectId, t)}</span>
          : explanation}
      >
        <button type="button" onClick={projectId ? newProject : newWs} className={primary}>{projectId ? t("+ Project agent") : t("+ Outer-loop agent")}</button>
      </PagesHeader>
      {err && <div className="pb-5"><Hint tone="danger">{err}</Hint></div>}

      <div className="flex flex-col gap-8">
      {inventory && !projectId && (
        <>
          {/* The fixed group: the summarizer, directly below it the agenda keeper — exactly one each per workspace, not deletable. */}
          <Section symbol={SYM.padlock(15)} title={t("Built in")} under={t("The summarizer summarizes every watched chat for other agents, the agenda keeper keeps the agenda up to date when the main agent forgets, the timeline agent records what really happened in a project. Without a chosen model they are off.")}>
            <div className={list} data-outerloop-fixed="">
              {groups.summarizer
                ? row(groups.summarizer, { right: enableToggle(groups.summarizer), editable: true })
                : <EmptyRow>{t("No summarizer yet — the server creates it on the next start.")}</EmptyRow>}
              {groups.keeper
                ? row(groups.keeper, { right: enableToggle(groups.keeper), editable: true })
                : <EmptyRow>{t("No agenda keeper yet — the server creates it on the next start.")}</EmptyRow>}
              {groups.timeline
                ? row(groups.timeline, { right: enableToggle(groups.timeline), editable: true })
                : <EmptyRow>{t("No timeline agent yet — the server creates it on the next start.")}</EmptyRow>}
            </div>
          </Section>
          <OriginSection kind="workspace" hint={t("Count as adopted in every project — can be switched off there one by one.")}>
            <div className={list}>
              {groups.workspace.length === 0
                ? <EmptyRow create={newWs}>{t("No workspace agents yet.")}</EmptyRow>
                : groups.workspace.map((a) => row(a, { right: enableToggle(a), editable: true }))}
            </div>
          </OriginSection>
          {groups.project.length > 0 && (
            <Section symbol={SYM.project(15)} title={t("Projects")} under={t("Created inside the project; they only apply there.")}>
              <div className={list}>{groups.project.map((a) => row(a, { right: enableToggle(a), editable: true }))}</div>
            </Section>
          )}
          {groups.chat.length > 0 && (
            <Section symbol={SYM.chat(15)} title={t("Chats")} under={t("Chat-owned agents — created in the chat's chat info, they go with it.")}>
              <div className={list}>{groups.chat.map((a) => row(a, { right: enableToggle(a), editable: true }))}</div>
            </Section>
          )}
          {/* The marks apply per workspace (not per project) — hence only on the workspace level. */}
          <ApprovalMarksSection workspaceId={workspaceId} groups={inventory.catalog.groups} onChanged={() => { void load(); }} />
        </>
      )}

      {inventory && projectId && (
        <>
          <OriginSection kind="project" hint={t("Watch only chats of this project.")}>
            <div className={list}>
              {groups.project.length === 0
                ? <EmptyRow create={newProject}>{t("No project agents yet.")}</EmptyRow>
                : groups.project.map((a) => row(a, { right: enableToggle(a), editable: true }))}
            </div>
          </OriginSection>
          <OriginSection kind="workspace" hint={t("Adopted in this project by default — switch off here. Edit at workspace level.")}>
            {projectWs && (
              <div className={list}>
                {projectWs.length === 0 && <EmptyRow>{t("No workspace agents.")}</EmptyRow>}
                {projectWs.map((a) => row(a, {
                  editable: false,
                  quieter: true,
                  retired: !a.takenOver,
                  right: (
                    <Toggle on={a.takenOver} disabled={toggles === a.id} onClick={() => { void toggleTakeover(a); }}
                      title={a.takenOver ? t("Adopted in the project — click to switch off") : t("Switched off in the project — click to adopt")} />
                  ),
                }))}
              </div>
            )}
          </OriginSection>
        </>
      )}
      </div>

      {editor && inventory && (
        <OuterLoopEditor
          workspaceId={workspaceId}
          inventory={inventory}
          agent={editor.agent}
          fresh={editor.fresh}
          projects={projects}
          onClose={() => setEditor(null)}
          onSaved={() => { void load(); }}
        />
      )}
      {runs && <OuterLoopRuns workspaceId={workspaceId} agent={runs} onClose={() => setRuns(null)} onOpenChat={(id) => { setRuns(null); openChat(id); }} />}
    </div>
  );
}
