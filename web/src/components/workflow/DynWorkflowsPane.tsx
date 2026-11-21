"use client";

// The kind "Dynamic" in the coding tab "Workflows" (segment bar in WorkflowsTab.tsx): the saved workflow scripts of the
// workspace (library, server: server/backend/electron/server/dynworkflows/routes.js).
//
// Workspace level: list, view (meta and the script BYTE-EQUAL, copyable — interchangeable with Claude Code), delete with
// confirmation. Entered project: the same list with a toggle per row — the adoption into this project, modeled on the
// graph workflows (WorkflowsPane), not on the skill dialog; editing and deleting happen at workspace level. An entry is
// never created here but by the agent through the tool cbase_dynamic_workflow_save.
//
// Shape: kit building blocks, split view through `SplitPane` (container query `@container/kit` of the page), the
// confirmation through `useConfirm` (sheet through a portal on the body). "Not loaded yet" is `null` and never shows "none
// saved".
//
// The calm page of the projects (building blocks in the kit, CbKit.tsx): the library stands in the shared column under the
// kind bar (WorkflowsTab.tsx) with the calm page header; no glass surface around the list, the rows stand directly on the
// stage between hairlines (the chosen entry through `data-active`), the name larger and medium weight, at the end the
// arrow to the view; the empty state is a sentence under a hairline. In the view on the right meta and script have the same
// structure as before, only without surfaces: hairlines instead of cards.
//
// In the form of the instances (kit, section "the form of the instances"): list and view like the tab "Instances" —
// rounded rows without hairlines, the chosen one in an accent tint (`SELECTED`, plus `data-active`), in front the tile with
// the script symbol (in a project green = adopted, muted = not), below `/name` · phases · description. Above the list the
// summary ("4 saved" or "2 of 4 adopted"). On the right the detail with a large tile and the sections meta and script (the
// script in the trough of the kit fields).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Section, FACTS, Fact, SELECTED, Hint, Tile, LIST_ROW, Loading, EmptySentence, Menu, MenuEntry, Placeholder, COLUMN_WIDTH, SYM,
  Toggle, PagesHeader, SplitBackButton, SplitPane, RowsArrow, ghostSm,
} from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";
import { useT } from "@/lib/i18n";
import { listPath, type DynWorkflowEntry, type DynWorkflowFull } from "@/lib/dyn-library";

export function DynWorkflowsPane({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const t = useT();
  const question = useConfirm();
  const [list, setList] = useState<DynWorkflowEntry[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api<DynWorkflowEntry[]>(listPath(workspaceId, projectId)));
      setError("");
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }, [workspaceId, projectId]);
  useEffect(() => { load(); }, [load]);

  // Adoption is name-based like for the graph workflows; the button ALWAYS sends the field `enabled` — the route requires it
  // (a missing field is not a statement).
  async function takeOver(w: DynWorkflowEntry, on: boolean) {
    if (!projectId) return;
    setToggling(w.name);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/workspace-dyn-workflows/${encodeURIComponent(w.name)}/enabled`, {
        method: "PATCH", body: JSON.stringify({ enabled: on }),
      });
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setToggling(null); }
  }

  async function erase(w: DynWorkflowEntry) {
    const ok = await question(
      t("Delete dynamic workflow “{name}”? It disappears from the workspace and from every project that adopted it.", { name: w.name }),
      { ok: t("Delete"), danger: true },
    );
    if (!ok) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/dyn-workflows/${encodeURIComponent(w.id)}`, { method: "DELETE" });
      if (selected === w.id) setSelected(null);
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }

  const entries = list ?? [];
  const active = entries.find((w) => w.id === selected) ?? null;

  const listContent = list === null ? (
    error ? null : <Loading />
  ) : entries.length === 0 ? (
    <EmptySentence title={t("No dynamic workflows saved yet.")}>
      {t("The agent saves them — ask it in the chat to save a workflow.")}
    </EmptySentence>
  ) : (
    <div className="flex shrink-0 flex-col gap-0.5" data-dynwf-list>
      {entries.map((w) => (
        <div
          key={w.id}
          role="button"
          tabIndex={0}
          aria-current={w.id === selected ? "true" : undefined}
          data-active={w.id === selected ? "1" : undefined}
          data-dynwf-entry={w.name}
          onClick={() => setSelected(w.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(w.id); } }}
          className={`${LIST_ROW} cursor-pointer items-center ${w.id === selected ? SELECTED : "hover:bg-hover"}`}
        >
          <Tile
            color={projectId ? (w.enabled ? "text-ok" : "text-dim") : "text-fg/80"}
            title={projectId ? (w.enabled ? t("Adopted in project — click to remove") : t("Not adopted — click to adopt")) : undefined}
          >
            {SYM.script(16)}
          </Tile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium tracking-[-0.01em]">{w.title || w.name}</div>
            <div className={`mt-0.5 ${FACTS}`}>
              {w.title && <span className="shrink-0 font-mono text-[11.5px]">/{w.name}</span>}
              {w.phases.length > 0 && (
                <Fact symbol={SYM.steps(12)} className="shrink-0 tabular-nums">{w.phases.length === 1 ? t("1 phase") : t("{n} phases", { n: w.phases.length })}</Fact>
              )}
              <span className="min-w-0 truncate">{w.description}</span>
            </div>
          </div>
          {projectId ? (
            <span onClick={(e) => e.stopPropagation()} className="flex shrink-0" data-dynwf-toggle={w.name}>
              <Toggle
                on={!!w.enabled}
                disabled={toggling === w.name}
                title={w.enabled ? t("Adopted in project — click to remove") : t("Not adopted — click to adopt")}
                onClick={() => takeOver(w, !w.enabled)}
              />
            </span>
          ) : (
            <span onClick={(e) => e.stopPropagation()} className="flex shrink-0">
              <Menu label={t("More")} silent width={200}>
                <MenuEntry label={t("Delete")} danger onClick={() => erase(w)} />
              </Menu>
            </span>
          )}
          <RowsArrow />
        </div>
      ))}
    </div>
  );

  // Above the list the summary as soon as there is something to count; otherwise (and as short info on it) the explanatory sentence.
  const explanation = projectId
    ? t("The saved workflow scripts of the workspace. Off by default in a project — adopt them one by one here; a project chat only sees the adopted ones.")
    : t("Saved workflow scripts: an agent starts them by name, you with /name in the chat. The script is byte-identical to what Claude Code writes and reads.");
  const summary = projectId
    ? t("{n} of {m} adopted", { n: entries.filter((w) => w.enabled).length, m: entries.length })
    : t("{n} saved", { n: entries.length });

  return (
    <div className={`${COLUMN_WIDTH} flex min-h-0 flex-1 flex-col`}>
      <PagesHeader
        title={t("Dynamic workflows")}
        under={entries.length > 0 ? <span className="tabular-nums" title={explanation} data-dynwf-summary>{summary}</span> : explanation}
      />
      {error && <div className="shrink-0 pb-5"><Hint tone="danger">{error}</Hint></div>}
      <SplitPane
        shared={entries.length > 0}
        list={listContent}
        detail={active ? <DynWorkflowView workspaceId={workspaceId} entry={active} onBack={() => setSelected(null)} /> : null}
        placeholder={<Placeholder title={t("Pick a workflow to see its script and meta.")} />}
      />
    </div>
  );
}

// The view of an entry: meta (name, description, whenToUse, phases) and the script. The script stands as text in a <pre>
// and goes unchanged into the clipboard with `writeText` — no markdown, no highlighting that could shift characters.
function DynWorkflowView({ workspaceId, entry, onBack }: { workspaceId: string; entry: DynWorkflowEntry; onBack: () => void }) {
  const t = useT();
  const [full, setFull] = useState<DynWorkflowFull | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    setError("");
    api<DynWorkflowFull>(`/api/workspaces/${encodeURIComponent(workspaceId)}/dyn-workflows/${encodeURIComponent(entry.id)}`)
      .then((v) => { if (!cancelled) setFull(v); })
      .catch((e) => { if (!cancelled) setError(String((e as Error)?.message || e)); });
    return () => { cancelled = true; };
  }, [workspaceId, entry.id]);

  async function copy() {
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }

  // In the form of the instance detail: on top the large tile with title and `/name`, below the sections "meta" (the
  // details as calm rows without hairlines) and "Script" (copy at the right of the header, the script in the trough of the
  // kit fields instead of between two hairlines).
  return (
    <div className="flex min-w-0 flex-col gap-8 pb-10 pr-2 @5xl/kit:pl-2" data-dynwf-view={entry.name}>
      <SplitBackButton label={t("All dynamic workflows")} onClick={onBack} />
      <div className="flex min-w-0 items-start gap-3">
        <Tile large>{SYM.script(19)}</Tile>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold leading-6 tracking-[-0.01em]">{entry.title || entry.name}</h3>
          <div className="mt-0.5 truncate font-mono text-[12px] text-dim">/{entry.name}</div>
        </div>
      </div>
      {error && <Hint tone="danger">{error}</Hint>}
      {!full ? (error ? null : <Loading />) : (
        <>
          <Section symbol={SYM.steps(15)} title="meta">
            <div className="flex flex-col text-[13px]">
              <MetaRow label={t("Name")}><span className="font-mono">/{full.name}</span>{full.title ? <span className="text-dim"> · {full.title}</span> : null}</MetaRow>
              <MetaRow label={t("Description")}>{full.description}</MetaRow>
              <MetaRow label="whenToUse">{full.whenToUse ?? <span className="text-dim">{t("(not given)")}</span>}</MetaRow>
              <MetaRow label={t("Phases")}>
                {full.phases.length === 0 ? <span className="text-dim">{t("(none)")}</span> : (
                  <ol className="list-decimal space-y-0.5 pl-4">
                    {full.phases.map((ph, i) => (
                      <li key={i}>
                        <span className="font-medium">{ph.title}</span>
                        {ph.detail ? <span className="text-dim"> — {ph.detail}</span> : null}
                        {ph.model ? <span className="text-dim"> · {ph.model}</span> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </MetaRow>
            </div>
          </Section>
          <Section
            symbol={SYM.script(15)}
            title={t("Script")}
            right={
              <button type="button" onClick={copy} className={ghostSm} data-dynwf-copy>
                {copied ? t("Copied") : t("Copy")}
              </button>
            }
          >
            <pre className="cb-scroll overflow-x-auto whitespace-pre rounded-xl bg-bg px-3.5 py-3 font-mono text-[12px] leading-relaxed" data-dynwf-script>{full.script}</pre>
          </Section>
        </>
      )}
    </div>
  );
}

/** One meta detail: the label on the left, the value on the right — without hairline, rounded light under the pointer like every row. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="-mx-2 flex flex-col gap-0.5 rounded-lg px-2 py-2 transition-colors hover:bg-hover @md/detail:flex-row @md/detail:gap-3">
      <div className="shrink-0 text-[11.5px] font-medium text-dim @md/detail:w-28">{label}</div>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}
