// The library of dynamic workflows in the web: the shapes of the server answers
// (server/backend/electron/server/dynworkflows/routes.js `entryShort`/`entryFull`) and the path of the list. The page is
// components/workflow/DynWorkflowsPane.tsx. Saving is done only by the agent.
//
// A leaf module without imports (web/test/dyn-library.test.mjs transpiles it without a tsconfig).

export type DynPhase = { title: string; detail?: string; model?: string };

/** An entry of the list (without script). `enabled` only in the list of a project: taken over there or not. */
export type DynWorkflowEntry = {
  id: string; name: string; description: string; title: string | null; whenToUse: string | null; phases: DynPhase[];
  createdAt: number; updatedAt: number; enabled?: boolean;
};

/** The view of an entry: plus `meta` (the normalized literal) and the script, byte-equal as stored. */
export type DynWorkflowFull = DynWorkflowEntry & { meta: Record<string, unknown>; script: string };

/** The list of an area: workspace ⇒ its library, entered project ⇒ the same with the takeover state. */
export function listPath(workspaceId: string, projectId: string | null): string {
  return projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/workspace-dyn-workflows`
    : `/api/workspaces/${encodeURIComponent(workspaceId)}/dyn-workflows`;
}
