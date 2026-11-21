// What a project row says about the setup. PURE: from the fields `setup` and `detection` of a project (server `setupField`, view
// `store/project-setup.js` `setupView`) the rows the project list shows under the name, their actions and what is locked meanwhile. The UI
// (`components/projects/`) only translates and calls the routes; iOS computes the same table in `Code/ProjectUpload.swift`.
//
// The server is the boundary: "locked" only greys out; every route answers 409 anyway if it does not fit.
//
// A row whose server step was run by a FOREIGN process is already delivered by the server as `error`/`INTERRUPTED`; that is not
// recomputed here. `lastChunk` is the START of the last chunk request (ms); younger than the upload quiet period means "an upload is
// running" (in this tab or another), older means "interrupted".

import type { Setup, SetupSource, SetupStep, Detection, LayoutRow, RetroactiveUpload, SourceState } from "@/lib/api";
export type { Setup, SetupSource, SetupStep, Detection, LayoutRow, RetroactiveUpload, SourceState };

export type ActionKind =
  | "resume" | "takeOver" | "leaveOut" | "abort" | "again"
  | "overwrite" | "skip" | "conflict-abort" | "erase" | "access";
/** `change`: only on "access": a stored access already exists and the host rejected it (button "Change access"). */
export interface Action { kind: ActionKind; seq?: number; change?: true }

/** A row under the project name. `text` is an i18n key (English), `values` its placeholders; the UI translates `step` via `STEP_NAMES`
 *  into the placeholder `{step}`. */
export interface Row {
  text: string;
  values?: Record<string, string | number>;
  step?: SetupStep;
  tone: "running" | "waiting" | "error";
  actions: Action[];
  seq?: number;
}

export interface Locked { erase: boolean; upload: boolean; layout: boolean }
export interface Display { rows: Row[]; locked: Locked }

/** The server's upload quiet period (`CBASE_UPLOAD_QUIET_MS`, default 60 s). */
export const UPLOAD_QUIET_MS = 60_000;

export const STEP_NAMES: Record<SetupStep, string> = {
  container: "creating the container",
  sources: "Sources",
  place: "placing the files",
  "code-repos": "creating the code repos",
  "project-repo": "Initial commit",
};

const STEP_RUNNING: Record<Exclude<SetupStep, "sources">, string> = {
  container: "Creating container",
  place: "placing files",
  "code-repos": "creating code repos",
  "project-repo": "Initial commit",
};

const SOURCE_RUNNING: Partial<Record<SourceState, string>> = {
  unpack: "{source}: extracting",
  clone: "{source}: cloning",
  submodule: "{source}: fetching submodules",
  lfs: "{source}: fetching LFS files",
};

/** The errors of a clone, each with its own sentence; `{host}` is the source's host, `{reason}` the last stderr row. */
const CLONE_ERROR: Record<string, string> = {
  NO_ACCESS: "{source}: no access for {host}",
  ACCESS_REJECTED: "{source}: the access for {host} was rejected",
  // `{reason}` is the name here: 'submodule "x"' (server clone.js); what is meant is "missing or rejected".
  SUBMODULE_ACCESS: "{source}: {reason} needs access for {host}",
  TARGET_OCCUPIED: "{source}: something already exists at the target",
  CLONE: "{source}: cloning failed: {reason}",
  SUBMODULE: "{source}: submodules failed: {reason}",
  LFS: "{source}: LFS files failed: {reason}",
};
/** For these errors a (new) access for the host helps: "Add access", then "Try again". */
export const ACCESS_HELPS = ["NO_ACCESS", "ACCESS_REJECTED", "SUBMODULE_ACCESS"];

const NO_LOCK: Locked = { erase: false, upload: false, layout: false };

/** Is an upload running for this source (last chunk request younger than the quiet period)? */
export function uploadRunning(q: Pick<SetupSource, "state" | "lastChunk">, now: number, quietMs = UPLOAD_QUIET_MS): boolean {
  return q.state === "wait-upload" && typeof q.lastChunk === "number" && now - q.lastChunk < quietMs;
}

/**
 * PURE: the rows and locks of a project. Without `setup` only the detection (or nothing). Row order: first the project (error, conflict,
 * running server step), then per source, last the service detection.
 */
export function setupDisplay(
  e: Setup | undefined | null,
  detection: Detection | undefined | null,
  now: number,
  quietMs = UPLOAD_QUIET_MS,
): Display {
  const rows: Row[] = [];
  const locked: Locked = { ...NO_LOCK };
  const lock = (s: Partial<Locked>) => { for (const k of Object.keys(s) as (keyof Locked)[]) if (s[k]) locked[k] = true; };

  if (e) {
    // Until the setup is finished there is no layout and no later upload ("view only").
    lock({ upload: true, layout: true });
    if (e.state === "error") {
      rows.push(e.code === "INTERRUPTED"
        ? { text: "Setup interrupted: {step}", step: e.step, tone: "error", actions: [{ kind: "again" }, { kind: "erase" }] }
        : { text: "Setup failed: {reason}", values: { reason: e.error || e.code || "" }, tone: "error", actions: [{ kind: "again" }, { kind: "erase" }] });
    } else if (e.waiting === "conflict") {
      rows.push({
        text: "{n} files already exist",
        values: { n: e.conflict?.existing ?? 0 },
        tone: "waiting",
        actions: [{ kind: "overwrite" }, { kind: "skip" }, { kind: "conflict-abort" }],
      });
    } else if (e.step !== "sources") {
      rows.push({ text: STEP_RUNNING[e.step], tone: "running", actions: [] });
      // Container: entering stays allowed (the turn waits), deleting does not. The other steps lock the same.
      lock({ erase: true });
    }
    // A clone (or the detection) waits for free memory; visible so that "standing" does not look like "hanging".
    if (e.state !== "error" && e.waiting === "storage") rows.push({ text: "waiting for memory", tone: "waiting", actions: [] });

    if (e.state !== "error" || e.code !== "INTERRUPTED") {
      const open = e.sources.filter((q) => q.state !== "leftOut");
      const allReady = open.length > 0 && open.every((q) => q.state === "staged");
      for (const q of e.sources) {
        const beforeContainer = e.step === "container" || e.waiting === "container";
        const z = sourceRow(q, now, quietMs, allReady || e.step !== "sources", e.state === "setUp" && e.step === "sources", beforeContainer);
        if (!z) continue;
        rows.push(z.row);
        lock(z.lock);
      }
    }
  }

  if (detection?.status === "running") rows.push({ text: "Detecting services", tone: "running", actions: [] });
  else if (detection?.status === "error") rows.push({ text: "Service detection failed", tone: "error", actions: [] });

  // "Try again" and "Delete" apply to the whole project: offer once, on the first row that carries them.
  const seen = new Set<ActionKind>();
  for (const z of rows) {
    z.actions = z.actions.filter((a) => {
      if (a.seq !== undefined) return true;
      if (seen.has(a.kind)) return false;
      seen.add(a.kind);
      return true;
    });
  }
  return { rows, locked };
}

function sourceRow(
  q: SetupSource, now: number, quietMs: number, still: boolean, inSources: boolean, beforeContainer = false,
): { row: Row; lock: Partial<Locked> } | null {
  const seq = q.seq;
  // The source's target; files into the root are called "/" (no translation needed, and it is exactly where they go).
  const name = q.target || "/";
  switch (q.state) {
    case "leftOut":
      return null;
    case "staged":
      // Only while ANOTHER source is still missing; once all are ready, the project step says more.
      return still ? null : { row: { text: "{source}: ready — waiting for the other sources", values: { source: name }, tone: "waiting", actions: [], seq }, lock: {} };
    case "wait-upload":
      if (uploadRunning(q, now, quietMs)) {
        return { row: { text: "{source}: upload running", values: { source: name }, tone: "running", actions: [], seq }, lock: { erase: true } };
      }
      return {
        row: {
          text: "{source}: waiting for upload",
          values: { source: name },
          tone: "waiting",
          // ZIP: half an archive cannot be unpacked (the directory is at the end), "Take as is" exists there only in
          // `error`/`aborted`; a complete archive that was merely not reported finished is closed by "Resume upload".
          actions: q.kind === "zip"
            ? [{ kind: "resume", seq }, { kind: "leaveOut", seq }, { kind: "erase" }]
            : [{ kind: "resume", seq }, { kind: "takeOver", seq }, { kind: "leaveOut", seq }, { kind: "erase" }],
          seq,
        },
        lock: {},
      };
    case "error":
    case "aborted":
      if (q.kind === "clone") {
        // A clone has nothing to upload, so there is no "Take as is"; "Try again" resumes at the step it stood at.
        const access = q.state === "error" && Boolean(q.host) && ACCESS_HELPS.includes(q.code ?? "");
        // "Take as is" only if the repository itself has already been fetched (`fetched`, server `cloneFetched`): then the server takes it
        // without the missing submodules or LFS files (routes.js takeOver); otherwise 409.
        const takeOver = inSources && Boolean(q.fetched) && q.code !== "INTERRUPTED";
        const text = q.state === "aborted" ? "{source}: cancelled"
          : (q.code && q.code !== "INTERRUPTED" && CLONE_ERROR[q.code]) || "{source}: setup failed: {reason}";
        return {
          row: {
            text,
            values: { source: name, reason: q.error || q.code || "", host: q.host || "" },
            tone: "error",
            actions: [
              ...(access ? [{ kind: "access" as const, seq, ...(q.code === "ACCESS_REJECTED" ? { change: true as const } : {}) }] : []),
              { kind: "again" },
              ...(takeOver ? [{ kind: "takeOver" as const, seq }] : []),
              { kind: "leaveOut", seq },
              { kind: "erase" },
            ],
            seq,
          },
          lock: {},
        };
      }
      return {
        row: {
          text: q.state === "aborted" ? "{source}: cancelled" : "{source}: setup failed: {reason}",
          values: { source: name, reason: q.error || q.code || "" },
          tone: "error",
          // "Take as is" (= `done` with `takeOver: true`): takes what lies in staging. The server accepts it only in step `sources`
          // (otherwise 409 NOT_READY), and not for an interrupted source (it still stands in the server state, e.g. `unpack` with a
          // foreign boot id ⇒ 409 SOURCE_STATE; "Try again" and "Leave out" help there).
          actions: inSources && q.code !== "INTERRUPTED"
            ? [{ kind: "again" }, { kind: "takeOver", seq }, { kind: "leaveOut", seq }, { kind: "erase" }]
            : [{ kind: "again" }, { kind: "leaveOut", seq }, { kind: "erase" }],
          seq,
        },
        lock: {},
      };
    default: {
      // From creation on a clone stands at `clone`, but cloning happens only in the ready container; until then it waits
      // ("cloning" used to appear under "Creating container" without git running).
      if (q.kind === "clone" && q.state === "clone" && beforeContainer) {
        return { row: { text: "{source}: waiting for the container…", values: { source: name }, tone: "waiting", actions: [{ kind: "abort", seq }], seq }, lock: {} };
      }
      const text = SOURCE_RUNNING[q.state];
      if (!text) return null;
      return {
        row: { text, values: { source: name }, tone: "running", actions: [{ kind: "abort", seq }], seq },
        lock: { erase: true },
      };
    }
  }
}

/** The sources currently waiting for an upload (for "Resume upload" and the upload right after creation). */
export const waitingSources = (e: Setup | undefined | null) => (e?.sources ?? []).filter((q) => q.state === "wait-upload");

// ── Later uploads ──────────

export type UploadActionKind = "resume" | "dismiss" | "abort" | "overwrite" | "skip";
export interface UploadAction { kind: UploadActionKind; operation: string }
/** One row per open operation; `text`/`values` as with `Row`. `examples`: the title of a conflict row. */
export interface UploadRow {
  text: string;
  values?: Record<string, string | number>;
  tone: Row["tone"];
  actions: UploadAction[];
  operation: string;
  examples?: string[];
}

/**
 * PURE: the rows of the open later operations (field `uploads`) and what is locked meanwhile. `own` are the operations THIS tab is
 * uploading right now (running only); it shows them with its own progress. `ended` are operations whose upload was aborted or failed in
 * THIS tab: they count as interrupted at once (resume · discard) instead of locking deletion as "running" until the quiet period. A
 * running placing or unpacking locks deletion; so does a running upload in another tab (as with creation). An open operation holds the
 * layout; the server regulates the waiting, nothing is locked here for it.
 */
export function retroactiveDisplay(
  uploads: RetroactiveUpload[] | undefined | null, own: ReadonlySet<string> = new Set(), ended: ReadonlySet<string> = new Set(),
  now = Date.now(), quietMs = UPLOAD_QUIET_MS,
): { rows: UploadRow[]; locked: Locked } {
  const rows: UploadRow[] = [];
  const locked: Locked = { ...NO_LOCK };
  for (const u of uploads ?? []) {
    const v = u.operation;
    const archive = u.kind === "archive";
    if (u.state === "upload") {
      if (own.has(v)) { locked.erase = true; continue; }
      // The server computes `interrupted` when loading the list; until the next load the page's clock keeps computing (as with
      // creation, `uploadRunning`): without a chunk younger than the upload quiet period the upload is interrupted.
      const last = Math.max(Number(u.lastChunk) || 0, Number(u.since) || 0);
      if (!u.interrupted && !ended.has(v) && !(last > 0 && now - last >= quietMs)) {
        rows.push({ text: archive ? "ZIP upload running" : "Upload running", tone: "running", actions: [], operation: v });
        locked.erase = true;
        continue;
      }
      const n = typeof u.staged === "number" ? u.staged : null;
      rows.push({
        text: archive ? "ZIP upload interrupted" : n === null ? "Upload interrupted" : u.capped ? "Upload interrupted (at least {n} files staged)" : "Upload interrupted ({n} files staged)",
        ...(n !== null && !archive ? { values: { n } } : {}),
        tone: "waiting",
        actions: [{ kind: "resume", operation: v }, { kind: "dismiss", operation: v }],
        operation: v,
      });
      continue;
    }
    if (u.state === "place" || u.state === "unpack") {
      const unpacked = u.state === "unpack";
      if (u.interrupted) {
        rows.push({
          text: unpacked ? "Extracting interrupted" : "Placing files interrupted",
          tone: "waiting",
          actions: [{ kind: "resume", operation: v }, { kind: "dismiss", operation: v }],
          operation: v,
        });
        continue;
      }
      rows.push({ text: unpacked ? "unpacked" : "placing files", tone: "running", actions: [{ kind: "abort", operation: v }], operation: v });
      locked.erase = true;
      continue;
    }
    if (u.state === "error") {
      if (u.code === "CONFLICT") {
        rows.push({
          text: "{n} files already exist",
          values: { n: u.existing ?? 0 },
          tone: "waiting",
          actions: [{ kind: "overwrite", operation: v }, { kind: "skip", operation: v }, { kind: "dismiss", operation: v }],
          operation: v,
          examples: u.examples ?? [],
        });
        continue;
      }
      rows.push({
        text: "Upload failed: {reason}",
        values: { reason: u.error || u.code || "" },
        tone: "error",
        actions: [{ kind: "resume", operation: v }, { kind: "dismiss", operation: v }],
        operation: v,
      });
    }
  }
  return { rows, locked };
}

/** May one upload into this project later now? Never without an instance (local). The server is the boundary. */
export function uploadPossible(p: { setup?: unknown; instance?: { state: string } }, locked: Pick<Locked, "upload">): boolean {
  return !p.setup && p.instance?.state === "ready" && !locked.upload;
}

// ── The job of a layout (the four layout rows) ───────────────────────────────

/** The steps of the procedure (server `projectbox/layout/procedure.js` LAYOUT_JOURNAL, plus `quiet` from the job) as
 *  i18n keys. An unknown step appears raw. */
export const LAYOUT_STEP_NAMES: Record<string, string> = {
  quiet: "checking for idle",
  prior: "taking stock",
  marker: "pausing services",
  stop: "stopping services and containers",
  postWork: "git follow-up",
  foreign: "processes in the project",
  terminals: "closing terminals",
  repack: "taking over borrowed objects",
  crossCheck: "cross-check",
  "docker-away": "removing Docker objects",
  parking: "parking folders",
  leaveOut: "Leave out",
  place: "placing folders",
  "code-repos": "creating the code repos",
  "project-repo": "project repo",
  worktrees: "repairing worktrees",
  alternates: "rewriting alternates",
  db: "paths in the database",
  compose: "recreating Compose stacks",
  startUp: "starting up",
  recheck: "verifying",
  completion: "Finishing",
  "rw-rules": "restoring restart policies",
  "rw-start-up": "starting up again",
  "rw-marker": "releasing services",
};

export type LayoutActionKind = "waitlist" | "revert" | "check-again" | "again";
export interface LayoutRowView {
  text: string;
  values?: Record<string, string | number>;
  /** A step key (LAYOUT_STEP_NAMES); the UI translates it into the placeholder `{step}`. */
  step?: string;
  /** The server's reason (title of the row). */
  reason?: string;
  tone: "running" | "waiting" | "error";
  actions: LayoutActionKind[];
}

/**
 * PURE: the row of the layout job and what is locked meanwhile; `services` means "start services" (the server answers 409 in `running`).
 * Without a job nothing.
 *   waiting                 "Layout waiting for idle (N)" · waitlist, undo · locked: edit layout, upload
 *   running                 "Layout being applied" (with the way back: "… being reverted") · locked: delete, upload, services
 *   error before the turn   "Layout no longer fits: <reason>" · check again, undo · locked: upload
 *   error after the turn    "Layout half applied: <step>" · try again · locked like `running`
 *   way back failed         "Reverting the layout interrupted: <reason>" · try again (undo answers 409
 *                           RETURN_PATH_OPEN; without the way back, restart policies and target would be missing)
 */
export function layoutRow(g: LayoutRow | undefined | null): { row: LayoutRowView | null; locked: Locked; services: boolean } {
  const locked: Locked = { ...NO_LOCK };
  if (!g) return { row: null, locked, services: false };
  const reason = g.error || "";
  if (g.state === "waiting") {
    locked.upload = true;
    locked.layout = true;
    return { row: { text: "Outline waiting for idle ({n})", values: { n: g.holders }, tone: "waiting", actions: ["waitlist", "revert"] }, locked, services: false };
  }
  if (g.state === "running" || (g.state === "error" && g.turned)) {
    locked.erase = true;
    locked.upload = true;
    locked.layout = true;
    if (g.state === "running") {
      return { row: { text: g.backward ? "Outline being reverted" : "Outline being applied", tone: "running", actions: [] }, locked, services: true };
    }
    return { row: { text: "Outline half applied: {step}", step: g.step, reason, tone: "error", actions: ["again"] }, locked, services: true };
  }
  // `error` before the turn: nothing in the tree is changed.
  if (g.backward) {
    locked.layout = true;
    return { row: { text: "Reverting the outline interrupted: {reason}", values: { reason }, reason, tone: "error", actions: ["again"] }, locked, services: false };
  }
  locked.upload = true;
  return { row: { text: "Outline no longer fits: {reason}", values: { reason }, reason, tone: "error", actions: ["check-again", "revert"] }, locked, services: false };
}
