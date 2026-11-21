// The tab keys of the Coding area: ONE place.
//
// The key used to stand FOUR times on the workspaces page (web/src/app/workspaces/page.tsx): the order of the slide effect
// (`TAB_ORDER`), the type of the tab state, the allowlist of the restore after ⌘R (`tabOk`) and the tab list. If a new key was missing
// from the allowlist, the tab silently jumped back to “Chats” after ⌘R, and no guard saw it (the categories test only read the tab
// list). Now order, type and allowlist derive from here, and web/test/coding-tab.test.mjs holds the page's tab list against this list
// (both directions).
//
// The graph workflows and the library of dynamic workflows are ONE tab “workflows” with two kinds (`WORKFLOW_KINDS`, segment bar in
// components/workflow/WorkflowsTab.tsx). The old key “dynworkflows” is a named legacy (`OLD_TAB`): a stored value leads to “workflows”
// + kind “dynamic” after ⌘R, never silently to “Chats”.
//
// There are TWO tabs for the same project view, one per level: “projects” at workspace level (list → row → view, `ONLY_WORKSPACE`) and
// “project” inside an entered project (directly THIS project's view, `ONLY_PROJECT`). They stand at the same place of the rail, never
// both at once, and a stored value of the other level leads to its counterpart (`tabOnLevel`), never silently to “Chats”.
//
// A leaf module without imports (the test compiles it without a tsconfig).

/**
 * All Coding tabs in the order of the tab row. “scheduled” stands right after “chats”, on BOTH levels (inside an entered project the
 * project's jobs); the scheduled jobs are all that lives on of the old Managing area, and `/todos` redirects here. “skills” stands
 * right after “vars” (credentials), on BOTH levels; it used to be the top-level page `/skills`, which now redirects to this tab
 * (`tabAddress`).
 */
export const CODING_TABS = [
  "chats", "scheduled", "agents", "workflows", "projects", "project", "mcp", "context", "vars", "skills", "code", "terminal", "browser",
] as const;

export type CodingTab = (typeof CODING_TABS)[number];

/** Tabs that exist only at workspace level; inside an entered project they are missing from the row. */
export const ONLY_WORKSPACE: readonly CodingTab[] = ["projects"];

/** Tabs that exist only inside an entered project; at workspace level they are missing from the row (counterpart of `ONLY_WORKSPACE`). */
export const ONLY_PROJECT: readonly CodingTab[] = ["project"];

/** The same place one level up or down: “projects” (workspace) ↔ “project” (entered project). */
export const LEVELS_COUNTERPART: Readonly<Partial<Record<CodingTab, CodingTab>>> = { projects: "project", project: "projects" };

/**
 * The tab on this level: if `r` exists here, `r` itself; otherwise its counterpart on the other level (`LEVELS_COUNTERPART`), and
 * without one `null` (the caller then falls back to “chats”).
 */
export function tabOnLevel(r: CodingTab, inProject: boolean): CodingTab | null {
  const missingHere = inProject ? ONLY_WORKSPACE.includes(r) : ONLY_PROJECT.includes(r);
  if (!missingHere) return r;
  return LEVELS_COUNTERPART[r] ?? null;
}

/**
 * Tabs that ⌘R does NOT restore: a named exception instead of a forgotten line. Currently empty.
 */
export const NOT_RESTORED: readonly CodingTab[] = [];

/**
 * The storage key of a workspace's last open tab (`localStorage`): ONE spelling for the page itself (app/workspaces/page.tsx,
 * remember and read after ⌘R) and for the handover chat in TodosPane.tsx. Whoever jumps into a tab from outside without knowing the
 * workspace takes `tabAddress` (the redirect app/skills/page.tsx).
 */
export function codingTabKey(workspaceId: string): string {
  return `cbase-tab:${workspaceId}`;
}

/**
 * The one-time jump into a tab via the address (`/workspaces/?tab=skills`): the Coding page reads it on mount like `?chat=`/`?instances=`,
 * removes it from the address again (otherwise every ⌘R would jump again) and switches on the first `open()`, even if a workspace
 * must be chosen first and without storage. (The redirect `/skills` used to write the remembered tab of the active workspace; without
 * a remembered workspace or without storage it landed in the last open tab instead of skills.)
 */
export const TAB_PARAMETER = "tab";

/** The address of the Coding page with the request to land in tab `r`. */
export function tabAddress(r: CodingTab): string {
  return `/workspaces/?${TAB_PARAMETER}=${encodeURIComponent(r)}`;
}

/**
 * The requested tab from the address: ONLY a known Coding tab that would also be restored after ⌘R (`NOT_RESTORED` applies here as
 * there); anything else (unknown, empty, a legacy from `OLD_TAB`) is `null`, and the page stays on its remembered tab. The caller
 * resolves the level with `tabOnLevel`.
 */
export function tabFromAddress(params: { get(name: string): string | null }): CodingTab | null {
  const raw = params.get(TAB_PARAMETER);
  if (!isCodingTab(raw)) return null;
  return NOT_RESTORED.includes(raw) ? null : raw;
}

/** Is `t` a Coding tab? */
export function isCodingTab(t: unknown): t is CodingTab {
  return typeof t === "string" && (CODING_TABS as readonly string[]).includes(t);
}

/**
 * Tab keys that no longer exist, and where a stored value leads after ⌘R. A named legacy instead of a silent fallback to “chats”:
 * “dynworkflows” used to be its own tab and is now the kind “dynamic” in the tab “workflows” (the kind is named by `savedWorkflowKind`).
 */
export const OLD_TAB: Readonly<Record<string, CodingTab>> = { dynworkflows: "workflows" };

/**
 * The tab after ⌘R from the stored value: a known, restorable tab that exists on this level, otherwise “chats”. An old key (`OLD_TAB`)
 * is first mapped to its successor, a tab of the other level to its counterpart (“projects” in a project ⇒ “project” and vice versa).
 */
export function savedTab(raw: string | null, inProject: boolean): CodingTab {
  const saved = raw !== null && Object.prototype.hasOwnProperty.call(OLD_TAB, raw) ? OLD_TAB[raw] : raw;
  if (!isCodingTab(saved)) return "chats";
  if (NOT_RESTORED.includes(saved)) return "chats";
  return tabOnLevel(saved, inProject) ?? "chats";
}

/** The two kinds in the tab “workflows”, in segment-bar order; the first is the default. */
export const WORKFLOW_KINDS = ["graph", "dynamic"] as const;

export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

/**
 * The kind in the tab “workflows” after ⌘R: a stored old tab “dynworkflows” means “dynamic” (it stood for exactly this page before the
 * merge and takes precedence over the stored kind), otherwise the stored kind if valid, otherwise “graph”.
 */
export function savedWorkflowKind(savedKind: string | null, savedTabName: string | null): WorkflowKind {
  if (savedTabName === "dynworkflows") return "dynamic";
  return (WORKFLOW_KINDS as readonly string[]).includes(savedKind ?? "") ? (savedKind as WorkflowKind) : "graph";
}

/**
 * The kinds in the tab “agents” (outer loop): “subagents” (the agent types the agent starts in the chat), “outerloop” (the background
 * agents the user manages, with the summarizer) and “instructions” (the sections every agent gets in its system prompt). Segment-bar
 * order; the first is the default. iOS `AgentKind` (Models/AppState.swift) carries the same values in the same order
 * (bound in web/test/coding-tab.test.mjs).
 */
export const AGENT_KINDS = ["subagents", "outerloop", "instructions"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** The kind in the tab “agents” after ⌘R (per workspace `cbase-agents-kind:<ws>`): validly stored, otherwise “subagents”. */
export function savedAgentKind(raw: string | null): AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(raw ?? "") ? (raw as AgentKind) : "subagents";
}
