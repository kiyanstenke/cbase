"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PortFinding, type RunningPorts, type Workspace } from "@/lib/api";
import { CopyDelete } from "@/components/projects/InstanceDialogs";
import { useGateway } from "@/lib/gateway";
import { useT } from "@/lib/i18n";
import { useEdgeClamp } from "@/lib/viewport";
import { appsProjectHref, handOverAppsJump, useActiveScope } from "@/lib/active-scope";
import {
  clearable, clearAwayResult, clearAwayPath, activeRows as activeRowsOf, activeBySituation, otherBesideTheList, triggerContent, progressBarParts, needsBringAlong,
  serviceInstance, servicesSum, serviceStatus, fmtBytes, measured, groupsTitle, cbasePart, cbaseValueText, instanceDesignation, instanceGroups, instancePerProject, instanceMeasurement,
  instancePorts, instanceTitle, copyNotReady, loadShare, runningInScope, runningPerInstance, measureRow, notReadySet, performanceTone, diskShare, projectOfTheIdentifier,
  ramShare, ramCapacity, machineLevel, resourcesSection, stageFrom, swapShare, tooltipRows, choiceServices, choiceServicesVisible, choiceRows, assignForwardings,
  forwardingKey, getsClearedAway, forwardingsToLift,
  type ServiceInScope, type ServiceStatus, type ServiceRow, type CbaseKind, type CbasePart, type InstanceResource, type InstanceStatus, type ProjectWithInstance, type MachineStatus,
  type MachineLevel, type ResourcesRow, type Stage, type Forwarding,
} from "@/lib/services-status";
import { stateWord } from "@/lib/instance-state";
import { serviceTargetInstance, linkOfTheRow } from "@/lib/preview-links";
import { usePreviewLinks } from "@/components/preview/usePreviewLinks";
import { PreviewArea, PreviewButton } from "@/components/preview/PreviewShare";

// Ports and performance in the header — two entries, not one pill. Frameless like the usage displays beside them: icon + text, no
// background, no border, no color as a permanent state; hovered/open they get the quiet surface of the other frameless header
// buttons (`hover:bg-hover`).
//  · PORTS (`data-status-ports`): icon + number of running services (muted and without a number at 0). Menu
//    `data-status-ports-menu`: forwarded (desktop client), running services with forward/open/×, unregistered, manual forwarding,
//    error row, "All services → Apps".
//  · PERFORMANCE (`data-status-performance`): icon + the CPU/RAM counts of the measured services (from `md` up). The machine's color
//    (over 70 % yellow, over 90 % red) tints the icon, otherwise neutral (`performanceTone`). Without a measurement only the icon,
//    muted — no claim. Menu `data-status-performance-menu`: the machine block first with RAM, CPU, swap, disk (with the gateway,
//    per bar the part of cbase), below it resources per project with "measured: x of n" and the RAM capacity.
// Per PROJECT its instances: if a project has copies, the ports menu shows a group "Main · k1 (chat X)" with "Clear away"
// (confirmation, then DELETE of the copy; the result shows in the menu). The group exists only from two instances; the rules live in
// the sheet. It now appears only where the exclusive choice is missing — the web without a bridge, and a client predating the choice.
//
// EXCLUSIVE CHOICE: with a client that knows the choice (bridge `active` — the version switch `canChoice`), the ports menu begins with
// a radio list (`data-ports-choice`): "None", below it for every project of the ACTIVE workspace with port services its main (running
// ones marked) and, indented, every live copy, equally selectable and with "Clear away" (`choiceRows` in the sheet). Choosing calls
// `select(identifier, instancePorts(…), {mode: "exclusive"})`: the client ends every forwarding of the old choice and binds the new
// one's ports to their own number (client/forwarding-rules.js `switchoverPlan`). Below that "Forwarded · <instance>" (`activeRows`:
// localhost:X ← service), below that "By hand and browser" with × (`otherBesideTheList`: every forwarding that the list above does
// not show itself — none is shown nowhere). The service rows then have no button, only their state (`serviceStatus`: forwarded, "not
// forwarded", "taken by hand", "being forwarded …").
//
// WHO BRINGS ALONG: the pill, not the main process. A service of the active instance that starts after the choice gets its forwarding
// through `select(active, instancePorts(…), {mode: "bringAlong"})` — the bring-along plan never ends a manual one and does not touch
// an own one that moved aside. Reasons: (1) the pill polls `/api/project-services` every 30 s anyway and renders in the TopNav on EVERY
// page, so without an open menu, as long as a window is open (without a window there is no cause: nobody opens localhost:X, and the
// next window brings along at once); (2) the ONE computation "which ports does an instance have" (`instancePorts`, with the state per
// instance) lives in the sheet — a second poller in the main process would have to derive the same list a second time; (3) the main
// process has no session of its own for `/api/project-services`. For that the main process restores the remembered forwardings of
// the choice at start (before the first window) and falls back to main itself when a tunnel to a cleared-away copy fails. The
// fallback without a connection is also done by the pill (`activeBySituation` on `/api/projects`, every 30 s): cleared-away copy ⇒
// main of its project, deleted project ⇒ "None". At most one attempt per answer (`selectionAttempted`), never two at once. Both go
// out with `ifActive: active`: the client chooses only if the choice it was computed from still applies in its chain.
// Two menus, never both open: ONE state `open` ("ports" | "performance" | null). A click on the other entry switches in one go —
// its mousedown closes the open menu (it lies outside that one's `data-…-pop`), its click opens its own.
//
// The rules (number, sum, color, "measured") live in the sheet `lib/services-status.ts` — there they are tested without a browser
// and bound to iOS. Only what you see lives here. The file name (`ServicesPill`) is historical: the TopNav renders `<ServicesPill />`
// as ONE component that carries both entries and their shared polling.
//
// From the old ports pill (desktop client, bridge `window.cbaseClient.ports`): forwardings with the mark of automatic forwardings,
// suggestions per running service, "unregistered" (fetched on open), manual forwarding, error row. From the old resources pill: the
// machine block, resources per project, the RAM capacity with its backward compatibility.
//
// The client also creates forwardings ITSELF: when the native browser navigates to a localhost port that the container has, it
// forwards it without asking. Such entries carry `source: "browser"` and show here with a mark — otherwise the list would show a
// forwarding nobody created. Stopping works as for a manual one; they are not persisted (the client re-creates them on the next
// page visit). The field is OPTIONAL: an older client does not send it, and a missing field means "by hand", not "unknown" —
// otherwise every old forwarding would carry a mark it does not deserve.
//
// Per INSTANCE: a relocated project listens in its project container, two projects there both on 3000. A service's forwarding goes
// to its project's instance (`GET /api/projects`, sheet `instancePerProject`), and the row finds its forwarding by (instance, port).
// There is no "in the project container" mark. A client without `select` does not know the instance: then everything stays by port
// as before (`canInstance`); a client predating the choice keeps "Forward" per service row.
// A forwarding WITHOUT an instance (remembered by an old client, the normal case since all projects were relocated) belongs to the
// project its tunnel leads to today (`assignForwardings`), and the client lifts it onto that instance (`lift`); if it cannot be
// assigned (two projects on the port), it shows without a project. With the choice the pill lifts nothing any more: a forwarding by
// hand stays as it was created (the client's migration removed the old ones without an instance once, client/forwarding-rules.js
// `startState`).
//
// PREVIEW LINKS: every service row with a port carries "Share link" on the right (`PreviewButton`), below it the menu with the four
// durations unfolds, and an active link shows there with address, remaining time, copy and revoke (`PreviewArea`,
// components/preview/). The instance of a row: in the choice the chosen identifier, otherwise the project's main instance from
// `/api/projects` (so the pill fetches the projects also WITHOUT an instance-capable client, when opening the ports menu) — before
// the answer nothing goes out (`serviceTargetInstance` ⇒ `undefined`). The links state is fetched on open and then follows the SSE
// event `preview/link`; at most ONE menu is unfolded at any time (`shareOpen`).
type Forward = Forwarding & { source?: "manual" | "browser" | "selection" };
type ChoiceMode = { mode: "exclusive" | "bringAlong"; ifActive?: string | null };
type ChoiceResponse = { ok?: boolean; error?: string; active?: string | null; bound?: { port: number; error?: string }[]; occupied?: number[] };
type ClientPorts = {
  list: () => Promise<Forward[]>;
  forward: (port: number, localPort?: number, instance?: string | null) => Promise<{ ok?: boolean; localPort?: number; error?: string }>;
  stop: (port: number, instance?: string | null) => Promise<{ ok?: boolean }>;
  select?: (instance: string | null, ports: number[], options?: ChoiceMode) => Promise<ChoiceResponse>;
  lift?: (port: number, instance: string) => Promise<{ ok?: boolean; error?: string }>;
  // Since the exclusive choice: the chosen instance (null = "None") and its changes.
  active?: () => Promise<string | null>;
  onActive?: (cb: (instance: string | null) => void) => () => void;
  onChanged: (cb: (list: Forward[]) => void) => () => void;
};
const bridge = (): ClientPorts | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { cbaseClient?: { ports?: ClientPorts } }).cbaseClient?.ports || null;
};

// What `/api/project-services` returns per service (only the fields the pill reads).
type RawService = ServiceInScope & {
  id: number; name: string; projectName: string; port: number | null; container: string;
  // The state per instance — ONLY from two instances of the project.
  instances?: InstanceStatus[];
  // For "Start" in the choice's service list: without a start command no button; `holdsStart` = running, not reachable (main).
  startCommand?: string | null;
  holdsStart?: boolean;
};
type RunningService = ServiceRow & { projectName: string };

// Bar: share of the OCCUPIED part, colored by reserve — the ONE bar of the menu (machine and RAM per project). The color comes
// from `stageFrom` in the sheet, the same function that colors the performance entry. No threshold literals (`> 0.9`, `> 0.7`)
// may be copied here: if they ever diverged from the rule, the bar would color differently from the dot beside it
// (statusBar.test.mjs keeps the file literal-free).
const PROGRESS_BAR: Record<Stage, string> = { ok: "bg-accent", warn: "bg-warn", danger: "bg-danger" };
// In two parts once the gateway knows cbase's share (`cbase`, from `cbasePart` in the sheet): from the left cbase's part in the
// stage's color, behind it the rest of the occupied part in the same color, lightened (`OTHER`). So the stage stays the statement of
// the WHOLE bar (in "ok" cbase is thus cobalt, the accent), and the color classes stay in the one table above. The sheet computes
// the split (`progressBarParts`); without a cbase part it is one piece.
const OTHER = "opacity-40";
function ProgressBar({ share, cbase = null, top = "mt-1" }: { share: number; cbase?: number | null; top?: string }) {
  const color = PROGRESS_BAR[stageFrom(share)];
  const parts = progressBarParts(share, cbase);
  return (
    <div className={`${top} h-1 overflow-hidden rounded-full bg-edge`}>
      {parts.cbase == null ? (
        <div className={`h-full rounded-full ${color}`} style={{ width: `${parts.width}%` }} />
      ) : (
        <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${parts.width}%` }}>
          <div className={`h-full shrink-0 ${color}`} style={{ width: `${parts.cbase}%` }} data-progress-bar-cbase />
          <div className={`h-full min-w-0 flex-1 ${color} ${OTHER}`} data-progress-bar-other />
        </div>
      )}
    </div>
  );
}

// The color of the performance icon: only warn/danger tint it (`performanceTone`), otherwise it inherits the entry's tone — like
// the rings beside it, of which only the arc is tinted.
const TONE: Record<ReturnType<typeof performanceTone>, string> = { neutral: "", warn: "text-warn", danger: "text-danger" };

// Two own icons in the header's stroke weight: ports/applications as two slots of a server rack, performance as a pulse line. Both
// 13 px like the agent browsers' icon beside them.
const SymbolPorts = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3.5" width="18" height="7" rx="2" />
    <rect x="3" y="13.5" width="18" height="7" rx="2" />
    <path d="M7 7h.01M7 17h.01" />
  </svg>
);
const SymbolPerformance = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 12h4l3-7.5 5 15 3-7.5h4" />
  </svg>
);

const Heading = ({ children, tone = "text-dim" }: { children: React.ReactNode; tone?: string }) => (
  <div className={`px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>{children}</div>
);

// The trigger of both entries: the form of the usage displays (icon + 11 px number, `text-dim`), no background, no border. Hovered and
// open the quiet surface of the frameless header buttons; muted like the zero state.
const TRIGGER = "flex h-8 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium transition-colors";
const triggerTone = (open: boolean, muted: boolean) =>
  open ? "bg-hover text-fg" : muted ? "text-dim/60 hover:bg-hover hover:text-fg" : "text-dim hover:bg-hover hover:text-fg";

// The menu per entry: the same glass surface, right-aligned to its own trigger, clamped at the window edge.
const MENU = "cb-pop absolute right-0 top-full z-40 mt-2 max-h-[min(80vh,640px)] w-[min(340px,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-2 text-fg";

export function ServicesPill() {
  const t = useT();
  const gateway = useGateway();
  const scope = useActiveScope();
  const ws = scope.workspaceId;
  const pid = scope.projectId;

  // null = no answer yet. Empty is not unknown: before the first answer the entries render nothing instead of claiming "0 services".
  const [all, setAll] = useState<RawService[] | null>(null);
  const [resources, setResources] = useState<ResourcesRow[] | null>(null);
  const [host, setHost] = useState<MachineStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // ONE state for both menus — so they can never both be open.
  const [open, setOpen] = useState<"ports" | "performance" | null>(null);
  const portsOpen = open === "ports";
  const perfOpen = open === "performance";
  // On narrow windows the triggers sit far left after the header wraps — without this correction the right-anchored menu would stick
  // out past the left edge.
  const portsRef = useEdgeClamp<HTMLDivElement>(portsOpen);
  const perfRef = useEdgeClamp<HTMLDivElement>(perfOpen);

  // Desktop client: port forwarding.
  const [available] = useState(() => !!bridge());
  // Does the client know instances? Its bridge then carries `select` — the version switch.
  const [canInstance] = useState(() => typeof bridge()?.select === "function");
  // Does the client know the exclusive choice? Its bridge then carries `active`.
  const [canChoice] = useState(() => typeof bridge()?.active === "function");
  // The chosen instance; `undefined` = not read yet (no row is then chosen), `null` = "None".
  const [active, setActive] = useState<string | null | undefined>(undefined);
  const [choiceBusy, setChoiceBusy] = useState(false);
  // The projects with their instance (`GET /api/projects`); null = no answer yet (the pill then computes without an instance).
  const [projects, setProjects] = useState<ProjectWithInstance[] | null>(null);
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");
  // The delete dialog of a copy (the SAME as in the "Instances" tab) — open for exactly one instance.
  const [erase, setDelete] = useState<{ projectId: string; projectName: string; i: InstanceResource } | null>(null);
  // "Start" from the choice's service list: the service whose start is going out right now (`<identifier>#<id>`), and the started ones
  // until they run (key → start time) — while one is pending, the pill polls the services every 2 s instead of every 30 s.
  const [startBusy, setStartBusy] = useState<string | null>(null);
  const [starting, setStarting] = useState<Record<string, number>>({});
  const fast = Object.keys(starting).length > 0;
  const [pullResult, setPullResult] = useState<{ ok: boolean; text: string } | null>(null);
  // After an accepted clear-away (202) resources and projects refetch AT ONCE: otherwise "Clear away" would stay until the next tick
  // (15 s or 30 s) although the copy is already cleared away. Every increment is a cause.
  const [reload, setReload] = useState(0);
  const projectsReloaded = useRef(0);
  const pullResultShown = useRef(false);
  // Is the clear-away confirmation open? Its sheet lies on the body, i.e. OUTSIDE the menu — without this mark every click on it (also
  // "Cancel") and its Escape would close the menu, and the result would then reopen it: the menu rebuilt itself before one's eyes.
  // While it is open, the menu stays.
  const questionOpen = useRef(false);
  const openedRef = useRef<Record<number, boolean>>({});
  const projectsLoaded = useRef(false);
  // Per mount every forwarding is offered for lifting at most once — the client measures itself and refuses what does not lead there
  // today; a second attempt per polling tick would only ask the server the same again.
  const liftedAttempted = useRef(new Set<string>());
  // Bring-along and fallback of the choice: at most one at a time, and per state (choice, services, projects) at most one attempt.
  const selectionRunning = useRef(false);
  const selectionAttempted = useRef<{ active: string | null; all: unknown; projects: unknown } | null>(null);
  // Unregistered services from project folders. They are in NO registry, so they show neither in the services nor in the Apps view —
  // and whoever is told such an address ("running on 127.0.0.1:3102") finds something to click here. Fetched when the ports menu OPENS,
  // not polled: the scan covers thousands of ports, and the question arises exactly when someone opens the list.
  const [unreg, setUnreg] = useState<PortFinding[]>([]);
  // Preview links: the state (fetched when the ports menu opens, then SSE) and the ONE unfolded row.
  const { status: preview, takeOver: previewTakeOver } = usePreviewLinks(portsOpen);
  const [shareOpen, setShareOpen] = useState<string | null>(null);
  useEffect(() => { if (!portsOpen) setShareOpen(null); }, [portsOpen]);
  // The result of a create/revoke is held by the PILL, not by the row's area: the answer can arrive when the menu is already closed or
  // another row is unfolded (a 502 after closing would vanish without a trace). It stays like the clear-away result until the ports
  // menu has shown it once and closes again; if it came while the menu was closed, the trigger carries a dot until then.
  const [previewNotice, setPreviewNotice] = useState("");
  const previewNoticeShown = useRef(false);

  // Running services: registered ports and containers whose status the server checks (the probe covers both). The answer carries ALL
  // workspaces — filtering happens here so a workspace change needs no new fetch.
  useEffect(() => {
    let alive = true;
    const check = () =>
      api<RawService[]>("/api/project-services")
        .then((rows) => { if (alive) setAll(Array.isArray(rows) ? rows : []); })
        .catch(() => {});
    check();
    const iv = setInterval(check, fast ? 2_000 : 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [fast]);

  // Resources of the scope. docker stats is not cheap → poll moderately. On a scope change clear first: the old workspace's numbers
  // under the new one's name would be a false statement, not a stale one. Clearing depends ONLY on the scope — in the polling effect
  // below, the numbers on the trigger would vanish for one query on every open and close of the menu.
  useEffect(() => { setResources(null); }, [ws, pid]);
  // The folder size per project ("Project files") costs a `du` over every project folder of the scope (services.js `dirSize`, cached
  // 60 s) — 130–190 ms per cold call over nine projects, against 2–3 ms without. It shows ONLY in the performance menu. Since the
  // entries sit on every page, the `du` would otherwise run every minute while any window is open. So: closed `disk=0` (the backend
  // knows the parameter; if absent it computes as before), on opening the performance menu once at once with it — and with it as long
  // as it stays open. The ports menu shows no folder size and therefore refetches nothing.
  useEffect(() => {
    if (!ws) return;
    let alive = true;
    const qs = new URLSearchParams({ workspaceId: ws, ...(pid ? { projectId: pid } : {}), ...(perfOpen ? {} : { disk: "0" }) }).toString();
    const load = () =>
      api<ResourcesRow[] | { resources: ResourcesRow[]; host?: MachineStatus | null }>(`/api/project-resources?${qs}`)
        .then((r) => {
          if (!alive) return;
          setResources(Array.isArray(r) ? r : (r.resources || []));
          // Without a gateway the backend is the machine itself. With a gateway it sees only its container quota — then what the gateway
          // reports from the host counts (below).
          if (!gateway && !Array.isArray(r)) setHost(r.host ?? null);
        })
        .catch(() => {});
    load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [ws, pid, gateway, perfOpen, reload]);

  useEffect(() => {
    if (!gateway) return;
    let alive = true;
    const load = () =>
      fetch("/gw/host", { headers: { accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((h: MachineStatus | null) => { if (alive && h) setHost(h); })
        .catch(() => {});
    load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [gateway]);

  // Names for header and tooltip: fetched as soon as the workspace is unknown, and fresh when either menu opens (renames, new
  // projects) — not on every close.
  const known = workspaces.some((w) => w.id === ws);
  useEffect(() => {
    if (!ws || (!open && known)) return;
    let alive = true;
    api<Workspace[]>("/api/workspaces")
      .then((l) => { if (alive && Array.isArray(l)) setWorkspaces(l); })
      .catch(() => {});
    return () => { alive = false; };
  }, [ws, open, known]);

  useEffect(() => {
    if (!portsOpen || !bridge()) return;
    let alive = true;
    api<RunningPorts>("/api/ports/running")
      .then((r) => { if (alive) setUnreg((r.findings ?? []).filter((b) => b.kind === "unregistered")); })
      .catch(() => {});
    return () => { alive = false; };
  }, [portsOpen]);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.list().then(setForwards).catch(() => {});
    return b.onChanged(setForwards);
  }, []);

  // Which projects were relocated — only with a client that knows instances; fresh at start and on every opening of the ports menu (a
  // relocation is rare, but then the next forwarding should already hit the instance). With the choice additionally every 30 s like the
  // services: new and cleared-away copies, deleted projects (fallback below).
  useEffect(() => {
    // Without an instance-capable client the pill asks only when the ports menu opens — for the preview links' instance.
    if (!canInstance && !portsOpen) return;
    let alive = true;
    // Loaded means an answer arrived — a failure lets the next cause (every opening) ask again.
    const load = () =>
      api<ProjectWithInstance[]>("/api/projects")
        .then((l) => { if (alive && Array.isArray(l)) { projectsLoaded.current = true; setProjects(l); } })
        .catch(() => {});
    if (!projectsLoaded.current || portsOpen || projectsReloaded.current !== reload) {
      projectsReloaded.current = reload;
      void load();
    }
    const iv = canChoice ? setInterval(load, 30_000) : null;
    return () => { alive = false; if (iv) clearInterval(iv); };
  }, [canInstance, canChoice, portsOpen, reload]);

  // The chosen instance: read once, then follow every change (also one from the main process — fallback, another window).
  useEffect(() => {
    const b = bridge();
    if (!b?.active) return;
    let alive = true;
    void b.active().then((k) => { if (alive) setActive(k ?? null); }).catch(() => {});
    const off = b.onActive?.((k) => setActive(k ?? null));
    return () => { alive = false; off?.(); };
  }, []);

  // Bring-along and fallback of the choice (reasoning in the header). If the chosen instance no longer exists, the choice falls
  // (exclusive) to its project's main or to "None"; otherwise every running port of the active instance without a forwarding gets
  // one (bring along). Only once choice and services are read — "not loaded yet" is not "nothing runs".
  useEffect(() => {
    const b = bridge();
    if (!canChoice || !b?.select || active === undefined || all === null || selectionRunning.current) return;
    const v = selectionAttempted.current;
    if (v && v.active === active && v.all === all && v.projects === projects) return;
    const situation = activeBySituation(active, projects);
    const target = situation.kind === "main" ? { identifier: situation.identifier, mode: "exclusive" as const }
      : situation.kind === "no" ? { identifier: null, mode: "exclusive" as const }
      : active && needsBringAlong(activeRowsOf({ active, services: all, forwards })) ? { identifier: active, mode: "bringAlong" as const }
      : null;
    if (!target) return;
    selectionAttempted.current = { active, all, projects };
    selectionRunning.current = true;
    // Computed from THIS `active`: the client chooses only if it still applies when executed in its chain (`ifActive`) — by the time
    // `cbase:ports-active` arrives, the human may long since have chosen again, and their click would already be waiting there.
    void b.select(target.identifier, instancePorts(all, target.identifier), { mode: target.mode, ifActive: active })
      .then((r) => { if (r?.active !== undefined) setActive(r.active ?? null); })
      .catch(() => {})
      .finally(() => { selectionRunning.current = false; });
  }, [canChoice, active, all, projects, forwards]);

  // Lift forwardings without an instance onto the project they belong to — only once projects AND services are loaded; a client
  // without `lift` only recomputes the display. Not any more with the choice (header).
  useEffect(() => {
    const b = bridge();
    const inst = instancePerProject(projects);
    if (!canInstance || canChoice || !b?.lift || !inst || all === null) return;
    for (const h of forwardingsToLift(assignForwardings(forwards, all, inst))) {
      const k = forwardingKey(h.instance, h.port);
      if (liftedAttempted.current.has(k)) continue;
      liftedAttempted.current.add(k);
      void b.lift(h.port, h.instance).catch(() => {});
    }
  }, [canInstance, canChoice, forwards, projects, all]);

  // Click catcher as a document mousedown, not as fixed inset-0 (house rule, globals.css): a veil over the page would lie over the
  // native browser view and eat the first click. "Outside" means: outside the OPEN entry with its menu — the other trigger counts as
  // outside, so a click there switches in one go. Never outside: anything, while the clear-away confirmation is open (click and
  // Escape then belong to it).
  useEffect(() => {
    if (!open) return;
    const pop = open === "ports" ? "[data-status-ports-pop]" : "[data-status-performance-pop]";
    const beside = (e: MouseEvent) => { if (!questionOpen.current && !(e.target as Element | null)?.closest?.(pop)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !questionOpen.current) setOpen(null); };
    document.addEventListener("mousedown", beside);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", beside); window.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (!portsOpen) setErr(""); }, [portsOpen]);
  // The clear-away result stays until the menu has shown it once and closes again. The confirmation does not close the menu (its sheet
  // lies outside; `questionOpen`). Whoever closes it during the DELETE sees the result on the next opening.
  useEffect(() => {
    if (portsOpen && pullResult) pullResultShown.current = true;
    if (!portsOpen && pullResultShown.current) { pullResultShown.current = false; setPullResult(null); }
  }, [portsOpen, pullResult]);
  useEffect(() => {
    if (portsOpen && previewNotice) previewNoticeShown.current = true;
    if (!portsOpen && previewNoticeShown.current) { previewNoticeShown.current = false; setPreviewNotice(""); }
  }, [portsOpen, previewNotice]);

  const doForward = useCallback(async (port: number, instance: string | null, autoOpen = false) => {
    const b = bridge();
    if (!b) return;
    setBusy(port);
    setErr("");
    try {
      const r = await b.forward(port, undefined, instance);
      if (r.error) setErr(r.error);
      else if (autoOpen && r.localPort) {
        openedRef.current[port] = true;
        window.open(`http://localhost:${r.localPort}`, "_blank");
      }
    } finally {
      setBusy(null);
    }
  }, []);

  // The exclusive choice: EXACTLY this instance forwards, or none (`null` here means "None").
  // The ports are the instance's running port services; the client ends every forwarding of the old choice.
  const doChoice = useCallback(async (identifier: string | null, ports: number[]) => {
    const b = bridge();
    if (!b?.select) return;
    setChoiceBusy(true);
    setErr("");
    try {
      const r = await b.select(identifier, ports, { mode: "exclusive" });
      if (r?.active !== undefined) setActive(r.active ?? null);
      const error = r.error || r.bound?.find((g) => g.error)?.error;
      if (error) setErr(error);
    } finally {
      setChoiceBusy(false);
    }
  }, []);

  // "Start" from the choice's service list: simple start (start command) IN the chosen instance (`?instance`) — for a copy in its
  // container, never in main. The forwarding follows by itself (bring-along), the pill polls the services every 2 s until it runs. A
  // 409 (already running, port taken, relocation) shows as an error under the list.
  const doStart = useCallback(async (identifier: string, id: number) => {
    const project = projectOfTheIdentifier(identifier);
    if (!project) return;
    const key = `${identifier}#${id}`;
    setStartBusy(key);
    setErr("");
    try {
      await api(`/api/projects/${encodeURIComponent(project)}/services/${id}/start?instance=${encodeURIComponent(identifier)}`,
        { method: "POST", body: JSON.stringify({ mode: "simple" }) });
      setStarting((v) => ({ ...v, [key]: Date.now() }));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setStartBusy(null);
    }
  }, []);
  // A started service drops out of the pending list as soon as it runs in its instance — after 90 s at the latest (the pill then polls at
  // the usual rate again; what the start reported already showed under the list).
  useEffect(() => {
    const keys = Object.keys(starting);
    if (!keys.length) return;
    const now = Date.now();
    const run = new Set((choiceServices({ active, services: all, forwards: [] }) ?? []).filter((d) => d.running === true).map((d) => `${active}#${d.id}`));
    const rest = Object.fromEntries(Object.entries(starting).filter(([k, t0]) => !run.has(k) && now - t0 < 90_000));
    if (Object.keys(rest).length !== keys.length) setStarting(rest);
  }, [all, active, starting]);

  // Clearing away a copy (through the SAME dialog as the "Instances" tab — projects/InstanceDialogs.tsx `CopyDelete`: the wording
  // `clearAwayQuestion` as the hint, the delete preview, the DELETE only on its button, a 409 INSTANCE_WORKING with the chats stays in
  // the dialog). Without a path (main) nothing opens. The menu stays open while the dialog is up (`questionOpen`), the accepted result
  // appears in place — it is not closed and reopened.
  const doClearAway = useCallback((projectId: string, projectName: string, i: InstanceResource) => {
    const path = clearAwayPath(projectId, i);
    if (!path) return;
    questionOpen.current = true;
    setPullResult(null);
    setDelete({ projectId, projectName, i });
  }, []);
  const deleteTo = useCallback(() => { questionOpen.current = false; setDelete(null); }, []);
  // The dialog reports only the accepted DELETE (202) — refetch at once, otherwise "Clear away" would stay until the next tick.
  const clearAwayAccepted = useCallback((i: InstanceResource, body: unknown) => {
    setPullResult(clearAwayResult(202, body, i, t));
    setReload((n) => n + 1);
  }, [t]);

  // Nothing before loading: neither the remembered workspace nor the services are settled. Nothing without a chosen workspace either —
  // the same as the Skills page in the web: no "All" state until someone chooses.
  if (!scope.loaded || !ws || all === null) return null;

  // Which services belong to the scope, what the triggers show and what their tooltips say is computed by the sheet — there is no own
  // cut by workspace/project and no own comparison with the count here (statusBar.test.mjs).
  const services: RunningService[] = runningInScope(all, ws, pid)
    .map((s) => ({ id: s.id, projectId: s.projectId, name: s.name || s.projectName, projectName: s.projectName, port: s.port, container: s.container || null }));
  const n = services.length;
  const sum = servicesSum(resources);
  const sample = measured(services, resources);
  // "measured: x of n" — also "0 of n" when NO service is measured, but only once the resources query has answered.
  const measurement = measureRow(sample, resources !== null);
  const stage: MachineLevel | null = machineLevel(host);
  const tone = performanceTone(stage);
  const { count, counts, muted } = triggerContent(n, sum);

  const wsObj = workspaces.find((w) => w.id === ws);
  const projObj = pid ? wsObj?.projects?.find((p) => p.id === pid) : undefined;
  const projName = projObj?.name || (pid ? services.find((d) => d.projectId === pid)?.projectName : undefined);
  const scopeName = wsObj ? (pid && projName ? `${wsObj.name} › ${projName}` : wsObj.name) : "";

  // Per (instance, port) — without an instance-capable client every instance falls to null, and everything goes by port as before.
  const instances = instancePerProject(projects);
  const space = (i: string | null | undefined) => (canInstance ? (i ?? null) : null);
  const instanceOf = (projectId: string) => serviceInstance(instances, projectId, canInstance);
  // A forwarding without an instance counts under the instance it belongs to — not as a foreign one, not as a conflict.
  const assigned = assignForwardings(forwards, all, canInstance ? instances : null);
  const fwdMap = new Map(assigned.map((z) => [forwardingKey(space(z.instance), z.f.port), z.f]));
  const serviceKey = new Set(services.map((d) => (d.port ? forwardingKey(instanceOf(d.projectId), d.port) : "")));
  // Forwardings that are NOT a running service of the scope (manual forwarding, unregistered, services of another workspace) — without
  // this section an active forwarding would vanish from the menu as soon as one switches workspace, and could no longer be stopped.
  const foreignForwards = assigned.filter((z) => !serviceKey.has(forwardingKey(space(z.instance), z.f.port))).map((z) => z.f);

  // Tooltips: ports — number and scope, then the forwardings; performance — "Performance · scope", then the reason for the color.
  const { row1, performanceRow, ports, performance } = tooltipRows({ count: n, scopeName, stage, forwarded: forwards.length }, t);
  // Muted without any number and without a warning color: the entry then claims nothing.
  const perfMuted = !counts && tone === "neutral";

  const openLocal = (f: Forward) => window.open(`http://localhost:${f.localPort}`, "_blank");
  // Browser path: the row jumps to Apps with the project selected. If Apps is already open, the page takes over the jump and the link
  // does NOT navigate — otherwise Next would push `?project=` into the address after this click, and ⌘R would win against the manual
  // choice (see `handOverAppsJump`). A click with a modifier key (new tab) stays a normal link.
  const toApps = (e: React.MouseEvent, projectId: string) => {
    setOpen(null);
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (handOverAppsJump(projectId)) e.preventDefault();
  };

  // Projects with at least two instances (the sheet decides from when a group exists).
  const groups = instanceGroups(resources);

  // The exclusive choice (header): only with a client that knows it.
  const choice = available && canChoice;
  const rowsChoice = choice ? choiceRows({ services: all, projects, ws, active, groups }) : null;
  const activeRows = choice ? activeRowsOf({ active, services: all, forwards }) : [];
  const activeTitle = active ? (instanceTitle(active, projects, groups, t) ?? active) : "";
  // The chosen copy is not ready: one sentence above the list, and NO start — a ▶ there would end in 409 COPY_NOT_READY. The list
  // itself stays with its LIVE services (otherwise a running copy being cleared away or in `error` would show with its forwarding
  // nowhere in the menu — `choiceServicesVisible`).
  const activeCopy = active ? rowsChoice?.find((z) => z.identifier === active)?.copy ?? null : null;
  const activeNotReady = copyNotReady(activeCopy);
  const choiceList = choice ? choiceServicesVisible(choiceServices({ active, services: all, forwards }), activeNotReady) : [];
  // "By hand and browser" = what the list above does NOT show (computed from the shown rows, not from `activeRows`): every forwarding exactly once.
  const other = otherBesideTheList(forwards, choiceList, activeRows);
  const stateText = (st: ServiceStatus<Forward>) =>
    st.kind === "occupied" ? t("taken by a manual forward") : st.kind === "pending" ? t("forwarding …") : t("not forwarded");

  // Two lines: the instance as the last part of the same truncated line would be left with ≈ 37 px in the 340 px menu (behind
  // "localhost:X ← :port", the "Browser" mark, ↗ and ×), and which copy stands behind localhost:3195 could never be read. So a line of its
  // own below, truncated with the full name as a tooltip — like the heading of the instance group.
  const fwdRow = (f: Forward) => {
    const inst = f.instance ? (instanceTitle(f.instance, projects, groups, t) ?? f.instance) : null;
    return (
      <div key={`f${forwardingKey(f.instance, f.port)}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
        <button onClick={() => openLocal(f)} className="flex min-w-0 flex-1 flex-col text-left" title={t("Open in browser")}>
          <span className="truncate text-[12px]">
            <span className="font-mono">localhost:{f.localPort}</span>
            <span className="text-dim"> ← :{f.port}</span>
            {f.connections > 0 && <span className="text-dim"> · {f.connections}</span>}
          </span>
          {inst && <span className="truncate text-[11px] text-dim" title={inst} data-fwd-instance={f.instance}>{inst}</span>}
        </button>
        {f.source === "browser" && (
          <span
            data-ports-source="browser"
            title={t("Forwarded automatically by the browser")}
            className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
          >
            {t("Browser")}
          </span>
        )}
        <button onClick={() => openLocal(f)} className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover" title={t("Open in browser")}>↗</button>
        <button onClick={() => bridge()?.stop(f.port, f.instance ?? null)} className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg" title={t("Stop forwarding")}>×</button>
      </div>
    );
  };

  const place = (d: RunningService) => (d.port ? `:${d.port}` : d.container || "");

  // Preview links per row (header): `identifier` = the choice's chosen instance, otherwise `null` (then the main instance from the
  // projects). The computation lives in the sheet lib/preview-links.ts.
  const toggleShare = (key: string) => setShareOpen((v) => (v === key ? null : key));
  // A row without a project or without a numeric service id gets no button (`splittable` false) — nothing is guessed.
  const previewRow = (projectId: string, id: number | string | undefined, identifier: string | null) => {
    const serviceId = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : null;
    const instance = projectId ? serviceTargetInstance(instances, projectId, identifier) : undefined;
    return {
      projectId, instance, serviceId, splittable: !!projectId && serviceId != null,
      key: `${identifier ?? projectId}#${serviceId}`,
      link: serviceId == null ? null : linkOfTheRow(preview?.active, projectId, instance, serviceId),
    };
  };
  const previewArea = (row: ReturnType<typeof previewRow>) => row.serviceId == null ? null : (
    <PreviewArea
      state={preview}
      projectId={row.projectId}
      instance={row.instance}
      serviceId={row.serviceId}
      link={row.link}
      open={shareOpen === row.key}
      onClose={() => setShareOpen((v) => (v === row.key ? null : v))}
      takeOver={previewTakeOver}
      onNotice={setPreviewNotice}
    />
  );

  // A row of the choice: radio, title, "running" dot, for a copy "Clear away" beside it (never inside the radio — two buttons).
  const radio = (p: { identifier: string | null; title: string; beside?: string; running?: boolean; ports: number[]; one?: boolean; clearAway?: React.ReactNode }) => {
    const on = active !== undefined && (active ?? null) === p.identifier;
    return (
      <div key={p.identifier ?? "no"} className={`flex items-center gap-2 rounded-xl py-1.5 pr-2 hover:bg-hover ${p.one ? "pl-6" : "pl-2"}`} data-ports-choice={p.identifier ?? ""}>
        <button
          type="button"
          role="radio"
          aria-checked={on}
          disabled={choiceBusy || active === undefined}
          onClick={() => { if (!on) void doChoice(p.identifier, p.ports); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
        >
          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${on ? "border-accent" : "border-edge"}`} aria-hidden>
            {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">
            {p.title}
            {p.beside && <span className="text-dim"> · {p.beside}</span>}
          </span>
          {p.running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" title={t("Services running")} />}
        </button>
        {p.clearAway}
      </div>
    );
  };
  const clearAwayButton = (projectId: string, projectName: string, i: InstanceResource) => (
    <button
      onClick={() => doClearAway(projectId, projectName, i)}
      disabled={erase != null}
      data-instance-clear-away
      title={t("Remove this copy")}
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-danger disabled:opacity-50"
    >
      {erase?.i.identifier === i.identifier ? t("…") : t("Remove##clear")}
    </button>
  );

  return (
    <>
      {/* ── Ports: the applications and their ports ── */}
      <span className="relative shrink-0" data-status-ports-pop>
        <button
          type="button"
          onClick={() => setOpen((v) => (v === "ports" ? null : "ports"))}
          data-status-ports
          data-services-count={n}
          title={ports}
          aria-label={row1}
          aria-haspopup="true"
          aria-expanded={portsOpen}
          className={`${TRIGGER} ${triggerTone(portsOpen, muted)}`}
        >
          <SymbolPorts />
          {count != null && <span className="tabular-nums">{count}</span>}
          {previewNotice && !portsOpen && <span className="text-[8px] leading-none text-danger" data-preview-notice-point title={previewNotice} aria-hidden>●</span>}
        </button>
        {portsOpen && (
          <div ref={portsRef} data-status-ports-menu data-overlay className={MENU}>
            <div className="truncate px-2 pb-1 pt-1 text-[12px] font-semibold" title={scopeName || undefined}>
              {t("Services")}{scopeName ? ` · ${scopeName}` : ""}
            </div>

            {choice && (
              <>
                <Heading>{t("Forward ports from")}</Heading>
                <div role="radiogroup" aria-label={t("Forward ports from")} data-ports-choice-list>
                  {radio({ identifier: null, title: t("None"), ports: [] })}
                  {rowsChoice === null && <div className="px-2 py-1.5 text-[12px] text-dim">{t("…")}</div>}
                  {rowsChoice?.length === 0 && <div className="px-2 py-1.5 text-[12px] text-dim">{t("No project with port services in this workspace.")}</div>}
                  {rowsChoice?.map((z) => radio({
                    identifier: z.identifier,
                    title: z.kind === "copy" && z.copy ? (z.foreign ? `${z.projectName} · ${instanceDesignation(z.copy, t)}` : instanceDesignation(z.copy, t)) : z.projectName,
                    // A copy that is not ready carries its state word ("being created", "being cleared away" …) instead of its ports —
                    // like the Apps page; "being cleared away" thus shows also where "Clear away" stood before.
                    beside: z.foreign ? t("other workspace") : copyNotReady(z.copy) ? stateWord(copyNotReady(z.copy), t) : z.ports.map((n) => `:${n}`).join(" "),
                    running: z.running,
                    ports: z.ports,
                    one: z.kind === "copy" && !z.foreign,
                    clearAway: z.copy && clearable(z.copy) ? clearAwayButton(z.projectId, z.projectName, z.copy) : null,
                  }))}
                </div>
                {/* The services of the forwarded project: every registered service of the chosen instance — running ones with their
                    forwarding, stopped ones with "Start" (▶). Other projects do not show here (Apps is for that). */}
                <div className="mx-2 mt-1 h-px bg-edge" />
                {active ? (
                  <>
                    <Heading>{t("Services · {instance}", { instance: activeTitle })}</Heading>
                    {activeNotReady && activeCopy && (
                      <div className="px-2 py-1.5 text-[12px] text-dim" data-choice-not-ready={activeNotReady}>
                        {notReadySet(activeCopy, stateWord(activeNotReady, t), t)}
                      </div>
                    )}
                    {choiceList === null && <div className="px-2 py-1.5 text-[12px] text-dim">{t("…")}</div>}
                    {!activeNotReady && choiceList?.length === 0 && <div className="px-2 py-1.5 text-[12px] text-dim">{t("No services registered.")}</div>}
                    {/* Not ready: only the live services (forwarded with ↗, taken, being forwarded, "running, not reachable") — none of
                        them carries ▶ (that shows only beside `running === false` without `holds`). */}
                    {choiceList?.map((d) => {
                      const z = d.row;
                      const key = `${active}#${d.id}`;
                      // Preview link of the row: the target is the CHOSEN instance (also a copy).
                      const row = previewRow(projectOfTheIdentifier(active) ?? "", d.id, active);
                      const buttonEl = row.splittable ? <PreviewButton state={preview} port={d.port} link={row.link} open={shareOpen === row.key} onToggle={() => toggleShare(row.key)} /> : null;
                      const area = row.splittable && d.port != null ? previewArea(row) : null;
                      if (z?.kind === "forwarded") {
                        return (
                          <div key={`w${d.id}`}>
                          <div className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover" data-ports-active-row={z.kind} data-choice-service={d.id}>
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                            <button onClick={() => openLocal(z.f)} className="min-w-0 flex-1 truncate text-left text-[12px]" title={t("Open in browser")}>
                              {d.name}
                              <span className="text-dim"> · </span>
                              <span className="font-mono">localhost:{z.f.localPort}</span>
                              {z.f.localPort !== d.port && <span className="text-dim"> ← :{d.port}</span>}
                            </button>
                            <button onClick={() => openLocal(z.f)} className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover" title={t("Open in browser")}>↗</button>
                            {buttonEl}
                          </div>
                          {area}
                          </div>
                        );
                      }
                      const location = d.port != null ? `:${d.port}` : d.container || "";
                      // The state per instance from the sheet: `null` = unknown (a copy without an entry) — no ring like "stopped" and no ▶;
                      // `holds` also in a copy — "running, not reachable" without ▶, as in main.
                      const state = d.running === true
                        ? (z?.kind === "occupied" ? t("taken by a manual forward") : z?.kind === "pending" ? t("forwarding …") : null)
                        : d.holds ? t("running, not reachable") : starting[key] ? t("starting …") : d.running === null ? t("state unknown") : null;
                      return (
                        <div key={`w${d.id}`}>
                        <div className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover" data-ports-active-row={z?.kind} data-choice-service={d.id} data-choice-running={d.running === true ? "1" : d.running === null ? "?" : "0"}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.running === true ? "bg-ok" : d.holds ? "bg-edge" : d.running === null ? "border border-dashed border-edge" : "border border-edge"}`} />
                          <span className={`min-w-0 flex-1 truncate text-[12px] ${d.running === true ? "" : "text-dim"}`}>
                            {d.name}
                            {location && <span className="font-mono text-dim"> · {location}</span>}
                            {state && <span className={z?.kind === "occupied" || d.holds ? "text-warn" : "text-dim"}> · {state}</span>}
                          </span>
                          {d.running === false && !d.holds && !starting[key] && (
                            <button
                              type="button"
                              onClick={() => void doStart(active, d.id)}
                              disabled={!d.startable || startBusy != null}
                              data-choice-start={d.id}
                              title={d.startable ? t("Start {name}", { name: d.name }) : t("No start command set")}
                              aria-label={t("Start {name}", { name: d.name })}
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-accent hover:bg-hover disabled:text-dim disabled:opacity-50"
                            >
                              {startBusy === key ? <span className="text-[11px]">…</span> : (
                                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden><path d="M2.5 1.5v7l6-3.5z" fill="currentColor" /></svg>
                              )}
                            </button>
                          )}
                          {buttonEl}
                        </div>
                        {area}
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div className="px-2 py-1.5 text-[12px] text-dim">{t("Choose a project above to see its services.")}</div>
                )}
                <div className="mx-2 mt-1 h-px bg-edge" />
              </>
            )}

            {available && !canChoice && foreignForwards.length > 0 && (
              <>
                <Heading>{t("Forwarded")}</Heading>
                {foreignForwards.map(fwdRow)}
              </>
            )}

            {/* With the choice only the forwarded project shows on top — the running services of the whole scope show only without the
                choice (web without a bridge, a client predating the choice). */}
            {!choice && <Heading>{t("Running services")}</Heading>}
            {!choice && n === 0 && <div className="px-2 py-1.5 text-[12px] text-dim">{t("No services running.")}</div>}
            {!choice && services.map((d) => {
              const inst = instanceOf(d.projectId);
              // With the choice: the row's state, without its own button (forwarding happens through the choice above). Without it (a client
              // predating the choice) and for a service without an instance (it is in no choice, and before the answer of /api/projects
              // everything is "without instance", then locked) the forwarding by (instance, port) and "Forward".
              const st = choice && d.port && inst ? serviceStatus(d.port, inst, active, forwards) : null;
              const f = st ? (st.kind === "forwarded" ? st.f : undefined) : available && d.port ? fwdMap.get(forwardingKey(inst, d.port)) : undefined;
              const text = (
                <span className="min-w-0 flex-1 truncate text-left text-[12px]">
                  {d.name}
                  {place(d) && <span className="font-mono text-dim"> · {place(d)}</span>}
                  {f && <span className="text-dim"> → localhost:{f.localPort}</span>}
                  {st && st.kind !== "forwarded" && <span className={st.kind === "occupied" ? "text-warn" : "text-dim"} data-ports-state={st.kind}> · {stateText(st)}</span>}
                </span>
              );
              // Preview link of the row: the target is the project's main instance (the scope's running services are those of main).
              const row = previewRow(d.projectId, d.id, null);
              const buttonEl = row.splittable ? <PreviewButton state={preview} port={d.port} link={row.link} open={shareOpen === row.key} onToggle={() => toggleShare(row.key)} /> : null;
              const area = row.splittable && d.port ? previewArea(row) : null;
              // Browser (no bridge) and services without a host port: the row jumps to Apps.
              if (!available || !d.port) {
                return (
                  <div key={`d${d.id}`}>
                    <div className="flex items-center gap-1 rounded-xl pr-2 hover:bg-hover">
                      <Link
                        href={appsProjectHref(d.projectId)}
                        onClick={(e) => toApps(e, d.projectId)}
                        title={t("Open on the Apps page")}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
                        data-service-row={d.id}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        {text}
                      </Link>
                      {buttonEl}
                    </div>
                    {area}
                  </div>
                );
              }
              return (
                <div key={`d${d.id}`}>
                <div className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover" data-service-row={d.id}>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${f ? "bg-ok" : "bg-accent"}`} />
                  {f ? (
                    <button onClick={() => openLocal(f)} className="flex min-w-0 flex-1" title={t("Open in browser")}>{text}</button>
                  ) : text}
                  {f?.source === "browser" && (
                    <span
                      data-ports-source="browser"
                      title={t("Forwarded automatically by the browser")}
                      className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
                    >
                      {t("Browser")}
                    </span>
                  )}
                  {f ? (
                    <>
                      <button onClick={() => openLocal(f)} className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover" title={t("Open in browser")}>↗</button>
                      {!st && <button onClick={() => bridge()?.stop(f.port, f.instance ?? null)} className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg" title={t("Stop forwarding")}>×</button>}
                    </>
                  ) : !st && (
                    <button
                      onClick={() => doForward(d.port!, inst)}
                      disabled={busy === d.port || (canInstance && !instances)}
                      className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] hover:bg-hover disabled:opacity-50"
                    >
                      {busy === d.port ? t("…") : t("Forward##send")}
                    </button>
                  )}
                  {buttonEl}
                </div>
                {area}
                </div>
              );
            })}

            {choice && other.length > 0 && (
              <>
                <div className="mx-2 mt-1 h-px bg-edge" />
                <Heading>{t("Manual and browser")}</Heading>
                {other.map(fwdRow)}
              </>
            )}

            {!choice && groups.length > 0 && (
              <>
                <div className="mx-2 mt-1 h-px bg-edge" />
                <Heading>{t("Instances")}</Heading>
                {groups.map((g) => {
                  return (
                    <div key={g.projectId} className="rounded-xl px-2 py-1.5" data-instance-group={g.projectId}>
                      <div className="truncate text-[12px] font-medium" title={g.name}>{g.name}</div>
                      <div className="truncate text-[11px] text-dim" data-instance-title>{groupsTitle(g, t)}</div>
                      {g.instances.map((i) => {
                        const run = runningPerInstance(all, g.projectId, i.identifier);
                        return (
                          <div key={i.identifier} className="mt-1 flex items-center gap-2" data-instance={i.identifier}>
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${run > 0 ? "bg-ok" : "bg-edge"}`} />
                            <span className="min-w-0 flex-1 truncate text-[12px]" title={instanceMeasurement(i) || i.dnsName || undefined}>
                              {instanceDesignation(i, t)}
                              {run > 0 && <span className="text-dim"> · {t("{n} running", { n: run })}</span>}
                            </span>
                            {clearable(i) ? clearAwayButton(g.projectId, g.name, i) : getsClearedAway(i) ? (
                              <span className="shrink-0 px-1.5 text-[11px] text-dim" data-instance-gets-cleared-away>{t("being removed")}</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}
            {pullResult && <div data-instance-result className={`px-2 pt-1 text-[11px] ${pullResult.ok ? "text-dim" : "text-danger"}`}>{pullResult.text}</div>}
            {previewNotice && <div data-preview-notice className="px-2 pt-1 text-[11px] text-danger">{t("Preview link: {text}", { text: previewNotice })}</div>}

            {available && unreg.filter((b) => !fwdMap.has(forwardingKey(space(b.instance), b.port))).length > 0 && (
              <>
                <div className="mx-2 mt-1 h-px bg-edge" />
                <Heading tone="text-warn">{t("Not registered")}</Heading>
                {unreg.filter((b) => !fwdMap.has(forwardingKey(space(b.instance), b.port))).map((b) => (
                  <div key={`u${forwardingKey(b.instance, b.port)}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover">
                    <span className="min-w-0 flex-1 truncate text-[12px]" title={t("{process} from {cwd} — not a registered service", { process: b.process || "?", cwd: b.cwd || "?" })}>
                      <span className="font-mono">:{b.port}</span>
                      {b.project && <span className="text-dim"> · {b.project}</span>}
                    </span>
                    <button
                      onClick={() => doForward(b.port, space(b.instance))}
                      disabled={busy === b.port}
                      className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] hover:bg-hover disabled:opacity-50"
                    >
                      {busy === b.port ? t("…") : t("Forward##send")}
                    </button>
                  </div>
                ))}
              </>
            )}

            {available && (
              <div className="mt-1 flex items-center gap-1.5 border-t border-edge px-1 pt-2">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter" && manual) { void doForward(Number(manual), null); setManual(""); } }}
                  placeholder={t("Port, e.g. 3000")}
                  inputMode="numeric"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-card px-2.5 py-1 font-mono text-[12px] outline-none focus:border-accent"
                />
                <button
                  onClick={() => { if (manual) { void doForward(Number(manual), null); setManual(""); } }}
                  disabled={!manual || busy != null}
                  className="shrink-0 rounded-lg border border-edge px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-50"
                >
                  {t("Forward##send")}
                </button>
              </div>
            )}
            {err && <div className="px-2 pt-1.5 text-[11px] text-danger">{err}</div>}

            <div className="mt-1 border-t border-edge px-1 pt-1.5">
              <Link
                href="/apps"
                onClick={() => setOpen(null)}
                className="block rounded-lg px-1.5 py-1 text-[12px] text-accent hover:bg-hover"
              >
                {t("All services → Apps")}
              </Link>
            </div>
          </div>
        )}
      </span>

      {/* ── Performance: what the services and the machine consume ── */}
      <span className="relative shrink-0" data-status-performance-pop>
        <button
          type="button"
          onClick={() => setOpen((v) => (v === "performance" ? null : "performance"))}
          data-status-performance
          data-services-stage={stage ? stage.stage : "no"}
          title={performance}
          aria-label={performanceRow}
          aria-haspopup="true"
          aria-expanded={perfOpen}
          className={`${TRIGGER} ${triggerTone(perfOpen, perfMuted)}`}
        >
          <span className={`flex ${TONE[tone]}`}><SymbolPerformance /></span>
          {/* Below md only the icon — the numbers are in the menu. */}
          {counts && <span className="hidden tabular-nums md:inline">{counts}</span>}
        </button>
        {perfOpen && (
          <div ref={perfRef} data-status-performance-menu data-overlay className={MENU}>
            <div className="truncate px-2 pb-1 pt-1 text-[12px] font-semibold" title={scopeName || undefined}>
              {performanceRow}
            </div>

            {/* What is occupied on the machine IN TOTAL — the denominator for the projects below, and the reason for the icon's color. At
                the very TOP, before "Resources". With a gateway plus the share of cbase per bar (`cbasePart`, sheet). */}
            {host && (() => {
              // Number AND bar show the OCCUPIED part — like the projects and like every bar in the house. The machine reports free
              // (MemAvailable, freeBytes); the subtraction lives ONCE in the sheet (`ramShare` …), in the same functions from which
              // `machineLevel` computes the icon's color. This file reads no raw machine value from which a share could be computed
              // (statusBar.test.mjs). An input without a denominator is `null` and shows as "—", not as 0.
              const ram = ramShare(host);
              // Load per core: can exceed 1 (more work than cores). The bar caps, the number does not — "143 %" is the statement, not a
              // display error.
              const load = loadShare(host);
              const disk = diskShare(host);
              const swap = swapShare(host);
              const bytes = (share: number | null, total: number | undefined) => (share == null || total == null ? null : Math.round(share * total));
              // The part of cbase per bar — `null` without a gateway measurement (local, old gateway, field not measured): the bar is then
              // one piece and there is no cbase row.
              const cbaseParts: Record<CbaseKind, CbasePart | null> = {
                ram: cbasePart(host, "ram"), load: cbasePart(host, "load"), swap: cbasePart(host, "swap"), disk: cbasePart(host, "disk"),
              };
              const withCbase = Object.values(cbaseParts).some((x) => x != null);
              const cbaseRow = (kind: CbaseKind) => {
                const part = cbaseParts[kind];
                if (!part) return null;
                return (
                  <div className="mt-1 whitespace-nowrap font-mono text-[10px] text-dim" data-cbase-value={kind}
                    title={kind === "load" ? t("{n} cores", { n: part.value }) : undefined}>
                    {t("cbase {value}", { value: cbaseValueText(host, kind, part) })}
                  </div>
                );
              };
              return (
                <div className="rounded-xl px-2 pb-2 pt-2" data-host>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{gateway ? t("Server") : t("This machine")}</span>
                    <span className="ml-auto text-[10px] text-dim">{t("in use")}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                    <div className="min-w-0">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">RAM</div>
                      <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-fg">{fmtBytes(bytes(ram, host.mem.totalBytes))}<span className="text-dim"> / {fmtBytes(ram == null ? null : host.mem.totalBytes)}</span></div>
                      {ram != null && <ProgressBar share={ram} cbase={cbaseParts.ram?.share} />}
                      {cbaseRow("ram")}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">CPU</div>
                      <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-fg" title={t("Load of the last minute per core")}>
                        {load == null ? "—" : `${Math.round(load * 100)}%`}<span className="text-dim"> · {t("{n} cores", { n: host.cpu.count })}</span>
                      </div>
                      {load != null && <ProgressBar share={load} cbase={cbaseParts.load?.share} />}
                      {cbaseRow("load")}
                    </div>
                    {swap != null && host.swap && (
                      <div className="min-w-0">
                        <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">{t("Swap")}</div>
                        <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-fg">{fmtBytes(bytes(swap, host.swap.totalBytes))}<span className="text-dim"> / {fmtBytes(host.swap.totalBytes)}</span></div>
                        <ProgressBar share={swap} cbase={cbaseParts.swap?.share} />
                        {cbaseRow("swap")}
                      </div>
                    )}
                    {disk != null && host.disk && (
                      <div className="min-w-0" title={host.disk.path || undefined}>
                        <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">{t("Disk")}</div>
                        <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-fg">{fmtBytes(bytes(disk, host.disk.totalBytes))}<span className="text-dim"> / {fmtBytes(host.disk.totalBytes)}</span></div>
                        <ProgressBar share={disk} cbase={cbaseParts.disk?.share} />
                        {cbaseRow("disk")}
                      </div>
                    )}
                  </div>
                  {/* The legend ONCE in the block, in the colors of the "ok" stage — in yellow and red the same split applies (solid =
                      cbase, lightened = the rest of the occupied part). */}
                  {withCbase && (
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-dim" data-cbase-legend
                      title={t("cbase: all user environments including everything running inside them")}>
                      <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${PROGRESS_BAR.ok}`} />cbase</span>
                      <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${PROGRESS_BAR.ok} ${OTHER}`} />{t("others")}</span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Resources per project — only what is measured. The row beside it says openly how many of the running services are in the sum;
                if NONE is measured, the section still shows, only with "measured: 0 of n services" and without any number. WHETHER it shows is
                decided by the sheet (`resourcesSection`): only with running services — otherwise it would show between two ticks under "No
                services running.". The numbers on the trigger show here once more (`data-services-sum`), so one sees where they come from. */}
            {resourcesSection(n, sum, measurement) && (
              <>
                {host && <div className="mx-2 mt-1 h-px bg-edge" />}
                <div className="flex items-center gap-2 px-2 pb-1 pt-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{t("Resources")}</span>
                  {counts && <span className="text-[10px] font-medium tabular-nums text-dim" data-services-sum>{counts}</span>}
                  {measurement && (
                    <span className="ml-auto text-[10px] text-dim" data-services-measured={`${measurement.measured}/${measurement.total}`}>
                      {t("measured: {x} of {n} services", { x: measurement.measured, n: measurement.total })}
                    </span>
                  )}
                </div>
                {(sum?.projects ?? []).map((r) => {
                  const capacity = ramCapacity(r);
                  const ramRatio = capacity > 0 ? r.memBytes / capacity : 0;
                  return (
                    <div key={r.projectId} className="rounded-xl px-2 py-2 hover:bg-hover" data-resource={r.projectId}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{r.name}</span>
                        <span className="shrink-0 text-[10px] text-dim">{r.containers === 1 ? t("1 container") : t("{n} containers", { n: r.containers })}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-[0.65fr_1.45fr_1fr] gap-2 tabular-nums">
                        <div className="min-w-0">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">CPU</div>
                          <div className="mt-0.5 font-mono text-[11px] text-fg">{r.cpu}%</div>
                        </div>
                        <div className="min-w-0">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-dim">RAM</div>
                          <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-fg">
                            {fmtBytes(r.memBytes)}
                            {capacity > 0 && <span className="text-dim"> / {fmtBytes(capacity)}</span>}
                          </div>
                        </div>
                        <div className="min-w-0" title={t("Project folder size")}>
                          <div className="truncate text-[9px] font-semibold uppercase tracking-wide text-dim">{t("Project files")}</div>
                          <div className="mt-0.5 font-mono text-[11px] text-fg">{fmtBytes(r.diskBytes)}</div>
                        </div>
                      </div>
                      {capacity > 0 && <ProgressBar share={ramRatio} top="mt-2" />}
                    </div>
                  );
                })}
              </>
            )}

            {/* Nothing measured yet (before the first answer, or in the gateway without `/gw/host` and without running services): said
                openly instead of an empty surface. */}
            {!host && !resourcesSection(n, sum, measurement) && (
              <div className="px-2 py-1.5 text-[12px] text-dim">{t("No measurements.")}</div>
            )}
          </div>
        )}
      </span>
      {erase && (
        <CopyDelete
          projectId={erase.projectId}
          projectName={erase.projectName}
          name={erase.i.name}
          onClose={deleteTo}
          onDeleted={(body) => clearAwayAccepted(erase.i, body)}
        />
      )}
    </>
  );
}
