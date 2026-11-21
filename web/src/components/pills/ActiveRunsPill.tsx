"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, progressDetail, copiesFrom, subscribeGlobalEvents, type ActiveCopy, type ActiveRun, type ActiveRunsView } from "@/lib/api";
import { loadAfterEvent } from "@/lib/active-runs";
import { loadActiveRuns } from "@/lib/active-runs-status";
import { runDetails, runPhase } from "@/lib/run-description";
import { useT } from "@/lib/i18n";
import { ProviderMark } from "@/components/ProviderMarks";
import { useEdgeClamp } from "@/lib/viewport";
import { readActiveScope, rememberWorkspace } from "@/lib/active-scope";
import { elapsed } from "@/lib/agents";
import { instancesAddress, showInstances } from "@/lib/project-jump";
import { CopyProgressBar, OverrunHint, restSet, stateSet } from "@/components/projects/CopyProgress";

// "Active runs" in the header: one place that shows on EVERY page what keeps the machine busy — running chats (with workflow step,
// background agents, wait reason) and workflows with an open question. The run history in the Workflows tab tells afterwards what was;
// this is about NOW: what is running, for how long, what needs me? A click jumps into the chat, a second button stops the run.
//
// Refreshing: the global event stream reports start/end of every run (`run`) and every workflow status change (`workflow_run`) →
// bundled reload. Within a run, phase and background work change without a global event, so while the list is OPEN it is
// additionally polled on a timer (closed, the counter is enough).
//
// COPIES BEING CREATED: the field `copies` of the same answer (runs/routes.js — a copy belongs to no chat and is therefore no entry in
// `items`). They count in the pill's number and spin the hexagon; `counts` stays the count of the RUNS (the chat list's short info reads
// it). In the sheet a section "Copies" under the runs: project · copy, the state ("waiting in the queue", "Step 3 of 6 · Second clone",
// during start "· Stage 2/3"), a thin bar (determinate with an estimated share, otherwise indeterminate), "about 4 min left" only with
// an estimate, and "takes longer than last time" when the step overruns its model (form and words: projects/CopyProgress.tsx). A click
// opens the "Instances" tab of the project with THIS copy selected (lib/project-jump.ts). Reloaded on `project/copy` (every state and
// phase change, lib/active-runs.ts); the server recomputes the estimate per request — open, that is every 3 s.

const REFRESH_OPEN_MS = 3_000;
const REFRESH_IDLE_MS = 20_000;

// Phase and details of a row (word, color, status dot; "Step 3/7 · 2 agents · wakes 14:32") live in lib/run-description.ts — the chat
// list's short info says the same sentence. The wait row at the credit gate is recognized there by its mark (`isGateWaitRow`), never
// by a text comparison. Run times (`elapsed`) come from lib/agents.ts.

export function ActiveRunsPill() {
  const t = useT();
  const [view, setView] = useState<ActiveRunsView | null>(null);
  const [open, setOpen] = useState(false);
  // On narrow windows the trigger sits far left after the header wraps — without this correction the right-anchored popover would
  // stick out over the left edge.
  const popRef = useEdgeClamp<HTMLDivElement>(open);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Own one-second tick for the run times — otherwise "3 m 12 s" would stand until the next load.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      // Via the shared state (lib/active-runs-status.ts): the chat list's short info reads it too.
      setView(await loadActiveRuns());
      // A hiccup must not empty the display (same rule as for the usage rings): on error the last state stays.
    } catch { /* keep the last state */ }
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => { loadRef.current(); }, []);

  // Global event stream: run start/end, workflow status change and start/end of a dynamic workflow (lib/active-runs.ts) → bundled reload.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeGlobalEvents((msg) => {
      if (!loadAfterEvent(msg)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadRef.current(), 400);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);

  // Timed reconciliation: more often while open (phase/background work change without an event), closed only as a safety net against
  // a missed broadcast.
  useEffect(() => {
    const id = setInterval(() => loadRef.current(), open ? REFRESH_OPEN_MS : REFRESH_IDLE_MS);
    return () => clearInterval(id);
  }, [open]);

  const items = view?.items ?? [];
  const counts = view?.counts;
  // The whitelist of copies (lib/api/copy-progress.ts): an older server without the field reports none — not "there are none".
  const copies = copiesFrom(view?.copies);

  // Click catcher as a document mousedown, not as fixed inset-0 (house rule, globals.css): a veil over the page would lie over the
  // native browser view and eat the first click.
  useEffect(() => {
    if (!open) return;
    const beside = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest?.("[data-runs-pop]")) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", beside);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", beside); window.removeEventListener("keydown", esc); };
  }, [open]);

  // One-second tick only while anything runs at all (or a copy is being created — its duration shows on the right of the row).
  const ticks = items.length + copies.length > 0;
  useEffect(() => {
    if (!ticks) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [ticks]);

  // A run needs attention (open question) → the pill turns yellow and the dot blinks.
  const needsMe = (counts?.ask ?? 0) > 0;
  const total = counts?.total ?? 0;
  // The pill's number: runs AND copies being created — `counts` itself stays the runs'.
  const count = total + copies.length;

  // Jump into the chat. On the workspaces page with the same workspace the event is enough (no reload); otherwise via the address —
  // the page establishes ?ws=, ChatPane opens ?chat=.
  function openRun(run: ActiveRun) {
    setOpen(false);
    if (!run.chatId) return;
    // "The same workspace" means: the one THIS tab shows — the live scope. Reading localStorage (`cbase-ws`) would be wrong: it is
    // only the start value for the next page load, written by other tabs and the agent dock too (`rememberStartWorkspace`). If Coding
    // showed ws Y and ws X was chosen in the dock, a run from X would open by event INSIDE the view of Y (ChatPane opens
    // `cbase-open-chat` without a workspace check), and a run from Y would reload.
    // Guard: statusBar.test.mjs ("scope per tab").
    const here = window.location.pathname.startsWith("/workspaces");
    const sameWs = readActiveScope().workspaceId === run.workspaceId;
    if (here && sameWs) {
      window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: run.chatId }));
      return;
    }
    rememberWorkspace(run.workspaceId);
    window.location.href = `/workspaces/?ws=${encodeURIComponent(run.workspaceId)}&chat=${encodeURIComponent(run.chatId)}`;
  }

  // Into the "Instances" tab of the project, the copy selected. On the workspaces page in the same workspace the event is enough (the page
  // switches the tab, an already open tab selects the copy); otherwise via the address — the same switch as `openRun`.
  function openCopy(k: ActiveCopy) {
    setOpen(false);
    const target = { workspaceId: k.workspaceId, projectId: k.projectId, instance: k.instance };
    const here = window.location.pathname.startsWith("/workspaces");
    if (here && readActiveScope().workspaceId === k.workspaceId) { showInstances(target); return; }
    rememberWorkspace(k.workspaceId);
    window.location.href = instancesAddress(target);
  }

  async function stop(run: ActiveRun) {
    if (!run.chatId) return;
    setStopping(run.id);
    setError("");
    try {
      await api(`/api/chats/${run.chatId}/stop`, { method: "POST" });
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setStopping(null); }
  }

  const copiesSet = copies.length === 1 ? t("1 copy being created") : copies.length > 1 ? t("{n} copies being created", { n: copies.length }) : "";
  const summary = [
    ...(counts && total > 0 ? [
      counts.running ? t("{n} running", { n: counts.running }) : "",
      counts.waiting ? t("{n} waiting", { n: counts.waiting }) : "",
      counts.ask ? t("{n} with a question", { n: counts.ask }) : "",
    ] : []),
    copiesSet,
  ].filter(Boolean).join(" · ");

  return (
    <span className="relative" data-runs-pop>
      <button
        onClick={() => setOpen((v) => !v)}
        title={[
          total ? t("Active runs: {n}", { n: total }) : copies.length ? "" : t("Active runs — nothing running right now"),
          copiesSet,
        ].filter(Boolean).join(" · ")}
        aria-label={t("Active runs")}
        aria-haspopup="true"
        aria-expanded={open}
        data-runs-copies={copies.length || undefined}
        className={`flex h-8 items-center gap-1 rounded-full px-2 transition-colors ${
          count
            ? needsMe
              ? "bg-warn/10 text-warn hover:bg-warn/15"
              : "bg-accent/10 text-accent hover:bg-accent/15"
            : "text-dim hover:bg-hover hover:text-fg"
        }`}
      >
        <span className={count ? (needsMe ? "" : "inline-flex animate-[spin_2.6s_linear_infinite]") : "inline-flex opacity-60"}>
          <CbIcon size={14} filled={needsMe && total > 0} />
        </span>
        {/* Zero stays silent: without a run (and without a copy being created) only the hexagon shows. */}
        {count > 0 && <span className="text-[12px] font-semibold tabular-nums">{count}</span>}
      </button>

      {open && (
        <div data-overlay ref={popRef} className="absolute right-0 top-full z-50 mt-2 w-[min(400px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl cb-pop">
          {/* Header: title and state in one line. No "Refresh" — while open the list asks every 3 s anyway. */}
          <div className="flex items-baseline gap-2 px-4 pb-1.5 pt-3">
            <span className="text-[13px] font-semibold tracking-tight">{t("Active runs")}</span>
            {summary && <span className="truncate text-[11.5px] text-dim">{summary}</span>}
          </div>

          {error && <div className="mx-4 mb-1 text-[11.5px] text-danger">{error}</div>}

          <div className="max-h-[64vh] overflow-y-auto px-1.5 pb-1.5">
            {items.length === 0 && copies.length === 0 ? (
              <div className="px-3 pb-6 pt-4 text-center">
                <div className="text-[12.5px] text-dim">{t("Nothing is running right now.")}</div>
                <div className="mt-0.5 text-[11px] text-dim/70">{t("Running chats and workflows appear here.")}</div>
              </div>
            ) : (
              items.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  stopping={stopping === run.id}
                  onOpen={() => openRun(run)}
                  onStop={() => stop(run)}
                />
              ))
            )}
            {copies.length > 0 && (
              <div data-runs-section="copies">
                <div className={`px-2.5 pb-1 text-[11px] font-medium text-dim ${items.length ? "pt-3" : "pt-1"}`}>{t("Copies")}</div>
                {copies.map((k) => <CopyRow key={k.id} k={k} onOpen={() => openCopy(k)} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function RunRow({ run, stopping, onOpen, onStop }: { run: ActiveRun; stopping: boolean; onOpen: () => void; onStop: () => void }) {
  const t = useT();
  // Phase with the round cap and review (the mark says WHAT the run waits for).
  const ph = runPhase(run);
  // Second line: what the run is doing now (lib/run-description.ts).
  const bits = runDetails(run, t);

  const where = [run.workspaceName, run.projectName].filter(Boolean).join(" › ");
  // One line of meta: the place, then what the run is doing; the full version is in the tooltip.
  const meta = [where, ...bits].filter(Boolean).join(" · ");
  // If the run needs me, the action stands as text on the row; otherwise the row itself opens the chat.
  const action = run.workflow?.pending === "review" ? t("Answer review →")
    : run.phase === "ask" ? t("Answer →") : null;
  const target = t("Open chat →");
  const marker = "shrink-0 truncate rounded-md px-1.5 py-px text-[10px] font-medium";

  return (
    <div className="group flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-hover" data-run={run.id} data-run-phase={run.phase}>
      <StatusPoint point={ph.point} pulse={ph.pulse} />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left" title={target}>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium">{run.title || t("Untitled")}</span>
          {(run.provider === "claude" || run.provider === "codex") && (
            <span className="shrink-0 opacity-50" title={run.provider}><ProviderMark provider={run.provider} size={10} /></span>
          )}
          {run.workflow && <span className={`${marker} bg-accent/10 text-accent`} title={run.workflow.name}>{run.workflow.name}</span>}
          {run.dynWorkflow && <span className={`${marker} bg-accent/10 text-accent`} title={t("Dynamic workflow")}>{run.dynWorkflow.name}</span>}
          {run.workflow?.origin === "trigger" && <span className={`${marker} bg-hover text-dim`}>{t("Trigger")}</span>}
          {run.lockKey && (
            <span title={t("This run holds the lock {key} — other runs are waiting for it.", { key: run.lockKey })} className={`${marker} bg-warn/15 text-warn`}>
              {t("locking")}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-dim" title={meta || undefined}>
          {run.phase !== "running" && <span className={ph.text}>{t(ph.label)}{meta ? " · " : ""}</span>}
          {meta}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {action && (
          <button onClick={onOpen} className="rounded-full px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10">{action}</button>
        )}
        <span className="w-12 text-right text-[11px] tabular-nums text-dim">{elapsed(Date.now() - run.startedAt)}</span>
        {run.stoppable && (
          <button
            onClick={onStop}
            disabled={stopping}
            title={t("Cancel run")}
            aria-label={t("Cancel run")}
            className={`flex h-6 w-6 items-center justify-center rounded-full text-dim transition-opacity hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 disabled:opacity-50 ${stopping ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            {stopping ? <span className="text-[11px]">…</span> : (
              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// A copy that is waiting or being created: project · copy, the state with remaining time, the thin bar, the overrun hint; on the right
// the duration since the start. The whole row opens the "Instances" tab with this copy selected.
function CopyRow({ k, onOpen }: { k: ActiveCopy; onOpen: () => void }) {
  const t = useT();
  const a = progressDetail(k.progress, k.state);
  const waiting = a?.kind === "queue" || a?.kind === "storage";
  const set = a ? stateSet(a, t) : t("being created");
  const rest = a ? restSet(a, t) : null;
  const since = k.progress?.begin ?? k.startedAt;
  const location = [k.workspaceName, k.projectName].filter(Boolean).join(" › ");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("To the instances →")}
      className="group flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover"
      data-copy={k.id}
      data-copy-kind={a?.kind ?? ""}
    >
      <span className="mt-[5px]"><StatusPoint point={waiting ? "bg-warn" : "bg-accent"} pulse={!waiting} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium">{k.projectName || t("Project")}</span>
          <span className="shrink-0 text-[13px] text-dim">·</span>
          <span className="shrink-0 truncate text-[13px]">{t("Copy {name}", { name: k.name })}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-dim" title={[location, set, rest].filter(Boolean).join(" · ")}>
          <span className={waiting ? "text-warn" : ""}>{set}</span>
          {rest && <span className="tabular-nums"> · {rest}</span>}
        </span>
        {a && <CopyProgressBar a={a} className="mt-1.5" />}
        {a?.overrun && <span className="mt-1 block text-[11px]"><OverrunHint a={a} t={t} /></span>}
      </span>
      <span className="w-12 shrink-0 pt-px text-right text-[11px] tabular-nums text-dim">{since ? elapsed(Date.now() - since) : ""}</span>
    </button>
  );
}

// The status dot of a row: still or with a soft ring running outward (running · needs me).
function StatusPoint({ point, pulse }: { point: string; pulse: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${point}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${point}`} />
    </span>
  );
}

const CbIcon = ({ size = 15, filled = false }: { size?: number; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" />
  </svg>
);
