"use client";

// Check and adopt a layout of an existing project.
//
// The right half of the "Layout" page (LayoutPage.tsx): the changes from the tree go as steps to `POST …/layout/check`; the result
// (rules, leave-outs with unsaved work and Docker objects, warnings, findings) shows here, and "Adopt" creates the JOB
// (`POST …/layout/takeOver`). The job waits for quiet — the wait list names every holder with "Stop" —, runs, fails (before the
// cutover: nothing changed; afterwards: "Try again") or ends with a report. The server is the boundary: every lock here only greys out.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeGlobalEvents } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { Hint, Spinner, ghostSm, primary, quietDangerSm } from "@/components/CbKit";
import { type FinalMapping, type Notice, type Step } from "@/lib/project-layout";
import { LAYOUT_STEP_NAMES } from "@/lib/project-setup";
import { sizeText, noticeText } from "@/components/projects/ProjectLayout";

type T = (k: string, p?: Record<string, string | number>) => string;

// ── What the server delivers (projectbox/layout/: check in read.js, the job view in job.js, the empty report) ──────────

export interface Situation {
  rootIsRepo: boolean;
  copyOpen: { name: string; count: number } | null;
  locked: { reason: string; code: string; text: string; name?: string } | null;
}

interface RepoDetails {
  path: string;
  kind: "code-repo" | "worktree";
  worktreeOf?: string | null;
  branch: string | null;
  noRemote?: boolean | null;
  unpushed?: { total: number; refs: { ref: string; commits: number }[] } | number | null;
  commits?: number | null;
  withoutUpstream?: string[];
  copyBackups?: { name: string; branches: string[] }[];
  stashes?: number | null;
  changes: number | null;
  ignored?: { count: number; names: string[] } | null;
  worktrees?: { path: string; outside?: boolean; branch: string | null; missing: boolean; changes: number | null }[];
  unreadable: string[];
}
interface ContainerRow { id: string; name: string; state: string; compose: { project: string; service: string } | null }
interface LeaveOutEntry {
  path: string;
  kind: string | null;
  /** Sum of the lstat sizes under the path (program `details`), null = not readable. */
  size: { bytes: number; files: number } | null;
  repos: RepoDetails[];
  projectRepo: { count: number; names: string[] } | null;
  services: { id: number; name: string }[];
  knowledge: number | null;
  docker: {
    container: ContainerRow[];
    volumes: { name: string; size: number | null }[];
    networks: { id: string; name: string }[];
    images: { id: string; tags: string[]; size: number | null }[];
    stays: { kind: string; name: string; size?: number | null; usedBy: string[] }[];
  } | null;
}
interface Citation { kind: string; name: string; field: string; row?: number; text?: string; secret?: boolean; path: string }
type Warning = Notice & { text?: string };

export interface Result {
  finalMapping: FinalMapping;
  error: (Notice & { prior?: boolean })[];
  warnings: Warning[];
  leaveOut: LeaveOutEntry[];
  move: { old: string; fresh: string; kind: string | null; container: ContainerRow[] | null }[];
  citations: { list: Citation[]; total: number; unreadable?: string[] };
  docker: { read: boolean; error?: string | null };
  situation: Situation;
}

export interface Check {
  check: string;
  state: "running" | "finished" | "error" | "aborted" | "expired";
  steps: Step[];
  result?: Result;
  /** layout/read.js startCheck: `{ code, text }`. */
  error?: { code: string; text: string };
}

export interface Holder { kind: string; id: string; chatId?: string; name: string; text: string; stoppable?: boolean }
interface Report {
  warnings: string[];
  foreign: { name: string }[];
  removed: { container: { name: string }[]; volumes: { name: string; size: number | null }[]; networks: { name: string }[]; images: { id: string; size: number | null }[] };
  add: { kind: string; name: string; size: number | null }[];
  superseded: { name: string; afterwards?: string | null; stack: string; fresh: string }[];
  codeRepos: string[];
  compose: { project: string; name: string; outcome: string }[];
  services: { rewritten: { name: string; old: string; fresh: string }[]; dropped: { name: string }[] };
  knowledge: number;
  findings: string[];
  end: { at: number; ways: { old: string; fresh: string }[]; gone: string[]; codeRepos: string[] } | null;
}
export interface Job {
  state: "waiting" | "running" | "error" | "finished";
  turned: boolean;
  backward: boolean;
  step: string;
  error: string | null;
  since: number;
  steps: Step[];
  finalMapping: FinalMapping | null;
  holders: Holder[];
  hints: Holder[];
  report: Partial<Report> | null;
}

/** Does this job block editing (header: waiting, running, error after the cutover, and an open way back)? */
export const jobOpen = (a: Job | null | undefined) =>
  Boolean(a) && (a!.state === "waiting" || a!.state === "running" || (a!.state === "error" && (a!.turned || a!.backward)));

const sameSteps = (a: Step[], b: Step[]) => JSON.stringify(a) === JSON.stringify(b);
const stepName = (s: string, t: T) => (LAYOUT_STEP_NAMES[s] ? t(LAYOUT_STEP_NAMES[s]) : s);
const errorOf = (e: unknown) => String((e as Error)?.message || e);

// ── The job: load and follow the event `project/layout` ─────────────────────────────────────────────────────────

/** The job of a project — `undefined` until the first answer, `null` without a job (404 NO_JOB). While waiting it rereads every
 *  10 s: the holders do not change only through events (a turn ends, an upload ages). */
export function useLayoutJob(projectId: string) {
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ job: Job }>(`/api/projects/${projectId}/layout/job`);
      setJob(r.job);
      setError(null);
    } catch (e) {
      if ((e as { code?: string }).code === "NO_JOB") { setJob(null); setError(null); return; }
      setError(errorOf(e));
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type !== "project/layout" || String(evt.projectId ?? "") !== projectId) return;
    if (evt.kind === "job" || evt.kind === "finished") void load();
  }), [projectId, load]);
  const waiting = job?.state === "waiting" || job?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    const i = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(i);
  }, [waiting, load]);
  return { job, error, load, setJob };
}

// ── The check ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The running or last check per project — it survives leaving the page like the draft (LayoutPage.tsx). */
const rememberedCheck = new Map<string, string>();

/** Start a check and fetch its result — via the event `project/layout` (`kind: "check"`) and, in case the stream loses an event,
 *  polled every 4 s. After 30 min the server forgets it (404 ⇒ "expired", check again). */
export function useCheck(projectId: string) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const fetch = useCallback(async (id: string) => {
    try {
      const r = await api<Check>(`/api/projects/${projectId}/layout/check/${id}`);
      if (current.current === id) setCheck(r);
    } catch (e) {
      if (current.current !== id) return;
      if ((e as { code?: string }).code === "CHECK_UNKNOWN") setCheck((p) => (p && p.check === id ? { ...p, state: "expired" } : p));
      else setError(errorOf(e));
    }
  }, [projectId]);
  const start = useCallback(async (steps: Step[]) => {
    setError(null);
    try {
      const r = await api<{ check: string }>(`/api/projects/${projectId}/layout/check`, { method: "POST", body: JSON.stringify({ steps }) });
      current.current = r.check;
      rememberedCheck.set(projectId, r.check);
      setCheck({ check: r.check, state: "running", steps });
      void fetch(r.check);
    } catch (e) {
      setError(errorOf(e));
    }
  }, [projectId, fetch]);
  useEffect(() => {
    const id = rememberedCheck.get(projectId);
    if (!id || current.current) return;
    current.current = id;
    void fetch(id);
  }, [projectId, fetch]);
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type !== "project/layout" || evt.kind !== "check" || String(evt.projectId ?? "") !== projectId) return;
    if (current.current && evt.check === current.current) void fetch(current.current);
  }), [projectId, fetch]);
  const running = check?.state === "running";
  useEffect(() => {
    if (!running || !current.current) return;
    const id = current.current;
    const i = setInterval(() => { void fetch(id); }, 4_000);
    return () => clearInterval(i);
  }, [running, fetch]);
  const forget = useCallback(() => { current.current = null; rememberedCheck.delete(projectId); setCheck(null); setError(null); }, [projectId]);
  return { check, error, start, forget };
}

// ── The parts of the display ────────────────────────────────────────────────────────────────────────────────────────────

// No surface (the page is a tab of the project view), in the form of the instances (ProjectForm.tsx): no hairlines — a muted title,
// below it rounded rows that light up under the pointer.
function Section({ title, children, data }: { title: string; children: React.ReactNode; data?: string }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1" data-layout-section={data}>
      <div className="px-2 pb-0.5 text-[11.5px] font-semibold text-dim">{title}</div>
      {children}
    </div>
  );
}
const Row = ({ children, tone }: { children: React.ReactNode; tone?: "warn" | "danger" }) => (
  <div className={`rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-hover ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : ""}`}>{children}</div>
);
const Small = ({ children, tone }: { children: React.ReactNode; tone?: "warn" | "danger" }) => (
  <div className={`text-[11.5px] ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-dim"}`}>{children}</div>
);

/** What would be lost with a repo that drops out: each row only if it says something; "not readable" never as 0. */
function RepoRows({ r, t }: { r: RepoDetails; t: T }) {
  const z: { text: string; tone?: "warn" | "danger" }[] = [];
  if (r.kind === "worktree") {
    z.push({ text: t("Worktree of {repo}{branch}", { repo: r.worktreeOf || "?", branch: r.branch ? ` (${r.branch})` : "" }) });
    if (typeof r.unpushed === "number" && r.unpushed > 0) z.push({ text: t("{n} commits not pushed", { n: r.unpushed }), tone: "danger" });
  } else {
    z.push({ text: t("Code repo {path}{branch}", { path: r.path, branch: r.branch ? ` (${r.branch})` : "" }) });
    const u = r.unpushed;
    if (u && typeof u === "object" && u.total > 0) z.push({ text: t("{n} commits not pushed: {refs}", { n: u.total, refs: u.refs.map((x) => `${x.ref.replace(/^refs\/(heads|tags)\//, "")} (${x.commits})`).join(", ") }), tone: "danger" });
    if (r.noRemote) z.push({ text: t("No remote — {n} commits exist only here", { n: r.commits ?? "?" }), tone: "danger" });
    if ((r.withoutUpstream ?? []).length && !r.noRemote) z.push({ text: t("Branches without upstream: {names}", { names: (r.withoutUpstream ?? []).join(", ") }), tone: "warn" });
    for (const k of r.copyBackups ?? []) z.push({ text: t("Backup of the copy “{name}”: {branches}", { name: k.name, branches: k.branches.join(", ") }), tone: "warn" });
    if ((r.stashes ?? 0) > 0) z.push({ text: t("{n} stashes", { n: r.stashes ?? 0 }), tone: "danger" });
    if (r.ignored && r.ignored.count > 0) z.push({ text: t("{n} ignored files, e.g. {names}", { n: r.ignored.count, names: r.ignored.names.join(", ") }), tone: "warn" });
    for (const w of r.worktrees ?? []) {
      z.push({ text: t("Linked worktree {path}{branch}{changes}", {
        path: w.path, branch: w.branch ? ` (${w.branch})` : "",
        changes: w.missing ? ` — ${t("missing")}` : w.changes ? ` — ${t("{n} uncommitted changes", { n: w.changes })}` : "",
      }), tone: w.changes ? "danger" : undefined });
    }
  }
  if ((r.changes ?? 0) > 0) z.push({ text: t("{n} uncommitted changes", { n: r.changes ?? 0 }), tone: "danger" });
  if (r.unreadable.length) z.push({ text: t("Not readable: {what}", { what: r.unreadable.join(", ") }), tone: "warn" });
  return <>{z.map((x, i) => <Small key={i} tone={x.tone}>{x.text}</Small>)}</>;
}

function LeaveOutList({ list, t }: { list: LeaveOutEntry[]; t: T }) {
  return (
    <Section title={t("Will be deleted ({n})", { n: list.length })} data="leaveOut">
      {list.map((w) => (
        <div key={w.path} className="space-y-0.5 px-3 py-2" data-layout-way={w.path}>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-medium">{w.path}</span>
            <span className="shrink-0 tabular-nums text-[11px] text-dim">
              {!w.size ? t("Size unknown") : w.size.files > 1 ? t("{size} in {n} files", { size: sizeText(w.size.bytes), n: w.size.files }) : sizeText(w.size.bytes)}
            </span>
          </div>
          {w.repos.map((r) => <RepoRows key={r.path} r={r} t={t} />)}
          {w.projectRepo && w.projectRepo.count > 0 && (
            <Small>{t("{n} files are tracked in the project repo — they stay in the creation commit.", { n: w.projectRepo.count })}</Small>
          )}
          {w.services.length > 0 && <Small tone="warn">{t("Services removed with it: {names}", { names: w.services.map((d) => d.name).join(", ") })}</Small>}
          {(w.knowledge ?? 0) > 0 && <Small tone="warn">{t("{n} knowledge entries depend only on this folder", { n: w.knowledge ?? 0 })}</Small>}
          {w.docker && w.docker.container.length > 0 && (
            <Small tone="danger">{t("Containers: {names}", { names: w.docker.container.map((c) => `${c.name} (${c.state})`).join(", ") })}</Small>
          )}
          {w.docker && w.docker.volumes.length > 0 && (
            <Small tone="danger">{t("Volumes: {names}", { names: w.docker.volumes.map((v) => `${v.name}${v.size === null ? "" : ` (${sizeText(v.size)})`}`).join(", ") })}</Small>
          )}
          {w.docker && w.docker.networks.length > 0 && <Small>{t("Networks: {names}", { names: w.docker.networks.map((n) => n.name).join(", ") })}</Small>}
          {w.docker && w.docker.images.length > 0 && (
            <Small>{t("Images: {names}", { names: w.docker.images.map((i) => `${i.tags[0] || i.id.slice(0, 19)}${i.size === null ? "" : ` (${sizeText(i.size)})`}`).join(", ") })}</Small>
          )}
          {(w.docker?.stays ?? []).map((b, i) => (
            <Small key={i}>{t("Stays: {name} — used by {usedBy}", { name: b.name, usedBy: b.usedBy.join(", ") })}</Small>
          ))}
        </div>
      ))}
    </Section>
  );
}

function ResultView({ e, t }: { e: Result; t: T }) {
  const moveWithContainers = e.move.filter((v) => (v.container ?? []).length > 0);
  const fund = e.citations;
  return (
    <div className="space-y-2" data-layout-result>
      {e.error.length > 0 && (
        <Hint tone="danger">
          {e.error.map((f, i) => (
            <div key={i}>{noticeText(f, t)}{f.prior ? ` ${t("(already the case before)")}` : ""}</div>
          ))}
        </Hint>
      )}
      {!e.docker.read && e.docker.error && (
        <Hint tone="warn">{t("Docker in the project container could not be read ({reason}) — applying needs a successful read.", { reason: e.docker.error })}</Hint>
      )}
      {e.leaveOut.length > 0 && <LeaveOutList list={e.leaveOut} t={t} />}
      {e.warnings.length > 0 && (
        <Section title={t("Warnings ({n})", { n: e.warnings.length })} data="warnings">
          {e.warnings.map((w, i) => <Row key={i} tone="warn">{w.text || noticeText(w, t)}</Row>)}
        </Section>
      )}
      {moveWithContainers.length > 0 && (
        <Section title={t("Containers that will be recreated")} data="container">
          {moveWithContainers.map((v) => (
            <Row key={v.old}>
              {t("{old} → {fresh}: {names}", { old: v.old, fresh: v.fresh, names: (v.container ?? []).map((c) => c.name).join(", ") })}
            </Row>
          ))}
        </Section>
      )}
      {fund.total > 0 && (
        <Section title={t("Mentions of the old path ({n}) — nothing is replaced", { n: fund.total })} data="citations">
          {fund.list.map((f, i) => (
            <div key={i} className="px-3 py-1.5 text-[11.5px]">
              <div className="truncate"><span className="text-dim">{f.kind}</span> {f.name} · {f.field}{f.row ? `:${f.row}` : ""}</div>
              {f.secret ? <Small>{t("A secret — only its key is shown.")}</Small> : f.text && <div className="truncate font-mono text-[11px] text-dim">{f.text}</div>}
            </div>
          ))}
          {fund.total > fund.list.length && <Row>{t("… and {n} more", { n: fund.total - fund.list.length })}</Row>}
        </Section>
      )}
      {(fund.unreadable ?? []).length > 0 && <Small tone="warn">{t("Not searched: {what}", { what: (fund.unreadable ?? []).join(", ") })}</Small>}
    </div>
  );
}

function HolderList({ title, list, onStop, t }: { title: string; list: Holder[]; onStop?: (h: Holder) => void; t: T }) {
  if (!list.length) return null;
  return (
    <Section title={title} data="holders">
      {list.map((h) => (
        <div key={`${h.kind}:${h.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-hover">
          <div className="min-w-0 flex-1">
            <div className="truncate">{h.text}</div>
            {h.name && <Small>{h.name}</Small>}
          </div>
          {onStop && h.stoppable && (
            <button type="button" onClick={() => onStop(h)} className={quietDangerSm} data-layout-stop={h.kind}>{t("Stop")}</button>
          )}
        </div>
      ))}
    </Section>
  );
}

function ReportView({ b, t }: { b: Partial<Report>; t: T }) {
  const e = b.end;
  const removed = b.removed;
  const countRemoved = removed ? removed.container.length + removed.volumes.length + removed.networks.length + removed.images.length : 0;
  return (
    <div className="space-y-2" data-layout-report>
      {e && (e.ways.length > 0 || e.gone.length > 0 || e.codeRepos.length > 0) && (
        <Section title={t("Changed##section")}>
          {e.ways.map((w) => <Row key={w.old}>{t("{old} → {fresh}", { old: w.old, fresh: w.fresh })}</Row>)}
          {e.gone.map((p) => <Row key={p}>{t("{path} deleted", { path: p })}</Row>)}
          {e.codeRepos.map((p) => <Row key={p}>{t("{path} is now a code repo", { path: p })}</Row>)}
        </Section>
      )}
      {countRemoved > 0 && removed && (
        <Section title={t("Docker objects removed ({n})", { n: countRemoved })}>
          {removed.container.length > 0 && <Row>{t("Containers: {names}", { names: removed.container.map((c) => c.name).join(", ") })}</Row>}
          {removed.volumes.length > 0 && <Row>{t("Volumes: {names}", { names: removed.volumes.map((v) => v.name).join(", ") })}</Row>}
          {removed.networks.length > 0 && <Row>{t("Networks: {names}", { names: removed.networks.map((n) => n.name).join(", ") })}</Row>}
          {removed.images.length > 0 && <Row>{t("{n} images", { n: removed.images.length })}</Row>}
        </Section>
      )}
      {(b.add ?? []).length > 0 && (
        <Section title={t("Added after the confirmation and deleted as well")}>
          {(b.add ?? []).map((h, i) => <Row key={i} tone="warn">{`${h.kind}: ${h.name}${h.size === null ? "" : ` (${sizeText(h.size)})`}`}</Row>)}
        </Section>
      )}
      {(b.superseded ?? []).length > 0 && (
        <Section title={t("Old containers (stopped, removable on the Services page)")}>
          {(b.superseded ?? []).map((a, i) => <Row key={i}>{t("{name} — the stack is now called {fresh}", { name: a.afterwards || a.name, fresh: a.fresh })}</Row>)}
        </Section>
      )}
      {b.services && (b.services.rewritten.length > 0 || b.services.dropped.length > 0) && (
        <Section title={t("Services")}>
          {b.services.rewritten.map((d, i) => <Row key={`u${i}`}>{t("{name}: {old} → {fresh}", { name: d.name, old: d.old || "/", fresh: d.fresh || "/" })}</Row>)}
          {b.services.dropped.map((d, i) => <Row key={`g${i}`} tone="warn">{t("{name} deleted", { name: d.name })}</Row>)}
        </Section>
      )}
      {(b.foreign ?? []).length > 0 && <Hint tone="warn">{t("Stopped because they ran in the project: {names}", { names: (b.foreign ?? []).map((f) => f.name).join(", ") })}</Hint>}
      {[...(b.warnings ?? []), ...(b.findings ?? [])].length > 0 && (
        <Section title={t("To check")}>
          {[...(b.warnings ?? []), ...(b.findings ?? [])].map((w, i) => <Row key={i} tone="warn">{w}</Row>)}
        </Section>
      )}
    </div>
  );
}

// ── Half of the page ─────────────────────────────────────────────────────────────────────────────────────────────────

export function LayoutTakeOver({
  projectId, steps, planError, situation, jobState, onSteps, onFinishedSeen,
}: {
  projectId: string;
  /** The steps from the tree (the combined list). */
  steps: Step[];
  /** Errors of the client-side computation — they do not block checking (the server sees the whole tree), but they block adopting. */
  planError: number;
  situation: Situation | null;
  jobState: ReturnType<typeof useLayoutJob>;
  onSteps: (s: Step[]) => void;
  /** After a report is hidden or the job ends: the page reloads the tree (the paths have changed). */
  onFinishedSeen: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const { job, error: jobError, load, setJob } = jobState;
  const { check, error: checkError, start, forget } = useCheck(projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportGone, setReportWay] = useState(false);

  // An end this page witnesses: reload the tree (the paths are different) — once per job.
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    const z = job?.state;
    if (z === "finished" && last.current && last.current !== "finished") { onSteps([]); forget(); onFinishedSeen(); }
    last.current = z;
  }, [job?.state, onSteps, forget, onFinishedSeen]);

  const tu = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorOf(e)); } finally { setBusy(false); await load(); }
  };

  const stale = Boolean(check) && !sameSteps(check!.steps, steps);
  const e = check?.state === "finished" && !stale ? check.result : undefined;
  const changes = e ? e.finalMapping.ways.length + e.finalMapping.gone.length + e.finalMapping.codeRepos.length : 0;
  const adoptable = Boolean(e) && e!.error.length === 0 && planError === 0 && changes > 0 && !situation?.locked && !(e!.docker.error && !e!.docker.read);

  async function takeOver() {
    if (!e || !check) return;
    const dropping = e.leaveOut.length;
    const text = dropping
      ? t("{n} entries will be deleted permanently — together with everything listed under “Will be deleted”. Apply the outline as soon as the project is idle?", { n: dropping })
      : t("Apply the outline as soon as the project is idle? Services and affected containers are stopped briefly for it.");
    if (!(await question(text, { ok: t("Adopt"), danger: dropping > 0 }))) return;
    await tu(async () => {
      const r = await api<{ job: Job }>(`/api/projects/${projectId}/layout/takeOver`, {
        method: "POST", body: JSON.stringify({ steps: check.steps, check: check.check }),
      });
      setJob(r.job);
      setReportWay(false);
    });
  }
  const revert = (keep: boolean) => tu(async () => {
    const old = job?.steps ?? [];
    await api(`/api/projects/${projectId}/layout/job`, { method: "DELETE" });
    setJob(null);
    if (keep) onSteps(old);
  });
  const checkAgain = () => {
    const old = job?.steps ?? [];
    onSteps(old);
    void start(old);
  };
  const again = () => tu(() => api(`/api/projects/${projectId}/layout/job/again`, { method: "POST" }));
  const stop = async (h: Holder) => {
    if (!(await question(t("Stop “{text}”?", { text: h.text }), { ok: t("Stop"), danger: true }))) return;
    await tu(() => api(`/api/projects/${projectId}/layout/holders/stop`, { method: "POST", body: JSON.stringify({ kind: h.kind, id: h.id }) }));
  };

  const errorRow = [error, checkError, jobError].filter(Boolean)[0];

  // ── An open job ──
  if (job && job.state !== "finished" && !(job.state === "error" && !job.turned && !job.backward)) {
    return (
      <div className="space-y-2" data-layout-job={job.state}>
        {errorRow && <Hint tone="danger">{errorRow}</Hint>}
        {job.state === "waiting" && (
          <>
            <Hint tone="warn">
              {job.holders.length
                ? t("Waiting for the project to be idle — applied as soon as nothing is working any more ({n}).", { n: job.holders.length })
                : t("Checking whether the project is idle…")}
            </Hint>
            <HolderList title={t("Waiting list")} list={job.holders} onStop={(h) => void stop(h)} t={t} />
            <HolderList title={t("Waits afterwards, does not hold up")} list={job.hints} t={t} />
            <div className="flex justify-end">
              <button type="button" disabled={busy} onClick={() => void revert(true)} className={`${ghostSm} disabled:opacity-40`} data-layout-revert>{t("Undo")}</button>
            </div>
          </>
        )}
        {job.state === "running" && (
          <div className="flex items-center gap-2 px-2 py-2.5 text-[12.5px]">
            <Spinner />
            <span>{job.backward ? t("Reverting: {step}", { step: stepName(job.step, t) }) : t("Applying: {step}", { step: stepName(job.step, t) })}</span>
          </div>
        )}
        {job.state === "error" && (
          <>
            <Hint tone="danger">
              {job.turned
                ? t("Half applied at “{step}”: {reason}. The project stays locked until the rest has run.", { step: stepName(job.step, t), reason: job.error ?? "" })
                : t("Reverting was interrupted: {reason}", { reason: job.error ?? "" })}
            </Hint>
            <div className="flex justify-end">
              <button type="button" disabled={busy} onClick={() => void again()} className={`${primary} disabled:opacity-40`} data-layout-again>{t("Try again")}</button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {errorRow && <Hint tone="danger">{errorRow}</Hint>}
      {job?.state === "error" && (
        <div className="space-y-2" data-layout-job="error">
          <Hint tone="danger">{t("The outline no longer fits: {reason}. Nothing in the project was changed.", { reason: job.error ?? "" })}</Hint>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => void revert(false)} className={`${ghostSm} disabled:opacity-40`}>{t("Undo")}</button>
            <button type="button" disabled={busy || Boolean(situation?.locked)} onClick={checkAgain} className={`${primary} disabled:opacity-40`}>{t("Check again")}</button>
          </div>
        </div>
      )}
      {job?.state === "finished" && job.report && !reportGone && steps.length === 0 && (
        <div className="space-y-2">
          <Hint tone="ok">{t("The outline has been applied.")}</Hint>
          <ReportView b={job.report} t={t} />
          <div className="flex justify-end">
            <button type="button" onClick={() => setReportWay(true)} className={ghostSm}>{t("Dismiss##hide")}</button>
          </div>
        </div>
      )}
      {situation?.locked && <Hint tone="warn">{situation.locked.text}</Hint>}
      {!situation?.locked && !jobOpen(job) && (job?.state !== "error" || steps.length > 0) && (
        <>
          {steps.length === 0 ? (
            <div className="px-1 text-[12px] text-dim">{t("Change the outline on the left — drag, rename, leave out, mark as code repo. Then check and apply.")}</div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {stale && <span className="mr-auto text-[11.5px] text-warn">{t("The changes are newer than the check.")}</span>}
              {check?.state === "expired" && !stale && <span className="mr-auto text-[11.5px] text-warn">{t("The check has expired.")}</span>}
              <button
                type="button"
                disabled={busy || check?.state === "running"}
                onClick={() => void start(steps)}
                className={`${e ? ghostSm : primary} disabled:opacity-40`}
                data-layout-check
              >
                {check?.state === "running" ? t("Checking…") : e ? t("Check again") : t("Check")}
              </button>
              {e && (
                <button type="button" disabled={busy || !adoptable} onClick={() => void takeOver()} className={`${primary} disabled:opacity-40`} data-layout-take-over>
                  {t("Adopt")}
                </button>
              )}
            </div>
          )}
          {check?.state === "running" && !stale && (
            <div className="flex items-center gap-2 px-1 text-[12px] text-dim"><Spinner /> {t("Checking repos, Docker and mentions in the project container…")}</div>
          )}
          {check?.state === "error" && !stale && (
            <Hint tone="danger">{t("Check failed: {reason}", { reason: check.error?.text || check.error?.code || t("unknown") })}</Hint>
          )}
          {check?.state === "aborted" && !stale && <Hint tone="warn">{t("The check was cancelled — check again.")}</Hint>}
          {e && changes === 0 && <Hint tone="warn">{t("These changes change nothing.")}</Hint>}
          {e && <ResultView e={e} t={t} />}
          {e && (
            <Small>{t("Running work (turns, agents, terminals, uploads) is only checked when applying: the order waits until the project is idle.")}</Small>
          )}
        </>
      )}
    </div>
  );
}
