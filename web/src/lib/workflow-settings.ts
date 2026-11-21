// The pure parts of the "Workflow settings" modal: the six tabs of the icon rail in their order and the five lock areas of
// concurrency. A leaf module without imports — JSX and icons live in components/workflow/WorkflowSettings.tsx, here only the lists a
// guard can read.
//
// Why the tabs live HERE and not in the component: the list is truth three times — for the rail, for the remembered tab (`isWfeTab` holds
// the localStorage value against it) and for iOS (`WorkflowSettingCategory` in mobile/…/Workflows/WorkflowRules.swift, bound in
// web/test/wfe-ios-binding.test.mjs). The lock areas are the server's `LOCK_SCOPES` (workflows.js), bound in
// web/test/workflow-settings-binding.test.mjs.

export const WFE_CATEGORIES = [
  { key: "general", title: "General" },
  { key: "execution", title: "Execution" },
  { key: "context", title: "Context" },
  { key: "check", title: "Caps & checks" },
  { key: "concurrency", title: "Concurrency" },
  { key: "trigger", title: "Triggers" },
] as const;
export type WfeTab = (typeof WFE_CATEGORIES)[number]["key"];

export const isWfeTab = (v: unknown): v is WfeTab =>
  typeof v === "string" && WFE_CATEGORIES.some((k) => k.key === v);

/** The last open tab is remembered per browser (a convenience, not a setting). */
export const WFE_TAB_KEY = "cbase-wfe-tab";

// What mutually excludes two runs? Order = from safe to free.
export const LOCK_AREAS = ["project", "workflow", "event", "custom", "off"] as const;
export type LockArea = (typeof LOCK_AREAS)[number];

/** Check rounds of the completion gate: 1…`max` (server `DONE_ROUNDS_MAX` = 10, via `limits.doneRoundsMax`). */
export function checkRoundsChoice(max: number): number[] {
  const n = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 10;
  return Array.from({ length: n }, (_, i) => i + 1);
}
