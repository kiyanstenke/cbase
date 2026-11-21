// A short process in the instance of the language service: the project's formatter (Prettier, ruff, black — lsp/formatter.js)
// and the check of the Python interpreters (lsp/interpreter.js). Started through runtime/inProject.js `inProject` with the
// target's instance — with an instance in the project container (in a copy, in its overlay view), without one in B with the
// secret-free environment (lsp/sessions.js environmentInB) and as leader of its own process group. The text goes in through
// stdin (providers/kind-stdin.js — never bypassing the watchdog), the answer comes back on stdout.
//
// CAPS are reported: deadline (`deadlineMs`, default RUN_DEADLINE_MS) and output (`maxBytes`, default RUN_MAX_BYTES) — when one
// hits, the process is killed (with an instance the group in the container, runtime/inProject.js; without, its own group in B)
// and the result says so (`cap: "deadline" | "output"`), never a silent truncation.
import { inProject } from "../runtime/inProject.js";
import { closeStdin, writeStdin } from "../providers/kind-stdin.js";
import { environmentInB } from "./sessions.js";

export const RUN_DEADLINE_MS = 20_000;
export const RUN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `program args` in instance `inst` (null: in B). → `{ code, signal, stdout, stderr, cap? }`; throws only if the start itself
 * fails (ENOENT of a program in B; errors of the docker CLI arrive as an exit code).
 */
export function runInProject(inst, program, args, { cwd, stdin = null, deadlineMs = RUN_DEADLINE_MS, maxBytes = RUN_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let kind;
    try {
      kind = inProject(inst, program, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...(inst ? {} : { env: environmentInB(), detached: true }) });
    } catch (e) { reject(e); return; }
    const out = [];
    let length = 0;
    let error = "";
    let cap = null;
    let finished = false;
    const end = () => {
      if (inst) { try { kind.kill("SIGKILL"); } catch { /* gone */ } return; }
      try { process.kill(-kind.pid, "SIGKILL"); } catch { try { kind.kill("SIGKILL"); } catch { /* gone */ } }
    };
    const tick = setTimeout(() => { cap = "deadline"; end(); }, deadlineMs);
    tick.unref?.();
    kind.stdout.on("data", (c) => {
      length += c.length;
      if (length > maxBytes) { if (!cap) { cap = "output"; end(); } return; }
      out.push(c);
    });
    kind.stderr.on("data", (c) => { error = (error + String(c)).slice(-4000); });
    kind.on("error", (e) => { if (finished) return; finished = true; clearTimeout(tick); reject(e); });
    kind.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(tick);
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: error, ...(cap ? { cap } : {}) });
    });
    if (stdin !== null && stdin !== undefined) writeStdin(kind, stdin, { close: true });
    else closeStdin(kind);
  });
}
