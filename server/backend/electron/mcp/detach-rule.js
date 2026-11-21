// The ONE rule against detached shell commands. A suite once ran as a background command, or under a monitor that died with the
// turn — the agent believed it would be notified. A command that is meant to outlive the end of the answer is a MONITOR in cbase
// (belongs to the chat, reports back, can be stopped); what detaches from the shell dies at the end of the turn or keeps running
// invisibly. Therefore it is refused at the CALL, not just explained.
//
// Who asks:
//   - Claude: the PreToolUse hook `mcp/bash-guard.js` (via `--settings` in every chat, subagent and workflow agent run,
//     providers/connectors/claude.js `bashGuardSettings`) — the refusal comes back as a tool result, the turn goes on.
//   - Loop engine (OpenRouter etc.): providers/tool-runtime.js before `Bash`.
//   - Codex: NOT — the Codex CLI runs its shell itself, cbase sees the command only afterwards. There the prompt and the tool
//     description carry the rule alone (known gap).
// The same sentences stand in the system prompt (runs/system-prompt.js via mcp/monitor-rule.js) — execution and description side
// say the same because it is the same text. Guard: server/backend/test/detach-rule.test.js.
//
// The detection is deliberately modest (word level, no shell grammar). Detected, outside quotes and comments:
//   run_in_background: true · nohup · setsid · disown · daemonize · start-stop-daemon · `screen` with -d/-dm… · `tmux new|new-session`
//   with -d · a single `&` as a control character (end or before the next command) — unless the command contains `wait` (then
//   the shell itself waits for its children, and that is allowed).
// Not refused: `&&`, `&>`, `&>>`, `>&`, `2>&1`, `|&`, `<&`, a `&` in quotes, `\&`.
// Known gaps (honestly): a detach inside a script the command calls (`./start.sh`), in `bash -c "…"`/`sh -c '…'` (the inner text is
// a string), via `eval`, in a here-doc, via `systemd-run`, `at`, `(cmd &)` with `wait` elsewhere, or a program that daemonizes
// itself (`docker run -d`, `pm2 start`). The prompt catches those.
//
// A leaf without imports: the hook process, the MCP server and the server read it.

/** The refusal — short, with the way out. */
export const DETACH_REFUSAL = "Refused: In cbase, background shells (run_in_background, nohup, setsid, disown, a trailing &, screen/tmux -d) die with the end of your answer, or keep running invisibly — nobody tells you when they end. Start the command as cbase_monitor instead, with report: \"end\" (reports once with the exit code when it is done) or report: \"rows\" (every matching line wakes you). Run short commands normally in the foreground.";

/**
 * The sentence for prompt and tool description. Provider-neutral and with separate ways: "Bash with run_in_background … where cbase
 * runs the shell" was wrong for Codex (exec_command/write_stdin, cbase sees the command only afterwards — see above), and
 * "you start as cbase_monitor (a service via cbase_service_start)" left open what belongs where. It is the ONLY place of the
 * prohibition in the system prompt — MONITOR_RULE (mcp/monitor-rule.js) does not repeat it.
 */
export const DETACH_RULE = "A shell command in the background (such as run_in_background) and any detaching (nohup, setsid, disown, a trailing &, screen/tmux -d) are forbidden in cbase: such processes die with the end of your answer or keep running invisibly — where cbase sees the command before execution, it refuses it. A service that should keep running you start with cbase_service_start; a command with an end (build, test suite, deploy) whose result you wait for, as cbase_monitor.";

const WORDS = new Set(["nohup", "setsid", "disown", "daemonize", "start-stop-daemon"]);

/**
 * The command without quote contents and comments: every character in '…', "…" or after `\` becomes `_`, a comment
 * (`#` at a word start) up to the end of the line is dropped. Pure, exported for the guard.
 */
export function withoutQuotes(command) {
  const s = String(command ?? "");
  let out = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < s.length) { out += "__"; i++; continue; }
      if (c === quote) { quote = ""; out += c; continue; }
      out += "_";
      continue;
    }
    if (c === "\\" && i + 1 < s.length) { out += "__"; i++; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** Is there a single `&` as a control character at position i (not &&, &>, >&, |&, <&)? */
function individualAnd(s, i) {
  if (s[i] !== "&") return false;
  const before = s[i - 1] || "";
  const next = s[i + 1] || "";
  if (before === "&" || next === "&") return false; // &&
  if (next === ">") return false; // &> and &>>
  if (before === ">" || before === "<" || before === "|") return false; // >&, 2>&1, <&, |&
  return true;
}

/**
 * Why this Bash call is refused — `null` if it is allowed. `input`: the tool's input
 * (`{ command, run_in_background }`). Pure.
 */
export function detachReason(input) {
  const e = input && typeof input === "object" ? input : {};
  if (e.run_in_background === true || e.run_in_background === "true") return { form: "run_in_background", text: DETACH_REFUSAL };
  const raw = typeof e.command === "string" ? e.command : "";
  if (!raw.trim()) return null;
  const s = withoutQuotes(raw);
  const words = s.split(/[\s;|&()<>`]+/).filter(Boolean);
  for (const w of words) {
    const name = w.split("/").pop();
    if (WORDS.has(name)) return { form: name, text: DETACH_REFUSAL };
  }
  // screen -d / -dm / -dmS …: a flag that begins with -d (letters only), anywhere after `screen`.
  for (let i = 0; i < words.length; i++) {
    const name = words[i].split("/").pop();
    if (name === "screen" && words.slice(i + 1).some((w) => /^-[A-Za-z]*d[A-Za-z]*$/.test(w) && w.startsWith("-d"))) return { form: "screen -d", text: DETACH_REFUSAL };
    if (name === "tmux") {
      const rest = words.slice(i + 1);
      const k = rest.findIndex((w) => w === "new" || w === "new-session" || w === "new-window");
      if (k >= 0 && rest.slice(k + 1).some((w) => /^-[A-Za-z]*d[A-Za-z]*$/.test(w))) return { form: "tmux -d", text: DETACH_REFUSAL };
    }
  }
  const waiting = words.includes("wait");
  if (!waiting) {
    for (let i = 0; i < s.length; i++) if (individualAnd(s, i)) return { form: "&", text: DETACH_REFUSAL };
  }
  return null;
}
