/**
 * The computations behind the workflow editor's node dialog — cycles, caps, placeholders, command stock. Pure functions, without a
 * single import.
 *
 * DELIBERATELY a leaf module and not part of `components/workflow/WorkflowNodeDialog.tsx`: as with `lib/slash.ts`,
 * `web/test/workflow-node-form.test.mjs` compiles this file with the local `tsc` and imports it — that would not work with JSX or an
 * `@/lib/api` import, and the visibility rules of the cap (when is "Rounds per run" in the sheet at all?) would go unmeasured. The
 * types are therefore STRUCTURAL: what the dialog passes from `WorkflowGraph` fits without an API type standing here.
 *
 * The three tri-valued modes of a node (`nodeModes`, including reading of the legacy state) and rules 1–3 live here too: does the
 * node check effectively, does it continue at the check cap, does it continue at the round cap — the same computations as in the
 * server (workflows.js) and on iOS (Workflows/WorkflowRules.swift), bound by tests.
 *
 * `nodesOnCycle` finds cycles by self-reachability (not by a back-edge stack; the reason is stated there).
 */

// The three tri-valued node fields: "As workflow" · on · off, or "As workflow" · question · continue. The same lists as
// `DONE_MODES`/`CAP_MODES` in server/backend/electron/server/workflows.js — bound in
// web/test/workflow-settings-binding.test.mjs.
export const DONE_MODES = ["inherit", "on", "off"] as const;
export const CAP_MODES = ["inherit", "ask", "continue"] as const;
export type DoneMode = (typeof DONE_MODES)[number];
export type CapMode = (typeof CAP_MODES)[number];

// `doneCheck`/`capAuto` are LEGACY (input only): a graph in client state that still came from the old server, or a test graph. They
// are read only in `nodeModes`.
export type FormNode = {
  id: string; type: string; title?: string; maxVisits?: number;
  doneMode?: DoneMode | string; doneCapMode?: CapMode | string; loopCapMode?: CapMode | string;
  capAuto?: boolean; doneCheck?: boolean;
};
export type FormGraph = { nodes: FormNode[]; edges: { from: string; to: string; branch?: string | null }[] };
export type Cap = { cap: number; auto: boolean; from: string };
/** The workflow's defaults (`run`) that a node set to "As workflow" inherits. A missing `doneAll` means ON. */
export type WfRule = { doneAll?: boolean; doneCapAuto?: boolean; loopCapAuto?: boolean };

const isDoneMode = (v: unknown): v is DoneMode => (DONE_MODES as readonly unknown[]).includes(v);
const isCapMode = (v: unknown): v is CapMode => (CAP_MODES as readonly unknown[]).includes(v);

/**
 * A node's three modes — the ONE place where the legacy state is read (mirror of `nodeModes` in the server): missing/invalid
 * `doneMode` ⇒ `doneCheck === true ? "on" : "inherit"`; missing `doneCapMode` or `loopCapMode` ⇒
 * `capAuto === true ? "continue" : "inherit"` — the old checkbox applied to BOTH caps, so it becomes both. An old `false` is
 * "never touched": the server wrote it on EVERY node, so "explicitly off" was indistinguishable from it.
 */
export function nodeModes(n: FormNode): { doneMode: DoneMode; doneCapMode: CapMode; loopCapMode: CapMode } {
  const oldCap: CapMode = n.capAuto === true ? "continue" : "inherit";
  return {
    doneMode: isDoneMode(n.doneMode) ? n.doneMode : (n.doneCheck === true ? "on" : "inherit"),
    doneCapMode: isCapMode(n.doneCapMode) ? n.doneCapMode : oldCap,
    loopCapMode: isCapMode(n.loopCapMode) ? n.loopCapMode : oldCap,
  };
}

// Steps that lie on a cycle (an edge leads back). They repeat during a run — there the round count is no detail but the question of how
// often the round is allowed.
//
// A step is on a cycle if it reaches ITSELF via forward edges — the same set as `cycleGroup` in the server (workflows.js: reachable
// AND back) and as the endpoints of `WorkflowGeometry.cycleEdges` on iOS. A depth-first search that took only the nodes on the stack
// of a BACK EDGE would find {A, B} for A→B, B→A, A→C, C→B and miss C although C→B→A→C turns — the server would apply the cycle cap
// there, the sheet would show no field for it, and `effectiveCaps` below would long since compute with the group for C.
export function nodesOnCycle(graph: FormGraph): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const onCycle = new Set<string>();
  for (const n of graph.nodes) {
    const seen = new Set<string>();
    const queue = [...(out.get(n.id) ?? [])];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === n.id) { onCycle.add(n.id); break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const to of out.get(cur) ?? []) queue.push(to);
    }
  }
  return onCycle;
}

// Where the run jumps at the cap when "without question" is set: out of this step's OWN cycle (for "Review clean?" that is the yes path).
// The same search as server-side `cycleExit` — here only so the switch can say where it continues. "" = no exit.
export function exitTitle(graph: FormGraph, nodeId: string): string {
  const reach = (from: string, next: (id: string) => string[]) => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const to of next(cur)) if (!seen.has(to)) { seen.add(to); queue.push(to); }
    }
    return seen;
  };
  const before = reach(nodeId, (id) => graph.edges.filter((e) => e.from === id).map((e) => e.to));
  const back = reach(nodeId, (id) => graph.edges.filter((e) => e.to === id).map((e) => e.from));
  const group = new Set([...before].filter((id) => back.has(id)));
  const nameOf = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? n.title || n.id : "";
  };
  if (!group.size) {
    const first = graph.edges.find((e) => e.from === nodeId && !e.branch) ?? graph.edges.find((e) => e.from === nodeId);
    return first ? nameOf(first.to) : "";
  }
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.from === cur)) {
      if (!group.has(e.to)) return nameOf(e.to);
      if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return "";
}

// Effective cap per node — MIRROR of `effectiveCap(graph, node, fallback, run)` in electron/server/workflows.js, bound in
// web/test/workflow-settings-binding.test.mjs.
// The NUMBER: an own value applies unchanged; without one a cycle node inherits the largest explicitly set cap of its cycle (`from` says
// from whom); if nobody in the cycle carries a value, the default stays. Without this mirror "5×" would stand on a node that really stops at 20.
//
// Whether the cap continues WITHOUT a question (`auto`, tri-valued):
//   · the node's own "Question"/"Continue" ⇒ that — the node overrides;
//   · otherwise the nodes of the same group as before (the givers if explicit caps exist, otherwise all in the cycle; with an own value
//     or off any cycle: none): any "Continue" ⇒ continue, otherwise any "Question" ⇒ question;
//   · otherwise the workflow's default (`wf.loopCapAuto`).
// So "the checkbox counts cycle-wide" is preserved: an old `capAuto: true` reads as "Continue".
export function effectiveCaps(graph: FormGraph, fallback: number, wf?: WfRule | null): Map<string, Cap> {
  const before = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of graph.edges) {
    before.set(e.from, [...(before.get(e.from) ?? []), e.to]);
    back.set(e.to, [...(back.get(e.to) ?? []), e.from]);
  }
  const reach = (from: string, adj: Map<string, string[]>) => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const to of adj.get(cur) ?? []) if (!seen.has(to)) { seen.add(to); queue.push(to); }
    }
    return seen;
  };
  const further = (n: FormNode, mates: FormNode[]): boolean => {
    const own = nodeModes(n).loopCapMode;
    if (own !== "inherit") return own === "continue";
    const modes = mates.map((m) => nodeModes(m).loopCapMode);
    if (modes.includes("continue")) return true;
    if (modes.includes("ask")) return false;
    return wf?.loopCapAuto === true;
  };
  const out = new Map<string, Cap>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    const ownCap = (n.maxVisits ?? 0) > 0 ? n.maxVisits! : fallback;
    if ((n.maxVisits ?? 0) > 0) { out.set(n.id, { cap: ownCap, auto: further(n, []), from: "" }); continue; }
    const forward = reach(n.id, before);
    const her = reach(n.id, back);
    const group = [...forward].filter((id) => her.has(id)).map((id) => byId.get(id)).filter((m): m is FormNode => !!m);
    if (!group.length) { out.set(n.id, { cap: ownCap, auto: further(n, []), from: "" }); continue; }
    const explicit = group.filter((m) => (m.maxVisits ?? 0) > 0);
    if (!explicit.length) { out.set(n.id, { cap: ownCap, auto: further(n, group), from: "" }); continue; }
    const top = Math.max(...explicit.map((m) => m.maxVisits!));
    const giver = explicit.filter((m) => m.maxVisits === top);
    out.set(n.id, { cap: top, auto: further(n, giver), from: giver[0].title || giver[0].id });
  }
  return out;
}

// The entry points and the end: an entry accepts no edge, the end gives none. They therefore carry no cap (they cannot lie on a cycle) and
// have no text — the start has only the command, the end only the notification, the trigger its component and the command.
const ENTRY_POINTS_AND_END = new Set(["start", "end", "trigger"]);

/**
 * Is "Rounds per run" in the sheet? ONLY on a step that lies on a cycle — elsewhere the value never takes effect (the counter runs fresh per
 * loop iteration, `visitKey`), and a field for a number without effect is an explanatory text in numeric form. A stored value on a node
 * without a cycle stays silently; it is not deleted, just not shown.
 */
export function showsCap(cycle: Set<string>, node: FormNode): boolean {
  return cycle.has(node.id) && !ENTRY_POINTS_AND_END.has(node.type);
}

// Only these two kinds know a "done" — MIRROR of `wantsDoneCheck(node, run)` in workflows.js: an `ask` or `review` node waits for a human
// anyway, a switch and a loop have no work result of their own. A mode set via API on another kind never runs — and then must show no row for it.
const WITH_COMPLETION = new Set(["instruction", "parallel"]);

/** Is "Check for completion" (tri-valued) in the sheet? On the two kinds on which the server evaluates it. */
export function showsDoneMode(node: FormNode): boolean {
  return WITH_COMPLETION.has(node.type);
}

/**
 * Rule 1: does this node REALLY check (`wantsDoneCheck(node, run)` in the server)? Kind instruction or parallel AND (node "on" OR
 * (node "As workflow" AND the workflow checks all)). A missing `wf.doneAll` ⇒ on — existing workflows with `run_settings = {}` check.
 */
export function checksEffective(node: FormNode, wf?: WfRule | null): boolean {
  if (!showsDoneMode(node)) return false;
  const m = nodeModes(node).doneMode;
  return m === "on" || (m === "inherit" && wf?.doneAll !== false);
}

/**
 * Rule 2: continue at the check cap without a question? Node "Continue" OR (node "As workflow" AND `wf.doneCapAuto`). Only the node's
 * OWN value counts — unlike at the round cap (`effectiveCaps`).
 */
export function checkCapContinue(node: FormNode, wf?: WfRule | null): boolean {
  const m = nodeModes(node).doneCapMode;
  return m === "continue" || (m === "inherit" && wf?.doneCapAuto === true);
}

/** Which rows the sheet has for this step — the composition per type in ONE place. */
export type Rows = {
  trigger: boolean;     // the trigger component (`trigger` only)
  text: boolean;        // instruction / condition / question / generate list from / defaults
  list: boolean;       // "Fixed list" + "Max. items" (`loop` only)
  command: boolean;     // "Command before"
  cap: boolean;      // "Rounds per run"
  loopCap: boolean;     // "At the round cap" (As workflow · Question · Continue)
  doneMode: boolean;    // "Check for completion" (As workflow · On · Off)
  doneCap: boolean;     // "At the check cap" (As workflow · Question · Continue)
  scale: boolean;    // "Yardstick (optional)" — only where checking is EFFECTIVE
  notification: boolean;  // "Notify on arrival" / "Notify when the review is due"
};

/**
 * The sheet's composition per type: start = title + command · end = title + notification · trigger = title + trigger component +
 * command · all others = title + text (+ list for `loop`) + command + notification. Plus: cap and "At the round cap" only on a cycle;
 * "Check for completion" on instruction/parallel; criterion and "At the check cap" only where the node EFFECTIVELY checks with the
 * defaults `wf` — a check cap without a check never takes effect. The dialog calls ONLY this; a default without a way that breaks it is none.
 */
export function rowsFor(cycle: Set<string>, node: FormNode, wf?: WfRule | null): Rows {
  const checks = checksEffective(node, wf);
  return {
    trigger: node.type === "trigger",
    text: !ENTRY_POINTS_AND_END.has(node.type),
    list: node.type === "loop",
    command: node.type !== "end",
    cap: showsCap(cycle, node),
    loopCap: showsCap(cycle, node),
    doneMode: showsDoneMode(node),
    doneCap: checks,
    scale: checks,
    notification: node.type !== "trigger" && node.type !== "start",
  };
}

/** The value in the number field: empty means "whatever the cycle dictates applies" — 0 is never shown. */
export function capField(node: FormNode): string {
  return (node.maxVisits ?? 0) > 0 ? String(node.maxVisits) : "";
}

/**
 * From the number field's input the stored `maxVisits`: empty, no number or ≤ 0 ⇒ 0 (inherited); otherwise rounded and clamped
 * to 1…`limit` (`limit` = the server's `maxVisitsLimit`).
 */
export function capFromInput(raw: string, limit: number): number {
  const s = raw.trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(limit, Math.round(n)));
}

/** The three placeholders of a step text, in the order of the chips (see `renderText`, workflows.js). Wire values — they stay German. */
export const PLACEHOLDER = ["{{input}}", "{{element}}", "{{answer}}"] as const;

/**
 * Insert a token at the caret: a selection is replaced, the caret afterwards stands BEHIND the token. No extra spaces — whoever puts
 * "{{element}}" in the middle of a word meant it, and a space before punctuation would be worse.
 */
export function insertPlaceholder(text: string, selStart: number, selEnd: number, token: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(selStart, selEnd, text.length));
  const b = Math.max(a, Math.min(text.length, Math.max(selStart, selEnd)));
  return { text: text.slice(0, a) + token + text.slice(b), caret: a + token.length };
}

/**
 * The two commands the picker offers at the command field — and ONLY those: cbase runs them itself before the step runs
 * (`isHarnessCommand` in workflows.js). The seven client commands of the composer (goal, model, effort, …) are missing on purpose: at the
 * node the string would go raw to the CLI, which would run ITS command. Skills are added from the server.
 *
 * Bound by `web/test/workflow-node-form.test.mjs` to the alternatives of the regex `isHarnessCommand`
 * (server/backend/electron/server/workflows.js) and to the chips of the iOS sheet
 * (`WorkflowNodeSheet.nodeCommands` in mobile/CbaseMobile/Workflows/WorkflowCanvasEditor.swift).
 */
export const NODE_COMMANDS = ["clear", "compact"] as const;
