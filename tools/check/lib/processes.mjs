// Which provider processes hold the idle gate up?
//
// The oneshot detection runs TWICE — locally over the descendants of the app (`ps`), in the container over
// `ps -ww -eo pid=,args=` (see `providerRows`) —, and both ask here. A leaf without imports: the backend test that holds the
// command lines of real agent starts against it (server/backend/test/active-runs.test.js) loads it without the tool's
// configuration.
//
// Every `claude … stream-json` and `codex exec` process counts as busy — except an AGENT OF A DYNAMIC WORKFLOW: the run has
// a journal and is resumed after the swap, the deploy does not wait for it. A subagent (cbase_agent) has no journal and
// still holds the deploy up.
//
// The PROCESS MARKER sits in the command line, not in the environment (`ps -o args` does not see that):
//  · Claude: `--mcp-config <scratch>/<chat>.agent-<id>.workflow.mcp.json` (runs/agents.js agentMcpFile; a subagent has
//    `….agent-<id>.mcp.json`);
//  · Codex: the MCP environment goes out as `-c mcp_servers.<server>.env.CBASE_WORKFLOW_AGENT="<id>"`
//    (providers/connectors/codex.js pushMcpConfig, set in toolchain/mcp-config.js).
// The loop engine runs in the backend process and has no process of its own.
//
// PROJECT CONTAINERS. A start of a converted project appears in the user container as a WRAPPER row — `docker exec …
// <container> /usr/sbin/cbase-wrapper --pgid-file P -- claude …` (runtime/inProject.js), briefly also `perl
// …/cbase-wrapper … -- claude …` — and, if `ps` in B sees the processes of the project container, next to it as an INNER
// line `claude …` (the wrapper replaces itself via exec, argv[0] stays the command). The same start must not count twice:
// `partsProcesses` drops a wrapper row if its inner line (the part behind the first ` -- ` after `cbase-wrapper`) is itself
// present — as a MULTISET, every visible inner line consumes exactly one wrapper. Several wrapper rows with the SAME
// pgid file (`docker exec` in B and, until its exec, `perl …` in the container) are one start. If B does not see the inner
// line, the wrapper counts for it. The marker of a workflow agent is the same in both rows (`WORKFLOW_AGENT_RE` stays on
// the name of the MCP file).
//
// MASKING (`mask`): before a command line goes into the deploy log (gates.mjs, locally and per container), values behind
// `-e NAME=…`/`--env NAME=…` and `…env.<NAME>=…` (Codex `-c mcp_servers.<n>.env.<NAME>=…`) are replaced by `***`. The names
// stay (they say what it was); classification happens before, on the raw line.

export const ONESHOT_RE = /(^|\/)claude\s+.*(\s-p(\s|$)|--output-format|stream-json)|codex\s+exec/;

export const WORKFLOW_AGENT_RE = /\.agent-[^\s/]+\.workflow\.mcp\.json(\s|$)|\smcp_servers\.[^\s.]+\.env\.CBASE_WORKFLOW_AGENT=/;

/** Does this command line carry the marker of a workflow agent? */
export const isWorkflowAgent = (cmd) => WORKFLOW_AGENT_RE.test(String(cmd || ""));

const WRAPPER_RE = /(^|[\s/])cbase-wrapper(\s|$)/;

/** The inner command line of a wrapper row (behind the first ` -- ` after `cbase-wrapper`), otherwise null. */
export function wrappersInner(cmd) {
  const s = String(cmd || "");
  const m = WRAPPER_RE.exec(s);
  if (!m) return null;
  const j = s.indexOf(" -- ", m.index);
  return j < 0 ? null : s.slice(j + 4).trim() || null;
}

// A row without leading pid (in the container "<pid> <command line>", locally `{cmd}` comes without).
const withoutPid = (cmd) => String(cmd || "").trim().replace(/^\d+\s+/, "");
// Is `row` the process of `inner`? Equal, or with a prefixed interpreter/path (`node /…/codex exec …` for
// `codex exec …`, `node /tmp/…/fake-claude …` for `/tmp/…/fake-claude …`).
const isInner = (row, inner) => row === inner || row.endsWith(` ${inner}`) || row.endsWith(`/${inner}`);

/** Splits entries already recognized as provider processes (locally `{cmd}` objects by ONESHOT_RE, in the container the rows
 *  of `providerRows`) into those that hold the gate up and the workflow agents. A wrapper row whose inner row is itself
 *  present does not count additionally (see header). */
export function partsProcesses(entries, read = (e) => (typeof e === "string" ? e : e?.cmd)) {
  const list = [...(entries || [])];
  const wrappers = [];
  for (const e of list) {
    const inner = wrappersInner(read(e));
    if (inner) wrappers.push({ e, inner, pgid: /--pgid-file\s+(\S+)/.exec(String(read(e)))?.[1] || null, consumed: false });
  }
  // Several wrapper rows of the same start (same pgid file) count as one — the first stands for it.
  const first = new Set();
  for (const h of wrappers) {
    if (!h.pgid) continue;
    if (first.has(h.pgid)) h.consumed = true;
    else first.add(h.pgid);
  }
  if (wrappers.length) {
    for (const e of list) {
      if (wrappers.some((h) => h.e === e)) continue;
      const row = withoutPid(read(e));
      const h = wrappers.find((x) => !x.consumed && isInner(row, x.inner));
      if (h) h.consumed = true;
    }
  }
  const holds = [], workflow = [];
  for (const e of list) {
    if (wrappers.some((h) => h.e === e && h.consumed)) continue;
    (isWorkflowAgent(read(e)) ? workflow : holds).push(e);
  }
  return { holds, workflow };
}

// In the container the gate reads the WHOLE process list (`ps -ww -eo pid=,args=`, one line per process) and decides here,
// in JS, with the SAME rule as locally (ONESHOT_RE) — plus the wrapper row of a converted project, whose command stands
// behind ` -- ` (where `(^|\/)claude` does not apply). A `pgrep` pattern like `claude --` would never hit: cbase always
// starts Claude with `-p` first (providers/connectors/claude.js buildClaudeChatArgs, buildClaudeOnceArgs).
/** Is this command line (without pid) a provider process — directly or as the wrapper of a project container? */
export function isProviderRow(cmd) {
  const z = String(cmd || "");
  if (ONESHOT_RE.test(z)) return true;
  const inner = wrappersInner(z);
  return Boolean(inner) && ONESHOT_RE.test(inner);
}

/** The output of `ps -ww -eo pid=,args=` → the rows "<pid> <command line>" of the provider processes (for partsProcesses). */
export function providerRows(psOutput) {
  const out = [];
  for (const raw of String(psOutput ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(raw);
    if (m && isProviderRow(m[2])) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/** Make values in a command line unrecognizable before it goes into the log (see header). */
export function mask(cmd) {
  return String(cmd ?? "")
    .replace(/(\s(?:-e|--env)(?:\s+|=))([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g, "$1$2=***")
    .replace(/(\benv\.[A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g, "$1=***");
}
