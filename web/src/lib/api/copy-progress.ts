// The progress of a copy that waits or is being created. The server computes it in
// server/backend/electron/server/projectbox/copy-progress.js (`copyProgress`) and delivers it in TWO places:
// `copies[].progress` on GET /api/active-runs (the "Active runs" pill, runs/routes.js) and `instances[].progress`
// in the instance tree (GET /api/projects/:pid/instances, projectbox/instances-tree.js — the "Instances" tab).
//
// This file holds the ONE type and its allow-list for both readers — `lib/api/workflows.ts` (ActiveCopy) and the leaf
// `lib/instances-tree.ts` (TreeInstance, bound to iOS: mobile/CbaseMobile/Code/InstancesTree.swift
// `copyProgressFrom`/`progressDetail`, binding in web/test/instances-tree-binding.test.mjs). A leaf module without imports:
// `lib/api/` imports nothing from outside, and instances-tree.ts is compiled alone with tsc in the tests (tsc takes this
// file along).
//
//   copyProgressFrom(raw)       the allow-list. `null` if the core is wrong (`kind` "waiting" with `reason` queue/storage
//                               or "create"; `steps` integer ≥ 1; `step` integer in 0…steps) — a broken progress is NONE,
//                               never "step 0". Single fields beside it fall back to null (`share` outside 0…1, `stage`
//                               without integers seq ≥ 1, from ≥ seq, times not finite or negative); `overrun` is only a
//                               JSON `true`.
//   progressDetail(f, state)    what the UI shows, without words: `kind` queue · storage (waiting) · step (step n of m with
//                               phase and, in start, stage) · create (being built, no known phase); `share` (null = indeterminate —
//                               the bar then runs without a number, never an invented one), `restMin` (rounded-up minutes, only
//                               estimated and not overrun), `overrun`. Without a progress (older server) from the state alone:
//                               waiting_* or build/create; otherwise `null` (no display).
//   copiesFrom(raw)             `copies` of GET /api/active-runs as a list (`[]` without the field — an older server reports none).

/** The phases of the build in their order (store `STACK_COPY_PHASES.build`; server twin projectbox/copy-progress.js). */
export const COPY_PHASES: readonly string[] = ["clone1", "freeze", "clone2", "creation", "prepare", "start"];

/** The progress of a copy that waits or is being created. `share`/`restMs` are an ESTIMATE from the last finished copy of the
 *  same project — null without a predecessor (then no determinate bar, never an invented number); `overrun`: the current step takes
 *  longer than back then. */
export type CopyProgress = {
  kind: "waiting" | "create";
  /** For "waiting": "queue" (behind another copy) or "storage" (too little free storage); otherwise "". */
  reason: string;
  /** 1–6 (phase under `clone1 … start`), 0 when waiting or on an unknown phase. */
  step: number;
  steps: number;
  phase: string;
  /** In the step "start": the stage of the compose start ("stage 2/3" of the instance row). */
  stage: { seq: number; from: number } | null;
  begin: number | null;
  share: number | null;
  restMs: number | null;
  estimateMs: number | null;
  overrun: boolean;
};

/** What the UI shows (without words — translated in the view). */
export type ProgressDetail = {
  kind: "queue" | "storage" | "step" | "create";
  step: number;
  steps: number;
  phase: string;
  stage: { seq: number; from: number } | null;
  share: number | null;
  restMin: number | null;
  overrun: boolean;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const count = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
// Whole and manageable (|x| < 1e15) — the Swift twin computes in Int; a number beyond that is no step anyway.
const whole = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && Math.abs(x) < 1e15 ? x : null);
const notNegative = (x: unknown): number | null => { const z = count(x); return z !== null && z >= 0 ? z : null; };

export function copyProgressFrom(raw: unknown): CopyProgress | null {
  if (!isObj(raw)) return null;
  const kind = raw.kind;
  if (kind !== "waiting" && kind !== "create") return null;
  const reason = kind === "waiting" ? (raw.reason === "queue" || raw.reason === "storage" ? raw.reason : null) : "";
  const steps = whole(raw.steps);
  const step = whole(raw.step);
  if (reason === null || steps === null || steps < 1 || step === null || step < 0 || step > steps) return null;
  const s = raw.stage;
  const seq = isObj(s) ? whole(s.seq) : null;
  const from = isObj(s) ? whole(s.from) : null;
  const a = count(raw.share);
  return {
    kind, reason, step, steps, phase: typeof raw.phase === "string" ? raw.phase : "",
    stage: seq !== null && from !== null && seq >= 1 && from >= seq ? { seq, from } : null,
    begin: count(raw.begin),
    share: a !== null && a >= 0 && a <= 1 ? a : null,
    restMs: notNegative(raw.restMs),
    estimateMs: notNegative(raw.estimateMs),
    overrun: raw.overrun === true,
  };
}

export function progressDetail(f: CopyProgress | null, state: string): ProgressDetail | null {
  const empty = { step: 0, steps: COPY_PHASES.length, phase: "", stage: null, share: null, restMin: null, overrun: false };
  if (!f) {
    if (state === "waiting_queue") return { kind: "queue", ...empty };
    if (state === "waiting_storage") return { kind: "storage", ...empty };
    if (state === "build" || state === "create") return { kind: "create", ...empty };
    return null;
  }
  if (f.kind === "waiting") return { kind: f.reason === "storage" ? "storage" : "queue", ...empty, steps: f.steps };
  return {
    kind: f.step >= 1 ? "step" : "create",
    step: f.step,
    steps: f.steps,
    phase: f.phase,
    stage: f.stage,
    share: f.share,
    restMin: f.restMs !== null && !f.overrun ? Math.max(1, Math.ceil(f.restMs / 60000)) : null,
    overrun: f.overrun,
  };
}

/** A copy that waits or is being created — field `copies` on GET /api/active-runs (runs/routes.js), beside the runs, not below them: it
 *  belongs to no chat, and `counts` counts only runs. */
export type ActiveCopy = {
  id: string;
  name: string;
  /** The instance name ("copy-<name>") — the choice in the "Instances" tab. */
  instance: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  state: string;
  baseInstance: string;
  startedAt: number;
  progress: CopyProgress | null;
};

const text = (x: unknown): string => (typeof x === "string" ? x : "");

export function copiesFrom(raw: unknown): ActiveCopy[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((k): ActiveCopy[] => {
    if (!isObj(k) || !text(k.id) || !text(k.name) || !text(k.projectId) || !text(k.workspaceId)) return [];
    return [{
      id: text(k.id), name: text(k.name), instance: text(k.instance) || `copy-${text(k.name)}`, projectId: text(k.projectId),
      projectName: text(k.projectName), workspaceId: text(k.workspaceId), workspaceName: text(k.workspaceName), state: text(k.state),
      baseInstance: text(k.baseInstance) || "main", startedAt: count(k.startedAt) ?? 0, progress: copyProgressFrom(k.progress),
    }];
  });
}
