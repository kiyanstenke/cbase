"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeGlobalEvents, type WorkflowRunStep, type WorkflowRunView } from "@/lib/api";
import { Sheet } from "@/components/workflow/WorkflowEditor";
import { Hint, Header, Loading, Empty, Menu, MenuEntry, Segments, ghostSm } from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";
import { useT, dateLocale } from "@/lib/i18n";
import { runNoteShown } from "@/lib/workflow-note";

// "Runs": the history of all workflow runs of a workspace (or project) — each run with status,
// duration, trigger and steps. A click opens the run's TIMELINE: per step the prompt the agent was
// sent off with, its result excerpt, the verdict of a condition or list model with the raw output on
// failure, and the error text. The chat history shows WHAT happened, but not WHAT the step was sent
// off with — which is what debugging needs.
//
// Live: the server broadcasts `workflow_run` on every status change — the list (and an open detail)
// refreshes, batched so that a run with many steps does not flicker.
//
// Form: header with a segment bar as state filter, the runs as ONE surface with rows, deleting in the
// ⋯ of the row, the timeline as a sheet. Colours only from the roles (`ok`, `warn`, `danger`,
// `accent`) — an `emerald-500` would have no counterpart in the dark theme.

const STATUS: Record<string, { label: string; dot: string; text: string }> = {
  running: { label: "running", dot: "bg-accent animate-pulse", text: "text-accent" },
  waiting: { label: "waiting for answer", dot: "bg-warn", text: "text-warn" },
  done: { label: "succeeded", dot: "bg-ok", text: "text-ok" },
  failed: { label: "failed", dot: "bg-danger", text: "text-danger" },
  cancelled: { label: "cancelled", dot: "bg-dim", text: "text-dim" },
};
const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "open", label: "Running" },
  { key: "failed", label: "Failed" },
  { key: "done", label: "Completed" },
];

// Human-readable duration: "840 ms", "4.2 s", "3 m 07 s", "2 h 14 m".
function dur(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m} m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")} s`;
  }
  const h = Math.floor(ms / 3_600_000);
  return `${h} h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")} m`;
}
// Total run time of a run. A still running run has no end — then its own clock keeps counting
// instead of showing "—" (the question "how long has it been running?" had no answer for exactly
// the interesting runs).
const runtimeOf = (r: WorkflowRunView, now: number) =>
  r.durationMs || (r.startedAt ? Math.max(0, now - r.startedAt) : 0);
const isOpenRun = (status: string) => status === "running" || status === "waiting";
const clock = (ms: number) => (ms ? new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const day = (ms: number) => (ms ? new Date(ms).toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" }) : "");

// Loop and review have no colour role of their own: the loop is flow (accent), the review waits
// for a human (warn) — exactly like the question.
const KIND: Record<string, { label: string; color: string }> = {
  trigger: { label: "Triggered", color: "text-accent" },
  start: { label: "Start##noun", color: "text-accent" },
  step: { label: "Step", color: "text-fg" },
  decision: { label: "Condition", color: "text-warn" },
  loop: { label: "Loop", color: "text-accent" },
  ask: { label: "Question##ask", color: "text-warn" },
  review: { label: "Review (human)", color: "text-warn" },
  answer: { label: "Answer", color: "text-accent" },
  skip: { label: "Skipped", color: "text-dim" },
  cap: { label: "Round cap", color: "text-warn" },
  gate: { label: "Completion gate", color: "text-warn" },
  // Start command of a node. Without this row the raw word "command" appeared as label and the
  // command itself was nowhere to be seen.
  command: { label: "Start command", color: "text-accent" },
  end: { label: "End", color: "text-dim" },
};

export function WorkflowRunsPane({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const t = useT();
  const question = useConfirm();
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set("projectId", projectId);
    else q.set("workspaceId", workspaceId);
    if (status) q.set("status", status);
    q.set("limit", "200");
    return q.toString();
  }, [workspaceId, projectId, status]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ runs: WorkflowRunView[] }>(`/api/workflow-runs?${query}`);
      setRuns(r.runs);
      setError("");
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setLoading(false); }
  }, [query]);
  useEffect(() => { setLoading(true); load(); }, [load]);

  // Tick every second while at least one run is open — its total run time counts up.
  const [now, setNow] = useState(() => Date.now());
  const anyOpen = runs.some((r) => isOpenRun(r.status));
  useEffect(() => {
    if (!anyOpen) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyOpen]);

  // Live: reload on every status change of a run — batched.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const off = subscribeGlobalEvents((msg) => {
      if (msg.type !== "workflow_run") return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => loadRef.current(), 400);
    });
    return () => { off(); if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  async function remove(r: WorkflowRunView) {
    if (!(await question(t("Delete this run from the history? Its step log goes with it.", {}), { ok: t("Delete"), danger: true }))) return;
    try {
      await api(`/api/workflow-runs/${r.id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(String((e as Error)?.message || e)); }
  }

  const filterItems = FILTERS.map((f) => ({ key: f.key, label: t(f.label) }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Header
        title={projectId ? t("Runs of this project") : t("Run history")}
        hint={t("Every run is kept — with a step timeline, prompts, verdicts and errors. Click a run to inspect it.")}
      >
        <Segments label={t("Status")} items={filterItems} value={status} onChange={setStatus} />
        <button type="button" onClick={() => load()} className={ghostSm}>{t("Refresh")}</button>
      </Header>
      {error && <Hint tone="danger">{error}</Hint>}

      <div className="cb-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {loading && runs.length === 0 && <Loading />}
        {!loading && runs.length === 0 && (
          <Empty title={status ? t("No run with this status.") : t("No workflow has run yet.")} />
        )}
        {runs.length > 0 && (
          // `shrink-0`: the rounded corners need `overflow-hidden`, which made the surface a scroll
          // container that shrinks to the column — scrolling happens in the column above.
          <div className="cb-kit-pane shrink-0 divide-y divide-edge overflow-hidden rounded-2xl">
            {runs.map((r) => {
              const st = STATUS[r.status] ?? STATUS.cancelled;
              return (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenId(r.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(r.id); } }}
                  className="cb-row group flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left transition-colors"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold">{r.name}</span>
                      {r.origin === "trigger" ? (
                        <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[10.5px] font-semibold text-accent">{t("Trigger")}</span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-bg px-2 py-0.5 text-[10.5px] font-semibold text-dim">{t("manual")}</span>
                      )}
                      {r.chatGone && <span className="shrink-0 text-[10.5px] text-dim">{t("(chat deleted)")}</span>}
                    </div>
                    <div className="truncate text-[12px] text-dim">
                      {r.trigger?.summary || r.nodeTitle || (r.note ? runNoteShown(r.note, t) : "") || t("—")}
                    </div>
                  </div>
                  <span className="hidden shrink-0 text-[11.5px] tabular-nums text-dim sm:block">
                    {day(r.startedAt)} {clock(r.startedAt)}
                  </span>
                  <span
                    className={`shrink-0 text-[11.5px] tabular-nums ${isOpenRun(r.status) ? "text-fg" : "text-dim"}`}
                    title={t("Total runtime of this run")}
                  >
                    {dur(runtimeOf(r, now))}
                  </span>
                  <span
                    className="shrink-0 rounded-full bg-bg px-2 py-0.5 text-[11px] tabular-nums text-dim"
                    title={r.approx ? t("Step {a} of an estimated {b} — the graph has loops or branches") .replace("{a}", String(r.step)).replace("{b}", String(r.total)) : t("Step {a} of {b}").replace("{a}", String(r.step)).replace("{b}", String(r.total))}
                  >
                    {/* The total is an ESTIMATE as soon as the graph has loops, branches or variable
                        start commands — the prompt tells the agent "step 9/ca. 8", the view would
                        show "9/8" and read like a broken counter. The LIST route must send `approx`
                        too. */}
                    {r.total ? `${r.step}/${r.approx ? "~" : ""}${r.total}` : `${r.step}`}
                  </span>
                  <span className={`shrink-0 text-[11.5px] font-semibold ${st.text}`}>{t(st.label)}</span>
                  <Menu label={t("More")} silent width={220}>
                    <MenuEntry label={t("Delete run from history")} danger onClick={() => remove(r)} />
                  </Menu>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openId && <RunDetail runId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// Timeline of ONE run. Loads run + steps and refreshes on status changes (a running workflow keeps
// writing while you watch).
function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const t = useT();
  const [data, setData] = useState<{ run: WorkflowRunView; steps: WorkflowRunStep[]; chat: { id: string; title: string } | null } | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/workflow-runs/${runId}`));
    } catch (e) { setError(String((e as Error)?.message || e)); }
  }, [runId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    return subscribeGlobalEvents((msg) => {
      if (msg.type === "workflow_run" && msg.runId === runId) load();
    });
  }, [runId, load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = data?.run;
  const st = run ? (STATUS[run.status] ?? STATUS.cancelled) : null;
  // While the run is still running, its total run time in the timeline header keeps counting.
  const open = run ? isOpenRun(run.status) : false;
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  return (
    <Sheet onClose={onClose} width={820}>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-edge px-5 py-3">
        {st && <span className={`h-2.5 w-2.5 rounded-full ${st.dot}`} />}
        <span className="min-w-0 truncate text-[15px] font-semibold">{run?.name || t("Workflow run")}</span>
        {st && <span className={`shrink-0 text-[12px] font-semibold ${st.text}`}>{t(st.label)}</span>}
        {run && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-dim" title={t("Start · total runtime")}>
            {day(run.startedAt)} {clock(run.startedAt)} · {dur(runtimeOf(run, now))}
          </span>
        )}
        {data?.chat && (
          <button
            type="button"
            onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: data.chat!.id })); }}
            className={`ml-auto ${ghostSm}`}
          >
            {t("Open chat →")}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t("Close")}
          aria-label={t("Close")}
          className={`${data?.chat ? "" : "ml-auto"} grid h-8 w-8 place-items-center rounded-full bg-bg text-dim transition-colors hover:bg-hover hover:text-fg`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="cb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-5">
        {error && <Hint tone="danger">{error}</Hint>}
        {run?.note && (run.status === "failed"
          ? <Hint tone="danger">{runNoteShown(run.note, t)}</Hint>
          : <div className="rounded-xl bg-bg px-3 py-2 text-[12px] text-dim">{runNoteShown(run.note, t)}</div>)}
        {run?.trigger && (
          <div className="rounded-xl bg-accent/8 px-3 py-2 text-[12px]">
            <span className="font-semibold text-accent">{t("Triggers")}: </span>
            {run.trigger.url
              ? <a href={run.trigger.url} target="_blank" rel="noreferrer" className="underline decoration-dotted">{run.trigger.summary}</a>
              : run.trigger.summary}
          </div>
        )}
        {run?.chatGone && (
          <div className="rounded-xl bg-bg px-3 py-2 text-[12px] text-dim">
            {t("This run's chat was deleted — the steps are kept.")}
          </div>
        )}

        {(data?.steps ?? []).map((s) => <StepRow key={s.id} step={s} />)}
        {data && data.steps.length === 0 && <div className="p-4 text-center text-[12.5px] text-dim">{t("No steps recorded.")}</div>}
        {!data && !error && <Loading />}
      </div>
    </Sheet>
  );
}

// One row of the timeline. Everything long (prompt, result, raw outputs) sits in collapsible
// <details> — the timeline stays skimmable, the material is one click away.
// A failed step is a tinted surface (traffic-light rule), not glass: `bg-danger/10` on the element
// would lose against the unlayered glass rule — hence it carries no glass class at all.
function StepRow({ step }: { step: WorkflowRunStep }) {
  const t = useT();
  const k = KIND[step.kind] ?? { label: step.kind, color: "text-fg" };
  const d = step.detail || {};
  // Parked (at the usage limit) is NOT failed: the command is made up later. Without this
  // distinction a waiting step would stay red in the history for good.
  const waiting = d.limited === true;
  const failed = !waiting && (d.failed === true || d.ok === false);
  const head = step.kind === "step"
    ? `${t("Step {n}", { n: step.step })}${step.nodeTitle ? `: ${step.nodeTitle}` : ""}`
    : step.kind === "gate"
      ? `${step.nodeTitle || t("Step")} → ${d.failed ? t("undecided") : d.done ? t("done") : t("not finished yet")}${d.round ? ` (${d.round}/${d.max})` : ""}`
    : step.kind === "decision"
      ? `${step.nodeTitle || t("Condition")} → ${d.failed ? t("undecided") : d.yes ? t("Yes") : t("No")}`
      : `${t(k.label)}${step.nodeTitle ? `: ${step.nodeTitle}` : ""}`;

  return (
    <div className={`rounded-xl px-3 py-2 ${failed ? "bg-danger/10" : "cb-kit-pane"}`}>
      <div className="flex items-center gap-2">
        <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide ${failed ? "text-danger" : waiting ? "text-warn" : k.color}`}>{t(k.label)}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{head}</span>
        {!!step.durationMs && <span className="shrink-0 text-[11px] tabular-nums text-dim">{dur(step.durationMs)}</span>}
        <span className="shrink-0 text-[11px] tabular-nums text-dim">{clock(step.at)}</span>
      </div>

      {typeof d.command === "string" && d.command && (
        <div className="mt-1 truncate font-mono text-[11.5px] text-dim">{d.command}{d.native === true ? "" : ` · ${t("as a message to the agent")}`}</div>
      )}
      {waiting && <div className="mt-1 text-[11.5px] text-warn">{t("Parked at the usage limit — will be retried.")}</div>}
      {typeof d.note === "string" && d.note && <div className="mt-1 text-[11.5px] text-dim">{d.note}</div>}
      {typeof d.status === "string" && <div className="mt-1 text-[11.5px] text-dim">{d.status}{d.ms ? ` · ${dur(Number(d.ms))}` : ""}</div>}
      {typeof d.error === "string" && d.error && <div className="mt-1 text-[11.5px] font-medium text-danger">{d.error}</div>}
      {typeof d.question === "string" && d.question && <div className="mt-1 text-[11.5px]">{d.question}</div>}
      {typeof d.rounds === "number" && typeof d.cap === "number" && (
        <div className="mt-1 text-[11.5px] text-dim">{t("{r} of {c} allowed rounds", { r: d.rounds, c: d.cap })}</div>
      )}
      {typeof d.granted === "number" && d.granted > 0 && (
        <div className="mt-1 text-[11.5px] text-dim">{t("{n} more rounds granted", { n: d.granted })}</div>
      )}
      {d.auto === true && (
        <div className="mt-1 text-[11.5px] text-dim">{t("Continued without asking (checkbox on the step)")}</div>
      )}
      {typeof d.answer === "string" && d.answer && <div className="mt-1 text-[11.5px] text-dim">↳ {d.answer}</div>}
      {/* Free text while a question card was open: does NOT answer the card. Without this hint
          the row reads like an answer — and the decision point looks done although it is open. */}
      {d.interjection === true && (
        <div className="mt-1 text-[11.5px] text-warn">{t("Follow-up from you — the question stays open and the step keeps waiting")}</div>
      )}
      {Array.isArray(d.items) && d.items.length > 0 && (
        <div className="mt-1 text-[11.5px] text-dim">
          {t("{n} items", { n: d.items.length })}: {d.items.slice(0, 6).join(", ")}{d.items.length > 6 ? " …" : ""}
          {typeof d.dropped === "number" && d.dropped > 0 && ` · ${t("{n} dropped (cap)", { n: d.dropped })}`}
        </div>
      )}
      {d.event && typeof d.event === "object" && (
        <div className="mt-1 text-[11.5px] text-dim">{(d.event as { summary?: string }).summary || ""}</div>
      )}

      {typeof d.prompt === "string" && d.prompt && <Fold label={t("Prompt sent to the agent")} body={d.prompt} />}
      {typeof d.input === "string" && d.input && <Fold label={t("Input at start")} body={d.input} />}
      {typeof d.output === "string" && d.output && <Fold label={t("Result of the step")} body={d.output} />}
      {Array.isArray(d.tries) && d.tries.length > 0 && (
        <Fold
          label={d.failed ? t("Raw output of the attempts ({n})", { n: d.tries.length }) : t("Response of the judging model")}
          body={(d.tries as string[]).map((x, i) => `— ${t("Attempt {n}", { n: i + 1 })} —\n${x}`).join("\n\n")}
          warn={d.failed === true}
        />
      )}
    </div>
  );
}

function Fold({ label, body, warn = false }: { label: string; body: string; warn?: boolean }) {
  return (
    <details className="mt-1.5 group">
      <summary className={`cursor-pointer list-none text-[11px] font-semibold ${warn ? "text-danger" : "text-dim"} hover:text-fg`}>
        ▸ {label} <span className="font-normal">({body.length})</span>
      </summary>
      <pre className="cb-scroll mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-dim">
        {body}
      </pre>
    </details>
  );
}
