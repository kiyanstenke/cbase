// Runs the agent hooks (Claude Code style: one shell command per event, the event as JSON on stdin) — ONE path for the
// hooks of the loop engine (engine.js) and the "SubagentStop" hook of the subagent core (runs/agents.js). Configured via
// toolchain/profiles.js loadAgentHooks.
//
// matchingHooks(hooks, event, name)          the hooks of an event; `matcher` "*"/empty = all, otherwise a RegExp against
//                                            `name` (tool name, for SubagentStop the agent type), unparsable = equality
// executeHook(command, payload, { instance, cwd })
//                                            one hook: process via runtime/inProject.js inProject (without an instance
//                                            exactly spawn), in an agent's shell (withLfsEnvironment), own process group;
//                                            the deadline (`CBASE_HOOK_DEADLINE_MS`, default 30 s, read at runtime) ends
//                                            the GROUP and resolves immediately. → `{ code, out, err }`, never throws.
// fireAgentHook(event, payload, { hooks, instance, cwd, name, sessionId })   (runningHooks(): all running ones as one promise)
//                                            events without feedback: every matching hook with
//                                            `{ hook_event_name, …payload, cwd, session_id }`; an error never fails the run.
import { inProject } from "../runtime/inProject.js";
import { withLfsEnvironment } from "../runs/lfs-environment.js";
import { endGroup } from "./tool-runtime.js";
import { writeStdin } from "./kind-stdin.js";

export function matchingHooks(hooks, event, name) {
  return (hooks || []).filter((h) => {
    if (!h || h.event !== event || !h.command) return false;
    if (!h.matcher || h.matcher === "*") return true;
    try { return new RegExp(h.matcher).test(name || ""); } catch { return h.matcher === name; }
  });
}

export function executeHook(command, payload, { instance = null, cwd } = {}) {
  const deadline = Number(process.env.CBASE_HOOK_DEADLINE_MS) || 30_000;
  const shellBin = process.env.SHELL && process.env.SHELL.length ? process.env.SHELL : "/bin/bash";
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    // Own process group, and the deadline ends the GROUP and resolves immediately (pattern: tool-runtime.js endGroup):
    // killing only the shell would leave a grandchild of the hook alive as an orphan, and if it held stdout, `close`
    // would never come and the run would hang on its hook.
    // A hook is an agent shell like its Bash (with the Claude CLI the hooks inherit the LFS environment as well).
    try { child = inProject(instance, shellBin, ["-c", command], withLfsEnvironment(instance, { cwd, env: process.env, detached: process.platform !== "win32" })); }
    catch (e) { return resolve({ code: 1, out: "", err: String(e?.message || e) }); }
    const timer = setTimeout(() => {
      endGroup(child);
      resolve({ code: null, out, err: `${err}\n[Hook deadline of ${deadline} ms expired — hook and its process group ended]` });
    }, deadline);
    // No try/catch here: a stream error arrives asynchronously, a catch would never see it (writeStdin handles it).
    writeStdin(child, JSON.stringify(payload), { close: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out, err: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const running = new Set(); // the promises of the firing events, until they end
export function fireAgentHook(event, payload = {}, { hooks, instance = null, cwd, name = payload?.tool_name, sessionId = "" } = {}) {
  const run = (async () => {
    for (const h of matchingHooks(hooks, event, name)) {
      try { await executeHook(h.command, { hook_event_name: event, ...payload, cwd, session_id: sessionId }, { instance, cwd }); } catch { /* hooks must never fail a run */ }
    }
  })();
  running.add(run);
  run.finally(() => running.delete(run));
  return run;
}
// Whatever is firing right now, as ONE promise — a caller that does not wait (the core on SubagentStop) can still await
// the end: a test waits for the event instead of a duration.
export const runningHooks = () => Promise.allSettled([...running]);
