// “Open in code tab” from the layout view: a code repo is a closed block there, and the code tab shows its inside. At the click the
// project's code tab is often not mounted yet, so the request waits here until a CodePane of THIS project picks it up (once).
const open = new Map<string, string>();

export function showInCode(projectId: string, path: string): void {
  open.set(projectId, path);
  window.dispatchEvent(new CustomEvent("cbase-code-show", { detail: { projectId } }));
}

/** Picks up a project's waiting path; afterwards it is gone. */
export function takeCodeTarget(projectId: string): string | null {
  const p = open.get(projectId);
  if (p === undefined) return null;
  open.delete(projectId);
  return p;
}

// “Code” and “Terminal” from the “Instances” tab: the project's code tab should stand in THIS instance, and for “Terminal” with an open
// terminal. The same pattern as above: the request waits here until the tab picks it up. `param` is the value of the instance choice
// (lib/code-instance.ts): `null` = the main one, else the copy's identifier (`<projectId>/copy-<name>`). CodeArea picks up the choice
// (on mount and on the event), the terminal that CodePane of EXACTLY this instance; a CodePane of the old instance that sees the event
// before the switch leaves it.
const instanceTarget = new Map<string, string | null>();
const terminalTarget = new Map<string, string | null>();
export const CODE_INSTANCE_EVENT = "cbase-code-instance";

export function showInstanceInCode(projectId: string, param: string | null, opts: { terminal?: boolean } = {}): void {
  instanceTarget.set(projectId, param);
  if (opts.terminal) terminalTarget.set(projectId, param);
  else terminalTarget.delete(projectId);
  window.dispatchEvent(new CustomEvent(CODE_INSTANCE_EVENT, { detail: { projectId } }));
}

/** Picks up the waiting instance request; `undefined` = none (`null` means: the main one). */
export function takeInstanceTarget(projectId: string): string | null | undefined {
  if (!instanceTarget.has(projectId)) return undefined;
  const p = instanceTarget.get(projectId) ?? null;
  instanceTarget.delete(projectId);
  return p;
}

/** Picks up the terminal request if it is meant for this instance (`param` of the CodePane); otherwise it stays. */
export function takeTerminalTarget(projectId: string, param: string | null): boolean {
  if (!terminalTarget.has(projectId) || (terminalTarget.get(projectId) ?? null) !== param) return false;
  terminalTarget.delete(projectId);
  return true;
}
