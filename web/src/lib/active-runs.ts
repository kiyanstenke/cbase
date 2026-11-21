// The "Active runs" pill (components/pills/ActiveRunsPill.tsx): which global events it reloads on.
//
// A leaf module without imports — web/test/active-runs.test.mjs compiles it alone and holds the list
// against the events the server really sends. `dyn_workflow` belongs to it (start and end of a run,
// server/backend/electron/server/dynworkflows/run.js GLOBAL_EVENT): a dynamic workflow lives outside
// every turn, and without this event it would appear in the pill only after the next tick (or stay in
// it after its end). Likewise `project/copy` (server/backend/electron/server/stacks/state.js, every
// state and phase change of a copy): the pill shows copies being made, with their step — without the
// event a new step would show only after the next tick.
export const LOAD_EVENTS: readonly string[] = Object.freeze(["init", "run", "workflow_run", "dyn_workflow", "project/copy"]);

/** Does the pill reload on this event of the global stream? */
export function loadAfterEvent(msg: { type?: unknown } | null | undefined): boolean {
  return typeof msg?.type === "string" && LOAD_EVENTS.includes(msg.type);
}
