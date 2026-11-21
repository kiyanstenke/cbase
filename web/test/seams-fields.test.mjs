// The seam: a field the web client SENDS and the server does not READ at all on the route it hits.
//
// The documented case: the 99-percent switch on the web called `PUT /api/auto-continue` with the field `creditGate`. The backend
// reads only `enabled` there (`server/backend/electron/server/settings/routes.js`). Answer 200, no type error, no red test -- and
// for nine days every click toggled a DIFFERENT setting, because the route read a missing `enabled` as ON.
//
// The lists were already bound elsewhere. This is the next layer: the contracts. Client and server are connected at this point by
// nothing but a string in an object literal, and `tsc` sees only one side.
//
// The computation lives in `tools/check/lib/seams.mjs` (a `.test.mjs` never imports another); the verdict stands here.
//
// -- When is this guard RED ---------------------------------------------------------------------
// Only if ALL four conditions hold. Each one came from a refuted candidate (eight were checked, all eight were not orphans):
//   1. the type of the body is resolved -- the type checker knows its properties;
//   2. the pairing is EXACT, path AND method (`PUT ${base}/${id}` in WorkflowEditor.tsx normalized hits twelve foreign routes --
//      such pairs are not counted);
//   3. none of the hit server places has an OPEN EDGE (dynamic access `b[k]`, unknown call target, unresolvable parameter
//      position, spread) -- there the guard does not know what is read, and stays silent;
//   4. the field is in none of the read sets -- including passing on to helpers (depth 3) and list-driven reading
//      (`for (const k of MANAGER_PROMPT_FIELDS) b?.[k]`; without this rule the prototype reported `about` and `team` as orphans,
//      and both are read).
//
// -- What it does NOT catch ---------------------------------------------------------------------
//   - the opposite direction: a field the server reads and nobody sends (a dead read, not silent data loss);
//   - the wrong VALUE in a right field -- `reason === "gate"` against `reason: "credit"` was the same day and the same family, but
//     a different computation;
//   - iOS. An `Encodable` omits a `nil` key and `CodingKeys` renames it; both turn every measurement there into a guess. The mobile
//     client stays outside;
//   - the send sites that cannot be measured and the server places with an open edge. They are counted and printed on EVERY run
//     (design `CYCLES_ALLOWED`): a silent exception cannot be told from a forgotten one.
//
// Counter-tests for the upload probes: `setupProjectRoutes` removed from ROUTES_PREFIX, rxPattern at the old state, the
// inheritance from the call switched off, `RE.exec(sub)` not read as a match variable => each the self-probe and anchor 4e red.
//
// Run:  node --test web/test/seams-fields.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findingRow, pairing, ROUTES_PREFIX, serverPlaces, loadTs, webPlaces } from "../../tools/check/lib/seams.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = loadTs(repo);

// -- The self-probes --------------------------------------------------------------------------
// Four files that do NOT exist on disk: they hang only in memory on the compiler host and run through the same program and the
// same type checker as the real tree. A guard that never sees its own red is the most expensive kind of test -- the prototype
// reported 521 of 521 green because a spread overwrote a field and a loop ran over CHARACTERS instead of fields.
const PROBE_FOLDER = "src/__seams-probe__";

const { places: serverList, fnNames } = serverPlaces(ts, { repo });

// The probe against the open edge is built at runtime: it takes the first server place that has one. A hard-wired route would be
// silently green after the next cleanup.
const openPlace = serverList.find((s) => s.open.length && s.paths && s.paths.length === 1 && s.methods.length === 1 && !s.paths[0].includes("*"));

const probes = [
  {
    name: "orphan",
    text: `// The old state: the 99-percent switch sent its own name along.\n`
      + `export async function probeOrphan(enabled: boolean, creditGate: boolean) {\n`
      + `  await fetch("/api/auto-continue", { method: "PUT", body: JSON.stringify({ enabled, creditGate }) });\n}\n`,
  },
  {
    name: "clean",
    text: `// The same route, only the field it really reads.\n`
      + `export async function probeClean(enabled: boolean) {\n`
      + `  await fetch("/api/auto-continue", { method: "PUT", body: JSON.stringify({ enabled }) });\n}\n`,
  },
  {
    // The folder PUT checks `fsub === "/archive"` with `const fsub = fm[2] || ""` -- without the alias rule in seams.mjs it stood
    // "without counterpart", and an invented field there would stay green. The probe sends the right field AND a wrong one.
    name: "folder-archive",
    text: `// The folder PUT of the archive, with a field the server does not read.\n`
      + `export async function probeFolderArchive(id: string, archived: boolean, archive: boolean) {\n`
      + `  await fetch(\`/api/chat-folders/\${id}/archive\`, { method: "PUT", body: JSON.stringify({ archived, archive }) });\n}\n`,
  },
  {
    // The routes of the later upload read their body in a helper (projectbox/setup/upload.js) to which the route passes `req` -- path
    // and method are inherited by the place from the call in routes.js; `.../upload/:operation/finished` also via the regex constant
    // `UPLOAD_RE.exec(sub)`. Without both, every send site there stood "without counterpart", and a renamed field would stay green.
    name: "upload-unpack",
    text: `// archive/unpack with a field the server does not read.\n`
      + `export async function probeUnpack(id: string, operation: string, invented: boolean) {\n`
      + `  await fetch(\`/api/projects/\${id}/archive/unpack\`, { method: "POST", body: JSON.stringify({ operation, invented }) });\n}\n`,
  },
  {
    name: "upload-finished",
    text: `// upload/:operation/finished with the field of archive/unpack ("mode" instead of "conflict").\n`
      + `export async function probeFinished(id: string, operation: string, conflict: string, mode: string) {\n`
      + `  await fetch(\`/api/projects/\${id}/upload/\${operation}/finished\`, { method: "POST", body: JSON.stringify({ conflict, mode }) });\n}\n`,
  },
  {
    name: "unspecific",
    text: `// Path from two variables: normalized it hits dozens of routes and must never be counted.\n`
      + `export async function probeUnspecific(base: string, id: string, inventedField: boolean) {\n`
      + `  await fetch(\`\${base}/\${id}\`, { method: "PUT", body: JSON.stringify({ inventedField }) });\n}\n`,
  },
];
if (openPlace) {
  // The path must arise the way a client builds it: an id in a template, not a number in the text -- `${id}` is normalized to
  // `{x}`, a literal `1` would stay a `1`.
  const filePath = openPlace.paths[0].includes("{x}")
    ? "`" + openPlace.paths[0].replace(/\{x\}/g, "${id}") + "`"
    : JSON.stringify(openPlace.paths[0]);
  probes.push({
    name: "open-edge",
    text: `// An invented field on a route whose server place has an open edge (${openPlace.file}:${openPlace.line}).\n`
      + `export async function probeOpenEdge(id: string, inventedField: boolean) {\n`
      + `  await fetch(${filePath}, { method: "${openPlace.methods[0]}", body: JSON.stringify({ inventedField }) });\n}\n`,
  });
}

const allWeb = webPlaces(ts, {
  repo,
  addition: probes.map((p) => ({ path: `${PROBE_FOLDER}/${p.name}.ts`, text: p.text })),
});
const isProbe = (w) => w.file.includes("__seams-probe__");
const webList = allWeb.filter((w) => !isProbe(w));
const probesList = allWeb.filter(isProbe);

const real = pairing(serverList, webList);
const probed = pairing(serverList, probesList);
// `measured` and `notMeasurable` are disjoint and cover every send site; `findings` is a subset of `measured`. If the scanner finds
// a probe not at all or twice, it is broken.
const probeOf = (name) => {
  const all = [...probed.measured, ...probed.notMeasurable].filter((x) => x.file.endsWith(`${name}.ts`));
  assert.equal(all.length, 1, `Self-probe "${name}" was not read as exactly ONE send site (${all.length}) -- the scanner no longer measures itself.`);
  return { entry: all[0], finding: probed.findings.find((x) => x.file.endsWith(`${name}.ts`)) || null };
};

// -- The guard -------------------------------------------------------------------------------

test("Seam: no field that the web client sends and the server does not read on the same route", (t) => {
  // The numbers stand HERE and not in the title: a number in the title ages silently ("the seven known cycles" lied three times
  // without anything turning red).
  const open = serverList.filter((s) => s.open.length);
  const withoutPath = serverList.filter((s) => !s.paths);
  const reasons = {};
  for (const n of real.notMeasurable) reasons[n.reason.split(":")[0]] = (reasons[n.reason.split(":")[0]] || 0) + 1;

  t.diagnostic(`[seams] measured: ${real.measured.length} of ${webList.length} web send sites against ${serverList.length} readBody places of the server`
    + ` (${serverList.length - withoutPath.length} with resolved path, ${open.length} with open edge); ${real.notMeasurable.length} not measurable; ${real.findings.length} orphan(s)`);
  for (const s of open) t.diagnostic(`[seams] open edge ${s.file}:${s.line} ${s.fnName} → ${(s.paths || ["?"]).join(" ")} ${s.methods.join("/")}: ${s.open.join("; ")}`);
  for (const s of withoutPath) t.diagnostic(`[seams] path unresolved ${s.file}:${s.line} ${s.fnName} — a helper instead of a route function; its fields are paired nowhere`);
  for (const [reason, n] of Object.entries(reasons).sort()) {
    const location = real.notMeasurable.filter((x) => x.reason.startsWith(reason)).map((x) => `${x.file}:${x.line}`);
    t.diagnostic(`[seams] not measurable (${reason}): ${n} — ${location.join(", ")}`);
  }

  assert.deepEqual(real.findings.map(findingRow), [],
    `The client sends fields the server does not read on this route:\n  ${real.findings.map(findingRow).join("\n  ")}`);
});

test("Self-probe: the old state is reported -- `{creditGate}` on PUT /api/auto-continue", () => {
  const { finding: b } = probeOf("orphan");
  assert.ok(b, "The guard no longer reports its own occasion as an orphan -- it has gone blind.");
  assert.deepEqual(b.orphans, ["creditGate"], `The guard no longer finds its own occasion: ${JSON.stringify(b)}`);
  assert.deepEqual(b.read, ["enabled"]);
  assert.equal(b.pathNorm, "/api/auto-continue");
  // The line of the route is searched, not hard-coded: a fixed number broke with every insertion above it.
  const routesSource = fs.readFileSync(path.join(repo, "server/backend/electron/server/settings/routes.js"), "utf8").split("\n");
  // Reported is the place where the route READS its body (the first readBody under the route condition).
  const route = routesSource.findIndex((z) => z.includes('p === "/api/auto-continue" && m === "PUT"'));
  assert.ok(route >= 0, "PUT /api/auto-continue is no longer in settings/routes.js");
  const readRow = routesSource.findIndex((z, i) => i > route && z.includes("readBody(")) + 1;
  assert.deepEqual(b.server, [`server/backend/electron/server/settings/routes.js:${readRow}`]);
  assert.match(findingRow(b), /sends creditGate to PUT \/api\/auto-continue, only enabled is read there/);
});

test("Counter-test: the same route with the right field stays green -- else everything would be red and nothing measured", () => {
  const { entry: g, finding } = probeOf("clean");
  assert.equal(finding, null, "The clean probe was reported as an orphan -- the guard raises false alarms.");
  assert.deepEqual(g.read, ["enabled"]);
  assert.ok(probed.measured.some((x) => x.file.endsWith("clean.ts")), "The clean probe was not measured at all.");
});

test("Self-probe: the folder PUT of the archive is paired via the group alias `fsub` -- an invented field there is an orphan", () => {
  const { entry: e, finding: b } = probeOf("folder-archive");
  assert.ok(b, `The folder PUT is not measured (${e.reason || "measured, but no finding"}) -- a group alias like \`fsub\` no longer resolves.`);
  assert.deepEqual(b.orphans, ["archive"]);
  assert.deepEqual(b.read, ["archived"]);
  assert.equal(b.pathNorm, "/api/chat-folders/{x}/archive");
  assert.match(b.server.join(" "), /^server\/backend\/electron\/server\/chats\/routes\.js:\d+$/, "exactly ONE server place: the folder PUT in chatFolderRoutes");
});

test("Anchor (archive): setArchive AND setFolderArchive are measured -- both send exactly what the route reads", () => {
  for (const filePath of ["/api/chats/{x}/archive", "/api/chat-folders/{x}/archive"]) {
    const w = real.measured.find((x) => x.file === "web/src/lib/api/archive.ts" && x.method === "PUT" && x.pathNorm === filePath);
    assert.ok(w, `PUT ${filePath} from lib/api/archive.ts is not under "measured" -- the promise is without a way (not measurable: ${
      real.notMeasurable.filter((x) => x.file === "web/src/lib/api/archive.ts").map((x) => `${x.line} ${x.reason}`).join(", ") || "—"}).`);
    assert.ok(w.fields.includes("archived") && w.read.includes("archived"), `PUT ${filePath}: ${JSON.stringify({ fields: w.fields, read: w.read })}`);
  }
});

test("Self-probe (upload): a later upload -- an invented field on archive/unpack and `mode` on upload/:operation/finished are orphans", () => {
  const { entry: e, finding: b } = probeOf("upload-unpack");
  assert.ok(b, `archive/unpack is not measured (${e.reason || "measured, but no finding"}) -- the inheritance from the call (\`() => startArchiveUnpack(pid, proj, req)\`) no longer holds.`);
  assert.deepEqual([b.orphans, b.read, b.pathNorm], [["invented"], ["mode", "operation"], "/api/projects/{x}/archive/unpack"]);
  assert.match(b.server.join(" "), /^server\/backend\/electron\/server\/projectbox\/setup\/upload\.js:\d+$/);
  const { entry: f, finding: bf } = probeOf("upload-finished");
  assert.ok(bf, `upload/:operation/finished is not measured (${f.reason || "measured, but no finding"}) -- \`UPLOAD_RE.exec(sub)\` no longer resolves.`);
  assert.deepEqual([bf.orphans, bf.read, bf.pathNorm], [["mode"], ["conflict"], "/api/projects/{x}/upload/{x}/finished"]);
});

test("Anchor (project setup): the routes of the later upload have path and method on the server, and the web client is measured at each", () => {
  const expected = {
    beginUpload: ["/api/projects/{x}/upload/begin", ["archive", "operation", "paths"]],
    uploadFinished: ["/api/projects/{x}/upload/{x}/finished", ["conflict"]],
    checkArchive: ["/api/projects/{x}/archive/check", ["operation"]],
    startArchiveUnpack: ["/api/projects/{x}/archive/unpack", ["mode", "operation"]],
    archiveChunk: ["/api/projects/{x}/archive", ["archiveId", "dataB64", "offset"]],
  };
  for (const [fn, [filePath, fields]] of Object.entries(expected)) {
    const st = serverList.filter((s) => s.file.startsWith("server/backend/electron/server/projectbox/setup/") && s.fnName === fn);
    assert.equal(st.length, 1, `${fn}: ${st.length} readBody places`);
    assert.deepEqual([st[0].paths, st[0].methods, st[0].fields, st[0].open], [[filePath], ["POST"], fields, []], `${fn}: ${JSON.stringify(st[0])}`);
    assert.ok(real.measured.some((w) => w.pathNorm === filePath && w.method === "POST"), `POST ${filePath}: no measured send site in the web client (not measurable: ${
      real.notMeasurable.filter((w) => w.pathNorm === filePath).map((w) => `${w.file}:${w.line} ${w.reason}`).join(", ") || "—"})`);
  }
});

test("Counter-test: a too unspecific path is NOT counted, but tallied", () => {
  const { entry: u } = probeOf("unspecific");
  assert.equal(u.reason, "path too unspecific", `Exception class (b) was expected, got: ${u.reason}`);
  assert.ok(!probed.findings.some((x) => x.file.endsWith("unspecific.ts")));
});

test("Counter-test: a server place with an open edge stays silent, even with an invented field", () => {
  assert.ok(openPlace, "No server place with an open edge found -- either the tree has become clean (then this counter-test falls) or the detection is blind.");
  const { entry: o } = probeOf("open-edge");
  assert.match(o.reason, /^open edge at the server/, `The silence rule was expected, got: ${o.reason}`);
  assert.ok(!probed.findings.some((x) => x.file.endsWith("open-edge.ts")));
});

// -- The anchors -----------------------------------------------------------------------------
// A guard that finds nothing reports green. So here stands what the scan MUST find.

test("Anchor server: the route of the occasion reads exactly one field, and the passing on holds", () => {
  const ac = serverList.find((s) => s.file.endsWith("settings/routes.js") && String(s.paths) === "/api/auto-continue" && s.methods.includes("PUT"));
  assert.ok(ac, "PUT /api/auto-continue not found -- the server scan is blind.");
  assert.deepEqual(ac.fields, ["enabled"]);
  assert.deepEqual(ac.open, []);

  // Passing on to a helper that reads list-driven: the route calls `areaContradicts(b, ...)` and `skillFields(b)`
  // (toolchain/skill-catalog.js), and only `skillFields` reads -- in a loop over an array. What stays open is EXACTLY the pair access
  // `b[field]` from areaContradicts (`[field, ab]` from a pair list) -- if the resolution of the loop in skillFields failed, four
  // fields would be missing and a second dynamic access `b[k]` would stand there.
  const sp = serverList.find((s) => s.file.endsWith("toolchain/routes.js") && String(s.paths) === "/api/workspaces/{x}/skills/{x}" && s.methods.includes("PUT"));
  assert.ok(sp, "PUT /api/workspaces/{x}/skills/{x} not found.");
  assert.deepEqual(sp.fields, ["allowedTools", "area", "body", "description", "model"]);
  assert.deepEqual(sp.open, ["dynamic access:b[field]"], "The list-driven reading in skillFields is no longer resolved.");
});

test("Anchor web: the real send site of the switch is in the scan and correct today", () => {
  const w = real.measured.find((x) => x.pathNorm === "/api/auto-continue" && x.method === "PUT");
  assert.ok(w, "No measured web send site on PUT /api/auto-continue -- either it moved or the web scan is blind.");
  assert.deepEqual(w.fields, ["enabled"], "The switch sends more than `enabled` again.");
});

test("Anchor: the prefix table of the sub-slices is a transcript -- every name must exist", () => {
  const tot = Object.keys(ROUTES_PREFIX).filter((k) => !fnNames.has(k));
  assert.deepEqual(tot, [], `ROUTES_PREFIX names route functions that no longer exist: ${tot.join(", ")} -- their paths no longer resolve, and the places below them silently drop out of the measurement.`);
});

test("Anchor: both sides found something at all", () => {
  assert.ok(serverList.length > 150, `Only ${serverList.length} readBody places -- the server scan has collapsed.`);
  assert.ok(webList.length > 150, `Only ${webList.length} web send sites -- the web scan has collapsed.`);
  // The lower bound is only "the scan has not collapsed"; 80 leaves room for small refactors, not for half a scan.
  assert.ok(real.measured.length > 80, `Only ${real.measured.length} send sites really measured -- the guard exempts itself.`);
  assert.ok(real.measured.every((x) => Array.isArray(x.fields) && Array.isArray(x.read)),
    "A measured place carries no field list -- here the prototype ran over characters instead of fields.");
});
