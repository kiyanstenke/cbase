// The pure rules of the services pill. A LEAF module: no imports, no DOM, no React — `web/test/services-status.test.mjs` compiles the file
// with tsc and recomputes it without a browser, and the iOS revision (`mobile/CbaseMobile/Shell/ServicesStatus.swift`, `enum ServicesRules`)
// is bound to exactly these numbers and inputs.
//
// The header carries two statements, and they come from two different sources:
//  · the NUMBERS are the services — sum of CPU/RAM of the scope's measured containers;
//  · the COLOR is the machine — the highest value of RAM, load per core and disk.
// Throwing both together would mean: a full server without services of its own stays green, and a single hungry container colors the
// pill red although the machine has room.
//
// There are TWO entries instead of one pill: Ports (symbol + count of running services, menu: services and forwardings) and Performance
// (symbol + the CPU/RAM counts, color = the machine, menu: resources and machine). The rules here apply unchanged; new are only
// `performanceTone` and the separate tooltips (`tooltipRows`).

// The color thresholds — the same as everywhere in the house (usage rings, bars): above 70 % yellow, above 90 % red. "Above" means
// strictly greater: exactly 0.7 is still ok.
export const MACHINE_WARN = 0.7;
export const MACHINE_DANGER = 0.9;

// A service as `/api/project-services` returns it — only the fields the scope cuts by. The response carries ALL workspaces; the cutting
// happens in the client (`runningInScope`).
export type ServiceInScope = { running: boolean; workspaceId: string | null; projectId: string };

// A running service of the scope (from `/api/project-services`, already filtered to `running`). `container` is empty for services that are
// only checked via a host port — `docker stats` cannot measure those.
export type ServiceRow = {
  id?: number | string;
  projectId: string;
  name: string;
  port: number | null;
  container: string | null;
};

// A row from `/api/project-resources` — per project the sum of its containers.
export type ResourcesRow = {
  projectId: string;
  name: string;
  dockerUp: boolean;
  containers: number;
  cpu: number;
  memBytes: number;
  memLimitBytes: number;
  memLimitShared?: boolean;
  diskBytes: number | null;
  /** ONLY from two instances of the project on (main and at least one copy); otherwise the field is missing. */
  instances?: InstanceResource[];
};

// What the machine reports (backend: `host` in /api/project-resources; gateway: GET /gw/host). Note: the fields are called `available`/`free`
// — the machine reports the FREE amount. Used is what is missing; hence subtraction everywhere.
export type MachineStatus = {
  at: number;
  cpu: { count: number; load1: number; load5: number; load15: number };
  mem: { totalBytes: number; availableBytes: number };
  swap: { totalBytes: number; freeBytes: number } | null;
  disk: { path?: string; totalBytes: number; freeBytes: number } | null;
  /** Only at the gateway (`GET /gw/host`): how much of it cbase occupies (see `CbaseState`). Missing without a gateway. */
  cbase?: CbaseState | null;
};

// cbase's share of the server as the gateway measures it (server/gateway/cbase-share.js): the sum over all user containers including the project
// containers in them — RAM as working set, swap, CPU as cores in use (growth between two measurements), disk from volumes and images. Every
// field can be `null` ("not measured": a freshly started container leaves the CPU open once, the disk only comes after the first background
// measurement) — `null` is never 0.
export type CbaseState = {
  memBytes: number | null;
  cpuCores: number | null;
  swapBytes: number | null;
  diskBytes: number | null;
  at?: number;
  diskAt?: number | null;
};

export type Stage = "ok" | "warn" | "danger";
export type StagesKind = "ram" | "load" | "disk";
export type MachineLevel = { stage: Stage; kind: StagesKind; share: number; occupied?: number; total?: number };

// The three inputs of the stage, in the order in which they win on a tie. Swap does NOT count: a Linux machine pushes cold pages into swap
// even with free RAM, and a full swap next to free RAM is no reason for yellow. Whoever adds a fourth input changes the rule of both
// clients — the guard holds this list against the iOS revision.
export const STAGES_INLETS: readonly StagesKind[] = ["ram", "load", "disk"] as const;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Stage from a share (0…∞). Strictly greater: 0.7 is ok, 0.7001 warn, 0.9 warn, 0.9001 danger. */
export function stageFrom(share: number): Stage {
  return share > MACHINE_DANGER ? "danger" : share > MACHINE_WARN ? "warn" : "ok";
}

// The three shares the stage arises from — exported INDIVIDUALLY because two places need them: `machineLevel` (the dot's color) and the
// machine block in the pill's menu (number and bar per input). Computing them a second time in the block let its load lack the clamp at 0
// — dot and bar next to it could say different things. The iOS revision has the same three functions (`ServicesRules.ramShare` …), and the
// guard (statusBar.test.mjs (b)) recomputes both sides against each other.
// An input without a denominator (0 cores, 0 bytes total, no disk) is `null`, not 0: "not measured" is not "empty".

/** RAM used: (total − available) / total, never below 0 (available > total occurs). */
export function ramShare(host: MachineStatus): number | null {
  const mem = host.mem;
  if (!mem || !finite(mem.totalBytes) || mem.totalBytes <= 0 || !finite(mem.availableBytes)) return null;
  return Math.max(0, mem.totalBytes - mem.availableBytes) / mem.totalBytes;
}

/** Load per core: the last minute's load divided by the cores. Can exceed 1 (more work than cores) — that is the message. */
export function loadShare(host: MachineStatus): number | null {
  const cpu = host.cpu;
  if (!cpu || !finite(cpu.count) || cpu.count <= 0 || !finite(cpu.load1)) return null;
  return Math.max(0, cpu.load1) / cpu.count;
}

/** Disk used: (total − free) / total, never below 0. */
export function diskShare(host: MachineStatus): number | null {
  const disk = host.disk;
  if (!disk || !finite(disk.totalBytes) || disk.totalBytes <= 0 || !finite(disk.freeBytes)) return null;
  return Math.max(0, disk.totalBytes - disk.freeBytes) / disk.totalBytes;
}

/**
 * Swap used — ONLY for the display in the menu. It does NOT count toward the stage (see STAGES_INLETS); it is here so the pill does not
 * compute a raw machine value itself.
 */
export function swapShare(host: MachineStatus): number | null {
  const swap = host.swap;
  if (!swap || !finite(swap.totalBytes) || swap.totalBytes <= 0 || !finite(swap.freeBytes)) return null;
  return Math.max(0, swap.totalBytes - swap.freeBytes) / swap.totalBytes;
}

/**
 * The machine's color (at the Performance entry): the highest value of RAM used, load per core and disk used. No machine value ⇒ `null` —
 * no claim, neutral. An input without a denominator is dropped instead of counting as 0 (see the three shares above).
 */
export function machineLevel(host: MachineStatus | null | undefined): MachineLevel | null {
  if (!host) return null;
  const candidates: { kind: StagesKind; share: number; occupied?: number; total?: number }[] = [];
  const ram = ramShare(host);
  if (ram != null) candidates.push({ kind: "ram", share: ram, occupied: ram * host.mem.totalBytes, total: host.mem.totalBytes });
  const load = loadShare(host);
  if (load != null) candidates.push({ kind: "load", share: load });
  const disk = diskShare(host);
  if (disk != null && host.disk) candidates.push({ kind: "disk", share: disk, occupied: disk * host.disk.totalBytes, total: host.disk.totalBytes });
  if (!candidates.length) return null;
  // On a tie the earlier input wins (order STAGES_INLETS) — only strictly greater displaces.
  let best = candidates[0];
  for (const k of candidates.slice(1)) if (k.share > best.share) best = k;
  return { stage: stageFrom(best.share), ...best };
}

/**
 * The scope's running services: running, belongs to the workspace, and in Coding with an entered project also to that project (`pid` empty ⇒
 * the whole workspace). Without a workspace there is NO scope and thus no services — not "all with `workspaceId: null`", because "none chosen
 * yet" is not "the one without a workspace" (empty is not unknown). The iOS revision cuts the same way (`running` in the
 * ServicesStatusModel, there with a real XCUITest: 2 in the project, 3 in the workspace).
 */
export function runningInScope<T extends ServiceInScope>(services: readonly T[] | null | undefined,
  ws: string | null | undefined, pid: string | null | undefined): T[] {
  if (!ws) return [];
  return (services ?? []).filter((d) => d.running && d.workspaceId === ws && (!pid || d.projectId === pid));
}

/** A resources row counts if at least one container runs in its project. */
export const counts = (r: ResourcesRow): boolean => finite(r.containers) && r.containers > 0;

/**
 * The numbers at the trigger: sum of CPU and RAM over the counting rows (CPU to one decimal place). `projects` are the counting rows
 * themselves (the menu breaks them down). No counting row ⇒ `null`, and the pill shows NO numbers — never "0 % · 0 B", that would mean
 * "measured and empty".
 */
export function servicesSum(resources: readonly ResourcesRow[] | null | undefined):
  { cpu: number; memBytes: number; projects: ResourcesRow[] } | null {
  const projects = (resources ?? []).filter(counts);
  if (!projects.length) return null;
  const cpu = Math.round(projects.reduce((s, r) => s + (finite(r.cpu) ? r.cpu : 0), 0) * 10) / 10;
  const memBytes = projects.reduce((s, r) => s + (finite(r.memBytes) ? r.memBytes : 0), 0);
  return { cpu, memBytes, projects };
}

/**
 * "measured: x of n": `total` are the passed running services of the scope, `measured` of those the ones that carry a container AND whose
 * project has a counting resources row. A service without a container (host port only) is never measured — its load is not in the sum, and
 * the row should say so openly.
 */
export function measured(services: readonly ServiceRow[], resources: readonly ResourcesRow[] | null | undefined):
  { measured: number; total: number } {
  const withMeasurement = new Set((resources ?? []).filter(counts).map((r) => r.projectId));
  const x = services.filter((d) => !!(d.container && d.container.trim()) && withMeasurement.has(d.projectId)).length;
  return { measured: x, total: services.length };
}

/**
 * Is the row "measured: x of n services" in the menu? As soon as NOT all running services are in the sum, EVEN if none is measured.
 * Otherwise the menu would stay silent entirely without any measurement, and "3 services running" without numbers could not be told from
 * "3 services, nothing going on". The row then says "0 of 3" and NO numbers — never "0 % · 0 B". Before the first answer of the
 * resources query (`loaded` false) it does not appear: "0 of 3 measured" would be a statement about a measurement nobody has made yet.
 */
export function measureRow(sample: { measured: number; total: number }, loaded: boolean):
  { measured: number; total: number } | null {
  if (!loaded || sample.total <= 0 || sample.measured >= sample.total) return null;
  return sample;
}

/**
 * Is the "Resources" section in the menu? Only if services are RUNNING in the scope, and then as soon as there is a sum or a `measureRow`.
 * The same count as at the trigger (`triggerContent`), for the same reason: services (web 30 s, iOS 20 s) and resources (web 15 s, iOS in
 * the same beat but as a second query) arrive separately. After a container starts, the resources reported it before the services, and the
 * menu showed CPU/RAM per project with the sum under "No services running." — while the trigger was already bound to the count. Without
 * running services `measureRow` is `null` anyway (total 0); it was only about the sum. The guard (statusBar.test.mjs (f5)) recomputes
 * the iOS revision (`ServicesRules.resourcesSection`) against this on a grid.
 */
export function resourcesSection(count: number, sum: { cpu: number; memBytes: number } | null,
  measurement: { measured: number; total: number } | null): boolean {
  return count > 0 && (sum != null || measurement != null);
}

/**
 * The Performance entry's tone. The dot of the old single pill carried the machine's color (grey without services, accent from one on,
 * warn/danger always). Since Ports and Performance are two entries, the color belongs to the entry that shows the machine — and there
 * ONLY the machine colors: warn/danger, otherwise neutral. No color as a permanent state, no accent for "services are running" either
 * (the number at the Ports entry says that). The number of services deliberately no longer enters — "warn/danger even with 0 services"
 * holds by itself. The iOS revision (`performanceColor` in ServicesButton.swift) is bound (statusBar.test.mjs (e)).
 */
export function performanceTone(stage: MachineLevel | null): "neutral" | "warn" | "danger" {
  if (stage?.stage === "danger") return "danger";
  if (stage?.stage === "warn") return "warn";
  return "neutral";
}

// Byte format for menu and trigger — the version WITH a null branch from the old ResourcesPill ("—" for "not measured", e.g. project files
// without `du`).
export const fmtBytes = (n: number | null) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

/** The numbers text at the trigger: "12.5 % · 1.4 GB". Without a sum there is no text. */
export function sumText(sum: { cpu: number; memBytes: number } | null): string | null {
  return sum ? `${sum.cpu} % · ${fmtBytes(sum.memBytes)}` : null;
}

/**
 * What stands at the trigger: from one running service on the count and — if measured — the CPU/RAM numbers; with 0 services NO count and
 * NO CPU/RAM numbers, the pill muted. Both hang on the same count, and that is the point: the pill asks services (30 s) and resources
 * (15 s) in two beats. After a container starts, the resources reported it up to 30 s before the services, and the trigger showed
 * "● · 3 % · 210 MB" next to the tooltip "No services running". `count` is `null`, not 0: "0" would stand at the trigger. The parts stand at
 * two entries: `count` and `muted` at the Ports entry, `counts` at the Performance entry — both from the SAME count, so that next to "No
 * services" at one there is no service load at the other.
 */
export function triggerContent(count: number, sum: { cpu: number; memBytes: number } | null):
  { count: number | null; counts: string | null; muted: boolean } {
  const running = finite(count) && count > 0;
  return { count: running ? count : null, counts: running ? sumText(sum) : null, muted: !running };
}

// The pill passes the translation in (`useT`) — the leaf module imports nothing.
export type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * The second tooltip row: the reason for the color — which input determines the stage and with what value, e.g. "Machine: RAM 92 % in use
 * (15 GB / 16 GB)". For `warn`/`danger` this is the ONLY place that says WHY the dot is yellow or red; for `ok` it appears too (the stage
 * together with the determining value). Without a machine value no row — no claim.
 */
export function machineRow(stage: MachineLevel | null, t: Translator): string {
  if (!stage) return "";
  const pct = Math.round(Math.max(0, stage.share) * 100);
  const occupied = fmtBytes(stage.occupied ?? null);
  const total = fmtBytes(stage.total ?? null);
  if (stage.kind === "ram") return t("Machine: RAM {pct}% in use ({occupied} / {total})", { pct, occupied: occupied, total: total });
  if (stage.kind === "load") return t("Machine: load {pct}% per core", { pct });
  return t("Machine: disk {pct}% in use ({occupied} / {total})", { pct, occupied: occupied, total: total });
}

/**
 * The tooltips of the two entries. Each entry carries only what its menu shows:
 * · Ports (`ports`): count and scope (`row1`, also the `aria-label`), then the forwardings (desktop client only, `row3`);
 * · Performance (`performance`): "Performance · scope" (`performanceRow`, also the `aria-label`), then the reason for the color
 *   (`row2`) — for warn/danger the ONLY place that says WHY the symbol is yellow or red.
 */
export function tooltipRows(p: { count: number; scopeName: string; stage: MachineLevel | null; forwarded: number },
  t: Translator): { row1: string; row2: string; row3: string; performanceRow: string; ports: string; performance: string } {
  const n = p.count;
  const scope = p.scopeName ? ` · ${p.scopeName}` : "";
  const row1 = (n === 1 ? t("1 service running") : n > 0 ? t("{n} services running", { n }) : t("No services running")) + scope;
  const row2 = machineRow(p.stage, t);
  const row3 = p.forwarded > 0 ? t("{n} port(s) forwarded", { n: p.forwarded }) : "";
  const performanceRow = t("Performance") + scope;
  return {
    row1, row2, row3, performanceRow,
    ports: [row1, row3].filter(Boolean).join("\n"),
    performance: [performanceRow, row2].filter(Boolean).join("\n"),
  };
}

// ── cbase's share of the server ─────────────────────────────────────────────────────────────────────────────────────────────
// At the top of the performance overview the server should be shown, including how much of the server's resources cbase claims (the bar
// can be colored differently for the part cbase claims, per category CPU, RAM, etc.). Per bar of the machine block (RAM, CPU, swap, disk)
// one part: from the left cbase, behind it the rest of what is used. The computation lives HERE and only here (the pill computes nothing,
// iOS is bound — web/test/cbase-share-binding.test.mjs runs both):
// · the part is a share OF THE WHOLE (like the bar): value / total — RAM/swap/disk in bytes, the CPU as cbase's cores divided by the
//   machine's cores (the same scale as the load per core above);
// · CLAMPED to what the bar has used: cbase cannot occupy more than is used. The measurements differ (working set against MemAvailable,
//   CPU window against load average) — without the clamp cbase's part would stand beyond the end of the bar. The number next to it
//   (`value`) stays the measured one;
// · no part (`null`) without a machine share (no denominator), without a cbase state (local, old gateway) or with a field `null` (not
//   measured) — then the bar is one-part as before and no cbase text stands. 0 is a part.
export type CbaseKind = "ram" | "load" | "swap" | "disk";
export const CBASE_KINDS: readonly CbaseKind[] = ["ram", "load", "swap", "disk"] as const;
export type CbasePart = { share: number; value: number };

export function cbasePart(host: MachineStatus | null | undefined, kind: CbaseKind): CbasePart | null {
  const h = host?.cbase;
  if (!host || !h) return null;
  const [occupied, value, total] =
    kind === "ram" ? [ramShare(host), h.memBytes, host.mem?.totalBytes]
      : kind === "load" ? [loadShare(host), h.cpuCores, host.cpu?.count]
        : kind === "swap" ? [swapShare(host), h.swapBytes, host.swap?.totalBytes]
          : [diskShare(host), h.diskBytes, host.disk?.totalBytes];
  if (occupied == null || !finite(value) || value < 0 || !finite(total) || total <= 0) return null;
  return { share: Math.min(occupied, value / total), value };
}

/**
 * The geometry of a bar: `width` = what is used in % of the track (capped at 100 — the load can exceed it, the number says so), inside it
 * `cbase` = cbase's part in % OF WHAT IS USED (so the ratio stays right even above 100 % load). Without a cbase part `null` — the bar
 * stays one-part.
 */
export function progressBarParts(share: number, cbase: number | null | undefined): { width: number; cbase: number | null } {
  const a = finite(share) ? Math.max(0, share) : 0;
  const width = Math.min(100, a * 100);
  if (cbase == null || !finite(cbase)) return { width, cbase: null };
  return { width, cbase: a > 0 ? Math.min(100, (Math.max(0, cbase) / a) * 100) : 0 };
}

/** The value behind "cbase …": bytes for RAM/swap/disk, for the CPU percent of the cores (like the load above, "15%"). */
export function cbaseValueText(host: MachineStatus, kind: CbaseKind, part: CbasePart): string {
  if (kind === "load") return `${Math.round((part.value / host.cpu.count) * 100)}%`;
  return fmtBytes(part.value);
}

// Old backends added the same shared Docker RAM limit once PER container. New backends mark the already corrected value with memLimitShared.
// So the client stays backward compatible during a rolling deployment and never shows 11× RAM again.
export const ramCapacity = (r: ResourcesRow) => {
  if (r.memLimitBytes <= 0) return 0;
  if (r.memLimitShared || r.containers <= 1) return r.memLimitBytes;
  return Math.round(r.memLimitBytes / r.containers);
};

// ── Forwarding per instance ─────────────────────────────────────────────────────────────────────────────────────────────────
// A converted project listens in its project container, and two projects there both quite normally listen on 3000 (back to the compose
// defaults). The desktop client therefore forwards per (instance, port) (client/forwarding-rules.js), and the UI must know which
// instance a service has. It stands at `GET /api/projects` (field `instance` of a project with a main instance, projectbox/names.js
// projectInstanceField) — a forwarding goes only to a CONVERTED instance (a project in the middle of the relocation still lives in B).
// The instance is the identifier "<projectId>/<instance>", `null` means: no instance (B, or a client that does not know it). There is no
// "in the project container" marker. The choice of the project used to stand ONLY at a conflict on the Mac ("Switch" at the service
// row); since then the exclusive selection (section below).

// A project as `GET /api/projects` returns it — only the fields read here. `copies` stands only if the project has copies;
// `workspaceId` is delivered by every server since the global project list. `state` of a copy is the state of its instance row
// (projectbox/names.js projectInstanceField: create · start · ready · … · remove · error) — the pill's selection reads it, because a
// copy under construction is still missing in the resources. `name` there is the DNS name, not the copy's name — that comes from the
// identifier (`copyResource`).
export type ProjectWithInstance = {
  id: string; name?: string; workspaceId?: string | null;
  instance?: { identifier?: string; converted?: boolean; copies?: { identifier?: string; chatId?: string; state?: string | null }[] } | null;
};
// A forwarding of the desktop client (`cbaseClient.ports.list`). `instance` is missing with a client from before instance support — that is
// the same forwarding as `null`. `source` "selection" carries a forwarding of the exclusive selection; a missing field means "by hand"
// (an older client does not send it).
export type Forwarding = { port: number; localPort: number; connections: number; source?: "manual" | "browser" | "selection"; instance?: string | null };

/** A forwarding's key — the same as in the client (`forwardKey`): "<instance>:<port>", without an instance ":<port>". */
export const forwardingKey = (instance: string | null | undefined, port: number): string => `${instance ?? ""}:${port}`;

/**
 * Project id → identifier of its main instance, only for CONVERTED projects. `null` without an answer — "not loaded" is not "no project
 * converted", and whoever builds on it computes until the answer as before instance support (everything without an instance).
 */
export function instancePerProject(projects: readonly ProjectWithInstance[] | null | undefined): Map<string, string> | null {
  if (!Array.isArray(projects)) return null;
  const m = new Map<string, string>();
  for (const p of projects) if (p?.instance?.converted && p.instance.identifier) m.set(String(p.id), p.instance.identifier);
  return m;
}

/** The name of the project of an identifier (for "occupied by …") — `null` if none carries it. */
export function projectOfTheInstance(projects: readonly ProjectWithInstance[] | null | undefined, identifier: string | null | undefined): string | null {
  if (!identifier || !Array.isArray(projects)) return null;
  return projects.find((p) => p?.instance?.identifier === identifier)?.name || null;
}

/**
 * The instance a project's service is forwarded to. Without instance support in the client (`canInstance` false: an older client does not
 * know the parameter) and before the answer of `/api/projects` always `null` — the pill then behaves as before, by port.
 */
export function serviceInstance(instances: Map<string, string> | null, projectId: string, canInstance: boolean): string | null {
  if (!canInstance || !instances) return null;
  return instances.get(String(projectId)) ?? null;
}

/**
 * Who owns a forwarding WITHOUT an instance on `port`? It goes by the old client's rule (server/backend/electron/server/tunnel.js
 * tunnelTarget: B if B holds the port, otherwise the ONE instance that holds it). All projects are relocated, and every remembered forwarding
 * from before instance support carries `instance: null` — without this assignment a service's own forwarding would read "occupied by another
 * project". Computed on the claims of the RUNNING services of all workspaces: a project in B on the port ⇒ `b`; exactly one converted ⇒
 * `instance`; two or none ⇒ `without` (the tunnel ends in B where nobody listens — honestly "without a project", not "another project").
 * `null`: the projects are not loaded yet ("empty is not unknown").
 */
export type NullTarget = { kind: "b" } | { kind: "instance"; instance: string } | { kind: "without" };
export function nullForwardingTarget(services: readonly { projectId: string; port: number | null; running?: boolean }[],
  instances: Map<string, string> | null, port: number): NullTarget | null {
  if (!instances) return null;
  let b = false;
  const inst = new Set<string>();
  for (const d of services) {
    if (d.running === false || d.port !== port) continue;
    const k = instances.get(String(d.projectId));
    if (k) inst.add(k);
    else b = true;
  }
  if (b) return { kind: "b" };
  if (inst.size === 1) return { kind: "instance", instance: [...inst][0] };
  return { kind: "without" };
}

/**
 * Every forwarding with the instance that owns it: its own, or for one without an instance the one from `nullForwardingTarget` — only if
 * the instance does not already have its own there. `withoutProject`: a forwarding without an instance that cannot be assigned to any
 * project (several or none) — the conflict row names it so. Without loaded projects everything stays as it is.
 */
export type AssignedForwarding<F extends Forwarding> = { f: F; instance: string | null; withoutProject: boolean };
export function assignForwardings<F extends Forwarding>(forwards: readonly F[],
  services: readonly { projectId: string; port: number | null; running?: boolean }[], instances: Map<string, string> | null): AssignedForwarding<F>[] {
  const real = new Set(forwards.filter((f) => f.instance).map((f) => forwardingKey(f.instance, f.port)));
  return forwards.map((f) => {
    if (f.instance || !instances) return { f, instance: f.instance ?? null, withoutProject: false };
    const z = nullForwardingTarget(services, instances, f.port);
    if (z?.kind === "instance" && !real.has(forwardingKey(z.instance, f.port))) return { f, instance: z.instance, withoutProject: false };
    return { f, instance: null, withoutProject: z?.kind !== "b" };
  });
}

/** The forwardings without an instance that the client should lift onto their instance (`cbaseClient.ports.lift`). */
export function forwardingsToLift<F extends Forwarding>(assigned: readonly AssignedForwarding<F>[]): { port: number; instance: string }[] {
  return assigned.filter((z) => !z.f.instance && z.instance).map((z) => ({ port: z.f.port, instance: z.instance as string }));
}

// The conflict on the Mac (`macConflict`) and `portsOfTheProject` are gone with the exclusive selection: there is no "Switch" button at the
// service row any more. The assignment above (`assignForwardings`, lifting) stays for a client that does not know the selection yet.

/**
 * The port list of the Apps page per namespace. `/api/ports/running` reports B AND every instance, each entry with `instance` — the same
 * port can appear twice in it (B and a project container), and one row per port would merge both: B's service counted as "running" because
 * a project container listened on the same port. A row is therefore (namespace, port): a service belongs in the namespace of its project
 * (`instances`, `null` = B), an open port in the one the scan names. `instances` null (no answer yet) puts everything in B — the list from
 * before instances. `conflictPorts` are the server's conflicts (store.portConflicts, without converted projects) and apply only in B.
 * `open` null: no scan yet (`open: null`).
 */
export type PortRow<D, O, B> = {
  key: string; port: number; instance: string | null; claims: D[]; conflict: boolean; open: boolean | null; info: O | null; unreg: B | null;
};
export function portRows<
  D extends { projectId: string; port: number | null },
  O extends { port: number; instance?: string | null },
  B extends { kind: string; port: number; instance?: string | null },
>(p: { services: readonly D[]; open: readonly O[] | null; findings?: readonly B[] | null; instances: Map<string, string> | null; conflictPorts: ReadonlySet<number> }): PortRow<D, O, B>[] {
  const space = (i: string | null | undefined) => (p.instances ? (i ?? null) : null);
  const rows = new Map<string, PortRow<D, O, B>>();
  const row = (instance: string | null, port: number) => {
    const k = forwardingKey(instance, port);
    let z = rows.get(k);
    if (!z) {
      z = { key: k, port, instance, claims: [], conflict: instance === null && p.conflictPorts.has(port), open: p.open ? false : null, info: null, unreg: null };
      rows.set(k, z);
    }
    return z;
  };
  for (const d of p.services) if (d.port != null) row(space(p.instances?.get(String(d.projectId))), d.port).claims.push(d);
  for (const o of p.open ?? []) {
    const z = row(space(o.instance), o.port);
    z.open = true;
    z.info = o;
  }
  for (const b of p.findings ?? []) {
    if (b.kind !== "unregistered") continue;
    const z = rows.get(forwardingKey(space(b.instance), b.port));
    if (z) z.unreg = b;
  }
  return [...rows.values()].sort((a, b) => a.port - b.port || (a.instance ?? "").localeCompare(b.instance ?? ""));
}

// ── Instances per project ───────────────────────────────────────────────────────────────────────────────────────────────────
// A project with copies has several instances: the main one and one per copy. The server names them ONLY from two instances on — at
// `GET /api/project-resources` per project `instances: [{ identifier, name, dnsName, chatId, chatTitle, state, cpu, memBytes, containers }]`,
// at `GET /api/project-services` per service `instances: [{ identifier, running, holdsStart }]` (server/backend/electron/server/projects/instance-fields.js).
// With one instance both fields are missing, and the pill shows nothing new: a group from one instance on would be a box around the main
// one alone. No path here falls back to the main instance — selecting and removing work only with the identifier that is meant.
// Since the exclusive selection the group shows only where the selection is missing (web without the bridge, a client before the
// selection): instances with "Remove", without "Switch" — in the client the copies stand as rows of their own in the selection.
export type InstanceResource = {
  identifier: string; name: string; dnsName?: string; chatId?: string; chatTitle?: string; state?: string; cpu?: number; memBytes?: number;
  /** The instance's running containers; the Apps page reads "running" from it. Missing with older servers. */
  containers?: number;
};
/** A service's state in an instance (`instances` of a row of `/api/project-services`). `holdsStart`: the start guard of THIS instance
 *  (a living group does not listen on the port) — only next to `running: false`, missing with older servers. */
export type InstanceStatus = { identifier: string; running: boolean; holdsStart?: boolean };
export type InstanceGroup = { projectId: string; name: string; instances: InstanceResource[] };

/** The name of the main instance in `name` of the instance fields. */
export const MAIN_NAME = "main";

/** Groups per project — only projects with AT LEAST TWO instances; a project with one or without data gets none. */
export function instanceGroups(resources: readonly ResourcesRow[] | null | undefined): InstanceGroup[] {
  const out: InstanceGroup[] = [];
  for (const r of resources ?? []) {
    const l = Array.isArray(r?.instances) ? r.instances.filter((i) => i && typeof i.identifier === "string" && i.identifier) : [];
    if (l.length >= 2) out.push({ projectId: r.projectId, name: r.name, instances: l });
  }
  return out;
}

/** "Main" or "k1 (Chat X)" — the copy with its chat's title, without a title only with its name. */
export function instanceDesignation(i: InstanceResource, t: Translator): string {
  if (i.name === MAIN_NAME) return t("Main");
  const name = i.name || i.identifier.slice(i.identifier.lastIndexOf("/") + 1);
  return i.chatTitle ? `${name} (${i.chatTitle})` : name;
}

/** The group's heading: "Main · k1 (Chat X)". */
export function groupsTitle(g: InstanceGroup, t: Translator): string {
  return g.instances.map((i) => instanceDesignation(i, t)).join(" · ");
}

/** How many of the project's services run in this instance (`instances` of the service rows; a row without data does not count). */
export function runningPerInstance(services: readonly { projectId: string; running?: boolean; instances?: readonly InstanceStatus[] }[],
  projectId: string, identifier: string): number {
  return services.filter((d) => d.projectId === projectId && d.instances?.some((s) => s.identifier === identifier && s.running === true)).length;
}

/**
 * A service's state in the CHOSEN instance of the Apps page (with several containers one can choose in which to look at the running
 * processes, and control them accordingly). The main instance reads the row's fields (`running`, `holdsStart`), a copy its entry in
 * `instances`. If the field or the entry is missing (older server, copy only just ready), the state is `running: null` — unknown, never
 * "stopped" (empty is not unknown). `holds` only next to a non-running service. Pure. The pill's service list (`choiceServices`) computes
 * through this as well — otherwise it set false there and offered "Start" to a copy without an entry or with a start guard.
 */
export function serviceInInstance(d: { running?: boolean; holdsStart?: boolean; instances?: readonly InstanceStatus[] },
  identifier: string | null | undefined, isMain: boolean): { running: boolean | null; holds: boolean } {
  if (isMain) {
    const running = d.running === true;
    return { running, holds: !running && d.holdsStart === true };
  }
  const state = identifier && Array.isArray(d.instances) ? d.instances.find((s) => s?.identifier === identifier) : undefined;
  if (!state || typeof state.running !== "boolean") return { running: null, holds: false };
  return { running: state.running, holds: !state.running && state.holdsStart === true };
}

// `switchPorts`, `occupiedByText`, `activeIdentifier` and `switchable` (switching the group) are gone with the exclusive selection: its
// ports are computed by `instancePorts` per INSTANCE, an instance's name by `instanceTitle`; which one is active is known by the client
// (`cbaseClient.ports.active`), not derived from its forwardings.

/** Is this a copy? Name and identifier must fit together (`<project>/copy-<name>`), the main instance never is one. The name rule of
 *  the `DELETE` (`clearAwayPath`) — independent of the state, so the route can say what happens to a copy being cleared away. */
const isCopy = (i: InstanceResource): boolean => !!i.name && i.name !== MAIN_NAME && i.identifier.endsWith(`/copy-${i.name}`);

/**
 * Does the UI offer "Remove"? Only for a copy, never the main instance — and not while it is already being cleared away (state
 * `clearAway`): there the button used to stay, and a second click got the same question and an "accepted" although the clearing was long
 * running. In its place stands "being removed" (`getsClearedAway`). `error` stays clearable (a failed clearing needs a new call), as does
 * `ready` (also "earmarked": the instance row stays ready) and a MISSING state — an older server or a copy known only from its
 * identifier: empty is not "clearAway".
 */
export const clearable = (i: InstanceResource): boolean => isCopy(i) && i.state !== "clearAway";

/** Is this copy being cleared away right now? Then "being removed" stands instead of the button. */
export const getsClearedAway = (i: InstanceResource | null | undefined): boolean => !!i && isCopy(i) && i.state === "clearAway";

/** The path of a copy's `DELETE`; `null` for the main instance and anything that is no copy — then NO call goes out. */
export function clearAwayPath(projectId: string, i: InstanceResource): string | null {
  if (!isCopy(i) || !projectId) return null;
  return `/api/projects/${encodeURIComponent(projectId)}/stack-copies/${encodeURIComponent(i.name)}`;
}

/**
 * The question before removing — the same wording in pill and Apps page. It is not "your changes that are not yet in the main instance are
 * lost", because that is wrong: removing fetches every commit and saves open work as a commit under `copy/<name>/…` into the main instance.
 * Lost are only the data in the copy's cloned Docker volumes and its ignored files (fetched back only on request; the pill sends no
 * `reclaim` — they are in the report). The iOS twin is `ServicesRules.removeNotice` (ServicesStatus.swift).
 */
export function clearAwayQuestion(i: InstanceResource, projectName: string, t: Translator): string {
  return t("Remove copy {copy} of {project}? Commits and open changes are kept in the main instance under copy/{name}/…. Lost are the data in the copy's Docker volumes and its ignored files (e.g. .env, build output) — only the report lists them.",
    { copy: instanceDesignation(i, t), project: projectName, name: i.name });
}

/** What the menu says after the `DELETE`: 202 means "accepted" (runs as soon as the copy is idle), any other status the server's error. */
export function clearAwayResult(status: number, body: unknown, i: InstanceResource, t: Translator): { ok: boolean; text: string } {
  const designation = instanceDesignation(i, t);
  if (status === 202) return { ok: true, text: t("Removal of {copy} accepted — it runs as soon as the copy is idle.", { copy: designation }) };
  const reason = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  if (status === 404) return { ok: false, text: t("{copy} no longer exists.", { copy: designation }) };
  return { ok: false, text: reason ? t("Removal of {copy} refused: {reason}", { copy: designation, reason: reason }) : t("Removal of {copy} failed ({status}).", { copy: designation, status }) };
}

/** An instance's numbers as tooltip text: "3,2 % · 120 MB"; empty without numbers. */
export function instanceMeasurement(i: InstanceResource): string {
  if (!finite(i.cpu) && !finite(i.memBytes)) return "";
  return `${finite(i.cpu) ? `${i.cpu} %` : "—"} · ${fmtBytes(finite(i.memBytes) ? i.memBytes : null)}`;
}

// ── Exclusive selection: which instance forwards the ports ────────────────────────────────────────────────────────────────────
// A radio button under the services pill where one activates which project forwards the ports now, and below it the activated project's
// forwarded ports are shown. Replaces "switch only on conflict". Exactly ONE instance (main or copy) or "none" forwards; the choice is held
// by the Mac client (client-settings.json `activeInstance`, `cbaseClient.ports.active`), the plan is in client/forwarding-rules.js
// (`switchPlan` with `mode`). What the pill SHOWS of it stands here, and which ports it names to the client: the selection list, an
// instance's ports, the fallback of a vanished choice, the active instance's rows and what is to be caught up. iOS has no forwarding and
// mirrors none of this.

const MAIN_SUFFIX = `/${MAIN_NAME}`;
const COPY_PREFIX = "copy-";
/** The project of an identifier "<projectId>/<instance>" — the server splits at the LAST slash (net-targets.js identifierParts). */
export function projectOfTheIdentifier(identifier: string | null | undefined): string | null {
  if (typeof identifier !== "string") return null;
  const i = identifier.lastIndexOf("/");
  return i > 0 && i < identifier.length - 1 ? identifier.slice(0, i) : null;
}
const isMain = (identifier: string) => identifier.endsWith(MAIN_SUFFIX) && projectOfTheIdentifier(identifier) !== null;

/**
 * The copy behind an identifier "<project>/copy-<name>" as an instance of the group (for designation and removal): from the scope's
 * resources if it stands there (then with chat title), otherwise only with its name. `null` for anything that is no copy — the main
 * instance cannot be removed (`clearable`). `state` (from `instance.copies` at `/api/projects`) applies where the resources name none: a copy
 * under construction is not there yet (projectbox/services.js takes only converted ones), and without it it would read like a ready one
 * in the selection. A state from the resources takes precedence (they arrive every 15 s).
 */
export function copyResource(identifier: string | null | undefined, groups: readonly InstanceGroup[] | null | undefined,
  state?: string | null): InstanceResource | null {
  const pid = projectOfTheIdentifier(identifier);
  if (!pid || !identifier) return null;
  const rest = identifier.slice(pid.length + 1);
  if (!rest.startsWith(COPY_PREFIX) || rest.length === COPY_PREFIX.length) return null;
  for (const g of groups ?? []) {
    const i = g.instances.find((x) => x.identifier === identifier);
    if (i) return i.state || !state ? i : { ...i, state };
  }
  return { identifier, name: rest.slice(COPY_PREFIX.length), ...(state ? { state } : {}) };
}

/**
 * The state of a copy that is NOT ready (`create`, `start`, `clearAway`, `error`, …) — `null` for a ready copy, for the main instance (`null` as
 * argument) and for a missing state: unknown is not "not ready" (an older server does not name it, and the pill would stay mute there). For
 * such a copy the pill shows the state word at the radio row and a sentence instead of its services — a ▶ there would end in 409
 * COPY_NOT_READY.
 */
export function copyNotReady(i: InstanceResource | null | undefined): string | null {
  const z = i?.state;
  return typeof z === "string" && z !== "" && z !== "ready" ? z : null;
}

/**
 * An instance's name for humans: the main instance is named like its project, a copy "<project> · k1 (Chat X)" (the chat title from the
 * group if the resources know it). `null` if no known project carries the identifier — a caller then says what it knows (the raw
 * identifier) instead of claiming "another project". The copy is called "k3", not "copy-k3".
 */
export function instanceTitle(identifier: string | null | undefined, projects: readonly ProjectWithInstance[] | null | undefined,
  groups: readonly InstanceGroup[] | null | undefined, t: Translator): string | null {
  if (!identifier) return null;
  const main = projectOfTheInstance(projects, identifier);
  if (main) return main;
  for (const g of groups ?? []) {
    const i = g.instances.find((x) => x.identifier === identifier);
    if (i) return `${g.name} · ${instanceDesignation(i, t)}`;
  }
  const pid = projectOfTheIdentifier(identifier);
  const project = pid ? (projects ?? []).find((p) => String(p?.id) === pid) : undefined;
  if (!project?.name) return null;
  const k = copyResource(identifier, null);
  return `${project.name} · ${k ? instanceDesignation(k, t) : identifier.slice(identifier.lastIndexOf("/") + 1)}`;
}

/** A service as `/api/project-services` returns it — only the selection's fields. */
export type SelectionService = {
  projectId: string; workspaceId?: string | null; name?: string; port: number | null; running?: boolean; instances?: readonly InstanceStatus[];
};

/**
 * The ports bound when choosing an instance (and that catching up adds): the project's registered port services that run in THIS
 * instance. The state per instance stands at `instances` (from two instances on); without it `running` is the state of the MAIN
 * instance (`/api/project-services` checks without an instance) — for a copy missing means "not running". The lesson stays: a service that
 * runs only in the copy belongs to the copy's ports, even if `running` (main) is false.
 */
export function instancePorts(services: readonly SelectionService[] | null | undefined, identifier: string | null | undefined): number[] {
  const pid = projectOfTheIdentifier(identifier);
  if (!pid || !identifier) return [];
  const main = isMain(identifier);
  const ports = new Set<number>();
  for (const d of services ?? []) {
    if (String(d.projectId) !== pid || d.port == null) continue;
    const state = Array.isArray(d.instances) ? d.instances.find((s) => s.identifier === identifier) : undefined;
    if (state ? state.running === true : main && d.running === true) ports.add(d.port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** A row of the selection: a project's main instance or one of its copies (indented below). */
export type ChoiceRow = {
  identifier: string; projectId: string; kind: "main" | "copy"; projectName: string;
  /** Copy only: designation ("k1 (Chat X)") and removal. */
  copy: InstanceResource | null;
  /** The ports of its running services — those bound when chosen. */
  ports: number[];
  /** At least one registered port service runs in THIS instance ("running marked"). */
  running: boolean;
  /** The active instance from ANOTHER workspace: stands only so the choice stays visible. Computed from the project's workspace — never
   * from the row otherwise missing; an unknown workspace is not "another" one. */
  foreign: boolean;
};

/**
 * The selection list in the active workspace `ws`: every CONVERTED project that has registered port services (or copies — so their removal
 * stays reachable), with its main instance and below it every living copy (`instance.copies` at `/api/projects`). The project of the ACTIVE
 * instance always stands in its workspace, even without both (the copy removed and the choice fallen back to the main instance, or the port
 * services gone on rescanning) — otherwise it would slip to the end and read "other workspace". "None" is not in it — the pill puts it in
 * front. If the active instance lies outside `ws`, it additionally stands at the end (`foreign`), otherwise no row would be chosen and the list
 * would lie. A project that has not relocated yet is missing: it has no instance one could choose (its ports go by hand). `null` while
 * services or projects are not loaded — "not loaded yet" is not "no projects".
 */
export function choiceRows(p: { services: readonly SelectionService[] | null | undefined; projects: readonly ProjectWithInstance[] | null | undefined;
  ws: string | null | undefined; active: string | null | undefined; groups?: readonly InstanceGroup[] | null }): ChoiceRow[] | null {
  if (!p.services || !p.projects) return null;
  const services = p.services;
  const withPort = new Set(services.filter((d) => d.port != null).map((d) => String(d.projectId)));
  const wsOf = (pr: ProjectWithInstance) => pr.workspaceId ?? services.find((d) => String(d.projectId) === String(pr.id))?.workspaceId ?? null;
  const rowsOf = (pr: ProjectWithInstance, foreign: boolean): ChoiceRow[] => {
    const main = pr.instance?.identifier;
    if (!pr.instance?.converted || !main) return [];
    const projectName = pr.name || String(pr.id);
    const out: ChoiceRow[] = [];
    const row = (identifier: string, kind: "main" | "copy", copy: InstanceResource | null) => {
      const ports = instancePorts(services, identifier);
      out.push({ identifier, projectId: String(pr.id), kind, projectName, copy, ports, running: ports.length > 0, foreign });
    };
    row(main, "main", null);
    for (const k of pr.instance.copies ?? []) {
      const copy = copyResource(k?.identifier, p.groups, k?.state);
      if (copy && projectOfTheIdentifier(copy.identifier) === String(pr.id)) row(copy.identifier, "copy", copy);
    }
    return out;
  };
  const out: ChoiceRow[] = [];
  const activeProject = projectOfTheIdentifier(p.active);
  if (p.ws) {
    for (const pr of p.projects) {
      if (!pr || wsOf(pr) !== p.ws) continue;
      if (!withPort.has(String(pr.id)) && !(pr.instance?.copies?.length) && String(pr.id) !== activeProject) continue;
      out.push(...rowsOf(pr, false));
    }
  }
  if (p.active && !out.some((z) => z.identifier === p.active)) {
    const pr = p.projects.find((x) => String(x?.id) === activeProject);
    const ws = pr ? wsOf(pr) : null;
    if (pr) out.push(...rowsOf(pr, ws !== null && ws !== (p.ws ?? null)).filter((z) => z.identifier === p.active));
  }
  return out;
}

/**
 * Does the active instance still exist? Computed on `/api/projects` (all projects, per project main instance and `copies`):
 *  - "stays": no choice, the projects are not loaded yet, or the instance stands there (main instance or living copy) — and likewise if the
 *    project is there but without instance data (a server without an operation mark: do not guess);
 *  - "main": the copy is removed — the choice falls back to its project's main instance (like the fallback in client/main.js, which only
 *    takes effect at the next failed tunnel; here immediately, even without a connection);
 *  - "no": the project is deleted.
 */
export type ActiveSituation = { kind: "stays" } | { kind: "main"; identifier: string } | { kind: "no" };
export function activeBySituation(active: string | null | undefined, projects: readonly ProjectWithInstance[] | null | undefined): ActiveSituation {
  if (!active || !projects) return { kind: "stays" };
  const pid = projectOfTheIdentifier(active);
  const pr = pid ? projects.find((x) => String(x?.id) === pid) : undefined;
  if (!pr) return { kind: "no" };
  const inst = pr.instance;
  if (!inst?.identifier) return { kind: "stays" };
  if (active === inst.identifier || (inst.copies ?? []).some((k) => k?.identifier === active)) return { kind: "stays" };
  return { kind: "main", identifier: inst.identifier };
}

const sourceOf = (f: Forwarding) => (f.source === "browser" || f.source === "selection" ? f.source : "manual");

/** A row under the selection: a port of the active instance — forwarded, occupied (by hand) or about to be caught up. */
export type ActiveRow<F extends Forwarding> =
  | { kind: "forwarded"; port: number; f: F; service: string | null; running: boolean }
  | { kind: "occupied"; port: number; from: F; service: string | null }
  | { kind: "pending"; port: number; service: string | null };

/**
 * The ports of the active instance for the list under the selection ("localhost:X ← service"): every forwarding of the instance that belongs
 * to the choice or lies on one of its running ports (also one from the browser, until catching up takes it over), plus every running port
 * without a forwarding — "occupied" if a forwarding by hand holds its number (catching up never removes it, client/forwarding-rules.js),
 * otherwise "pending" (catching up is coming). Empty without a choice. Sorted by port.
 */
export function activeRows<F extends Forwarding>(p: { active: string | null | undefined; services: readonly SelectionService[] | null | undefined;
  forwards: readonly F[] }): ActiveRow<F>[] {
  const active = p.active;
  if (!active) return [];
  const pid = projectOfTheIdentifier(active);
  const ports = instancePorts(p.services, active);
  const serviceOn = (port: number) => (p.services ?? []).find((d) => String(d.projectId) === pid && d.port === port)?.name || null;
  const out: ActiveRow<F>[] = [];
  const own = new Set<number>();
  for (const f of p.forwards) {
    if ((f.instance ?? null) !== active) continue;
    if (sourceOf(f) !== "selection" && !ports.includes(f.port)) continue;
    own.add(f.port);
    out.push({ kind: "forwarded", port: f.port, f, service: serviceOn(f.port), running: ports.includes(f.port) });
  }
  for (const port of ports) {
    if (own.has(port)) continue;
    const from = p.forwards.find((g) => g.localPort === port && (g.instance ?? null) !== active && sourceOf(g) === "manual");
    out.push(from ? { kind: "occupied", port, from, service: serviceOn(port) } : { kind: "pending", port, service: serviceOn(port) });
  }
  return out.sort((a, b) => a.port - b.port);
}

/** A service as `/api/project-services` returns it — the fields for the service list under the selection. */
export type ChoiceRawService = SelectionService & { id: number; container?: string | null; startCommand?: string | null; holdsStart?: boolean };

/** A registered service of the active instance's project as the pill shows it under the selection. */
export type ChoiceService<F extends Forwarding> = {
  id: number; name: string; port: number | null; container: string | null;
  /** Runs in THIS instance (`serviceInInstance`: the main instance reads the row's `running`, a copy its entry in `instances`).
   *  `null` = unknown: the copy has (yet) no entry — a copy under construction, an older server. Never "stopped". */
  running: boolean | null;
  /** Holds a start without being reachable (`holdsStart` of THIS instance, also per copy) — "running, not reachable", no start
   *  (otherwise it would end in 409 SERVICE_RUNNING). Only next to `running === false`. */
  holds: boolean;
  /** Stopped (measured, not unknown), not held and with a start command: the pill offers "Start" (simple start in this
   *  instance). */
  startable: boolean;
  /** The state of its forwarding if it runs with a port (forwarded · occupied · pending) — from `activeRows`. */
  row: ActiveRow<F> | null;
};

/**
 * The service list under the selection: EVERY registered service of the active instance's project, running ones first, then by name. A running
 * port service carries the state of its forwarding (the same computation as `activeRows`); a stopped one is `startable` if it has a start
 * command and nothing holds it. Empty without a choice; `null` while the services are not loaded — "not loaded yet" is not "no services".
 * The state per instance is the SAME computation as on the Apps page (`serviceInInstance`). The pill used to compute it itself: `holds`
 * only for the main instance (a copy with a start guard offered ▶ and ended in 409 SERVICE_RUNNING) and a missing entry as "stopped" (a copy
 * under construction offered ▶).
 */
export function choiceServices<F extends Forwarding>(p: { active: string | null | undefined; services: readonly ChoiceRawService[] | null | undefined;
  forwards: readonly F[] }): ChoiceService<F>[] | null {
  const active = p.active;
  if (!active) return [];
  if (!p.services) return null;
  const pid = projectOfTheIdentifier(active);
  if (!pid) return [];
  const main = isMain(active);
  const rows = activeRows({ active, services: p.services, forwards: p.forwards });
  const out: ChoiceService<F>[] = [];
  for (const d of p.services) {
    if (String(d.projectId) !== pid) continue;
    const { running, holds } = serviceInInstance(d, active, main);
    const row = running === true && d.port != null ? rows.find((z) => z.port === d.port) ?? null : null;
    const command = typeof d.startCommand === "string" && d.startCommand.trim() !== "";
    out.push({ id: d.id, name: d.name || "", port: d.port, container: d.container || null, running, holds, startable: running === false && !holds && command, row });
  }
  const front = (x: ChoiceService<F>) => (x.running === true ? 1 : 0);
  return out.sort((a, b) => front(b) - front(a) || a.name.localeCompare(b.name));
}

/** The remaining forwardings (by hand, from the browser, without an instance) — the section of its own with ×: everything that does not stand above. */
export function otherForwardings<F extends Forwarding>(forwards: readonly F[], rows: readonly ActiveRow<F>[]): F[] {
  const top = new Set(rows.flatMap((z) => (z.kind === "forwarded" ? [z.f] : [])));
  return forwards.filter((f) => !top.has(f));
}

// ── The chosen copy is not ready ────────────────────────────────────────────────────────────────────────────────────────────
// Hiding the WHOLE service list for a copy that is not ready left its running services nowhere in the pill: `otherForwardings` counted its
// forwarding as "above" (from `activeRows`) and took it out of "By hand and browser" — but above stood nothing. And they demonstrably keep
// running: while being cleared away up to step 5 (stacks/clear-away.js), after a failed clearing (`error`, stacks/remove.js) for good.
// Exactly there localhost:X points to this copy. What is taken away is the start, not the view.

/**
 * What the service list under the selection shows. Without a state or ready (and for the main instance, `notReady = null`): every row of
 * `choiceServices`. If the chosen copy is NOT ready (`copyNotReady`), only the living services — `running === true` (forwarded with ↗,
 * occupied by hand, being forwarded) and `holds` ("running, not reachable"). None of them is `startable` (that applies only next to
 * `running === false` without `holds`), so no ▶ stands there — a start there would end in 409 COPY_NOT_READY. `null` stays `null` (not
 * loaded yet is not "no services").
 */
export function choiceServicesVisible<F extends Forwarding>(list: ChoiceService<F>[] | null, notReady: string | null): ChoiceService<F>[] | null {
  if (!notReady || list === null) return list;
  return list.filter((d) => d.running === true || d.holds);
}

/**
 * The forwardings for "By hand and browser" next to the service list: every one that the list does NOT itself show at its service's row (↗).
 * Computed from the SHOWN rows (`choiceServicesVisible`), not from `activeRows` — otherwise a forwarding whose row the list does not carry
 * stood neither above nor here: that of the not-ready copy (see above), and likewise a forwarding of the choice on a service that is no
 * longer measured as running in this instance (`activeRows` lists it as "forwarded", the list attaches a forwarding only to a running
 * service). So every forwarding stands exactly ONCE in the menu, and every one that holds localhost:X can be ended with ×. While the services
 * are not loaded (`list === null`), `activeRows` applies as before — otherwise the choice's forwardings would jump here for a beat.
 */
export function otherBesideTheList<F extends Forwarding>(forwards: readonly F[], list: readonly ChoiceService<F>[] | null,
  rows: readonly ActiveRow<F>[]): F[] {
  if (list === null) return otherForwardings(forwards, rows);
  return otherForwardings(forwards, list.flatMap((d) => (d.row ? [d.row] : [])));
}

/**
 * The sentence above the service list of a copy that is not ready. It promises only what happens: while being cleared away its services
 * do not start here any more; with `error` neither — without a new clearing or re-creation it never becomes ready, "as soon as it is ready"
 * was wrong there; in a transition (`create`, `start`, `recreate`, `relocation`, …) only once it is ready. `stateText` is the state's word
 * (`stateWord`, lib/instance-state.ts — the pill passes it in, the leaf module imports nothing). Running services stand below it
 * (`choiceServicesVisible`).
 */
export function notReadySet(i: InstanceResource, stateText: string, t: Translator): string {
  if (i.state === "clearAway") return t("The copy {name} is being removed — its services no longer start here.", { name: i.name });
  if (i.state === "error") return t("The copy {name} has an error — its services do not start here.", { name: i.name });
  return t("The copy {name} is not ready right now ({state}) — its services start here only once it is ready.", { name: i.name, state: stateText });
}

/**
 * Must the pill catch up? If a running port of the active instance has no forwarding yet (and none by hand holds it), or a forwarding of
 * the instance on a running port does not belong to the choice yet (from the browser/by hand — catching up takes it over). "Occupied"
 * does NOT catch up: catching up does nothing there, and a call per beat would be noise.
 */
export function needsBringAlong<F extends Forwarding>(rows: readonly ActiveRow<F>[]): boolean {
  return rows.some((z) => z.kind === "pending" || (z.kind === "forwarded" && z.running && sourceOf(z.f) !== "selection"));
}

/**
 * The state of a service row under "Running services" (client with selection): forwarded (a forwarding of its instance on its port — of
 * whatever source), otherwise for the active instance "occupied" (by hand) or "pending", for every other "not forwarded" — it has no button of
 * its own any more; forwarding goes via the selection.
 */
export type ServiceStatus<F extends Forwarding> = { kind: "forwarded"; f: F } | { kind: "occupied"; from: F } | { kind: "pending" } | { kind: "not-active" };
export function serviceStatus<F extends Forwarding>(port: number, instance: string | null, active: string | null | undefined, forwards: readonly F[]): ServiceStatus<F> {
  const f = forwards.find((g) => (g.instance ?? null) === (instance ?? null) && g.port === port);
  if (f) return { kind: "forwarded", f };
  if (!instance || instance !== active) return { kind: "not-active" };
  const from = forwards.find((g) => g.localPort === port && (g.instance ?? null) !== instance && sourceOf(g) === "manual");
  return from ? { kind: "occupied", from } : { kind: "pending" };
}

// ── The answer of a service stop ────────────────────────────────────────────────────────────────────────────────────────────
// Applies to EVERY service view, not only the pill (it stops nothing): ProjectServicesPane and the Apps page. The iOS version is
// `ServiceStopResponse.notice` in mobile/CbaseMobile/Models/ServiceModels.swift (bound in web/test/service-stoppable.test.mjs).
/**
 * What a view says after `POST …/services/<id>/stop`. `stopped: true` ⇒ nothing (`null`); `stopped: false` ⇒ the server's reason (`error`,
 * e.g. "Project container … is frozen — service … not stopped, try again"), without it the general sentence. An answer without `stopped`
 * (or an unreadable one) is no statement: `null` — neither success nor failure is claimed.
 */
export function stopNotice(response: unknown, name: string, t: Translator): string | null {
  if (!response || typeof response !== "object") return null;
  const a = response as { stopped?: unknown; error?: unknown };
  if (a.stopped !== false) return null;
  if (typeof a.error === "string" && a.error.trim()) return a.error;
  return t("{name} could not be safely stopped — something may still be running on the port.", { name });
}
