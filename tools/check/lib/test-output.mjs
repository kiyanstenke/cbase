// The verdict on ONE test suite.
//
// A file of its own because `check.mjs` is a target, not a module: the guards below are the only place that decides whether a
// run is green — and exactly those belong under a test of their own (`tools/check/test-output.test.mjs`, against REAL
// `node --test` output).
//
// Three guards over the numbers, each from a measured failure (a fourth, over the form, is further down):
//
//   1. Exit code. The obvious one.
//   2. `# fail N` with N > 0 — also at exit 0. The shell shorthand `ls && node --test || echo none` returned exit 0 after a
//      RED run, the table showed "# pass 74 # fail 1" with a green tick, and the gate passed.
//   3. `# skipped N` with N > 0. A skipped test counts as passed for `node --test` — the same trap as for XCUITest
//      ("Executed 145, 145 skipped, 0 failures" with SUCCEEDED), here on the Node side. Tests with a runtime condition
//      (`t.skip(…)`, mostly "node_modules missing (tsc)") never skip on the dev Mac, but all of them silently on a foreign
//      machine.
//
//      With ONE named exception: `expectedSkips`. On Linux four tests skip unavoidably — three at the macOS keychain, one at
//      the installed bundle under /Applications. They are listed as TITLES in `latch.json` under `onlyMacOS`, and the check
//      runs in BOTH directions: a skip that is not on the list is red (the guard stays sharp), and a title on the list that did
//      NOT skip is red too (the list may only shrink — otherwise after a repair it keeps covering something that long runs).
//      On macOS the list is empty and everything stays as it was.
//
// `# cancelled` and `# todo` deliberately do NOT count: an aborted run already shows through the exit code, and `todo` is an
// announcement, not a measurement.
//
// And a fourth, BEFORE the three: **an output from which the metrics cannot be read is not green.** "No `# fail N` line found"
// used to silently mean "0 failures" and "no `# skipped N`" "0 skipped" — "I don't know" became "passed". Two measured ways there:
//
//   · From Node 23 on, `node --test` writes the spec format (`ℹ skipped 1`, `﹣ title`) instead of TAP even WITHOUT a terminal.
//     Measured with Electron 44.4.4 as Node (Node 24.21.0): `valuesSuite` returned `{fail:0, skips:0, title:[], red:false}` for
//     a run with a skipped test — green, only the exit code held. Node 22.17.1 writes the same form line by line with
//     `--test-reporter=spec` (only the times differ); `test-output.test.mjs` measures against that. The suites in `check.mjs`
//     therefore carry `--test-reporter=tap` explicitly, and this guard catches the invocation that lacks it.
//   · An inherited `NODE_TEST_CONTEXT` makes the child `node --test` write NOTHING (only a warning on stderr, "run() is being
//     called recursively … skipping running files") and end with exit 0 — measured under Node 22.17.1, also for a failure.
//
// The one explicit exception is `NO_TESTS`: the suites in `check.mjs` write exactly this word when their glob finds nothing
// (`echo 'none'`). A read announcement "there is nothing here" is something other than an output nobody can read.

// Verbatim the same as `echo 'none'` in the suites of `targets/check.mjs` — `test-output.test.mjs` binds both sides.
export const NO_TESTS = "none";

// The form of an output. TAP is recognised by the header line or by a metrics line (the guard corner "skip detection no longer
// fits" builds TAP without a header); spec by the ℹ metrics.
export function outputForm(stdout) {
  if (/^TAP version \d+$/m.test(stdout) || /^# (tests|pass|fail) \d+$/m.test(stdout)) return "tap";
  if (/^ℹ (tests|pass|fail) \d+$/m.test(stdout)) return "spec";
  if (stdout.trim() === NO_TESTS) return "no";
  return "unreadable";
}

// The metrics shown in the table row — `skipped` ALWAYS, also as 0. A number that appeared only in the failure case could not be
// told from "nothing skipped". The spec form is read along so that the red row says what the run counted.
function metrics(stdout) {
  return (stdout.match(/^[#ℹ] (pass|fail|skipped) \d+$/gm) || []).join(" ");
}

// The titles of the skipped tests. `node --test` writes them as `ok N - <title> # SKIP`; the reason follows and does not matter
// here — we compare titles.
export function skipTitle(stdout) {
  return [...stdout.matchAll(/^ok \d+ - (.*?) # SKIP/gm)].map((m) => m[1].trim());
}

// What counts as PROGRESS in the TAP stream — the stall deadline of the suites (lib/gate-plan.mjs `suiteDeadlines`, lib/sh.mjs
// `stall`) restarts at every such line: a test result, `ok N` or `not ok N`, whatever the indentation (a subtest is a
// result too), followed by a space or the end of the line. NOT: `# Subtest: …` (the reporter writes it only immediately before
// the result, except for a group whose children are already running), comment lines `# …` (that is also where what a test itself
// writes to stdout lands — an "ok 1" from a test appears as `# ok 1`), YAML blocks. A line in a YAML block that happened to look
// like this never comes alone: the block stands immediately behind its result.
export function isTapResult(row) {
  return /^ *(?:not )?ok \d+(?: |$)/.test(row);
}

// The name in a result line, without directive (`# SKIP …`, `# TODO …`).
function resultName(row) {
  const m = row.match(/^ *(?:not )?ok \d+ - (.*)$/);
  return m ? m[1].replace(/ # (?:SKIP|TODO)\b.*$/, "").trim() : "";
}

// The subtests that have begun but are not reported: `# Subtest: X` at indentation e, without a result at the same indentation
// after it. With `node --test` these are the GROUPS of the foremost file whose children are already reported — the path to the
// running test as far as TAP reveals it. A test without children appears only with its result; which other file is running,
// TAP does not say (files behind the foremost report buffered).
export function openSubtests(stdout) {
  const stack = [];
  for (const z of stdout.split("\n")) {
    const on = z.match(/^( *)# Subtest: (.*)$/);
    if (on) {
      stack.push({ depth: on[1].length, name: on[2].trim() });
      continue;
    }
    if (!isTapResult(z)) continue;
    const depth = z.match(/^ */)[0].length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
  }
  return stack.map((s) => s.name);
}

/**
 * The verdict on a suite.
 *
 *   abort     null, or `{ kind: "stall" | "cap", ms }` if lib/sh.mjs aborted the suite (`stall` resp.
 *             `timedOut`) — the output is then truncated, and the row says so instead of the metrics.
 */
/** From the process lines of a stalled suite (lib/sh.mjs `running`): the test files whose child still ran. `node --test` runs one
 *  child per file (its argv names that ONE file); the runner itself names all of them and is left out. */
export function stillRunningFiles(lines = []) {
  const out = [];
  for (const l of lines) {
    const files = String(l).split(/\s+/).filter((w) => /\.test\.m?js$/.test(w));
    if (files.length === 1 && !out.includes(files[0])) out.push(files[0]);
  }
  return out;
}

export function valuesSuite(name, stdout, code, { expectedSkips = [], abort = null } = {}) {
  // An abort says that it is one, and WHICH: the silence (a hang) or the emergency cap on the total duration (it ran, but too long).
  // Otherwise only the last line of the TAP output would stand in the table — "...", the end of a YAML block — and no word of it.
  if (abort) {
    const reported = (stdout.match(/^(?:not )?ok \d+ - /gm) || []).length;
    const last = resultName(stdout.split("\n").filter(isTapResult).pop() || "");
    const open = openSubtests(stdout);
    const s = `${Math.round(abort.ms / 1000)} s`;
    const header = abort.kind === "stall" ? `Stall: ${s} without a test result` : `Emergency cap ${s} total duration expired`;
    const short = (t) => `„${t.slice(0, 120)}“`;
    const location = [
      last ? `last reported: ${short(last)}` : "no test result yet",
      open.length ? `open: ${open.map(short).join(" › ")}` : "",
    ].filter(Boolean).join("; ");
    const line = `${header} — aborted after ${reported} reported tests; ${location}`;
    const interpretation = abort.kind === "stall"
      ? "a test or hook hangs (the test after the last reported one is running, or the next file)"
      : "the suite kept reporting but did not finish";
    return {
      line, form: outputForm(stdout), fail: 0, skips: 0, title: [], unexpected: [], absent: [], red: true, last, open,
      reason: `${name} tests: ${line} — process group killed, no metrics; ${interpretation}`,
    };
  }
  const form = outputForm(stdout);
  const count = (field) => {
    const m = stdout.match(new RegExp(`^[#ℹ] ${field} (\\d+)$`, "m"));
    return m ? Number(m[1]) : 0;
  };
  const fail = count("fail");
  const skips = count("skipped");
  // Only TAP and the explicit empty announcement are readable. spec is readable for the numbers but not for the skip TITLES (the
  // onlyMacOS exceptions compare titles) — and it only arises if an invocation lacks `--test-reporter=tap`. Both mean: the
  // invocation needs repair.
  const formRed = form === "spec" || form === "unreadable";
  const title = skipTitle(stdout);
  const unexpected = title.filter((t) => !expectedSkips.includes(t));
  // An expected skip that does not happen: either the exception is repaired (then it belongs off the list) or the test is named
  // differently (then the list guards nothing). Both are red.
  const absent = expectedSkips.filter((t) => !title.includes(t));
  // If title detection fails (another TAP format), `title` is empty while `skips` counts — then the hard rule applies again. A
  // guard that goes blunt through a format change would be worse than one that trips too often.
  const titleUnclear = skips > 0 && title.length !== skips;
  const skipRed = titleUnclear ? true : unexpected.length > 0 || absent.length > 0;
  const line = metrics(stdout) || stdout.trim().split("\n").pop() || (form === "unreadable" ? "no output" : "");
  const red = code !== 0 || fail > 0 || formRed || skipRed;
  // The reason names the guard that trips first — a "failed" next to "# fail 0" has cost half an hour before.
  const reason = !red
    ? ""
    : code !== 0 || fail > 0
      ? `${name} tests failed`
      : form === "spec"
        ? `${name} tests: output in spec format instead of TAP — the invocation lacks --test-reporter=tap (Node ≥ 23 writes spec without a terminal; skip titles are not readable that way)`
        : form === "unreadable"
          ? `${name} tests: output without readable metrics (${stdout.trim() ? "neither TAP nor spec" : "empty"}) — not measured is not passed (inherited NODE_TEST_CONTEXT? missing reporter?)`
          : titleUnclear
            ? `${name} tests: ${skips} skipped, ${title.length} titles read — the skip detection no longer fits the output`
            : unexpected.length
              ? `${name} tests: ${unexpected.length} skipped unexpectedly (${unexpected.slice(0, 3).join(" · ")}) — a skip counts as passed for node --test`
              : `${name} tests: expected skipped but ran: ${absent.slice(0, 3).join(" · ")} — the exception belongs off latch.json (onlyMacOS)`;
  return { line, form, fail, skips, title, unexpected, absent, red, reason };
}
