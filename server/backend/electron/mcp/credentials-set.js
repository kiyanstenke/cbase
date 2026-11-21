// The ONE sentence about the scope of the credentials. Three places used to say different things, and two of them were wrong: the
// base block, the project focus and cbase_vars_list/_get. As measured on the routes:
//   in project focus  GET /api/projects/:id/vars?mcp=1 → store.effectiveProjectVars: the project's own vars PLUS the workspace vars
//                     the project has not hidden (project_var_excluded; on by default), with the same key the project wins
//                     (projects/routes.js, resolveProjectVar);
//   without focus     GET /api/workspaces/:id/vars?mcp=1 → store.effectiveWorkspaceVars: the workspace vars PLUS the vars of ALL projects
//                     of the workspace, with the same key the workspace wins, then the project created first (toolchain/routes.js,
//                     resolveWorkspaceVar).
// The field `origin` (toolchain/mcp-config.js varsMcpRow) names the source of each entry.
// A leaf without imports: the MCP server (own process, never reads the server tree) and the server (runs/system-prompt.js) read it.
// Guard: server/backend/test/prompt-audit.test.js.

/** What the tools deliver in project focus (without a sentence start, for "… deliver <that>"). */
export const CREDENTIALS_IN_PROJECT = "the credentials of THIS project plus those of the workspace, unless the project has hidden them (with the same key the project's wins)";

/** What they deliver without project focus. */
export const CREDENTIALS_WITHOUT_PROJECT = "those of the workspace plus those of all its projects (with the same key the workspace's wins)";

/** The whole sentence — base block and descriptions of cbase_vars_list/_get. */
export const CREDENTIALS_AREA = `In project focus that is ${CREDENTIALS_IN_PROJECT}; without project focus ${CREDENTIALS_WITHOUT_PROJECT}. The field origin names the source of each entry.`;
