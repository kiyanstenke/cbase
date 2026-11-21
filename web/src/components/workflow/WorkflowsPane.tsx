"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type TriggerView, type WorkflowMeta } from "@/lib/api";
import { WorkflowEditor } from "@/components/workflow/WorkflowEditor";
import {
  FACTS, Fact, Hint, Tile, LIST_ROW, EmptySentence, EmptyRow, Menu, MenuEntry, COLUMN_WIDTH, SYM, PagesHeader, RowsArrow, primary,
} from "@/components/CbKit";
import { OriginSection, OriginMarker } from "@/components/Origin";
import { useConfirm, usePrompt } from "@/components/Prompts";
import { useT } from "@/lib/i18n";

// Workflow management. Workspace level: CRUD of the workspace workflows. Project level: own project
// workflows (CRUD) PLUS the workspace workflows as an adoptable list (opt-in) — the same pattern as
// skills, agents and MCP servers.
//
// Form: the quiet page of the projects. The overview sits in the shared column under the kind bar
// (WorkflowsTab.tsx) with the quiet page header; rows have no hairlines, rounded corners, lighter
// under the pointer. In front a tile with the graph glyph of the rail in the colour of the state
// (green: trigger listening, yellow: holds a lock, muted: trigger off or not adopted in the
// project); "locks" as a word only when it is so; trigger, steps and trigger line or description as
// facts with symbols. Above the list the summary ("5 workflows · 2 triggers active"), the
// explanatory sentence on an empty list or as a short info beside it; in a project the origins as
// `OriginSection`. The header stays put, the lists scroll below in full width (the scrollbar at the
// stage edge, not mid-page). The editor (branch `editing`) is not affected.

// How does this workflow serialise? Shown in the list because it explains why a trigger is doing
// nothing right now (someone holds the lock).
const LOCK_LABEL: Record<string, string> = {
  project: "sequential per project",
  workflow: "sequential per workflow",
  event: "sequential per issue/MR",
  custom: "sequential per custom key",
  off: "parallel allowed",
};

// One-liner for a trigger in the list ("GitLab · group/project · 2 events · fired 3×").
function triggerLine(tv: TriggerView, t: (k: string, p?: Record<string, string | number>) => string) {
  const where = tv.scope === "project" || tv.scope === "group" ? tv.target || "?" : t("All my projects");
  const parts = ["GitLab", where, tv.events.length === 1 ? t("1 event") : t("{n} events", { n: tv.events.length })];
  if (tv.fires) parts.push(t("triggered {n}×", { n: tv.fires }));
  if (tv.missing) parts.push(t("not fully configured yet"));
  return parts.join(" · ");
}

// The switch: trigger armed/off or, in a project, adopted/not. The accent means "listening" here —
// a permanent state that is a signal.
function Toggle({ enabled, busy, title, onClick }: { enabled: boolean; busy: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={busy}
      title={title}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-edge"} disabled:opacity-50`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function WorkflowsPane({ workspaceId, projectId, onEditingChange }: {
  workspaceId: string;
  projectId: string | null;
  // Tells the frame that the editor is open — it then hides its sub-tab bar so the canvas gets the
  // full height.
  onEditingChange?: (editing: boolean) => void;
}) {
  const t = useT();
  // NEVER window.prompt(): Electron silently ignores it — in the client nothing happened on create
  // (in the browser it did, which is why it slipped through the test).
  const ask = usePrompt();
  const question = useConfirm();
  const [own, setOwn] = useState<WorkflowMeta[]>([]);
  const [adoptable, setAdoptable] = useState<WorkflowMeta[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { onEditingChange?.(!!editing); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState("");

  const base = projectId ? `/api/projects/${projectId}/workflows` : `/api/workspaces/${workspaceId}/workflows`;

  const load = useCallback(async () => {
    setOwn(await api<WorkflowMeta[]>(base));
    setAdoptable(projectId
      ? await api<WorkflowMeta[]>(`/api/projects/${projectId}/workspace-workflows`).catch(() => [])
      : []);
  }, [base, projectId]);
  useEffect(() => { load().catch((e) => setError(String(e))); }, [load]);

  async function create() {
    const name = await ask(t("Workflow name:"), t("New workflow"));
    if (!name?.trim()) return;
    try {
      const created = await api<WorkflowMeta>(base, { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await load();
      setEditing(created.id);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }
  async function remove(id: string, name: string) {
    if (!(await question(t("Delete workflow \"{name}\"?", { name }), { ok: t("Delete"), danger: true }))) return;
    await api(`${base}/${id}`, { method: "DELETE" });
    await load();
  }
  // Arm/disarm a trigger. The server checks that the trigger is complete and sets the watermark to
  // NOW — the error message ("no event chosen yet") belongs visibly in the list, otherwise the
  // switch would just stay put.
  async function toggleActive(w: WorkflowMeta) {
    setToggling(w.id);
    setError("");
    try {
      await api(`${base}/${w.id}`, { method: "PUT", body: JSON.stringify({ active: !w.active }) });
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setToggling(null); }
  }
  // Adoption is name-based (name unique per scope; on rename the server follows).
  async function toggleAdopt(name: string, on: boolean) {
    if (!projectId) return;
    setToggling(name);
    try {
      await api(`/api/projects/${projectId}/workspace-workflows/${encodeURIComponent(name)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: on }) });
      await load();
    } finally { setToggling(null); }
  }

  if (editing) {
    return (
      <WorkflowEditor
        base={base}
        id={editing}
        workspaceId={workspaceId}
        projectId={projectId}
        onClose={() => { setEditing(null); load().catch(console.error); }}
        onSaved={() => load().catch(console.error)}
      />
    );
  }

  // One row per own workflow: in front the tile with the graph glyph of the rail in the colour of its
  // state (yellow: a run holds a lock; green: the trigger listens; muted: the trigger is off; neutral
  // without trigger), the name and — only when it is not the normal case — "locks"; below the facts
  // trigger · steps · trigger line or description · lock kind.
  const row = (w: WorkflowMeta) => {
    const locks = (w.holding?.length ?? 0) > 0;
    const color = locks ? "text-warn" : w.triggers.length > 0 ? (w.active ? "text-ok" : "text-dim") : "text-fg/80";
    return (
      <div
        key={w.id}
        role="button"
        tabIndex={0}
        onClick={() => setEditing(w.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(w.id); } }}
        title={t("Edit")}
        className={`${LIST_ROW} cursor-pointer items-center hover:bg-hover`}
      >
        <Tile color={color}>{SYM.workflow(16)}</Tile>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{w.name}</span>
            {locks && (
              <span
                title={t("A run of this workflow holds the lock {keys} — others are waiting.", { keys: (w.holding ?? []).map((h) => h.key).join(", ") })}
                className="shrink-0 text-[12px] text-warn"
              >
                {t("locking")}
              </span>
            )}
          </div>
          <div className={`mt-0.5 ${FACTS}`}>
            {w.triggers.length > 0 && (
              <Fact
                symbol={SYM.blitz(12)}
                title={w.triggers.map((tv) => `${tv.title || t("Trigger")}: ${triggerLine(tv, t)}`).join("\n")}
                className={`shrink-0 ${w.active ? "text-ok" : ""}`}
              >
                {w.active ? t("Trigger active") : t("Trigger off")}
              </Fact>
            )}
            <Fact symbol={SYM.steps(12)} className="shrink-0 tabular-nums">
              {w.steps.approx ? t("approx. {n} steps", { n: w.steps.total }) : t("{n} steps", { n: w.steps.total })}
            </Fact>
            <span className="min-w-0 truncate">
              {w.triggers.length > 0 ? triggerLine(w.triggers[0], t) : w.description || t("(no description)")}
              {w.lock && LOCK_LABEL[w.lock.scope] ? ` · ${t(LOCK_LABEL[w.lock.scope])}` : ""}
            </span>
          </div>
        </div>
        {/* Arm straight from the list — the trigger must be fully set up for that. */}
        {w.triggers.length > 0 && (
          <Toggle
            enabled={!!w.active}
            busy={toggling === w.id}
            title={w.active ? t("Turn the trigger off") : t("Arm the trigger (only events from now on count)")}
            onClick={() => toggleActive(w)}
          />
        )}
        <Menu label={t("More")} silent width={200}>
          <MenuEntry label={t("Edit")} onClick={() => setEditing(w.id)} />
          <MenuEntry label={t("Delete")} danger onClick={() => remove(w.id, w.name)} />
        </Menu>
        <RowsArrow />
      </div>
    );
  };

  // Above the list the summary as soon as there is something to count; otherwise (and as a short info beside it) the explanatory sentence.
  const explanation = projectId
    ? t("Apply in chats of this project and in workspace chats (other projects never see them). Selectable in a chat as long as no message has been sent.")
    : t("A workflow is a graph of steps the agent works through one at a time. Selectable in a chat as long as no message has been sent. Off by default in projects (adopt them there individually).");
  const summary = () => {
    if (projectId) {
      return [
        t("{n} own", { n: own.length }),
        t("{n} of {m} from the workspace adopted", { n: adoptable.filter((w) => w.enabled).length, m: adoptable.length }),
      ].join(" · ");
    }
    const parts = [own.length === 1 ? t("1 workflow") : t("{n} workflows", { n: own.length })];
    const listen = own.filter((w) => w.triggers.length > 0 && w.active).length;
    if (listen) parts.push(listen === 1 ? t("1 trigger active") : t("{n} triggers active", { n: listen }));
    const lock = own.filter((w) => (w.holding?.length ?? 0) > 0).length;
    if (lock) parts.push(t("{n} holding a lock", { n: lock }));
    return parts.join(" · ");
  };
  const countable = own.length + adoptable.length > 0;

  // The header stays put, the lists scroll below: the tab has a fixed height.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`${COLUMN_WIDTH} shrink-0`}>
        <PagesHeader
          title={projectId ? t("Project workflows") : t("Workflows")}
          under={countable ? <span className="tabular-nums" title={explanation} data-workflows-summary>{summary()}</span> : explanation}
        >
          <button type="button" onClick={create} className={primary}>{projectId ? t("+ Project workflow") : t("+ Workflow")}</button>
        </PagesHeader>
        {error && <div className="pb-5"><Hint tone="danger">{error}</Hint></div>}
      </div>

      <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={`${COLUMN_WIDTH} flex flex-col gap-8 pb-8`}>
        {/* In a project: the own ones first, as a section of their origin (Origin.tsx); the workspace workflows follow as a
            section of their own. At workspace level the list stands without a section under the header. */}
        {projectId ? (
          <OriginSection kind="project">
            {own.length === 0
              ? <EmptyRow>{t("No project workflows yet.")}</EmptyRow>
              : <div className="flex shrink-0 flex-col gap-0.5">{own.map(row)}</div>}
          </OriginSection>
        ) : own.length === 0 ? (
          <EmptySentence title={t("No workflows yet.")} />
        ) : (
          <div className="flex shrink-0 flex-col gap-0.5" data-workflow-list>{own.map(row)}</div>
        )}

        {projectId && (
          <OriginSection kind="workspace" hint={t("Off by default in the project — enable specifically for this project here. (Edit at the workspace level.)")}>
            {adoptable.length === 0 ? (
              <EmptyRow>{t("No workspace workflows.")}</EmptyRow>
            ) : (
              <div className="flex shrink-0 flex-col gap-0.5">
                {adoptable.map((w) => (
                  <div key={w.id} className={`${LIST_ROW} items-center hover:bg-hover`}>
                    <Tile
                      color={w.enabled ? "text-ok" : "text-dim"}
                      title={w.enabled ? t("Adopted in project — click to remove") : t("Not adopted — click to adopt")}
                    >
                      {SYM.workflow(16)}
                    </Tile>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`min-w-0 truncate text-[14px] font-medium tracking-[-0.01em] ${w.enabled ? "text-fg/90" : "text-dim"}`}>{w.name}</span>
                        <OriginMarker kind="workspace" />
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-dim">{w.description || t("(no description)")}</div>
                    </div>
                    <Toggle
                      enabled={!!w.enabled}
                      busy={toggling === w.name}
                      title={w.enabled ? t("Adopted in project — click to remove") : t("Not adopted — click to adopt")}
                      onClick={() => toggleAdopt(w.name, !w.enabled)}
                    />
                  </div>
                ))}
              </div>
            )}
          </OriginSection>
        )}
        </div>
      </div>
    </div>
  );
}
