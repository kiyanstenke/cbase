// "CPU saver": the ONE rule for priority and waiting of background work. A leaf with only node:* — the hook process
// (mcp/bash-guard.js), the connectors (providers/connectors/claude.js, codex.js), the loop engine (providers/tool-runtime.js) and
// the monitors read it.
//
// Whether a start "saves" is NOT decided by this leaf but by whoever builds the spec (runs/saver.js: switch on AND background
// work) — here only HOW: `nice -n 10` before the program (the children inherit it) and, before a new command, waiting while the CPU
// is overloaded, at most WAIT_CAP_MS. No command names, no lists: the measure is the machine's load.

import fs from "node:fs";
import os from "node:os";

/** The nice value of background work — measured: 10 brings the foreground from 4.2× to 1.8×, 19 hardly more. */
export const NICE_LEVEL = 10;
/** Overload from PSI `some avg10` ≥ this value (settled ≈ five to six runnable processes on four threads). */
export const PSI_THRESHOLD = 60;
/** The cap of the wait: after it the command starts despite the load. */
export const WAIT_CAP_MS = 120_000;
/** The deadline of the hook at the Claude CLI (seconds) — above the cap so that the CLI never aborts it (measured: it honors `timeout`). */
export const HOOK_DEADLINE_S = 150;
/** The marker on the hook's stderr or in the engine's event — by it agent-runtime.js recognizes "waiting for CPU". */
export const CPU_WAIT_MARKER = "CBASE-CPU-WAIT";

/**
 * Program and arguments of a start — with `saver` under `nice -n 10`, otherwise EXACTLY the ones passed (the same array).
 * `nice` replaces itself with the program via exec: pid, process group and argv[0] stay those of the program.
 * @returns {[string, string[]]}
 */
export function withNice(program, args, saver) {
  if (saver !== true) return [program, args];
  return ["nice", ["-n", String(NICE_LEVEL), program, ...args]];
}

// Test seam: CBASE_CPU_LAST_FILE replaces /proc/pressure/cpu (a file in PSI format), CBASE_CPU_LOAD_FILE /proc/loadavg.
const psiFile = () => process.env.CBASE_CPU_LAST_FILE || "/proc/pressure/cpu";
const loadFile = () => process.env.CBASE_CPU_LOAD_FILE || "/proc/loadavg";

/** PSI `some avg10` — `null` if not readable (macOS, old kernel): unknown is not "calm", then `overload` asks the load. */
export function psiSome(text = null) {
  let t = text;
  if (t === null) { try { t = fs.readFileSync(psiFile(), "utf8"); } catch { return null; } }
  const m = /^some\b.*?\bavg10=([0-9.]+)/m.exec(String(t));
  return m ? Number(m[1]) : null;
}

/**
 * Is the CPU overloaded? `{ over, mass, value, threshold }` — PSI if readable; otherwise the 1-min load against the core count;
 * if neither is readable, `over: false` (then nobody waits — the waiting must never hang on its own measuring error).
 */
export function overload() {
  const psi = psiSome();
  if (psi !== null) return { over: psi >= PSI_THRESHOLD, mass: "psi", value: psi, threshold: PSI_THRESHOLD };
  let load = null;
  try { load = Number(String(fs.readFileSync(loadFile(), "utf8")).split(/\s+/)[0]); } catch { /* see below */ }
  if (!Number.isFinite(load)) load = process.platform === "win32" ? NaN : os.loadavg()[0];
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  if (!Number.isFinite(load) || !cores) return { over: false, mass: "none", value: null, threshold: null };
  return { over: load > cores, mass: "load", value: load, threshold: cores };
}

const capMs = () => { const n = Number(process.env.CBASE_CPU_WAIT_MAX_MS); return Number.isFinite(n) && n >= 0 ? n : WAIT_CAP_MS; };
const tickMs = () => { const n = Number(process.env.CBASE_CPU_WAIT_TICK_MS); return Number.isFinite(n) && n > 0 ? n : 2000 + Math.floor(Math.random() * 1000); };

/**
 * Wait while the CPU is overloaded — at most the cap. Without overload it returns immediately (no tick).
 * `atBegin(status)` is called as soon as it really waits; `signal` aborts (the command then does not start — the caller
 * decides). Result: `{ waitedMs, reason: "free" | "cap" | "aborted", status }`.
 */
export async function waitForCpu({ atBegin = null, signal = null } = {}) {
  let status = overload();
  if (!status.over) return { waitedMs: 0, reason: "free", status };
  const start = Date.now();
  const cap = capMs();
  try { atBegin?.(status); } catch { /* the display must not topple the waiting */ }
  for (;;) {
    if (signal?.aborted) return { waitedMs: Date.now() - start, reason: "aborted", status };
    const rest = cap - (Date.now() - start);
    if (rest <= 0) return { waitedMs: Date.now() - start, reason: "cap", status };
    await new Promise((r) => {
      const t = setTimeout(r, Math.min(tickMs(), rest));
      signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
    status = overload();
    if (!status.over) return { waitedMs: Date.now() - start, reason: "free", status };
  }
}

/** The sentence at the start of the wait (stderr of the hook, event of the engine) — with the marker in front. */
export const waitText = (state) =>
  `${CPU_WAIT_MARKER} CPU saver: CPU overloaded (${state.mass} ${state.value} ≥ ${state.threshold}) — the command waits up to ${Math.round(capMs() / 1000)} s.`;

/** The sentence at the end — says when the cap applied (the command starts despite the load). */
export const endText = (r) => r.reason === "cap"
  ? `CPU saver: cap of ${Math.round(capMs() / 1000)} s reached — the command starts despite the load.`
  : `CPU saver: free after ${Math.round(r.waitedMs / 1000)} s.`;

/**
 * What an event of an agent says about waiting for CPU (read in providers/agent-runtime.js makeForward): `true` begins
 * (`system/hook_progress` of a PreToolUse with the marker on stderr — that is how the CLI reports the hook, measured on 2.1.296 with
 * `--include-hook-events`; the engine sends the same), `false` ends (`hook_response`, a tool call or result),
 * `null` says nothing. Pure.
 */
export function cpuWaitFrom(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "system" && evt.hook_event === "PreToolUse") {
    if (evt.subtype === "hook_progress") return String(evt.stderr || "").includes(CPU_WAIT_MARKER) ? true : null;
    return evt.subtype === "hook_response" ? false : null;
  }
  return evt.type === "user" || evt.type === "assistant" ? false : null;
}

/** The event with which the loop engine reports the wait — the same shape the Claude CLI sends for the hook. */
export const cpuWaitEvent = (enabled, text) => ({
  type: "system", subtype: enabled ? "hook_progress" : "hook_response", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse",
  stdout: "", stderr: String(text || ""), output: String(text || ""),
});
