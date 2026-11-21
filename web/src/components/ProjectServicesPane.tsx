"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { stopNotice } from "@/lib/services-status";
import { withResponse, transitionStep, type ServiceTransition } from "@/lib/service-transition";
import { AgentStartDialog } from "@/components/AgentStartDialog";
import { ServiceTransitionIndicator } from "@/components/ServiceTransitionIndicator";
import { useT } from "@/lib/i18n";
import { readActiveScope } from "@/lib/active-scope";
import { openCodingChat } from "@/lib/chat-jump";
import { BackButton, Hint, Menu, MenuEntry, ghost, ghostSm, quietDangerSm } from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";
import { FACTS, Fact, Tile, LIST_ROW, S } from "@/components/projects/ProjectForm";

// Opens the chat that starts a service via an agent (a Coding chat in the project, server/projects/coding-jobs.js).
// The view stands in the workspace this tab shows; the project belongs to it.
const openServiceChat = (chatId: string) => {
  const ws = readActiveScope().workspaceId;
  if (ws) openCodingChat(chatId, ws);
};

interface ServiceStatus {
  running: boolean;
  // The server's start guard holds a start although the port shows nothing (the group is alive but does not listen on the
  // registered port); then "Stop" is offered instead of "Start", otherwise the start would end in 409 with no way out.
  // Absent on older servers.
  holdsStart?: boolean;
  mode: "simple" | "agent" | null;
  pid: number | null;
  since: number | null;
  chatId: string | null;
  hasLog: boolean;
}

interface Service {
  id: number;
  name: string;
  kind: string;
  port: number | null;
  tech: string;
  dir: string;
  startCommand: string;
  description: string;
  agentInstructions?: string;
  status?: ServiceStatus;
}

interface ScanState {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  count?: number;
  error?: string;
  conflicts?: { port: number; name: string; owner: string }[];
  // What the scan no longer named: `notFound` stays (registered by hand, unknown origin, running or in the target
  // state), `removed` was dropped. Absent on older servers.
  notFound?: { id: number; name: string }[];
  removed?: { id: number; name: string }[];
}

const KIND_LABELS: Record<string, string> = {
  backend: "Backend",
  frontend: "Frontend",
  db: "Database",
  cache: "Cache",
  queue: "Queue",
  worker: "Worker",
  infra: "Infra",
  other: "Other",
};

// Services of a project: the result of the AI service scan (runs at project creation, repeatable here via
// "Rescan"). Services can be started (simple or via an agent) and stopped; the run state is polled regularly.
//
// In the form of the instances (projects/ProjectForm.tsx): no hairlines, rounded rows, light under the pointer; in
// front a tile in the colour of the state (green running, accent in transition, yellow "running, not reachable",
// dimmed stopped), below it kind · tech · port · location as facts with small icons; above the list the summary
// "N services · M running" with "Rescan" beside it. The run state is a dot with a word, the actions stand on the
// right of the row. `embedded` (tab "Services" of the project view, projects/ProjectView.tsx) drops the back
// link and title; the view carries those itself.
export function ProjectServicesPane({
  projectId,
  projectName,
  onBack,
  embedded = false,
  startLocked = null,
  addition = null,
}: {
  projectId: string;
  projectName: string;
  /** The back link in its own header; only without `embedded`. */
  onBack?: () => void;
  /** In a view that shows back link and project name itself: no header of its own, only counter and "Rescan". */
  embedded?: boolean;
  /** Reason why no service may start right now (a running layout job); the server otherwise answers 409. */
  startLocked?: string | null;
  /** Below the list: e.g. "Old containers (N)" (projects/OldContainerRemove.tsx). */
  addition?: React.ReactNode;
}) {
  const t = useT();
  const question = useConfirm();
  const [services, setServices] = useState<Service[] | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  // The start/stop request itself finishes quickly. The transition therefore stays active separately until status polling
  // confirms the target state, or `transitionStep` (lib/service-transition.ts) says it will not come any more: a simple
  // start whose command did not keep running, and every transition after its deadline. "Starting" must not end on `running` alone.
  const [transitions, setTransitions] = useState<Record<number, ServiceTransition>>({});
  // The same state for reading in `load` (a snapshot is evaluated, and only an unchanged entry is removed).
  const transitionsRef = useRef(transitions);
  transitionsRef.current = transitions;
  const [logsFor, setLogsFor] = useState<number | null>(null);
  const [logText, setLogText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentDialog, setAgentDialog] = useState<Service | null>(null);
  const [editCmdFor, setEditCmdFor] = useState<number | null>(null); // inline edit of the start command
  const [cmdDraft, setCmdDraft] = useState("");

  const load = useCallback(async () => {
    const queried = Date.now();
    const d = await api<{ scan: ScanState | null; services: Service[] }>(
      `/api/projects/${projectId}/services`,
    );
    setScan(d.scan);
    setServices(d.services);
    // `now` (after the response): when the state arrived; from the first dead one the grace period counts (`deadSince`).
    const now = Date.now();
    const ends = new Map<number, ServiceTransition>();
    // A transition that continues but advanced `deadSince`: old → new (replaces only if the old one is still there).
    const carriedForward = new Map<number, [ServiceTransition, ServiceTransition]>();
    const ended: string[] = [];
    for (const [id, u] of Object.entries(transitionsRef.current)) {
      const service = d.services.find((x) => x.id === Number(id));
      const state = service ? { running: service.status?.running ?? false, holdsStart: service.status?.holdsStart ?? false } : null;
      const { end, next } = transitionStep(u, state, { now, queried });
      if (!end) {
        if (next !== u) carriedForward.set(Number(id), [u, next]);
        continue;
      }
      ends.set(Number(id), u);
      if (end === "ended" && service) ended.push(service.name);
    }
    if (!ends.size && !carriedForward.size) return;
    setTransitions((current) => {
      let changed = false;
      const next = { ...current };
      for (const [id, u] of ends) {
        if (next[id] !== u) continue;
        delete next[id];
        changed = true;
      }
      for (const [id, [old, fresh]] of carriedForward) {
        if (next[id] !== old) continue;
        next[id] = fresh;
        changed = true;
      }
      return changed ? next : current;
    });
    // The start command did not keep running; the row is back at "stopped" and "Logs" shows the reason.
    if (ended.length) setActionError(ended.map((name) => t("“{name}” did not keep running after the start — the service log has the reason.", { name })).join(" · "));
  }, [projectId, t]);

  useEffect(() => {
    setTransitions({});
  }, [projectId]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  // Refresh the run state regularly; nearly live during start/stop, so the transition
  // indicator ends exactly when the service has really switched.
  const hasTransition = Object.keys(transitions).length > 0;
  useEffect(() => {
    const interval = hasTransition ? 800 : scan?.status === "running" ? 3000 : 5000;
    const t = setInterval(() => load().catch(console.error), interval);
    return () => clearInterval(t);
  }, [hasTransition, scan?.status, load]);

  function setServiceTransition(serviceId: number, transition: ServiceTransition | null) {
    setTransitions((current) => {
      if (transition) return { ...current, [serviceId]: transition };
      if (!(serviceId in current)) return current;
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
  }

  async function rescan() {
    await api(`/api/projects/${projectId}/services/scan`, { method: "POST" });
    await load();
  }

  // Save the start command: manual corrections survive rescans (service_start_commands);
  // clearing releases the command again, and the next scan derives it by itself.
  async function saveCmd(s: Service) {
    const v = cmdDraft.trim();
    setEditCmdFor(null);
    if (v === s.startCommand) return;
    try {
      await api(`/api/project-services/${s.id}`, { method: "PATCH", body: JSON.stringify({ startCommand: v }) });
      await load();
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  // Remove a service from the list. A rescan removes only what it created itself and what is not running; a row
  // registered by hand, a row from before origins were tracked and a duplicate next to a running service stay;
  // without this button they could only go through an agent (cbase_service_delete). Only on a stopped service: the
  // process of a running one would be left without a row, and nothing would stop it any more.
  async function removeService(s: Service) {
    setActionError(null);
    const ok = await question(t("Remove service “{name}” from the list? The next scan adds it again if it finds it.", { name: s.name }), { ok: t("Remove"), danger: true });
    if (!ok) return;
    try {
      await api(`/api/project-services/${s.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setActionError(t("Removing failed: {msg}", { msg: String((e as Error).message) }));
    }
  }

  // An agent start first opens the instructions dialog; the simple start runs directly.
  function startService(s: Service, mode: "simple" | "agent") {
    setActionError(null);
    if (mode === "agent") {
      setAgentDialog(s);
      return;
    }
    startServiceNow(s, "simple");
  }

  async function startServiceNow(s: Service, mode: "simple" | "agent", instructions?: string) {
    const u: ServiceTransition = { kind: "starting", since: Date.now(), mode: mode };
    setServiceTransition(s.id, u);
    try {
      const r = await api<{ mode: string; chatId?: string }>(
        `/api/projects/${projectId}/services/${s.id}/start`,
        { method: "POST", body: JSON.stringify({ mode, instructions }) },
      );
      // The response is in; only a state from after it may end a simple start as "did not keep running".
      setTransitions((cur) => (cur[s.id] === u ? { ...cur, [s.id]: withResponse(u, Date.now()) } : cur));
      if (r.chatId) openServiceChat(r.chatId); // agent start → the Coding chat that brings the service up
      await load();
    } catch (e) {
      setServiceTransition(s.id, null);
      setActionError(t("Start failed: {msg}", { msg: String((e as Error).message) }));
    }
  }

  async function stopService(s: Service) {
    setActionError(null);
    setServiceTransition(s.id, { kind: "stopping", since: Date.now() });
    try {
      // The server's reason (`error`, e.g. "project container ... is frozen ...") instead of the generic sentence.
      const notice = stopNotice(await api<unknown>(`/api/projects/${projectId}/services/${s.id}/stop`, { method: "POST" }), s.name, t);
      if (notice) {
        setServiceTransition(s.id, null);
        setActionError(notice);
      }
      await load();
    } catch (e) {
      setServiceTransition(s.id, null);
      setActionError(t("Stop failed: {msg}", { msg: String((e as Error).message) }));
    }
  }

  async function toggleLogs(s: Service) {
    if (logsFor === s.id) {
      setLogsFor(null);
      return;
    }
    setLogsFor(s.id);
    setLogText(t("Loading log…"));
    try {
      const r = await api<{ log: string }>(`/api/projects/${projectId}/services/${s.id}/log`);
      setLogText(r.log || t("(Log is empty)"));
    } catch (e) {
      setLogText(t("Could not load log: {msg}", { msg: String((e as Error).message) }));
    }
  }

  const list = services ?? [];
  const removed = scan?.removed ?? [];
  const stay = (scan?.notFound ?? []).filter((d) => list.some((s) => s.id === d.id));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        {!embedded && onBack && <BackButton label={t("Projects")} onClick={onBack} />}
        {!embedded && <h3 className="min-w-0 truncate text-[14px] font-semibold tracking-tight">Services · {projectName}</h3>}
        <p className="min-w-0 flex-1 text-[13px] tabular-nums text-dim" data-services-summary>
          {list.length > 0
            ? `${list.length === 1 ? t("1 service") : t("{n} services", { n: list.length })} · ${t("{n} running", { n: list.filter((s) => s.status?.running).length })}`
            : " "}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {scan?.status === "running" ? (
            <span className="text-[12px] font-medium text-dim">{t("Scan running — AI agent is inventorying the stack…")}</span>
          ) : (
            <button type="button" onClick={rescan} className={ghost}>{t("Rescan")}</button>
          )}
        </div>
      </div>

      {actionError && <Hint tone="danger">{actionError}</Hint>}
      {startLocked && <Hint tone="warn">{startLocked}</Hint>}
      {scan?.status === "error" && <Hint tone="danger">{t("Scan failed:")} {scan.error}</Hint>}
      {scan?.status === "done" && (scan.conflicts?.length ?? 0) > 0 && (
        <Hint tone="warn">
          <span className="font-semibold">{t("Port conflicts during registration:")}</span>{" "}
          {scan.conflicts!.map((c) => t(":{port} ({name} — belongs to \"{owner}\")", { port: c.port, name: c.name, owner: c.owner })).join(", ")}
                  </Hint>
      )}
      {/* What the last scan no longer found: the same message as the bell, here beside the button. What was removed by
          hand since then no longer appears under "stay" (the scan's state stays until the next one). */}
      {scan?.status === "done" && (removed.length > 0 || stay.length > 0) && (
        <Hint tone="warn">
          {removed.length > 0 && (
            <span className="block">{t("No longer found and removed: {names}", { names: removed.map((d) => d.name).join(", ") })}</span>
          )}
          {stay.length > 0 && (
            <span className="block">{t("Not found, they stay: {names} — “Remove” on the row takes one out.", { names: stay.map((d) => d.name).join(", ") })}</span>
          )}
        </Hint>
      )}

      {services !== null && list.length === 0 && (
        <p className="shrink-0 py-10 text-[13px] leading-relaxed text-dim">
          {scan?.status === "running"
            ? t("The agent is reading the project folder…")
            : t("No services recorded yet. 'Rescan' lets an AI agent inventory the stack in the project folder.")}
        </p>
      )}

      {list.length > 0 && (
        <div className="flex shrink-0 flex-col gap-0.5" data-services-list>
          {list.map((s) => {
            const running = s.status?.running ?? false;
            const holds = !running && (s.status?.holdsStart ?? false);
            const transition = transitions[s.id]?.kind;
            const state = transition === "starting" ? t("Starting") : transition === "stopping" ? t("Stopping") : running ? t("running") : holds ? t("running, not reachable") : t("stopped");
            return (
              <div key={s.id} className={`${LIST_ROW} items-start hover:bg-hover`} data-service={s.id}>
                {/* The tile carries the state as colour and does NOT pulse: a transition is a process and stands beside it as a word and
                    spinner (a pulsing 8 px dot measurably cost 27 % CPU). */}
                <Tile
                  color={transition === "starting" ? "text-accent" : transition === "stopping" ? "text-danger" : running ? "text-ok" : holds ? "text-warn" : "text-dim"}
                  title={state}
                  data={{ "data-service-tile": transition ?? (running ? "running" : holds ? "holds" : "stopped") }}
                >
                  {S.services(16)}
                </Tile>
                <div className="min-w-0 flex-1">
                <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{s.name}</span>
                      {(!running || transition) && (
                        <span className={`shrink-0 text-[12px] ${transition === "starting" ? "text-accent" : transition === "stopping" ? "text-danger" : holds ? "text-warn" : "text-dim"}`} data-service-word>{state}</span>
                      )}
                      {running && !transition && s.status?.mode === "agent" && <span className="shrink-0 text-[12px] text-dim">{t("via agent")}</span>}
                    </span>
                    <span className={`mt-0.5 ${FACTS}`}>
                      <span className="shrink-0">{t(KIND_LABELS[s.kind] || s.kind)}</span>
                      {s.tech && <span className="min-w-0 truncate">{s.tech}</span>}
                      <Fact symbol={S.port(12)} className="shrink-0 font-mono" title={s.port != null ? t("Port {port}", { port: s.port }) : t("no port detected")}>
                        {s.port != null ? `:${s.port}` : "—"}
                      </Fact>
                      {s.dir && <Fact symbol={S.project(12)}><span className="min-w-0 truncate font-mono text-[11.5px]">/{s.dir}</span></Fact>}
                    </span>
                  </span>

                  {/* Actions on the right: ONE filled button (Start, graphite), everything else quiet. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {running && s.status?.mode === "agent" && s.status.chatId && (
                      <button type="button" onClick={() => openServiceChat(s.status!.chatId!)} className={ghostSm}>{t("Chat")}</button>
                    )}
                    {s.status?.hasLog && (
                      <button type="button" onClick={() => toggleLogs(s)} className={`${ghostSm} ${logsFor === s.id ? "bg-hover text-fg" : ""}`}>
                        {logsFor === s.id ? t("Hide log") : t("Logs")}
                      </button>
                    )}
                    {/* While "Starting", Stop stands beside it as soon as the start guard holds the run; otherwise it would wait
                        until the deadline with no way out. The start menu is the kit `Menu`: its sheet hangs on the body, whereas a
                        hand-built one stood `absolute` in this surface (`overflow-hidden`) and was clipped under the last row. */}
                    {transition === "starting" && !running && !holds ? (
                      <ServiceTransitionIndicator kind="starting" />
                    ) : running || holds ? (
                      transition === "stopping" ? (
                        <ServiceTransitionIndicator kind="stopping" />
                      ) : (
                        <>
                          {transition === "starting" && <ServiceTransitionIndicator kind="starting" />}
                          <button type="button" onClick={() => stopService(s)} className={quietDangerSm}>{t("Stop")}</button>
                        </>
                      )
                    ) : (
                      <>
                        {!transition && (
                          <button type="button" onClick={() => void removeService(s)} className={ghostSm} title={t("Remove from the list")}>{t("Remove")}</button>
                        )}
                        <Menu
                          label={t("Start")}
                          width={268}
                          button={{
                            content: <>{t("Start")}<CaretDown /></>,
                            className: "flex items-center gap-1 rounded-full bg-dark px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90",
                          }}
                        >
                          <MenuEntry
                            label={t("Simple start")}
                            hint={startLocked ?? (s.startCommand ? t("Run start command directly") : t("No start command detected"))}
                            disabled={!s.startCommand || Boolean(startLocked)}
                            onClick={() => startService(s, "simple")}
                          />
                          <MenuEntry
                            label={t("Start with agent")}
                            hint={startLocked ?? t("An agent brings the service up (env, dependencies, port check)")}
                            disabled={Boolean(startLocked)}
                            onClick={() => startService(s, "agent")}
                          />
                        </Menu>
                      </>
                    )}
                  </div>
                </div>

                {s.description && <div className="mt-1.5 max-w-[80ch] text-[12.5px] leading-relaxed text-dim">{s.description}</div>}

                {/* Location and start command in one line: the location is a marker, the command stays
                    editable in place (a click turns the line into a field). */}
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {editCmdFor === s.id ? (
                    <input
                      autoFocus
                      value={cmdDraft}
                      onChange={(e) => setCmdDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveCmd(s);
                        if (e.key === "Escape") setEditCmdFor(null);
                      }}
                      onBlur={() => void saveCmd(s)}
                      placeholder={t("Start command — leave empty to let the scan derive it")}
                      spellCheck={false}
                      className="min-w-[240px] flex-1 rounded-lg bg-code px-2 py-1 font-mono text-[11px] outline-none ring-1 ring-accent/50"
                    />
                  ) : s.startCommand ? (
                    <code
                      onClick={() => { setEditCmdFor(s.id); setCmdDraft(s.startCommand); }}
                      title={t("Click to edit — changes survive re-scans")}
                      className="min-w-0 max-w-full cursor-text truncate rounded-lg bg-code px-2 py-1 font-mono text-[11px] transition-shadow hover:ring-1 hover:ring-accent/50"
                    >
                      {s.startCommand}
                    </code>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setEditCmdFor(s.id); setCmdDraft(""); }}
                      className="text-[11px] font-medium text-dim hover:text-fg"
                    >
                      + {t("Set start command")}
                    </button>
                  )}
                </div>

                {logsFor === s.id && (
                  <pre className="cb-scroll mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-code p-2.5 font-mono text-[11px] leading-relaxed">
                    {logText}
                  </pre>
                )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addition}

      {agentDialog && (
        <AgentStartDialog
          serviceName={agentDialog.name}
          initial={agentDialog.agentInstructions || ""}
          onClose={() => setAgentDialog(null)}
          onStart={(instructions) => {
            const s = agentDialog;
            setAgentDialog(null);
            startServiceNow(s, "agent", instructions);
          }}
        />
      )}
    </div>
  );
}

const CaretDown = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
