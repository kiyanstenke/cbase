// The JSONL reader of the harnesses: returns only COMPLETED lines — everything up to the last "\n". No test (hence .mjs).
//
// The logs of the fake CLIs (turns, oneshots, argv, prompts, the spawn log of the golden harness) are written by a CHILD PROCESS
// while the test reads them. `appendFileSync(line + "\n")` is one write() — but a reader that grabs into the middle of a long line
// (a prompt of 15,000 characters) sees its start without an end: `JSON.parse` throws, and the test goes red with "Unterminated
// string" instead of its statement. The unfinished last line belongs to the writer; the next look sees it whole.
//
// If the file is missing, the log is empty. Empty lines are dropped.
import fs from "node:fs";

export function readJsonl(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const end = raw.lastIndexOf("\n");
  if (end < 0) return [];
  return raw.slice(0, end).split("\n").filter((z) => z.trim()).map((z) => JSON.parse(z));
}
