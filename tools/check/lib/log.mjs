// Output: console (terse, colored) + complete recording into a log file.
// Every measurement, command and answer lands in the log — after a deploy it should be
// traceable WHAT was measured, not only that it "worked".
import fs from "node:fs";
import path from "node:path";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c("2");
export const bold = c("1");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("36");

let stream = null;
let logPath = null;

export function openLog(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, `${name}.log`);
  stream = fs.createWriteStream(logPath, { flags: "a" });
  raw(`=== ${new Date().toISOString()} ${name} ===`);
  return logPath;
}

export function logFile() {
  return logPath;
}

/**
 * Close the log stream and WAIT for the write — before any hard end of the tool.
 *
 * `createWriteStream` writes asynchronously; `process.exit` does not wait for the backlog. Measured: real aborts
 * carried NO FAIL row in their log — one ended in the middle of the lsof output — and on an early abort the file does
 * not exist at all. The reason for the abort then stood only on the console; whoever looks into the log the next day
 * finds a run that stops without a word.
 */
export function closeLog() {
  const s = stream;
  stream = null;
  if (!s) return Promise.resolve();
  return new Promise((resolve) => {
    s.end(() => resolve());
    s.on("error", () => resolve());
  });
}

function raw(line) {
  if (stream) stream.write(line.endsWith("\n") ? line : line + "\n");
}

// Raw output of a child process: into the log only, not onto the console.
export function trace(chunk) {
  if (!stream) return;
  for (const line of String(chunk).split("\n")) if (line.trim()) raw(`    | ${line}`);
}

// Each step carries its start — as `[+m:ss]` since the start of the tool in both outputs, and at the end as a
// "duration per step" table (`durationTable`). Reason: the log used to have NO time, and the question "why twelve
// minutes?" could only be reconstructed from the mtimes of artifacts. A duration that is in the log can be read.
const START = Date.now();
const steps = [];

export function mmss(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function step(title) {
  const at = Date.now();
  steps.push({ title, at });
  const line = `\n${bold("▸ " + title)} ${dim(`[+${mmss(at - START)}]`)}`;
  console.log(line);
  raw(`\n## ${title}  [+${mmss(at - START)}]`);
}

// Duration per step (from the gaps between the `step` calls; the last ends now) plus total.
export function durationTable() {
  const now = Date.now();
  const rows = steps.map((s, i) => [s.title, mmss((steps[i + 1]?.at ?? now) - s.at), null]);
  rows.push(["total", mmss(now - START), null]);
  return rows;
}

export function info(msg) {
  console.log(`  ${msg}`);
  raw(`  ${msg}`);
}

export function detail(msg) {
  console.log(dim(`  ${msg}`));
  raw(`  ${msg}`);
}

export function ok(msg) {
  console.log(`  ${green("✓")} ${msg}`);
  raw(`  OK   ${msg}`);
}

export function warn(msg) {
  console.log(`  ${yellow("!")} ${msg}`);
  raw(`  WARN ${msg}`);
}

export function fail(msg) {
  console.log(`  ${red("✗")} ${msg}`);
  raw(`  FAIL ${msg}`);
}

export function cmdLine(msg) {
  console.log(dim(`  $ ${msg}`));
  raw(`  $ ${msg}`);
}

// Small measurement table: [[label, value, state]] with state "ok" | "warn" | "bad" | null.
export function table(rows) {
  const w = Math.max(...rows.map((r) => String(r[0]).length));
  for (const [label, value, state] of rows) {
    const mark = state === "ok" ? green("✓") : state === "warn" ? yellow("!") : state === "bad" ? red("✗") : " ";
    console.log(`  ${mark} ${String(label).padEnd(w)}  ${value}`);
    raw(`  ${state || "-"}  ${String(label).padEnd(w)}  ${value}`);
  }
}

export function section(title) {
  console.log(`\n${bold(title)}`);
  raw(`\n# ${title}`);
}
