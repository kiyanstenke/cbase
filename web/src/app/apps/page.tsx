"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Workspace } from "@/lib/api";
import { AgentStartDialog } from "@/components/AgentStartDialog";
import { HeadersMiddle } from "@/components/HeadersMiddle";
import { ServiceTransitionIndicator } from "@/components/ServiceTransitionIndicator";
import { CopyDelete } from "@/components/projects/InstanceDialogs";
import {
  Hint, Header, Empty, Menu, MenuEntry, Modal, ModalTitle, Overline, Placeholder, RemoveButton,
  SplitBackButton, SplitPane, field, ghost, primary, quietDangerSm,
} from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { WORK, fallbackOutdated, stateWord } from "@/lib/instance-state";
import { APPS_PROJECT_EVENT } from "@/lib/active-scope";
import { withResponse, transitionStep, type ServiceTransition } from "@/lib/service-transition";
import { openCodingChat } from "@/lib/chat-jump";
import {
  clearAwayResult, clearAwayPath, serviceInInstance, fmtBytes, runningPerInstance, stopNotice,
  type InstanceResource, type InstanceStatus, type ResourcesRow,
} from "@/lib/services-status";
import {
  instancePath, copyNameOf, afterError, selectInstance, type InstanceField, type InstanceHint, type InstanceChoice, type ListSituation,
} from "@/lib/code-instance";

// The apps page: an overview of the projects and which stacks run under them (main docker stack and copies). ONE view instead of
// projects · ports:
//   left   the projects of all workspaces, one surface per workspace; per project its stacks (the main one, i.e. the project
//          container with its compose stack, and every copy) with state and load, the running services at the top right;
//   right  the chosen project: the stacks as rows (per instance "start/stop all", for copies "Clear away") and the services as
//          ONE row per service (state, name, kind, port, start command, actions). The description sits in the tooltip of the
//          name and in the edit dialog; it is the operating manual for the service agent, not running text for the list.
// Instance choice: from one ready copy on, the stack rows ARE the choice: a click on "Main" or "k1" selects the instance, and state,
// "Stop"/"Start" of the services and the header then apply to it. The computation is that of the code tab (lib/code-instance.ts
// `selectInstance`: only ready copies, visible fallback, a temporarily not ready copy stays selected, empty is not unknown),
// remembered per project under `cbase-apps-instance:<projectId>`. The main one carries no parameter, a copy `?instance=<identifier>`;
// there is no agent start in a copy (409 COPY_AGENT). The state of a service in the copy comes from `instances[]` of the service row
// (`serviceInInstance`); if it is missing it is "unknown", never "stopped". A 404 `UNKNOWN_INSTANCE` on an action (the copy vanished
// between choice and click) falls visibly back to the main one, as in the code tab (`afterError`). In the project list a click on
// "k1" opens the project directly in that instance. Separately, the services pill chooses which instance FORWARDS the ports: whoever
// starts k1 here still sees under localhost what the pill forwards.
// The port view is gone; forwarding lives in the services pill. Sources: `/api/projects` (instance and copies per project),
// `/api/project-services` (services, per instance from two on), `/api/project-resources?disk=0` (load per project and instance),
// `/api/ports/conflicts` (only projects without their own container can have one).

// All project services with live status (scan or cbase_service_add): the ONLY source for services.
interface ProjectService {
  id: number;
  projectId: string;
  projectName: string;
  workspaceId: string | null;
  name: string;
  kind: string;
  port: number | null;
  container: string;
  tech: string;
  startCommand: string;
  description: string;
  agentInstructions: string;
  running: boolean;
  // The server's start guard holds a start although the port shows nothing (group lives, does not listen on the port): then "Stop"
  // instead of "Start", in the batch stop too. Missing on older servers.
  holdsStart?: boolean;
  // The state per instance, only from two instances of the project on (main plus copy).
  instances?: InstanceStatus[];
  // Client only: this row as a view on ONE copy (`viewIn`): `instanceParam` is the value for `?instance=`, `running`/`holdsStart` are then
  // those of the copy; `unknown`: its state there is missing (neither "running" nor "stopped", no button). A row from the server never
  // carries both; every action reads `instanceParam` (the main one: none, no parameter).
  instanceParam?: string | null;
  unknown?: boolean;
}
// "Has a run that can be stopped": the port shows it, or the start guard holds it.
const stoppable = (s: ProjectService) => s.running || Boolean(s.holdsStart);

/**
 * The row `d` in the instance `param` (a copy): `running`/`holdsStart` from its entry in `instances` (`serviceInInstance`: the start
 * guard of THIS copy; otherwise with a living group it would offer "Start" and every click would end in 409 SERVICE_RUNNING);
 * without `param` (the main one) the row itself. `open`: the choice is not settled yet or the copy is not ready right now; then
 * every state is unknown.
 */
function viewIn(d: ProjectService, param: string | null | undefined, open = false): ProjectService {
  if (!param) return d;
  const st = open ? { running: null, holds: false } : serviceInInstance(d, param, false);
  return { ...d, running: st.running === true, holdsStart: st.holds, instanceParam: param, unknown: st.running === null };
}
/** The key of a transition (starting/stopping): per service AND instance; otherwise a switch would show the other one's "starting". */
const uidOf = (s: ProjectService) => (s.instanceParam ? `ps${s.id}@${s.instanceParam}` : `ps${s.id}`);

// The remembered instance choice per project (localStorage, every access in try/catch; without storage the main one applies).
const appsRememberKey = (pid: string) => `cbase-apps-instance:${pid}`;
const readRemembered = (pid: string): string | null => {
  try { return localStorage.getItem(appsRememberKey(pid)) || null; } catch { return null; }
};
const writeRemembered = (pid: string, identifier: string | null) => {
  try {
    if (identifier) localStorage.setItem(appsRememberKey(pid), identifier);
    else localStorage.removeItem(appsRememberKey(pid));
  } catch { /* without storage the main one applies on the next open */ }
};

// A project from `GET /api/projects`; `instance` only on a project with an instance row (projectbox/names.js projectInstanceField).
interface Project {
  id: string;
  name: string;
  workspaceId: string | null;
  instance?: {
    identifier?: string; state?: string; converted?: boolean; name?: string; container?: string;
    copies?: { identifier: string; name?: string; chatId?: string; state?: string }[];
  } | null;
}

// A stack of a project: the main one or a copy.
interface Stack {
  identifier: string | null; // null: a project without its own container (local, not relocated yet)
  name: string; // "main" or the copy name
  main: boolean;
  state: string | null; // the state of the instance row, null without a row
  running: boolean | null; // whether the container runs; null: no measurement
  cpu: number | null;
  memBytes: number | null;
  services: number; // services running in this instance
  dns: string;
  chatTitle: string;
  resource: InstanceResource | null; // for "Clear away" (copies only)
}


// Port conflicts per project: the server's ONE computation (GET /api/ports/conflicts, store.projectPortConflicts; a project in its
// own container has none). Guard: web/test/apps-conflicts.test.mjs.
type PortConflicts = Record<string, { items: { port: number; name: string; owner: string }[] }>;

const KIND_LABELS: Record<string, string> = {
  backend: "Backend", frontend: "Frontend", db: "Database", cache: "Cache",
  queue: "Queue", worker: "Worker", infra: "Infra", other: "Other",
};

/** The copy names from the identifier `<project>/copy-<name>`. */
const copyName = (identifier: string) => {
  const i = identifier.lastIndexOf("/copy-");
  return i >= 0 ? identifier.slice(i + 7) : identifier.slice(identifier.lastIndexOf("/") + 1);
};

/**
 * The stacks of a project, main one first, then the copies in creation order. The copies are in `/api/projects` (every instance
 * row, also while being built), their load and chat in the resources (only from two instances on).
 */
function stacksOf(p: Project, r: ResourcesRow | undefined, services: readonly ProjectService[]): Stack[] {
  const last = r?.instances ?? [];
  const lastOf = (k: string | null | undefined) => (k ? last.find((i) => i.identifier === k) : undefined);
  const main = lastOf(p.instance?.identifier);
  const mainRunning = main ? (main.containers ?? 0) > 0 : r ? r.containers > 0 : null;
  const off: Stack[] = [{
    identifier: p.instance?.identifier ?? null,
    name: "main",
    main: true,
    state: p.instance?.state ?? null,
    running: p.instance ? mainRunning : mainRunning || null,
    cpu: main ? main.cpu ?? null : r ? r.cpu : null,
    memBytes: main ? main.memBytes ?? null : r ? r.memBytes : null,
    services: services.filter((d) => d.running).length,
    dns: p.instance?.name || "",
    chatTitle: "",
    resource: null,
  }];
  const copies = [...(p.instance?.copies ?? [])];
  // A copy that only the resources know (the project list is older than the measurement) is shown anyway, but only with a state.
  // An EMPTY one means: its instance row was already gone when the measurement enriched it (projects/instance-fields.js reads the row
  // AFTER `docker stats`, clearing away deletes it last). Otherwise a just removed copy would stand there as "stopped" with "Clear
  // away" until the next resources tick (15 s) and count as a copy.
  for (const i of last) if (i.name && i.name !== "main" && i.state && !copies.some((k) => k.identifier === i.identifier)) copies.push({ identifier: i.identifier, state: i.state });
  for (const k of copies) {
    const l = lastOf(k.identifier);
    off.push({
      identifier: k.identifier,
      name: copyName(k.identifier),
      main: false,
      // "" is no state (empty is not unknown): then that of the measurement, otherwise none.
      state: k.state || l?.state || null,
      running: l ? (l.containers ?? 0) > 0 : null,
      cpu: l?.cpu ?? null,
      memBytes: l?.memBytes ?? null,
      services: runningPerInstance(services, p.id, k.identifier),
      dns: k.name || l?.dnsName || "",
      chatTitle: l?.chatTitle || "",
      resource: { identifier: k.identifier, name: copyName(k.identifier), chatId: k.chatId || l?.chatId, chatTitle: l?.chatTitle, state: k.state || l?.state },
    });
  }
  return off;
}

type Translator = ReturnType<typeof useT>;
type Tone = "ok" | "work" | "removing" | "error" | "off";

/** Word and colour of a stack: first the operation on the instance, then whether its container runs. */
function stackState(s: Stack, t: Translator): { word: string; tone: Tone } {
  if (s.state && WORK[s.state]) return { word: t(WORK[s.state]), tone: "work" };
  if (s.state === "clearAway") return { word: t("being removed"), tone: "removing" };
  if (s.state === "error") return { word: t("Error"), tone: "error" };
  if (s.running === true || (s.identifier === null && s.services > 0)) return { word: t("running"), tone: "ok" };
  if (s.running === false || s.identifier === null) return { word: t("stopped"), tone: "off" };
  return { word: t("unknown"), tone: "off" };
}

const POINT: Record<Tone, string> = {
  ok: "bg-ok", work: "animate-pulse bg-accent", removing: "animate-pulse bg-danger", error: "bg-danger", off: "bg-dim/40",
};

function Point({ tone }: { tone: Tone }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${POINT[tone]}`} aria-hidden />;
}

/** "Main" or "k1": the name under which the page lists a stack (without project: "Local"). */
const stackName = (s: Stack, t: Translator) => (s.main ? (s.identifier ? t("Main") : t("Local")) : s.name);

/** "2.1 % · 812 MB": only with a measurement of a running container. */
const lastText = (s: Stack) => (s.running && s.cpu != null && s.memBytes != null ? `${s.cpu} % · ${fmtBytes(s.memBytes)}` : "");

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5v14l11-7z" />
    </svg>
  );
}

const CaretDown = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

// Stacked levels as in the workspace rail: the page spans ALL workspaces.
const StackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 3 7.5 12 12l9-4.5L12 3z" />
    <path d="M3 12.5 12 17l9-4.5" />
  </svg>
);

/**
 * The run state of a service as a dot with a word: pulsing ONLY during a transition (that is an operation and ends), "running" is a
 * permanent state and stays static. `holds`: the start guard holds a run whose port shows nothing ("running, not reachable"), a
 * warning dot as on iOS (`AppsPage.swift`, orange), not the grey of "stopped".
 */
function StatePoint({ running, transition, result: idleWord, holds = false }: { running: boolean | null; transition?: ServiceTransition["kind"]; result: string; holds?: boolean }) {
  const t = useT();
  const word = transition === "starting" ? t("Starting") : transition === "stopping" ? t("Stopping") : running ? t("running") : running === null ? t("unknown") : idleWord;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-dim" title={word}>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          transition === "starting" ? "animate-pulse bg-accent"
          : transition === "stopping" ? "animate-pulse bg-danger"
          : running ? "bg-ok"
          : running === false && holds ? "bg-warn"
          : "bg-dim/40"
        }`}
      />
      <span className={`truncate ${running && !transition ? "text-fg" : ""}`}>{word}</span>
    </span>
  );
}

// Warning mark on a service: port conflict (only projects without their own container).
function WarnMarker({ label, title }: { label: string; title?: string }) {
  return (
    <span title={title} className="shrink-0 rounded-full bg-warn/15 px-2 py-px text-[10px] font-semibold text-warn">
      {label}
    </span>
  );
}

// Modal for editing a service's start command (pencil on the service row). Defined at MODULE level (never in the render body:
// remount trap). Manual changes are remembered server-side and survive rescans; an emptied field releases the command again.
function EditCommandDialog({
  serviceId,
  serviceName,
  initial,
  initialDescription,
  onSave,
  onClose,
}: {
  serviceId: number;
  serviceName: string;
  initial: string;
  initialDescription: string;
  onSave: (cmd: string, description: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [cmd, setCmd] = useState(initial);
  // The description belongs in THIS window, not in a second one: it explains the command above it. Edited separately it eventually
  // says something different from it: one once said "rebuild with VITE_API_BASE=…" while the command demanded "MUST stay empty".
  const [description, setDescription] = useState(initialDescription);
  // The replaced versions. Without them a save is final: whoever bends a stored command for an interim state cannot name the original
  // state afterwards; exactly such a command of a registered service was lost once.
  const [history, setHistory] = useState<{ startCommand: string; replacedAt: number }[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ history: { startCommand: string; replacedAt: number }[] }>(`/api/project-services/${serviceId}/command-history`)
      .then((r) => { if (alive) setHistory(r.history ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [serviceId]);
  return (
    <Modal onClose={onClose} width={560} label={t("Edit service")} z="z-[60]">
      <ModalTitle hint={<>{t("Service")} <span className="font-medium text-fg">{serviceName}</span> — {t("manual changes survive re-scans. Leave empty to let the next scan derive the command again.")}</>}>
        {t("Edit service")}
      </ModalTitle>
      <Overline>{t("Start command")}</Overline>
      <input
        autoFocus
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(cmd.trim(), description.trim());
          if (e.key === "Escape") onClose();
        }}
        placeholder={t("e.g. task up, docker compose up -d, npm run dev …")}
        spellCheck={false}
        className={`${field} w-full font-mono text-[12.5px]`}
      />
      <div className="mt-3.5">
        <Overline>{t("Description")}</Overline>
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        rows={3}
        placeholder={t("What is it, which port is its own, what breaks it?")}
        spellCheck={false}
        className={`${field} w-full resize-y leading-relaxed`}
      />
      {history.length > 0 && (
        // The tub (bg) in the glass sheet: recessed, not a second card.
        <div className="mt-4 rounded-xl bg-bg px-2.5 pb-1.5 pt-2.5">
          <div className="px-1">
            <Overline>{t("Replaced — click restores")}</Overline>
          </div>
          <ul className="space-y-0.5">
            {history.map((h) => (
              <li key={h.replacedAt}>
                <button
                  type="button"
                  onClick={() => setCmd(h.startCommand)}
                  className="w-full rounded-lg px-1.5 py-1 text-left font-mono text-[12px] transition-colors hover:bg-hover"
                  title={t("Put into the field")}
                >
                  <span className="break-all">{h.startCommand}</span>
                  <span className="ml-1.5 whitespace-nowrap font-sans text-[11px] text-dim">
                    {new Date(h.replacedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button type="button" onClick={() => onSave(cmd.trim(), description.trim())} className={primary}>{t("Save")}</button>
      </div>
    </Modal>
  );
}

// "running/total" on a project row: the dot says WHETHER something runs, the number HOW MUCH, in the project's CHOSEN instance (like the
// header on the right and the card on iOS). `running: null`: no state is known there: "?/N", never "0/N".
function RunMarker({ running, total }: { running: number | null; total: number }) {
  const t = useT();
  if (total === 0) return null;
  const on = running !== null && running > 0;
  return (
    <span
      title={running === null ? t("unknown") : t("{running} of {total} services running", { running, total })}
      className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums text-dim"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-ok" : "bg-dim/40"}`} />
      <span className={on ? "text-fg" : ""}>{running ?? "?"}/{total}</span>
    </span>
  );
}

export default function AppsPage() {
  const t = useT();
  const [services, setServices] = useState<ProjectService[]>([]);
  const [conflicts, setConflicts] = useState<PortConflicts>({});
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // The projects with instance and copies (`GET /api/projects`). null = no answer yet; until then the projects that have services
  // (from the services) stand there without stacks.
  const [projects, setProjects] = useState<Project[] | null>(null);
  // The load per project and instance (`GET /api/project-resources?disk=0`); null = no measurement yet.
  const [resources, setResources] = useState<ResourcesRow[] | null>(null);
  // The transitions "starting"/"stopping" per service AND instance. When one ends is told by `transitionStep` (lib/service-transition.ts):
  // at the target, for a simple start also when the start command did not continue, and after a deadline at the latest; otherwise
  // "starting" would end only at `running` and hang forever on a held run (`holdsStart`) or a dead process.
  const [svcTransitions, setSvcTransitions] = useState<Record<string, ServiceTransition>>({});
  // The same state, for reading after a query (`applyServices`): a snapshot is evaluated, and an entry is removed only if it is still
  // the SAME one; a start that began during the query stays.
  const transitionsRef = useRef(svcTransitions);
  transitionsRef.current = svcTransitions;
  const [agentDialog, setAgentDialog] = useState<{ name: string; initial: string; start: (instructions: string) => void } | null>(null);
  const [editSvc, setEditSvc] = useState<ProjectService | null>(null); // start-command modal
  // Stacks that are starting/stopping right now, per instance (the copy's identifier, for the main one the projectId), so "Stop all"
  // in the main one neither locks nor frees the buttons of a copy. With the KIND: start and stop shared one flag, and "Start all"
  // said "starting…" during a stop too (until the resources reload was done).
  const [stackBusy, setStackBusy] = useState<Record<string, "start" | "stop">>({});
  // The delete dialog of a copy (the SAME as in the "Instances" tab and in the services pill), open for this copy.
  const [erase, setDelete] = useState<{ projectId: string; projectName: string; i: InstanceResource } | null>(null);
  // Copies whose clearing away the server accepted (202), while the project list still shows them as ready: otherwise the button
  // came back when the request ended, before the new list was there, and stayed gone for a queued clearing (the row then stays
  // `ready` on purpose). A second click did no harm (same job) but said nothing true.
  const [pullAccepted, setPullAccepted] = useState<Record<string, true>>({});
  const [selectedProject, setSelectedProject] = useState<string | null>(null); // project whose stacks and services stand on the right
  // The instance choice per project: remembered copy (null = main; if the key is missing, localStorage applies) and the last fallback.
  const [kept, setKept] = useState<Record<string, string | null>>({});
  const [fallback, setFallback] = useState<Record<string, InstanceHint | null>>({});
  // If `/api/projects` never came (error before the first answer), the choice decides "unchecked" instead of waiting forever.
  const [projectsFailure, setProjectsFailure] = useState(false);
  // Jump from the header's services pill: `?project=<id>` selects the project. The static export has no server routing, so read the
  // address bar directly (useSearchParams would need a suspense boundary) and remove the parameter afterwards; otherwise it would win
  // against the manual choice on every ⌘R. If the page is already open, the pill's event carries the choice over.
  useEffect(() => {
    const select = (id: string) => {
      if (!id) return;
      setSelectedProject(id);
    };
    // BOTH ways clear the address: a jump to the already open page only selected, and `?project=` stayed; Next does not rebuild the
    // page for a new query, so the mount branch never ran again, and ⌘R then selected the pill's project against the later manual
    // choice. Guard: statusBar.test.mjs ("scope").
    //
    // And they clear it THROUGH Next, not past it: Next patches `replaceState` and syncs its router state (`canonicalUrl`) only for a
    // call WITHOUT its own marker; a state with `__NA` counts as Next's own and passes unseen (next/dist/client/components/
    // app-router.js, the pushState/replaceState patch). The router would keep `/apps/?project=<id>`, and EVERY later change of its
    // state without navigation wrote that back into the address through the HistoryUpdater. With `null` Next copies its marker and
    // its tree in itself and triggers `ACTION_RESTORE` with the new address.
    const cleanAddress = () => {
      try {
        const u = new URL(window.location.href);
        if (!u.searchParams.has("project")) return;
        u.searchParams.delete("project");
        window.history.replaceState(null, "", u.toString());
      } catch { /* without a valid address there is nothing to clear */ }
    };
    try {
      const id = new URL(window.location.href).searchParams.get("project") || "";
      if (id) {
        select(id);
        cleanAddress();
      }
    } catch { /* without a valid address the page stays without a selection */ }
    // The open page TAKES OVER the jump: `preventDefault()` tells the pill its link should no longer navigate. Without it Next pushed
    // `?project=` into the address after the click, AFTER this listener, so clearing here alone was not enough.
    const atJump = (e: Event) => {
      const id = String((e as CustomEvent<string>).detail || "");
      if (!id) return;
      e.preventDefault();
      select(id);
      cleanAddress();
    };
    window.addEventListener(APPS_PROJECT_EVENT, atJump);
    return () => window.removeEventListener(APPS_PROJECT_EVENT, atJump);
  }, []);
  // Error messages stand as a tinted row under the header, no native alert() in front of a page of glass surfaces. `info` carries a
  // success message (clearing away accepted).
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // `queried`: when the query of these services BEGAN; a state from before the answer to a start does not end it. `now` (after the
  // answer): when the state arrived; the grace period (`deadSince`) runs from the first dead one.
  const applyServices = useCallback((nextServices: ProjectService[], queried: number) => {
    setServices(nextServices);
    const byId = new Map(nextServices.map((service) => [service.id, service]));
    const now = Date.now();
    const ends = new Map<string, ServiceTransition>();
    // A transition that continues but advanced `deadSince`: old → new (replaces only if the old one is still there).
    const carriedForward = new Map<string, [ServiceTransition, ServiceTransition]>();
    const ended: string[] = [];
    for (const [uid, u] of Object.entries(transitionsRef.current)) {
      // `ps<id>` (main) or `ps<id>@<identifier>` (copy): the end measures the state of THIS instance.
      const m = /^ps(\d+)(?:@(.+))?$/.exec(uid);
      const raw = m ? byId.get(Number(m[1])) : undefined;
      const service = raw ? viewIn(raw, m?.[2] ?? null) : undefined;
      const { end, next } = transitionStep(u, service && !service.unknown ? service : null, { now, queried });
      if (!end) {
        if (next !== u) carriedForward.set(uid, [u, next]);
        continue;
      }
      ends.set(uid, u);
      if (end === "ended" && service) ended.push(service.name);
    }
    if (!ends.size && !carriedForward.size) return;
    setSvcTransitions((current) => {
      let changed = false;
      const next = { ...current };
      for (const [uid, u] of ends) {
        if (next[uid] !== u) continue;
        delete next[uid];
        changed = true;
      }
      for (const [uid, [old, fresh]] of carriedForward) {
        if (next[uid] !== old) continue;
        next[uid] = fresh;
        changed = true;
      }
      return changed ? next : current;
    });
    // The start command did not continue: the row is back at "stopped" with "Start"; why, only the log knows.
    if (ended.length) setError(ended.map((name) => t("“{name}” did not keep running after the start — the service log has the reason.", { name })).join(" · "));
  }, [t]);

  // Services, projects and conflicts in ONE go: a port someone just moved should not stand with the old conflict for a tick. But
  // INDEPENDENT: an error of the conflict route does not drag services and workspaces down, and it keeps the LAST state of the
  // conflicts; `{}` would mean "no conflicts", and empty is not unknown. The same for the projects (their error keeps the last stacks).
  // Guard: web/test/apps-conflicts.test.mjs.
  const refreshServices = useCallback(async () => {
    const queried = Date.now();
    const [ps, k, pr] = await Promise.allSettled([
      api<ProjectService[]>("/api/project-services"),
      api<PortConflicts>("/api/ports/conflicts"),
      api<Project[]>("/api/projects"),
    ]);
    if (k.status === "fulfilled") setConflicts(k.value);
    if (pr.status === "fulfilled" && Array.isArray(pr.value)) setProjects(pr.value);
    else setProjectsFailure(true);
    if (ps.status === "rejected") throw ps.reason;
    applyServices(ps.value, queried);
  }, [applyServices]);

  // The load asks `docker stats` per container: less often than the service state, and without folder size (`disk=0`).
  const refreshResources = useCallback(async () => {
    const r = await api<ResourcesRow[] | { resources?: ResourcesRow[] }>("/api/project-resources?disk=0");
    const rows = Array.isArray(r) ? r : r?.resources;
    if (Array.isArray(rows)) setResources(rows);
  }, []);

  const load = useCallback(async () => {
    const [w, rest] = await Promise.allSettled([api<Workspace[]>("/api/workspaces"), refreshServices()]);
    if (w.status === "fulfilled") setWorkspaces(w.value);
    const error = [w, rest].find((r) => r.status === "rejected");
    if (error) throw (error as PromiseRejectedResult).reason;
  }, [refreshServices]);

  useEffect(() => {
    load().catch(console.error);
    refreshResources().catch(console.error);
  }, [load, refreshResources]);

  // Keep the service state live; during a start/stop transition nearly live, so the display only disappears at the actually reached
  // target state.
  const hasSvcTransition = Object.keys(svcTransitions).length > 0;
  useEffect(() => {
    const t = setInterval(() => {
      refreshServices().catch(() => {});
    }, hasSvcTransition ? 800 : 6000);
    return () => clearInterval(t);
  }, [hasSvcTransition, refreshServices]);
  useEffect(() => {
    const t = setInterval(() => { refreshResources().catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [refreshResources]);

  // An accepted clearing away (`pullAccepted`) applies while the project list still shows the copy as ready; after that its state
  // ("being cleared away") or its absence says enough.
  useEffect(() => {
    if (!projects) return;
    setPullAccepted((a) => {
      const all = Object.keys(a);
      if (!all.length) return a;
      const stays = all.filter((k) => projects.some((p) => p.instance?.copies?.some((x) => x.identifier === k && x.state === "ready")));
      return stays.length === all.length ? a : Object.fromEntries(stays.map((k) => [k, true as const]));
    });
  }, [projects]);

  // The instance choice of the selected project (see header): from its row in `/api/projects`, the remembered value and the list situation.
  const situation: ListSituation = projects ? "loaded" : projectsFailure ? "error" : "loading";
  const rememberedOf = (pid: string) => (pid in kept ? kept[pid] : readRemembered(pid));
  const fieldOf = (pid: string) => ((projects ?? []).find((p) => String(p.id) === pid)?.instance ?? undefined) as InstanceField;
  const choiceField = selectedProject ? fieldOf(selectedProject) : undefined;
  const remembered = selectedProject ? rememberedOf(selectedProject) : null;
  const choice = useMemo(() => selectInstance(selectedProject ?? "", choiceField, remembered, situation), [selectedProject, choiceField, remembered, situation]);
  // A fallback is shown and the choice forgotten (except "unchecked": then it stays remembered). It is outdated as soon as a copy
  // applies again, the named one is selectable again, or it is gone and there is no choice any more (`fallbackOutdated`); otherwise
  // it would only fall with a new choice and stand until the page is left even when it was no longer true.
  useEffect(() => {
    const pid = selectedProject;
    if (!pid) return;
    const h = choice.hint;
    if (h && h.kind !== "transient") setFallback((r) => (r[pid]?.kind === h.kind && r[pid]?.name === h.name ? r : { ...r, [pid]: h }));
    else setFallback((r) => (r[pid] && fallbackOutdated(r[pid]!, choice, choiceField, situation) ? { ...r, [pid]: null } : r));
    if (!choice.waiting && choice.remember !== remembered) {
      setKept((m) => ({ ...m, [pid]: choice.remember }));
      writeRemembered(pid, choice.remember);
    }
  }, [choice, remembered, selectedProject, choiceField, situation]);

  // The choice of ANY project (the selected one's is `choice`) and its services in it: the same computation for the card on the right,
  // the run mark on the left and the figures at the top. If the choice waits or the chosen copy is not ready right now, every
  // state is unknown: no button, no "stopped", in no number.
  const choiceOf = (pid: string): InstanceChoice => (pid === selectedProject ? choice : selectInstance(pid, fieldOf(pid), rememberedOf(pid), situation));
  const inSelected = (pid: string, serviceList: ProjectService[]): ProjectService[] => {
    const w = choiceOf(pid);
    const open = w.waiting || w.hint?.kind === "transient";
    return serviceList.map((d) => viewIn(d, w.waiting ? w.remember : w.param, open));
  };

  /**
   * Selects an instance of a project (click on a stack row on the right or in the project list on the left); only what its choice
   * offers (main and ready copies). `true` if the identifier was selectable.
   */
  const rememberInstance = (pid: string, identifier: string | null): boolean => {
    const options = pid === selectedProject ? choice.options : selectInstance(pid, fieldOf(pid), rememberedOf(pid), situation).options;
    const target = identifier ? options.find((o) => o.identifier === identifier) : undefined;
    if (!target) return false;
    const fresh = target.kind === "copy" ? target.identifier : null;
    setFallback((r) => (r[pid] ? { ...r, [pid]: null } : r));
    setKept((m) => ({ ...m, [pid]: fresh }));
    writeRemembered(pid, fresh);
    return true;
  };
  const selectStackInstance = (identifier: string | null) => {
    if (selectedProject) rememberInstance(selectedProject, identifier);
  };

  /**
   * If the server calls the copy `param` unknown (404 `UNKNOWN_INSTANCE`, cleared away between choice and click), that is the visible
   * fallback to the main one (`afterError` of the code tab); `true`, then the error is dealt with. Any other error stays what it is.
   */
  const instanceGone = (e: unknown, param: string): boolean => {
    const pid = selectedProject;
    const copy = copyNameOf(param);
    if (!pid || !copy) return false;
    const r = afterError({ ...choice, param, copy }, e);
    if (!r) return false;
    setFallback((x) => ({ ...x, [pid]: r.hint }));
    // The action itself did NOT happen; the error row says so (dismissible). The addition to "Services" falls as soon as the list no
    // longer shows the copy and there is no choice any more (`fallbackOutdated`); without this row the click would stay without an answer.
    setError(t("The copy {name} no longer exists — the page shows the main instance again.", { name: copy }));
    if (remembered === param) {
      setKept((m) => ({ ...m, [pid]: null }));
      writeRemembered(pid, null);
    }
    refreshAll().catch(() => {});
    return true;
  };

  const wsName = (id: string | null) => workspaces.find((w) => w.id === id)?.name ?? null;

  // WHETHER a port is in conflict is told by the server (`conflicts`, see PortConflicts): a service is in conflict if ITS project holds
  // the port there.
  const conflictPorts = new Set<number>();
  for (const k of Object.values(conflicts)) for (const i of k.items) conflictPorts.add(i.port);
  const inConflict = (s: ProjectService) => s.port != null && Boolean(conflicts[s.projectId]?.items.some((i) => i.port === s.port));

  // The projects: all from `/api/projects` (also without services; a stack can run without a registered service); before the first
  // answer those that have services.
  const servicesOf = new Map<string, ProjectService[]>();
  for (const s of services) {
    const l = servicesOf.get(s.projectId);
    if (l) l.push(s);
    else servicesOf.set(s.projectId, [s]);
  }
  const resourceOf = new Map((resources ?? []).map((r) => [String(r.projectId), r]));
  const base: Project[] = projects ?? [...servicesOf.entries()].map(([id, l]) => ({ id, name: l[0].projectName, workspaceId: l[0].workspaceId }));
  const rows = base
    .map((p) => {
      const serviceList = servicesOf.get(String(p.id)) ?? [];
      // `view`: the services in the project's chosen instance (`inSelected`); run mark, figures and card count them.
      return { p, services: serviceList, view: inSelected(String(p.id), serviceList), stacks: projects ? stacksOf(p, resourceOf.get(String(p.id)), serviceList) : [] };
    })
    .sort((a, b) => a.p.name.localeCompare(b.p.name));
  // One surface per workspace, in the order of the workspace list; projects without a (known) workspace last.
  const groups: { id: string | null; name: string; rows: typeof rows }[] = [];
  for (const w of workspaces) {
    const z = rows.filter((x) => x.p.workspaceId === w.id);
    if (z.length) groups.push({ id: w.id, name: w.name, rows: z });
  }
  const rest = rows.filter((x) => !workspaces.some((w) => w.id === x.p.workspaceId));
  if (rest.length) groups.push({ id: null, name: t("No workspace"), rows: rest });

  // Counted per project in its chosen instance (as on iOS); a service with an unknown state counts neither as running nor as stopped;
  // it is missing from counter AND total, and if no state is known no number shows (empty is not unknown).
  const knownServices = rows.flatMap((z) => z.view).filter((s) => !s.unknown);
  const totalRunning = knownServices.filter((s) => s.running).length;
  const allStacks = rows.flatMap((z) => z.stacks);
  const runningStacks = allStacks.filter((s) => stackState(s, t).tone === "ok").length;
  const copiesCount = allStacks.filter((s) => !s.main).length;

  // Start/stop control of a service (project_service).
  interface Ctl {
    uid: string;
    name: string;
    running: boolean;
    simpleCmd: string;
    instructions: string;
    onStop: () => Promise<void> | void;
    onStartSimple: () => void;
    onStartAgent: (instructions: string) => void;
    copy?: boolean; // in a copy: "Start" without a menu (no agent start, 409 COPY_AGENT)
    unknown?: boolean; // state in the instance unknown: no button
  }

  const refreshAll = () => Promise.all([load(), refreshResources().catch(() => {})]);

  // The key of a stack in `stackBusy`: the copy's identifier (`instanceParam` of the view), for the main one the projectId.
  const stackKey = (projectId: string, svcs: ProjectService[]) => svcs.find((s) => s.instanceParam)?.instanceParam ?? projectId;
  const stackRunning = (key: string, kind: "start" | "stop" | false) =>
    setStackBusy((b) => {
      if (kind) return { ...b, [key]: kind };
      const rest = { ...b };
      delete rest[key];
      return rest;
    });

  // Start the whole stack of an instance: all non-running services with a start command, one after another in "simple" mode (backend/DB
  // before frontend is usually already given by the scan). Services without a start command are skipped. `svcs` is the instance's view
  // (`viewIn`): a copy carries its `instanceParam` (`?instance=`), the main one none. Reasons for failed starts (port taken, already
  // running, SERVICE_RUNNING …) are collected in the error row. If the copy is gone (404 UNKNOWN_INSTANCE), the batch ends with the
  // visible fallback to the main one.
  async function startStack(projectId: string, svcs: ProjectService[]) {
    const toStart = svcs.filter((s) => s.startCommand && !s.unknown && !stoppable(s));
    if (!toStart.length) return;
    const key = stackKey(projectId, svcs);
    stackRunning(key, "start");
    try {
      const reasons: string[] = [];
      for (const s of toStart) {
        const param = s.instanceParam ?? null;
        try {
          await api(instancePath(`/api/projects/${projectId}/services/${s.id}/start`, param), { method: "POST", body: JSON.stringify({ mode: "simple" }) });
        } catch (e) {
          if (param && instanceGone(e, param)) return;
          reasons.push(`${s.name}: ${String((e as Error)?.message || e)}`);
        }
      }
      if (reasons.length) setError(reasons.join(" · "));
      setTimeout(() => refreshAll().catch(console.error), 2000);
    } finally {
      stackRunning(key, false);
    }
  }
  async function stopStack(projectId: string, svcs: ProjectService[]) {
    const toStop = svcs.filter(stoppable);
    if (!toStop.length) return;
    const key = stackKey(projectId, svcs);
    stackRunning(key, "stop");
    try {
      // Every failed stop names its reason, also a rejected call (500, 400 INSTANCE_INVALID, network), as on iOS; otherwise "Stop all"
      // would stay without any feedback. Only a copy that no longer exists (404 UNKNOWN_INSTANCE) ends the batch with the visible
      // fallback to the main one.
      const notices: string[] = [];
      for (const s of toStop) {
        const param = s.instanceParam ?? null;
        let r: unknown = null;
        try {
          r = await api<unknown>(instancePath(`/api/projects/${projectId}/services/${s.id}/stop`, param), { method: "POST" });
        } catch (e) {
          if (param && instanceGone(e, param)) return;
          notices.push(`${s.name}: ${String((e as Error)?.message || e)}`);
          continue;
        }
        const notice = stopNotice(r, s.name, t);
        if (notice) notices.push(notice);
      }
      if (notices.length) setError(notices.join(" · "));
      await refreshAll();
    } finally {
      stackRunning(key, false);
    }
  }

  // Clearing away a copy: through the SAME dialog as the "Instances" tab and the services pill (projects/InstanceDialogs.tsx
  // `CopyDelete`: the question text as a hint, the delete preview, the DELETE only on its button, a 409 INSTANCE_BUSY with the chats stays
  // in the dialog). Two places for the same list: delete one; the page used to ask its own question and send its own DELETE, past the
  // preview and chat list. Without a path (the main one) nothing opens.
  function clearAway(projectId: string, projectName: string, i: InstanceResource) {
    if (!clearAwayPath(projectId, i)) return;
    setError(null);
    setInfo(null);
    setDelete({ projectId, projectName, i });
  }

  // The dialog reports only the ACCEPTED DELETE (202). If the human clears away the CHOSEN copy themselves, the page switches to the main
  // one: otherwise it would report the consequence of their own action as a fallback in warning colour ("Main · k1 not ready") that
  // stood until they left the page. A rejected DELETE (409 with the chats) stays in the dialog and changes nothing.
  function clearAwayAccepted(projectId: string, i: InstanceResource, body: unknown) {
    if (rememberedOf(projectId) === i.identifier) {
      setKept((m) => ({ ...m, [projectId]: null }));
      writeRemembered(projectId, null);
    }
    setFallback((r) => (r[projectId] && r[projectId]!.name === copyName(i.identifier) ? { ...r, [projectId]: null } : r));
    setInfo(clearAwayResult(202, body, i, t).text);
    setPullAccepted((a) => ({ ...a, [i.identifier]: true }));
    refreshAll().catch(() => {});
  }

  function setSvcTransition(uid: string, transition: ServiceTransition | null) {
    setSvcTransitions((current) => {
      if (transition) return { ...current, [uid]: transition };
      if (!(uid in current)) return current;
      const next = { ...current };
      delete next[uid];
      return next;
    });
  }

  // `mode` only on start: a simple one also ends when the start command did not continue, an agent start only at the target or the deadline.
  async function runAction(uid: string, kind: ServiceTransition["kind"], fn: () => Promise<unknown>, param: string | null = null, mode?: "simple" | "agent") {
    const u: ServiceTransition = { kind, since: Date.now(), ...(mode ? { mode } : {}) };
    setSvcTransition(uid, u);
    try {
      await fn();
      // The answer is here; only a state queried afterwards may end a simple start as "did not continue".
      if (kind === "starting") setSvcTransitions((cur) => (cur[uid] === u ? { ...cur, [uid]: withResponse(u, Date.now()) } : cur));
      await refreshAll();
    } catch (e) {
      setSvcTransition(uid, null);
      if (param && instanceGone(e, param)) return;
      setError(t("Action failed: {msg}", { msg: (e as Error).message }));
    }
  }

  // Control of a service in the instance of its view (`viewIn`): the main one without a parameter, a copy with `?instance=<identifier>`;
  // one path for both, so no call of a copy silently lands in the main one. There is no agent start in a copy (the service agent is a
  // chat of its own that does not know the copy, 409 COPY_AGENT): `copy` hides it.
  const ctlFromPs = (s: ProjectService): Ctl => {
    const uid = uidOf(s);
    const param = s.instanceParam ?? null;
    return {
      uid,
      name: s.name,
      running: stoppable(s), // drives only the button: "Stop" also with holdsStart; in a copy its own
      simpleCmd: s.startCommand,
      instructions: s.agentInstructions || "",
      copy: param !== null,
      unknown: Boolean(s.unknown),
      // A failed stop (`stopped: false`) names its reason here.
      onStop: () => runAction(uid, "stopping", async () => {
        const notice = stopNotice(await api<unknown>(instancePath(`/api/projects/${s.projectId}/services/${s.id}/stop`, param), { method: "POST" }), s.name, t);
        if (notice) { setSvcTransition(uid, null); setError(notice); }
      }, param),
      onStartSimple: () =>
        runAction(uid, "starting", async () => {
          await api(instancePath(`/api/projects/${s.projectId}/services/${s.id}/start`, param), { method: "POST", body: JSON.stringify({ mode: "simple" }) });
        }, param, "simple"),
      onStartAgent: (instructions) =>
        runAction(uid, "starting", async () => {
          const r = await api<{ chatId?: string }>(instancePath(`/api/projects/${s.projectId}/services/${s.id}/start`, param), { method: "POST", body: JSON.stringify({ mode: "agent", instructions }) });
          // A coding chat in the project (server projects/coding-jobs.js); the page switches to Coding.
          if (r.chatId && s.workspaceId) openCodingChat(r.chatId, s.workspaceId);
        }, param, "agent"),
    };
  };

  async function saveStartCommand(s: ProjectService, cmd: string, description: string) {
    setEditSvc(null);
    const body: { startCommand?: string; description?: string } = {};
    if (cmd !== s.startCommand) body.startCommand = cmd;
    if (description !== (s.description || "")) body.description = description;
    if (!Object.keys(body).length) return;
    try {
      await api(`/api/project-services/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(t("Action failed: {msg}", { msg: (e as Error).message }));
    }
  }

  // Pencil on the service row: opens the service's start-command modal (command AND description). The command is registered per PROJECT;
  // in a copy the title says it applies to the main one too.
  const renderEdit = (s: ProjectService) => (
    <button
      type="button"
      onClick={() => setEditSvc(s)}
      title={s.instanceParam ? t("Edit start command — applies to every instance of the project") : s.startCommand ? t("Edit start command") : t("Set start command")}
      aria-label={s.startCommand ? t("Edit start command") : t("Set start command")}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
  );

  // Actions on the right of the row: ONE filled button (Start, graphite), everything else quiet.
  const renderControls = (c: Ctl) => {
    const transition = svcTransitions[c.uid]?.kind;
    // While "starting" stands, stop sits beside it as soon as there is something to stop: a run held by the start guard would
    // otherwise wait until the deadline with no way out; `c.running` here is `running || holdsStart`.
    const stopInStart = transition === "starting" && c.running && !c.unknown;
    if (transition && !stopInStart) return <ServiceTransitionIndicator kind={transition} />;
    if (c.unknown) return null;
    if (c.running) {
      return (
        <>
          {stopInStart && <ServiceTransitionIndicator kind="starting" />}
          <button type="button" onClick={() => c.onStop()} className={quietDangerSm}>
            {t("Stop")}
          </button>
        </>
      );
    }
    if (c.copy) {
      return (
        <button
          type="button"
          onClick={() => c.onStartSimple()}
          disabled={!c.simpleCmd}
          title={c.simpleCmd ? t("Run start command directly") : t("No start command set")}
          className="flex shrink-0 items-center gap-1 rounded-full bg-dark px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {t("Start")}
        </button>
      );
    }
    // The start menu is the kit `Menu`: its sheet hangs via portal at the body and measures in window coordinates. The hand-built one
    // stood `absolute` in the services surface (`overflow-hidden`, rounded corners) and was clipped at its lower edge: under the last
    // service row "Start with agent" and in the last row the whole menu was unreachable with the mouse.
    return (
      <Menu
        label={t("Start")}
        width={248}
        button={{
          content: <>{t("Start")}<CaretDown /></>,
          className: "flex items-center gap-1 rounded-full bg-dark px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90",
        }}
      >
        <MenuEntry
          label={t("Simple start")}
          hint={c.simpleCmd ? t("Run start command directly") : t("No start command known")}
          disabled={!c.simpleCmd}
          onClick={() => c.onStartSimple()}
        />
        <MenuEntry
          label={t("Start with agent")}
          hint={t("An agent brings the service up")}
          onClick={() => setAgentDialog({ name: c.name, initial: c.instructions, start: c.onStartAgent })}
        />
      </Menu>
    );
  };

  // A service row: ONE row: state, name (description in the tooltip), kind, port, start command, actions. Narrow, the start command moves
  // under the row. `s` is the view of the selected instance (`viewIn`): state and buttons apply to it.
  const serviceRow = (s: ProjectService) => {
    const conflict = inConflict(s);
    return (
      <div key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2">
        <span className="w-[5.5rem] min-w-0 shrink-0">
          <StatePoint running={s.unknown ? null : s.running} transition={svcTransitions[uidOf(s)]?.kind} result={s.holdsStart ? t("running, not reachable") : t("stopped")} holds={Boolean(s.holdsStart)} />
        </span>
        <span
          className="min-w-0 max-w-[14rem] truncate text-[13px] font-semibold @2xl/detail:w-[12rem] @2xl/detail:flex-none"
          title={s.description ? `${s.name}\n\n${s.description}` : s.name}
        >
          {s.name}
        </span>
        <span className="shrink-0 rounded-full bg-bg px-2 py-px text-[10.5px] font-semibold text-dim">{t(KIND_LABELS[s.kind] || s.kind)}</span>
        <span className="w-[3.25rem] shrink-0 font-mono text-[12px] text-dim" title={s.port != null ? t("Port {port}", { port: s.port }) : t("no port")}>
          {s.port != null ? `:${s.port}` : "—"}
        </span>
        {conflict && <WarnMarker label={t("conflict")} title={t("Conflict: port :{port} is claimed by multiple projects", { port: s.port! })} />}
        <div className="order-last min-w-0 base-full @2xl/detail:order-none @2xl/detail:flex-1 @2xl/detail:base-0">
          {s.startCommand ? (
            <code
              onClick={() => setEditSvc(s)}
              title={`${s.startCommand}\n\n${t("Click to edit — changes survive re-scans")}`}
              className="block min-w-0 max-w-full cursor-text truncate rounded-lg bg-code px-2 py-1 font-mono text-[11px] transition-shadow hover:ring-1 hover:ring-accent/50"
            >
              {s.startCommand}
            </code>
          ) : (
            <button type="button" onClick={() => setEditSvc(s)} className="text-[11px] font-medium text-dim hover:text-fg">
              + {t("Set start command")}
            </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {renderEdit(s)}
          {renderControls(ctlFromPs(s))}
        </div>
      </div>
    );
  };

  // A stack row on the right: state, name, address or chat, running services, load, and the stack's actions: per controllable instance
  // "stop/start all", on a copy also "Clear away".
  const stackRow = (p: Project, serviceList: ProjectService[], s: Stack) => {
    const state = stackState(s, t);
    // From a ready copy on, the row is the choice (see header). The main one can always be controlled, a copy only when `ready`; a
    // frozen one (clearing away, fetching) or one being created would hang at start or stop.
    const selectable = s.identifier !== null && choice.options.some((o) => o.identifier === s.identifier);
    const active = selectable && s.identifier === choice.identifier;
    const controllable = s.main || (selectable && s.state === "ready");
    const view = s.main ? serviceList : controllable ? serviceList.map((d) => viewIn(d, s.identifier)) : [];
    const startable = view.filter((d) => d.startCommand && !d.unknown && !stoppable(d)).length;
    const stoppableCount = view.filter(stoppable).length;
    // The number only where the state per service is known: "0 of 9" for a copy without data would be a claim (empty is not unknown).
    const running = view.some((d) => !d.unknown) ? view.filter((d) => d.running && !d.unknown).length : null;
    // What this instance's stack is doing right now: both buttons are locked, and the word is said only by the one that is doing it.
    const stackKind = stackBusy[s.main ? p.id : s.identifier ?? ""];
    const stackWorking = Boolean(stackKind);
    const beside = s.main ? s.dns : s.chatTitle ? t("Chat “{title}”", { title: s.chatTitle }) : s.dns;
    const last = lastText(s);
    // A button in the row acts on ITS instance and selects it too; it does not trigger the row's selection a second time.
    const withChoice = (fn: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      if (selectable) selectStackInstance(s.identifier);
      fn();
    };
    // State, name and address: in a selectable row a SEPARATE button (`aria-pressed`) with the actions beside it: no button in a button
    // (the whole row used to be a `role="button"` with "Stop all", "Start all" and "Clear away" inside, and a screen reader read it as ONE
    // button). The rest of the row's surface still selects by mouse.
    const header = (
      <>
        <span className="flex w-[5.5rem] min-w-0 shrink-0 items-center gap-1.5 text-[11px] font-medium text-dim" title={s.state ? stateWord(s.state, t) : undefined}>
          <Point tone={state.tone} />
          <span className={`truncate ${state.tone === "ok" ? "text-fg" : state.tone === "error" ? "text-danger" : ""}`}>{state.word}</span>
        </span>
        <span className="shrink-0 text-[13px] font-semibold">{stackName(s, t)}</span>
        {beside && <span className="min-w-0 truncate text-[12px] text-dim" title={beside}>{beside}</span>}
      </>
    );
    return (
      <div
        key={s.identifier ?? "local"}
        data-apps-stack={s.identifier ?? "local"}
        data-active={active ? "1" : undefined}
        onClick={selectable ? () => selectStackInstance(s.identifier) : undefined}
        className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 ${selectable ? "cb-row cursor-pointer transition-colors" : ""}`}
      >
        {selectable ? (
          <button
            type="button"
            aria-pressed={active}
            title={active ? undefined : t("Show and control the services of this instance")}
            onClick={(e) => { e.stopPropagation(); selectStackInstance(s.identifier); }}
            className="flex min-w-0 items-center gap-x-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
          >
            {header}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-x-3">{header}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-dim">
          {running !== null && <span>{t("{running} of {total} services", { running: running, total: serviceList.length })}</span>}
          {last && <span className="text-fg/80">{last}</span>}
        </span>
        {controllable && (stoppableCount > 0 || startable > 0) && (
          <span className="flex shrink-0 items-center gap-1.5">
            {stoppableCount > 0 && (
              <button type="button" onClick={withChoice(() => void stopStack(p.id, view))} disabled={stackWorking} className={`${quietDangerSm} disabled:opacity-50`}>
                {stackKind === "stop" ? t("stopping…") : t("Stop all")}
              </button>
            )}
            {startable > 0 && (
              <button
                type="button"
                onClick={withChoice(() => void startStack(p.id, view))}
                disabled={stackWorking}
                title={s.main ? t("Bring up all services of this project that have a start command") : t("Bring up all services of this copy that have a start command")}
                className="flex items-center gap-1 rounded-full bg-dark px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <PlayIcon />
                {stackKind === "start" ? t("starting…") : t("Start all")}
              </button>
            )}
          </span>
        )}
        {/* Only with a known state (empty is not unknown) and not while an accepted clearing away is running. */}
        {!s.main && s.resource && s.state && s.state !== "clearAway" && !(s.identifier && pullAccepted[s.identifier] && s.state === "ready") && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearAway(p.id, p.name, s.resource!); }}
            disabled={erase?.i.identifier === s.identifier}
            className={`${quietDangerSm} shrink-0 disabled:opacity-50`}
            data-apps-clear-away={s.identifier}
          >
            {t("Remove##clear")}
          </button>
        )}
      </div>
    );
  };

  /**
   * "Main" or "k1" and, if the choice does not (fully) apply, a short addition: for the services heading and the project header.
   * `null`: no choice (one instance) and no fallback; then everything stands as before the instance choice. `fallback`: the addition
   * says that the remembered copy does NOT apply (tinted); a copy that is only temporarily not ready stays selected and is none. An
   * outdated fallback (`fallbackOutdated`) already no longer shows in this render, not only after the effect.
   */
  const instanceLabel = (pid: string): { name: string; addition: string | null; explanation: string | null; fallback: boolean } | null => {
    const candidate = choice.hint ?? (choice.param ? null : fallback[pid] ?? null);
    const h = candidate && (candidate.kind === "transient" || !fallbackOutdated(candidate, choice, choiceField, situation)) ? candidate : null;
    if (choice.waiting) {
      const k = copyNameOf(choice.remember);
      return k ? { name: k, addition: t("Loading…##inline"), explanation: null, fallback: false } : null;
    }
    if (!choice.options.length && !h) return null;
    const name = choice.copy ?? t("Main");
    if (!h) return { name, addition: null, explanation: null, fallback: false };
    if (h.kind === "transient") {
      return { name, addition: stateWord(h.state, t), explanation: t("The copy {name} is not ready right now ({state}) — the page stays with it and shows its services as soon as it is ready.", { name: h.name, state: stateWord(h.state, t) }), fallback: false };
    }
    if (h.kind === "gone") return { name, addition: t("{name} gone", { name: h.name }), explanation: t("The copy {name} no longer exists — the page shows the main instance again.", { name: h.name }), fallback: true };
    if (h.kind === "not-ready") return { name, addition: t("{name} not ready", { name: h.name }), explanation: t("The copy {name} is not ready ({state}) — the page shows the main instance.", { name: h.name, state: stateWord(h.state, t) }), fallback: true };
    if (h.kind === "held") return { name, addition: null, explanation: null, fallback: false }; // exists only in the code tab (unsaved tabs)
    return { name, addition: t("{name} unchecked", { name: h.name }), explanation: t("The project list could not be loaded — whether the copy {name} still exists is unknown. The page shows the main instance.", { name: h.name }), fallback: true };
  };

  // The figures as a half sentence under the title.
  const metrics = (
    <span className="tabular-nums">
      {rows.length === 1 ? t("1 project") : t("{n} projects", { n: rows.length })}
      {projects && (
        <>
          {" · "}
          <span className={runningStacks ? "text-fg" : ""}>{runningStacks === 1 ? t("1 stack running") : t("{n} stacks running", { n: runningStacks })}</span>
          {copiesCount > 0 && <>{" · "}{copiesCount === 1 ? t("1 copy") : t("{n} copies", { n: copiesCount })}</>}
        </>
      )}
      {knownServices.length > 0 && (
        <>
          {" · "}
          <span className={totalRunning ? "text-fg" : ""}>{t("{running} of {total} services running", { running: totalRunning, total: knownServices.length })}</span>
        </>
      )}
      {conflictPorts.size > 0 && (
        <>
          {" · "}
          <span className="font-medium text-warn">{conflictPorts.size === 1 ? t("1 conflict") : t("{n} conflicts", { n: conflictPorts.size })}</span>
        </>
      )}
    </span>
  );

  const selected = rows.find((z) => z.p.id === selectedProject) ?? null;

  return (
    // The stage: `cb-kit` colours the colour roles cool, `cb-kit-stage bg-panel` marks the opaque stage surface, `@container/kit` is
    // the reference for the two-column rule of the split view.
    <main className="@container/kit cb-kit cb-kit-stage flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel">
      {/* The frame in the middle of the header (`HeadersMiddle`), like Workspace › Project on the coding page: here it is all of them. */}
      <HeadersMiddle>
        <span className="shrink-0 text-dim"><StackIcon /></span>
        <span className="truncate">{t("All workspaces")}</span>
      </HeadersMiddle>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 pt-3.5 sm:px-5">
        <Header title={t("Projects & Stacks")} hint={metrics} />

        {error && (
          <div className="shrink-0">
            <Hint tone="danger">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <RemoveButton label={t("Close")} onClick={() => setError(null)} />
              </div>
            </Hint>
          </div>
        )}
        {info && (
          <div className="shrink-0">
            <Hint tone="ok">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{info}</span>
                <RemoveButton label={t("Close")} onClick={() => setInfo(null)} />
              </div>
            </Hint>
          </div>
        )}

        {/* Left the projects per workspace with their stacks, right the selected project: the same split view as the one used by inbox and
            raw data of the manager. */}
        <SplitPane
          shared={rows.length > 0}
          list={
            rows.length === 0 ? (
              <Empty>{t("No projects yet.")}</Empty>
            ) : (
              <div className="flex flex-col gap-3.5">
                {groups.map((g) => (
                  <section key={g.id ?? "without"} className="shrink-0">
                    <div className="px-1">
                      <Overline>{g.name}</Overline>
                    </div>
                    <div className="cb-kit-pane divide-y divide-edge overflow-hidden rounded-2xl">
                      {g.rows.map(({ p, services: serviceList, view, stacks }) => {
                        const sel = selectedProject === p.id;
                        // Counted in the selected instance (like the header on the right); without a known state "?".
                        const known = view.filter((s) => !s.unknown);
                        const running = known.length ? known.filter((s) => s.running).length : null;
                        // A project without its own container carries no stack row when nothing runs; it would only say "stopped".
                        const visible = stacks.filter((s) => s.identifier !== null || stackState(s, t).tone === "ok");
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={(e) => {
                              // A click on a stack sub-row ("Main", "k1") opens the project IN that instance if it is selectable; the row
                              // then does not collapse. Otherwise as before: open or close the project.
                              const identifier = (e.target as HTMLElement | null)?.closest?.("[data-stack-identifier]")?.getAttribute("data-stack-identifier") ?? null;
                              if (identifier && rememberInstance(p.id, identifier)) {
                                setSelectedProject(p.id);
                                return;
                              }
                              setSelectedProject(sel ? null : p.id);
                            }}
                            aria-pressed={sel}
                            data-active={sel ? "1" : undefined}
                            className="cb-row flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors"
                          >
                            <div className="flex w-full min-w-0 items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={p.name}>{p.name}</span>
                              <RunMarker running={running} total={serviceList.length} />
                            </div>
                            {visible.length > 0 && (
                              <span className="flex w-full min-w-0 flex-col gap-0.5">
                                {visible.map((s) => {
                                  const state = stackState(s, t);
                                  const last = lastText(s);
                                  return (
                                    <span key={s.identifier ?? "local"} data-stack-identifier={s.identifier ?? undefined} className="flex min-w-0 items-center gap-2 text-[11.5px] text-dim">
                                      <Point tone={state.tone} />
                                      <span className={`shrink-0 font-medium ${state.tone === "ok" ? "text-fg" : ""}`}>{stackName(s, t)}</span>
                                      {!s.main && s.chatTitle && <span className="min-w-0 truncate">{s.chatTitle}</span>}
                                      <span className="ml-auto shrink-0 tabular-nums">
                                        {state.tone === "ok" ? last || state.word : state.word}
                                      </span>
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                            {serviceList.length === 0 && visible.length === 0 && (
                              <span className="text-[11.5px] text-dim">{t("No services.")}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )
          }
          placeholder={
            <Placeholder title={t("Pick a project on the left")}>
              {t("Its stacks and services appear on the right — with state, port, start command and start/stop.")}
            </Placeholder>
          }
          detail={selected && (() => {
            // `view`: the services in the selected instance (`inSelected`): the main one as before, a copy from `instances[]`. If the choice waits
            // or the chosen copy is not ready right now, every state is unknown: no button, no "stopped".
            const { p, services: serviceList, view: inInstance, stacks } = selected;
            const sorted = [...inInstance].sort((a, b) =>
              a.port == null && b.port == null ? a.name.localeCompare(b.name)
              : a.port == null ? 1 : b.port == null ? -1 : a.port - b.port);
            const known = inInstance.filter((s) => !s.unknown);
            const runCount = known.filter((s) => s.running).length;
            const label = instanceLabel(p.id);
            const ws = wsName(p.workspaceId);
            return (
              <div className="flex min-h-0 flex-col gap-3">
                <SplitBackButton label={t("Projects")} onClick={() => setSelectedProject(null)} />
                <Header
                  title={p.name}
                  hint={
                    // The number counts the SELECTED instance (from a choice on with its name in front); if its state is unknown, none shows.
                    <>
                      {ws && <>{ws} · </>}
                      {label && <>{label.name} · </>}
                      {serviceList.length === 0
                        ? t("No services.")
                        : known.length === 0
                          ? t("{n} services", { n: serviceList.length })
                          : t("{running} of {total} services running", { running: runCount, total: serviceList.length })}
                    </>
                  }
                />
                {stacks.length > 0 && (
                  <div className="cb-kit-pane shrink-0 overflow-hidden rounded-2xl">
                    <div className="px-3.5 pt-2.5">
                      <Overline>{t("Stacks")}</Overline>
                    </div>
                    <div className="divide-y divide-edge">
                      {stacks.map((s) => stackRow(p, serviceList, s))}
                    </div>
                  </div>
                )}
                {sorted.length === 0 ? (
                  <Empty>{t("No services registered. A service scan in the project adds them.")}</Empty>
                ) : (
                  <div className="cb-kit-pane shrink-0 overflow-hidden rounded-2xl">
                    <div className="px-3.5 pt-2.5" data-apps-services-instance={choice.identifier ?? undefined}>
                      <Overline>
                        {t("Services")}
                        {label && <span className="normal-case tracking-normal text-fg">{" · "}{label.name}</span>}
                        {label?.addition && (
                          <span
                            className={`font-medium normal-case tracking-normal ${label.fallback ? "text-warn" : ""}`}
                            title={label.explanation ?? undefined}
                          >
                            {" · "}{label.addition}
                          </span>
                        )}
                      </Overline>
                    </div>
                    <div className="divide-y divide-edge">
                      {sorted.map(serviceRow)}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        />
      </div>

      {editSvc && (
        <EditCommandDialog
          serviceId={editSvc.id}
          serviceName={editSvc.name}
          initial={editSvc.startCommand}
          initialDescription={editSvc.description || ""}
          onClose={() => setEditSvc(null)}
          onSave={(cmd, description) => void saveStartCommand(editSvc, cmd, description)}
        />
      )}
      {erase && (
        <CopyDelete
          projectId={erase.projectId}
          projectName={erase.projectName}
          name={erase.i.name}
          onClose={() => setDelete(null)}
          onDeleted={(body) => clearAwayAccepted(erase.projectId, erase.i, body)}
        />
      )}
      {agentDialog && (
        <AgentStartDialog
          serviceName={agentDialog.name}
          initial={agentDialog.initial}
          onClose={() => setAgentDialog(null)}
          onStart={(instructions) => {
            const d = agentDialog;
            setAgentDialog(null);
            d.start(instructions);
          }}
        />
      )}
    </main>
  );
}
