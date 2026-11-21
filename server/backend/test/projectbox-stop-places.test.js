// Guard of ALL stop places of the containers in the daemon of B: cbase's OWN stops of a project or copy container NEVER trigger
// a resumption (projectbox/resumption.js). Pattern: in-project-start-places.test.js (table in the wording, built-in sabotage).
//
// The promises, each with the way that breaks it:
//   (1) SOURCE TABLE. Every call of a seam function that starts a child in the daemon of B (docker, dockerKind,
//       dockerChildAfterThaw, dockerStream — projectbox/docker.js — and localDocker, services.js) whose command is `stop`,
//       `rm`, `kill` or `restart` (also `container <verb>`) is listed in STOP_PLACES — file, function, command, count, reason
//       why its `die` triggers no resumption. Red: a new place without an entry, another count, an entry without a place (the
//       list follows the tree), a stop through dockerKind/dockerChildAfterThaw/dockerStream (they bypass the mark "cbase stops
//       itself" in docker()) and a stop that bypasses docker() without `withoutMarker` with a reason.
//   (2) DYNAMIC CALLS. A call whose command the guard cannot read (`docker(args)`, `docker(asAgent(…))`, an array that starts
//       with a spread or a variable) is listed with a reason in DYNAMIC — otherwise it would hide a stop. Red: a new one, a
//       missing one, another count.
//   (3) HEADER AND GUARD SAY THE SAME. Every file of STOP_PLACES is in the table "THE STOP PLACES" in the header of
//       projectbox/resumption.js, and every file there has an entry here.
//   (4) BUILT-IN SABOTAGE: a new stop place (also multi-line, also as `container stop`, also through dockerKind), a missing
//       one, a multiplied one, a hidden dynamic call, a header line without a place and a place without a header line — each red
//       with the expected sentence.
//   (5) PLACES OUTSIDE THE BACKEND. Two stops of the project containers do NOT go through docker.js docker(), because they do
//       not run in the backend: server/gateway/containers.js stopProjectContainer (`docker exec -u agent B sh -c
//       PROJECT_STOP_SCRIPT`; unhealthy B in ensureRunning, destroy before the stop of B) and server/backend/entry.sh
//       project_container_stop (without network cut, before the backend). They are in EXTERNAL_PLACES, also with a line in the
//       header of resumption.js. Red: a second `docker stop` in the gateway source or in entry.sh (a new place without an entry),
//       stopProjectContainer without the mark "B ends" (`exec -u root` with B_ENDS_SCRIPT) BEFORE the script, entry.sh without
//       removing the mark at every start (a text comparison — that the rm RUNS is driven by tools/check/entry-sh.test.mjs),
//       a header line missing. That the backend reads the mark and when it applies is held by server-end-marker.test.js; the
//       gateway behavior (order of the calls) by containers.test.js.
// The mark itself (docker() notes stop/rm/kill/restart BEFORE the child) is held by projectbox-resumption.test.js.
//
// Not detected (named so nobody takes it for checked): the seam as a VALUE — server.js hands dockerKind and
// dockerChildAfterThaw to runtime/inProject.js (there only `exec … cbase-wrapper` starts, guard in-project-start-places),
// relocation/procedure.js hands docker to relocation/collect.js (there a parameter named `docker`, whose calls this guard sees
// again). Comment lines do not count; a call in the wording of a string counts (an error in the safe direction: red and looked
// at, never silent). Reading is latin1 — the same as `grep -a` (a few server files are taken for binary by plain grep).
//
// COUNTER-TESTS: the built-in sabotage of (4) turns each rule red on the real tree:
//   a second `docker(["stop", …])` in stacks/clearAway.js removeStep         => (1) red ("2 call(s) instead of 1")
//   a new `docker(["kill", …])` / `docker(["rm", …])` place                  => (1) red (NEW stop place)
//   a `dockerKind(["stop", …])`                                              => (1) red ("bypasses the mark")
//   a new call `docker(a)` with a variable                                   => (2) red
//   the line "stacks/remove.js" removed from the header of resumption.js     => (3) red
// The numbers of the tree are in the measuring line that every run prints (not in the test title — a number there ages silently).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");
const SEAM = "projectbox/docker.js";
const HEADER_FILE = "projectbox/resumption.js";
const REPO = path.join(SERVER, "..", "..", "..", "..");
const GATEWAY_FILE = "server/gateway/containers.js";
const ENTRY_FILE = "server/backend/entry.sh";

// The functions that start a child in the daemon of B, and where their arguments stand.
const SEAM_FUNCTIONS = { docker: 0, dockerKind: 0, dockerChildAfterThaw: 1, dockerStream: 0, localDocker: 0 };
// These bypass docker() — without the mark "cbase stops itself".
const WITHOUT_MARKER = new Set(["dockerKind", "dockerChildAfterThaw", "dockerStream", "localDocker"]);
const STOP_COMMANDS = new Set(["stop", "rm", "kill", "restart"]);

// The table: per file, function (the topmost named function around the call), command — count and reason. `withoutMarker`
// only for a stop that bypasses docker() (the reason says why it triggers no resumption without the mark).
const STOP_PLACES = [
  { file: "projectbox/recreate.js", fn: "procedure", command: "stop", count: 1, reason: "the old project container before the recreate: row in `recreate`, procedure (withProcedure) and instance occupancy \"recreate\" — and the mark" },
  { file: "projectbox/recreate.js", fn: "procedure", command: "rm", count: 1, reason: "the same old container after the stop (by id, without -f) — as above" },
  { file: "projectbox/erase.js", fn: "stopAll", command: "stop", count: 1, reason: "erase, phase 1: project occupancy \"erase\" (and the lock); if the erase fails, the rows stay `ready` — then the mark alone holds" },
  { file: "projectbox/erase.js", fn: "removeStopped", command: "rm", count: 1, reason: "erase, phase 2 (-f): as above; afterwards the row is gone (no-row)" },
  { file: "projectbox/serverEnd.js", fn: "projectboxServerEnd", command: "stop", count: 1, reason: "the stop chain at server end: serverEnds() is set BEFORE the hooks, the observer ends after it — and the mark" },
  { file: "projectbox/instance.js", fn: "creation", command: "rm", count: 2, reason: "rollback of a failed creation (-f, id or remainder by name): row in `create`/`recreate`, procedure of the creation" },
  { file: "projectbox/setup/procedure.js", fn: "removeRestContainer", command: "stop", count: 1, reason: "only on \"try again\" of a failed setup (project creation): the row is in `error` or missing — the resumption touches only `ready` —, procedure of the setup; and the mark" },
  { file: "projectbox/setup/procedure.js", fn: "removeRestContainer", command: "rm", count: 1, reason: "the same leftover container after the stop (by id, without -f) — as above" },
  { file: "projectbox/helper.js", fn: "emptyHelper", command: "stop", count: 1, reason: "a helper (-t 0) never carries `cbase.project` — not in the stream; the observer also ignores `cbase.helper`" },
  { file: "projectbox/helper.js", fn: "removeHelper", command: "rm", count: 1, reason: "the same helper (-f -v) — as above" },
  { file: "projectbox/relocation/procedure.js", fn: "stopStep", command: "stop", count: 1, reason: "the old compose containers in B (relocation, step stop): without `cbase.project`, not in the stream; row in `relocation`" },
  { file: "projectbox/relocation/procedure.js", fn: "removeStep", command: "stop", count: 1, reason: "the old compose containers in B (step remove): as above" },
  { file: "projectbox/relocation/procedure.js", fn: "removeStep", command: "rm", count: 1, reason: "the same, after the stop — as above" },
  { file: "projectbox/relocation/procedure.js", fn: "rwContainer", command: "rm", count: 1, reason: "the new project container in the return path of the relocation (-f): row in `relocation`, procedure of the relocation" },
  { file: "stacks/dismantling.js", fn: "dismantleCopy", command: "rm", count: 1, reason: "the copy container in the dismantling (-f): row in `create`/`clearAway`, procedure or instance occupancy of the dismantling" },
  { file: "stacks/clearAway.js", fn: "removeStep", command: "stop", count: 1, reason: "the copy before the clear-away (-t 30): row in `clearAway`, procedure and instance occupancy \"copy-clear-away\"" },
  { file: "stacks/remove.js", fn: "removeCopyOrphans", command: "rm", count: 1, reason: "an orphaned copy container (-f): without a row (only orphans), no-row" },
  { file: "projectbox/restore.js", fn: "procedureAttempt", command: "stop", count: 1, reason: "a project container of an older release (hostname or bridge not the derived `cbp-<n>`, namingDeviation) in the restore: row in `start`/`recreate`, instance occupancy \"restore\" and withProcedure — and the mark; afterwards `error` with the recreate request" },
  { file: "projectbox/instance-stop.js", fn: "stopContainer", command: "stop", count: 1, reason: "a human's \"stop\" (-t 30, by id) — the row stands BEFORE the stop in `stop` (procedure, instance occupancy \"stop\"), afterwards `stopped`; the same when catching up in the reconciliation (row `stopped`, occupancy \"stop\") — and the mark" },
  { file: "services.js", fn: "stopService", command: "stop", count: 1, withoutMarker: true, reason: "the container service of a project WITHOUT an instance through localDocker (DOCKER_CALLS_ALLOWED, projectbox-ops.test.js): compose container without `cbase.project` — not in the stream" },
];

// The stops of the project containers that do NOT run in the backend (paths relative to the repo root). The reason says why
// the observer (projectbox/resumption.js) sees no crash in them.
const EXTERNE_PLACES = [
  { file: GATEWAY_FILE, fn: "stopProjectContainer", reason: "`docker exec -u agent B sh -c PROJECT_STOP_SCRIPT` bypasses the docker() of the backend; BEFORE it the gateway sets the mark /run/cbase/b-ends through `exec -u root` (serverEnds() reads it like its own), destroy() stops B only afterwards with `docker stop -t 60`" },
  { file: ENTRY_FILE, fn: "project_container_stop", reason: "without network cut, in the start of B before the backend: no observer, no backend; the mark b-ends is removed at every start" },
];

// Calls whose command is not in the wording — per file and function with count and the reason why no stop is in there.
const DYNAMIC = [
  { file: "ports.js", fn: "lsofIn", count: 1, reason: "`docker(asAgent(…))` = `exec -u agent <container> lsof …` (asAgent in the same file)" },
  { file: "ports.js", fn: "readPorts", count: 1, reason: "`docker(asAgent(…))` = `exec -u agent <container> cat /proc/net/tcp …`" },
  { file: "projectbox/instance.js", fn: "networkFor", count: 3, reason: "`docker(args(net))` and `docker(networkArgs(…))` = `network create …` (the latter: the network recreated on its subnet when its bridge is not the derived one)" },
  { file: "projectbox/instance.js", fn: "creation", count: 1, reason: "`docker(args)` = `run -d …` (creation.js runArgs)" },
  { file: "projectbox/helper.js", fn: "startHelper", count: 1, reason: "`docker(args)` = `run -d … --label cbase.helper …` (the helper)" },
  { file: "projectbox/helper.js", fn: "executeHelper", count: 1, reason: "`docker(args, opts)` = `exec -u 0 <helper> …`" },
  { file: "projectbox/relocation/procedure.js", fn: "inspectOne", count: 1, reason: "`docker(args)` = `inspect --type …`" },
  { file: "projectbox/relocation/collect.js", fn: "inspectBundle", count: 1, reason: "`docker([...front, ...part])` — front is `inspect`, `image inspect`, `volume inspect` or `network inspect` (collectDocker)" },
  { file: "projectbox/resumption.js", fn: "startStream", count: 1, reason: "`dockerStream(EVENTS_ARGS(…))` = `events --since …` (the observer itself)" },
];

// ── The scanner ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** All source files under electron/server (without node_modules): [{ path, text }], path posix and relative to server/. */
function sourceFiles(root = SERVER) {
  const out = [];
  const run = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(root, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "latin1") });
    }
  };
  run(root);
  return out;
}

const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
// The topmost named function around a call: a declaration at the line start or an arrow function that is assigned to a name
// at the line start (`const lsofIn = (c) => async (args) => …`).
const FUNCTION_TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/;
const CALL = new RegExp(`(?<![\\w$.])(${Object.keys(SEAM_FUNCTIONS).join("|")})\\(`, "g");
const DECLARATION = /(?:function\s+|(?:const|let|var)\s+)$/;

// From `i` (behind the opening parenthesis): the top-level arguments up to the closing parenthesis, roughly — parentheses,
// strings and templates count (comments INSIDE a call are not needed here).
function argsValue(text, i) {
  const args = [];
  let depth = 0;
  let start = i;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (k++; k < text.length && text[k] !== ch; k++) if (text[k] === "\\") k++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) { args.push(text.slice(start, k)); return args; }
      depth--;
    } else if (ch === "," && depth === 0) { args.push(text.slice(start, k)); start = k + 1; }
  }
  return args;
}

// The command of an argument text: { command } for an array that starts with strings (`container` skipped), else { dynamic: true }.
function commandFrom(argText) {
  const t = String(argText || "").trim();
  if (!t.startsWith("[")) return { dynamic: true };
  const lit = /^\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1\s*(,|\])/;
  let rest = t.slice(1);
  let m = lit.exec(rest);
  if (!m || m[1] === "`" && m[2].includes("${")) return { dynamic: true };
  if (m[2] === "container") {
    rest = rest.slice(m[0].length);
    m = lit.exec(rest);
    if (!m || m[1] === "`" && m[2].includes("${")) return { dynamic: true };
  }
  return { command: m[2] };
}

/** { stops: Map "file#function#command" -> { …, fn, rows }, dynamic: Map "file#function" -> { …, rows } } */
function scan(files) {
  const stops = new Map();
  const dynamic = new Map();
  for (const { path: filePath, text } of files) {
    if (filePath === SEAM) continue;
    const rows = text.split("\n");
    const beginnings = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") beginnings.push(i + 1);
    const rowOf = (index) => {
      let z = 0;
      while (z + 1 < beginnings.length && beginnings[z + 1] <= index) z++;
      return z;
    };
    for (const m of text.matchAll(CALL)) {
      const row = rowOf(m.index);
      if (COMMENT.test(rows[row])) continue;
      if (DECLARATION.test(text.slice(Math.max(0, m.index - 12), m.index))) continue; // `function docker(` — the declaration
      const fn = m[1];
      const args = argsValue(text, m.index + m[0].length);
      let fnValue = "(module level)";
      for (let k = row; k >= 0; k--) {
        const f = rows[k].match(FUNCTION_TOP);
        if (f) { fnValue = f[1] || f[2]; break; }
      }
      const b = commandFrom(args[SEAM_FUNCTIONS[fn]]);
      if (b.dynamic) {
        const k = `${filePath}#${fnValue}`;
        if (!dynamic.has(k)) dynamic.set(k, { file: filePath, fn: fnValue, count: 0, rows: [] });
        const d = dynamic.get(k);
        d.count++;
        d.rows.push(row + 1);
      } else if (STOP_COMMANDS.has(b.command)) {
        const k = `${filePath}#${fnValue}#${b.command}`;
        if (!stops.has(k)) stops.set(k, { file: filePath, fn: fnValue, command: b.command, count: 0, seams: new Set(), rows: [] });
        const s = stops.get(k);
        s.count++;
        s.seams.add(fn);
        s.rows.push(row + 1);
      }
    }
  }
  return { stops, dynamic };
}

// The files in the table "THE STOP PLACES" in the header of resumption.js (up to "Not among them").
function headerFiles(text) {
  const from = text.indexOf("// THE STOP PLACES");
  const until = text.indexOf("//   Not among them", from);
  if (from < 0 || until < 0) return null;
  const out = new Set();
  for (const z of text.slice(from, until).split("\n")) {
    const m = /^\/\/\s{3}((?:[\w-]+\/)*[\w-]+\.(?:js|sh))\s/.exec(z);
    if (m) out.add(m[1]);
  }
  return out;
}

/** The sources of the external places from disk: { [file]: text } (latin1 as above). */
function readExternal() {
  return Object.fromEntries(EXTERNE_PLACES.map((e) => [e.file, fs.readFileSync(path.join(REPO, e.file), "latin1")]));
}
const withoutComment = (text) => text.split("\n").filter((z) => !/^\s*(?:\/\/|#)/.test(z));
// The body of a function: for JS from `async function name(` up to the first line `}` at the line start, for sh from `name() {`.
function body(text, fn) {
  const from = text.search(new RegExp(`(?:async function ${fn}\\(|^${fn}\\(\\) \\{)`, "m"));
  if (from < 0) return null;
  const until = text.indexOf("\n}\n", from);
  return text.slice(from, until < 0 ? undefined : until);
}

// (5) The places outside the backend.
function externalViolations(extern) {
  const v = [];
  const gw = extern[GATEWAY_FILE] ?? "";
  const gwStops = withoutComment(gw).filter((z) => /docker stop/.test(z));
  if (gwStops.length !== 1) v.push(`${GATEWAY_FILE}: ${gwStops.length} line(s) with "docker stop" instead of 1 (PROJECT_STOP_SCRIPT) — a NEW stop place: entry in EXTERNAL_PLACES and line in the header of ${HEADER_FILE}`);
  const r = body(gw, "stopProjectContainer");
  if (!r) v.push(`${GATEWAY_FILE}: stopProjectContainer is missing`);
  else {
    const marker = r.search(/docker\(\["exec", "-u", "root", container, "sh", "-c", B_ENDS_SCRIPT\]/);
    const script = r.search(/docker\(\["exec", "-u", "agent", container, "sh", "-c", script\]/);
    if (marker < 0) v.push(`${GATEWAY_FILE}: stopProjectContainer does not set the mark "B ends" (exec -u root with B_ENDS_SCRIPT) — the observer would see the stop as a crash`);
    else if (script < 0) v.push(`${GATEWAY_FILE}: stopProjectContainer does not run the stop script (exec -u agent … script)`);
    else if (marker > script) v.push(`${GATEWAY_FILE}: the mark "B ends" stands AFTER the stop script — it must stand before it`);
  }
  const sh = extern[ENTRY_FILE] ?? "";
  const shStops = withoutComment(sh).filter((z) => /docker stop/.test(z));
  const shR = body(sh, "project_container_stop") ?? "";
  if (shStops.length !== 1 || withoutComment(shR).filter((z) => /docker stop/.test(z)).length !== 1) v.push(`${ENTRY_FILE}: ${shStops.length} line(s) with "docker stop" (expected: exactly 1, in project_container_stop) — a NEW stop place: entry in EXTERNAL_PLACES and line in the header of ${HEADER_FILE}`);
  if (!/^B_ENDS_MARKER="\$W\/run\/cbase\/b-ends"$/m.test(sh)) v.push(`${ENTRY_FILE}: B_ENDS_MARKER="$W/run/cbase/b-ends" is missing`);
  if (!/^\s*rm -f .*"\$B_ENDS_MARKER"/m.test(withoutComment(sh).join("\n"))) v.push(`${ENTRY_FILE}: the start of B does not remove the mark b-ends (rm -f … "$B_ENDS_MARKER") — it would still stand after a docker start, serverEnds() would stay wrong-true for up to ten minutes`);
  return v;
}

function violations(files, extern = readExternal()) {
  const v = [];
  const { stops, dynamic } = scan(files);
  const list = new Map(STOP_PLACES.map((e) => [`${e.file}#${e.fn}#${e.command}`, e]));
  for (const [k, t] of stops) {
    const e = list.get(k);
    const bypass = [...t.seams].filter((f) => WITHOUT_MARKER.has(f));
    if (bypass.some((f) => f !== "localDocker")) v.push(`Stop bypasses the mark ${k} through ${bypass.join(", ")} (line ${t.rows.join(", ")}) — a stop goes through docker(), only there sits the mark "cbase stops itself"`);
    else if (!e) v.push(`NEW stop place ${k} (line ${t.rows.join(", ")}) — no entry: reason in STOP_PLACES and line in the header of ${HEADER_FILE}`);
    else {
      if (e.count !== t.count) v.push(`${k}: ${t.count} call(s) instead of ${e.count} (line ${t.rows.join(", ")})`);
      if (bypass.length && !e.withoutMarker) v.push(`${k}: bypasses docker() (${bypass.join(", ")}), the entry does not say "withoutMarker"`);
      if (!bypass.length && e.withoutMarker) v.push(`${k}: the entry says "withoutMarker", the call goes through docker()`);
    }
  }
  for (const [k] of list) if (!stops.has(k)) v.push(`Entry without a stop place ${k} — rebuilt? Then adjust the entry`);
  const dyn = new Map(DYNAMIC.map((e) => [`${e.file}#${e.fn}`, e]));
  for (const [k, t] of dynamic) {
    const e = dyn.get(k);
    if (!e) v.push(`NEW dynamic call ${k} (line ${t.rows.join(", ")}) — the command is not readable: write it in the wording or list it with a reason in DYNAMIC`);
    else if (e.count !== t.count) v.push(`${k}: ${t.count} dynamic call(s) instead of ${e.count} (line ${t.rows.join(", ")})`);
  }
  for (const [k] of dyn) if (!dynamic.has(k)) v.push(`Entry without a dynamic call ${k} — remove the entry`);
  // (3) Header and guard.
  const header = headerFiles(files.find((d) => d.path === HEADER_FILE)?.text || "");
  if (!header) v.push(`${HEADER_FILE}: the table "THE STOP PLACES" is missing in the header`);
  else {
    const here = new Set([...STOP_PLACES, ...EXTERNE_PLACES].map((e) => e.file));
    for (const d of here) if (!header.has(d)) v.push(`${d} is missing in the table in the header of ${HEADER_FILE}`);
    for (const d of header) if (!here.has(d)) v.push(`${d} is in the header of ${HEADER_FILE}, but without a stop place here`);
  }
  v.push(...externalViolations(extern));
  return v;
}

// ── (1)–(3) on the real tree ──────────────────────────────────────────────────────────────────────────────────────────

test("(1)–(3) every stop place in the daemon of B is in the table with a reason, every unreadable call too, and the header of resumption.js names the same files", () => {
  const files = sourceFiles();
  for (const p of [SEAM, HEADER_FILE, "services.js", "stacks/clearAway.js"]) assert.ok(files.some((d) => d.path === p), `${p} is missing — the guard looks in the wrong place`);
  const { stops, dynamic } = scan(files);
  // Printed at EVERY run: a silent list cannot be told from a forgotten one.
  for (const e of STOP_PLACES) console.log(`[stop-places] ${e.file}#${e.fn} ${e.command} (${e.count}x)${e.withoutMarker ? " WITHOUT mark" : ""}: ${e.reason}`);
  for (const e of DYNAMIC) console.log(`[stop-places] dynamic ${e.file}#${e.fn} (${e.count}x): ${e.reason}`);
  for (const e of EXTERNE_PLACES) console.log(`[stop-places] external ${e.file}#${e.fn}: ${e.reason}`);
  const sum = [...stops.values()].reduce((n, t) => n + t.count, 0);
  const sumDyn = [...dynamic.values()].reduce((n, t) => n + t.count, 0);
  console.log(`[stop-places] measured: ${sum} stop call(s) at ${stops.size} place(s), ${sumDyn} dynamic call(s) in ${dynamic.size} function(s), over ${files.length} files`);
  assert.deepEqual(violations(files), []);
});

// ── (4) Built-in sabotage ─────────────────────────────────────────────────────────────────────────────────────────

test("(4) built-in sabotage: new, missing and multiplied stop place, stop through dockerKind, hidden dynamic call, header without a place and place without a header — each red", () => {
  const real = sourceFiles();
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const from = (filePath) => real.find((d) => d.path === filePath).text;
  const newFile = (body) => including("project/sabotage.js", `import { docker, dockerKind } from "../projectbox/docker.js";\nexport async function foreign(id) {\n  ${body};\n}\n`);

  // A new place, in every spelling: single-line, multi-line, single quotes, `container stop`, kill, restart — each exactly
  // ONE violation "NEW stop place".
  for (const body of [
    'await docker(["stop", "-t", "5", id])',
    'await docker(\n    [\n      "rm", "-f", id,\n    ],\n  )',
    "await docker(['kill', id])",
    'await docker(["container", "stop", id])',
    "await docker([`restart`, id])",
  ]) {
    const v = violations(newFile(body));
    assert.equal(v.length, 1, `not detected (exactly once): ${body}\n${v.join("\n")}`);
    assert.match(v[0], /^NEW stop place project\/sabotage\.js#foreign#(stop|rm|kill|restart)/);
  }
  // A stop through dockerKind bypasses the mark — red, not to be saved even with an entry.
  const kind = violations(newFile('dockerKind(["stop", id])'));
  assert.equal(kind.length, 1);
  assert.match(kind[0], /^Stop bypasses the mark project\/sabotage\.js#foreign#stop through dockerKind/);
  // No stop: another command, a stop INSIDE the container (exec), a comment, `network rm`, `volume rm`.
  for (const body of [
    'await docker(["inspect", id])',
    'await docker(["exec", id, "docker", "stop", "x"])',
    '// await docker(["stop", id])',
    'await docker(["network", "rm", id])',
    'await docker(["volume", "rm", id])',
  ]) {
    assert.deepEqual(violations(newFile(body)), [], `falsely detected: ${body}`);
  }
  // A hidden dynamic call: a variable, a spread, a template with a placeholder — each "NEW dynamic".
  for (const body of ["const a = [\"stop\", id];\n  await docker(a)", "await docker([...[\"stop\"], id])", "await docker([`${\"st\"}op`, id])", "await docker([\"container\", verb, id])"]) {
    const v = violations(newFile(body));
    assert.equal(v.length, 1, `not detected: ${body}\n${v.join("\n")}`);
    assert.match(v[0], /^NEW dynamic call project\/sabotage\.js#foreign/);
  }

  // A missing place: the stop in removeStep goes away — the entry stands without a reason.
  const abr = from("stacks/clearAway.js");
  const without = abr.replace('docker(["stop", "-t", "30", id]', 'docker(["inspect", "-f", "x", id]');
  assert.notEqual(without, abr, "the sabotage replaced nothing");
  assert.deepEqual(violations(including("stacks/clearAway.js", without)), ["Entry without a stop place stacks/clearAway.js#removeStep#stop — rebuilt? Then adjust the entry"]);
  // A multiplied one: a second stop in the same function.
  const duplicate = abr.replace(/(try \{ await docker\(\["stop", "-t", "30", id\])/, 'await docker(["stop", id]);\n        $1');
  assert.notEqual(duplicate, abr, "the sabotage replaced nothing");
  const v2 = violations(including("stacks/clearAway.js", duplicate));
  assert.equal(v2.length, 1, v2.join("\n"));
  assert.match(v2[0], /^stacks\/clearAway\.js#removeStep#stop: 2 call\(s\) instead of 1/);
  // A dynamic call goes away: the entry stands without a reason.
  const collect = from("projectbox/relocation/collect.js");
  const withoutDyn = collect.replace("await docker([...front, ...part])", 'await docker(["inspect", ...part])');
  assert.notEqual(withoutDyn, collect, "the sabotage replaced nothing");
  assert.deepEqual(violations(including("projectbox/relocation/collect.js", withoutDyn)), ["Entry without a dynamic call projectbox/relocation/collect.js#inspectBundle — remove the entry"]);

  // Header and guard: a line in the header removed, a line in the header without a place.
  const header = from(HEADER_FILE);
  const withoutRow = header.replace(/^\/\/ {3}stacks\/remove\.js .*\n/m, "");
  assert.notEqual(withoutRow, header, "the sabotage replaced nothing");
  assert.deepEqual(violations(including(HEADER_FILE, withoutRow)), [`stacks/remove.js is missing in the table in the header of ${HEADER_FILE}`]);
  for (const d of [GATEWAY_FILE, ENTRY_FILE]) {
    const withoutExt = header.replace(new RegExp(`^// {3}${d.replace(/[./]/g, "\\$&")} .*\\n(?://  {30,}.*\\n)*`, "m"), "");
    assert.notEqual(withoutExt, header, `the sabotage replaced nothing: ${d}`);
    assert.deepEqual(violations(including(HEADER_FILE, withoutExt)), [`${d} is missing in the table in the header of ${HEADER_FILE}`]);
  }
  const withRow = header.replace(/^(\/\/ {3}stacks\/remove\.js .*\n)/m, "$1//   projectbox/invented.js        stop                          an entry without a place\n");
  assert.notEqual(withRow, header, "the sabotage replaced nothing");
  assert.deepEqual(violations(including(HEADER_FILE, withRow)), [`projectbox/invented.js is in the header of ${HEADER_FILE}, but without a stop place here`]);
  // (5) The places outside the backend: per sabotage exactly one violation with the expected sentence.
  const ext = readExternal();
  const withExt = (file, text) => ({ ...ext, [file]: text });
  assert.deepEqual(externalViolations(ext), [], "the real tree is not clean for (5)");
  const gw = ext[GATEWAY_FILE];
  const sh = ext[ENTRY_FILE];
  const replace = (text, from, after) => { const fresh = text.replace(from, after); assert.notEqual(fresh, text, `the sabotage replaced nothing: ${from}`); return fresh; };
  // A second stop place in the gateway (another script string) or in entry.sh.
  const vGw = externalViolations(withExt(GATEWAY_FILE, `${gw}\nconst STILL_ONE_STOP = "docker stop -t 5 $ids";\n`));
  assert.equal(vGw.length, 1, vGw.join("\n"));
  assert.match(vGw[0], /^server\/gateway\/containers\.js: 2 line\(s\) with "docker stop" instead of 1/);
  const vSh = externalViolations(withExt(ENTRY_FILE, `${sh}\nanother_one() {\n  docker stop -t 5 x\n}\n`));
  assert.equal(vSh.length, 1, vSh.join("\n"));
  assert.match(vSh[0], /^server\/backend\/entry\.sh: 2 line\(s\) with "docker stop"/);
  // The mark is missing / stands behind the script / is set as agent (it would no longer be trustworthy: the backend checks
  // root ownership, the guard here the call).
  const markerRow = /^ *await docker\(\["exec", "-u", "root", container.*\n/m;
  const withoutMarker = externalViolations(withExt(GATEWAY_FILE, replace(gw, markerRow, "")));
  assert.equal(withoutMarker.length, 1, withoutMarker.join("\n"));
  assert.match(withoutMarker[0], /does not set the mark "B ends"/);
  const asAgent = externalViolations(withExt(GATEWAY_FILE, replace(gw, '"exec", "-u", "root", container', '"exec", "-u", "agent", container')));
  assert.equal(asAgent.length, 1, asAgent.join("\n"));
  assert.match(asAgent[0], /does not set the mark "B ends"/);
  const rowMarker = gw.match(markerRow)[0];
  const afterwards = externalViolations(withExt(GATEWAY_FILE, replace(replace(gw, rowMarker, ""), /(\n  await docker\(\["exec", "-u", "agent", container.*\n[^\n]*\n  \}\);\n)/, `$1${rowMarker}`)));
  assert.equal(afterwards.length, 1, afterwards.join("\n"));
  assert.match(afterwards[0], /stands AFTER the stop script/);
  // entry.sh no longer removes the mark.
  const state = externalViolations(withExt(ENTRY_FILE, replace(sh, ' "$B_ENDS_MARKER" "$B_ENDS_MARKER.fresh"', "")));
  assert.equal(state.length, 1, state.join("\n"));
  assert.match(state[0], /does not remove the mark b-ends/);
  // Header: the line of the external place is missing.
  const headerWithExt = `// THE STOP PLACES\n//   ${GATEWAY_FILE}  x\n//   ${ENTRY_FILE}  y\n//   Not among them\n`;
  assert.deepEqual(headerFiles(headerWithExt), new Set([GATEWAY_FILE, ENTRY_FILE]), ".sh rows in the header are not read");

  // The seam itself never counts.
  assert.deepEqual(violations(including(SEAM, `${from(SEAM)}\nexport async function x(id) { await docker(["stop", id]); }\n`)), []);
});
