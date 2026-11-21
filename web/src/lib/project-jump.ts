// The jump into a subitem of a project (Projects → Project → <subitem>) from places that are not on the project page. ONE mechanism for
// every subitem; the subitem is a parameter. Three subitems:
//   - "Instances" (`showInstances`): "Create copy …" under a chat's instance picker (chat/chatInstance.ts: the tab opens and in it the
//     "Create copy" dialog with the chat's instance as base, `createFrom`) and a copy in the "Active Runs" pill (pills/ActiveRunsPill.tsx:
//     the tab opens with THIS copy selected, `instance`);
//   - "Git" (`showProjectGit`): the big git overview with a chosen repo (`repo`). On the web the address `?git=<p>` leads there; iOS
//     has its own jump. The mechanism stays (web/test/jumps.test.mjs "Projects → Git").
//   - "Timeline": the project's timeline, "Show all" from the right chat rail.
//
// Same pattern as lib/code-show.ts: the request waits here (per subitem and project) until the tab picks it up, on mounting or on the
// event if it is already mounted (components/projects/InstancesPage.tsx `takeInstancesTarget`, the git page `takeProjectGitTarget`).
// On the same event the page (app/workspaces/page.tsx) switches the tab: without an entered project "Projects" with this project on the
// subitem, otherwise "Project" (another project is entered in the process).
//
// From another page or into another workspace the jump goes through the address (`projectAddress`, like the pill's `?ws=…&chat=…`):
// `?<subitem>=<projectId>` plus the target's fields (`?instances=<p>[&instance=…][&create=…]`, `?git=<p>[&repo=…]`).
// app/workspaces/page.tsx reads them on build-up (`projectFromAddress`), stores the request here and removes the parameters from the
// address again (`JUMP_PARAMETER`). A request that nobody picks up within `VALID_MS` (the project is not relocated, no longer exists)
// expires; otherwise it would open a dialog minutes later on the next visit to the tab that nobody asked for any more.
// A leaf without imports (the test compiles it on its own).

/** Per subitem what the tab should do after the jump. */
export type ProjectTargets = {
  instances: {
    /** Select this instance ("main" or "copy-<name>"). */
    instance?: string;
    /** Open the "Create copy" dialog with this instance as the preselected base. */
    createFrom?: string;
  };
  git: {
    /** Select this repo (path relative to the project, like `rel` of the git overview). */
    repo?: string;
    /** Prefill this branch search (the branch of a timeline event, components/timeline/TimelineCard.tsx). */
    search?: string;
  };
  /** The project's timeline: "Show all" from the right chat rail; without target fields. */
  timeline: Record<never, string>;
};
export type ProjectSubitem = keyof ProjectTargets;
export type ProjectJump<U extends ProjectSubitem = ProjectSubitem> = { workspaceId: string; projectId: string; subitem: U };

export type InstancesTarget = ProjectTargets["instances"];
export type InstancesJump = InstancesTarget & { workspaceId: string; projectId: string };
export type ProjectGitTarget = ProjectTargets["git"];
export type ProjectGitJump = ProjectGitTarget & { workspaceId: string; projectId: string };

export const PROJECT_JUMP_EVENT = "cbase-project-show";
export const VALID_MS = 60_000;

/** Per subitem the names of its target fields in the address; the subitem itself is the parameter carrying the project id. */
const PARAMETER: { [U in ProjectSubitem]: Record<keyof ProjectTargets[U], string> } = {
  instances: { instance: "instance", createFrom: "create" },
  git: { repo: "repo", search: "search" },
  timeline: {},
};
const SUBITEMS = Object.keys(PARAMETER) as ProjectSubitem[];

/** A subitem the jump knows (the event's detail is unchecked). */
export function isProjectSubitem(v: unknown): v is ProjectSubitem {
  return typeof v === "string" && (SUBITEMS as string[]).includes(v);
}

/** All parameters of a jump; the page removes them from the address after reading (otherwise every Cmd+R would jump again). */
export const JUMP_PARAMETER: readonly string[] = SUBITEMS.flatMap((u) => [u, ...Object.values<string>(PARAMETER[u])]);

const targets = new Map<string, { target: Record<string, string>; at: number }>();
const key = (u: ProjectSubitem, projectId: string) => `${u}\u0000${projectId}`;
// Only fields that are set (an empty text is no choice).
const tidied = (target: object): Record<string, string> =>
  Object.fromEntries(Object.entries(target).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));

/** Stores the request for this project's tab, without an event (the page is only building up). A newer one replaces the older. */
export function rememberProjectTarget<U extends ProjectSubitem>(subitem: U, projectId: string, target: ProjectTargets[U], now = Date.now()): void {
  targets.set(key(subitem, projectId), { target: tidied(target), at: now });
}

/** Stores the request and announces it: the page switches the tab, an already mounted tab of this project picks it up. */
export function showProject<U extends ProjectSubitem>(s: ProjectJump<U>, target: ProjectTargets[U]): void {
  rememberProjectTarget(s.subitem, s.projectId, target);
  window.dispatchEvent(new CustomEvent(PROJECT_JUMP_EVENT, {
    detail: { workspaceId: s.workspaceId, projectId: s.projectId, subitem: s.subitem },
  }));
}

/** Picks up a subitem's waiting request; afterwards it is gone; an expired one counts as none. */
export function takeProjectTarget<U extends ProjectSubitem>(subitem: U, projectId: string, now = Date.now()): ProjectTargets[U] | null {
  const k = key(subitem, projectId);
  const z = targets.get(k);
  if (!z) return null;
  targets.delete(k);
  return now - z.at > VALID_MS ? null : (z.target as ProjectTargets[U]);
}

/** The address for the jump from another page or into another workspace. */
export function projectAddress<U extends ProjectSubitem>(s: ProjectJump<U>, target: ProjectTargets[U]): string {
  const q = new URLSearchParams({ ws: s.workspaceId, [s.subitem]: s.projectId });
  const names = PARAMETER[s.subitem] as Record<string, string>;
  for (const [field, value] of Object.entries(tidied(target))) if (names[field]) q.set(names[field], value);
  return `/workspaces/?${q.toString()}`;
}

/** `?<subitem>=<projectId>[&…]` → the jump (without workspace, which `?ws=` supplies), otherwise null. The first subitem wins. */
export function projectFromAddress(params: URLSearchParams): { subitem: ProjectSubitem; projectId: string; target: Record<string, string> } | null {
  for (const subitem of SUBITEMS) {
    const projectId = (params.get(subitem) ?? "").trim();
    if (!projectId) continue;
    const target: Record<string, string> = {};
    for (const [field, name] of Object.entries<string>(PARAMETER[subitem])) {
      const value = (params.get(name) ?? "").trim();
      if (value) target[field] = value;
    }
    return { subitem, projectId, target };
  }
  return null;
}

// ── The subitems as thin calls ─────────────────────────────────────────

const parts = <Z extends object>(s: Z & { workspaceId: string; projectId: string }) => {
  const { workspaceId, projectId, ...target } = s;
  return { workspaceId, projectId, target };
};

/** Into a project's "Instances" tab (select a copy or open "Create copy"). */
export function showInstances(s: InstancesJump): void {
  const { workspaceId, projectId, target } = parts(s);
  showProject({ workspaceId, projectId, subitem: "instances" }, target);
}
export function instancesAddress(s: InstancesJump): string {
  const { workspaceId, projectId, target } = parts(s);
  return projectAddress({ workspaceId, projectId, subitem: "instances" }, target);
}
export function takeInstancesTarget(projectId: string, now = Date.now()): InstancesTarget | null {
  return takeProjectTarget("instances", projectId, now);
}

/** Into a project's "Git" subitem (the big git overview), optionally with a chosen repo. */
export function showProjectGit(s: ProjectGitJump): void {
  const { workspaceId, projectId, target } = parts(s);
  showProject({ workspaceId, projectId, subitem: "git" }, target);
}
export function projectGitAddress(s: ProjectGitJump): string {
  const { workspaceId, projectId, target } = parts(s);
  return projectAddress({ workspaceId, projectId, subitem: "git" }, target);
}
export function takeProjectGitTarget(projectId: string, now = Date.now()): ProjectGitTarget | null {
  return takeProjectTarget("git", projectId, now);
}

/** Into a project's "Timeline" subitem: "Show all" of the timeline in the right chat rail. */
export function showProjectTimeline(s: { workspaceId: string; projectId: string }): void {
  showProject({ workspaceId: s.workspaceId, projectId: s.projectId, subitem: "timeline" }, {});
}
