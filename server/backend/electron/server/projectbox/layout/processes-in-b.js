// Processes IN B under the affected paths of a layout. ONE computation for the quiet check (job.js quietAsync, part "In B") and for
// step 5 (a) of the procedure (procedure.js) — until now the same check stood twice, and both knew only the main CLI process of a
// RUNNING turn.
//
// WHAT WAS MISSING: a subagent is a CLI process of its own of the core (providers/agent-runtime.js, no child of the main CLI) and lives
// as a background agent beyond the turn (the chat then no longer stands in `running`); the bash of the loop engine
// (providers/tool-runtime.js) is a child of the server itself; a background server that an agent started with `nohup … &` hangs on
// PID 1 after its shell ended. None of them descended from the main CLI — the folder was moved or deleted under them. cbase nowhere
// keeps the pids of these processes per chat (the core does not expose them), so what counts here is what /proc says: EVERY process
// in B (same mount namespace, not B itself and none of its ancestors — proc-program.js procCore) with cwd, program or open file under
// an affected path holds, unless it belongs to a terminal (the terminals have their own way: foreground holds in the quiet check,
// step 6 ends the session). If it descends from the main CLI of a chat (runChildren, every chat, not only one in the workspace without
// a project), it is that chat's turn — "Stop" ends it; otherwise a process without a known run, not stoppable (it ends by itself, or a
// human ends it in a terminal).
//
//   processesInB({ paths, roots, sessions? })   → { findings, holders, truncated }
//       `findings` the raw hits (for the terminal check of the quiet check and step 6), `holders` rows in the form of the quiet check
//       (`{ kind: "turn" | "process" | "check", id, chatId?, name, text, stoppable }`). Throws if /proc is not readable (the caller makes
//       "not checkable" of it — empty is not unknown).
//   remainingInB(opts, { quietMs, wait })       → the same shape: two looks `quietMs` apart (default `bQuietMs()`), only who is in BOTH with
//       the same pid counts (like relocation/processes.js remainingProcesses: a short process, say a `git status`, would otherwise send
//       step 5 into the return path including a restart of the stopped containers). Knob CBASE_LAYOUT_B_QUIET_MS (default 2 s; tests 0).
//
// Foreign text (process and chat names) stands only as data in `name`. Never command line or environment.
import fs from "node:fs";
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { runChildren } from "../../runs/state.js";
import { terminalSessions } from "../../terminal.js";
import { processSeamRoot } from "../relocation/processes.js";
import { procInB } from "./proc-program.js";

export const B_QUIET_MS = 2_000;
export function bQuietMs() {
  const raw = process.env.CBASE_LAYOUT_B_QUIET_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : B_QUIET_MS;
}

const short = (s, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const chatName = (chatId) => { try { return short(store.getChat(chatId)?.title || "") || String(chatId); } catch { return String(chatId); } };

/** The processes in B under `paths` (see header). */
export function processesInB({ paths, roots = [], sessions = terminalSessions() } = {}) {
  const r = procInB(fs, "processes", { paths, roots }, processSeamRoot());
  const findings = r.processes || [];
  // Every terminal session (PTY in B — also that of a terminal in the project container, its `docker exec` runs in B): its shell is the
  // leader of the session, its processes carry its pid as `sid` or in the ancestor chain.
  const terminals = sessions.map((s) => s.pid).filter((p) => Number.isInteger(p) && p > 1);
  const ofTerminal = (x) => terminals.some((t) => x.pid === t || x.sid === t || (x.chain || []).includes(t));
  const runs = [...runChildren].map(([c, k]) => [c, k?.pid]).filter(([, p]) => Number.isInteger(p) && p > 1);
  const holders = [];
  const alongside = (h) => { if (!holders.some((x) => x.kind === h.kind && x.id === h.id)) holders.push(h); };
  for (const x of findings) {
    if (ofTerminal(x)) continue;
    const run = runs.find(([, p]) => x.pid === p || (x.chain || []).includes(p));
    if (run) {
      alongside({ kind: "turn", id: run[0], chatId: run[0], name: chatName(run[0]), text: T("A chat is working in an affected folder in B."), stoppable: true });
      continue;
    }
    alongside({
      kind: "process", id: `b:${x.pid}`, name: short(x.name),
      text: T`The process “${short(x.name, 40)}” (pid ${x.pid}) is working in an affected folder in B — for example a subagent, a tool or a background server of a chat.`,
      stoppable: false,
    });
  }
  if (r.truncated) {
    alongside({ kind: "check", id: "processes-b", name: "", text: T`${r.truncated} processes work in affected folders in B — too many to list one by one.`, stoppable: false });
  }
  return { findings, holders, truncated: r.truncated || 0 };
}

/** Two looks (see header): only who is in both. */
export async function remainingInB(opts = {}, { quietMs = bQuietMs(), wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }) } = {}) {
  const first = processesInB(opts);
  if (!first.holders.length) return first;
  if (quietMs > 0) await wait(quietMs);
  const then = processesInB(opts);
  const prior = new Set(first.findings.map((x) => x.pid));
  const stay = new Set(then.findings.filter((x) => prior.has(x.pid)).map((x) => x.pid));
  const holders = then.holders.filter((h) => {
    if (h.kind === "check") return true;
    if (h.kind === "process") return stay.has(Number(String(h.id).slice(2)));
    // A turn holds if one of ITS processes stood in both looks.
    const run = runChildren.get(h.chatId)?.pid;
    return then.findings.some((x) => stay.has(x.pid) && (x.pid === run || (x.chain || []).includes(run)));
  });
  return { findings: then.findings.filter((x) => stay.has(x.pid)), holders, truncated: then.truncated };
}
