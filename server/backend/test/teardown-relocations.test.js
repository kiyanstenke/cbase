// What Coding needs moves out of managing/, intake/ and manager.js instead of dying with managing: channel delivery
// (channels/deliver.js), the ruling row of the approval (runs/approval-ruling.js), time zone (workspaces/timeZone.js), tool catalog
// (toolchain/tool-catalog.js), approval marks with their route (toolchain/approval-marks.js, GET/PUT /api/workspaces/:id/approval-marks),
// GitLab (the passthrough left cbase later, D2).
//
// (1) The relocation targets import nothing that falls (managing/, intake/, manager.js, pipeline.js, administrator.js, curator/) -
//     otherwise what should stay would die with managing. Counter-test built in: an import line on managing/ turns the check red.
// (2) The approval-marks route on a real server: the new key `approval.cbase.<wid>`, a missing `tools` is a 400, a name outside the
//     Coding catalog a 400, and a Coding PUT replaces only its own slice - a mark outside it (only legacy data of the fallen manager
//     route) stays (counter-test: a Coding PUT that wrote the whole list would take it along - the test checks that it stays).
// (3) Time zone and GitLab access write the NEW keys, never the old `manager.*`.
// Channel delivery (Coding <-> Coding, waiting workflow, open card holds) is checked by channel.test.js and communication-*.test.js under
// the new paths.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { MARKABLE, approvalMarks } from "../electron/server/toolchain/approval-marks.js";
import { CODING_GROUPS, CODING_TOOLS, toolPrimer } from "../electron/server/toolchain/tool-catalog.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");
const RELOCATION_TARGETS = [
  "channels/deliver.js", "channels/migration-communication.js", "channels/migration-communication-table.js",
  "runs/approval-ruling.js", "workspaces/timeZone.js",
  "toolchain/tool-catalog.js", "toolchain/approval-marks.js",
];
const FALLS = /^(\.\.\/)*(managing|intake|curator)\/|(^|\/)(manager|pipeline|administrator|ingest)\.js$/;
const importsOf = (text) => [...text.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
const violations = (files) => files.flatMap(({ name, text }) => importsOf(text).filter((s) => s.startsWith(".") && FALLS.test(s)).map((s) => `${name} → ${s}`));

test("(1) The relocation targets import nothing that falls with managing - with a built-in counter-test", () => {
  const files = RELOCATION_TARGETS.map((name) => ({ name, text: fs.readFileSync(path.join(SERVER, name), "utf8") }));
  assert.deepEqual(violations(files), []);
  // The ruling row is a leaf with exactly two imports (store, stream).
  assert.deepEqual(importsOf(files.find((d) => d.name === "runs/approval-ruling.js").text), ["../store.js", "../runtime/sse.js"]);
  // Counter-test: the same check finds an import line on managing/ and on manager.js.
  const sabotaged = [{ name: "channels/deliver.js", text: 'import { deliverToChat } from "../managing/proposal-ops.js";\nimport * as mgr from "../manager.js";\n' }];
  assert.deepEqual(violations(sabotaged), ["channels/deliver.js → ../managing/proposal-ops.js", "channels/deliver.js → ../manager.js"]);
});

// (1b) Until managing was torn down, manager.js also assembled catalog, areas and primer from the SAME objects of the leaf - manager.js
// fell; what stays is the leaf itself.
test("(1b) The tool catalog: the leaf carries the two Coding groups, the primer starts with the header, the marks are its slice", () => {
  assert.deepEqual(CODING_GROUPS.map((g) => g.key), ["context", "communication"]);
  const choice = [...CODING_TOOLS];
  assert.equal(toolPrimer(choice, "HEADER").split("\n")[0], "HEADER");
  assert.equal(toolPrimer(choice, "HEADER").split("\n").length, 3, "header and one line per group");
  assert.deepEqual(MARKABLE, CODING_TOOLS.filter((t) => t.startsWith("cbase_")));
});

const status = async (url, init) => {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: res.status, body: await res.json() };
};

test("(2)(3) Approval marks, time zone and GitLab access on a real server: new keys, 400 instead of silent, a foreign mark stays", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const url = `${base}/api/workspaces/${ws.id}/approval-marks`;
    assert.deepEqual(await json(url), { tools: [], markable: MARKABLE });
    assert.equal((await status(url, { method: "PUT", body: JSON.stringify({}) })).status, 400, "a missing tools is no statement");
    const foreign = await status(url, { method: "PUT", body: JSON.stringify({ tools: ["cbase_fact_create"] }) });
    assert.equal(foreign.status, 400, "a tool outside the Coding catalog");
    assert.match(foreign.body.error, /cbase_fact_create/);

    // Legacy data: the fallen manager route wrote the same key with its whole catalog (now only possible through the store).
    store.setSetting(`approval.cbase.${ws.id}`, JSON.stringify(["cbase_fact_create", "cbase_agent_send"]));
    assert.deepEqual((await json(url)).tools, ["cbase_agent_send"], "Coding sees only its slice");
    assert.equal((await status(`${base}/api/workspaces/${ws.id}/manager/approval/cbase`)).status, 404, "the manager route is gone");

    // Coding replaces ITS slice; the foreign mark stays.
    assert.deepEqual((await json(url, { method: "PUT", body: JSON.stringify({ tools: ["cbase_projects_list"] }) })).tools, ["cbase_projects_list"]);
    assert.deepEqual(JSON.parse(store.getSetting(`approval.cbase.${ws.id}`)), ["cbase_fact_create", "cbase_projects_list"]);
    assert.deepEqual(approvalMarks(ws.id, new Set(["cbase_projects_list"])), ["cbase_projects_list"]);

    // The GitLab passthrough is gone entirely (D2): neither the old manager route nor the later coding route answers.
    assert.equal((await status(`${base}/api/workspaces/${ws.id}/manager/gitlab-access`)).status, 404, "the old route is gone");

    // Time zone: a schedule with a zone remembers it under the new key.
    const { timeZoneDefault, rememberTimeZone } = await import("../electron/server/workspaces/timeZone.js");
    assert.equal(timeZoneDefault(ws.id), "UTC");
    rememberTimeZone(ws.id, "Europe/Berlin");
    rememberTimeZone(ws.id, "Nirgendwo/Nonexistent");
    assert.equal(timeZoneDefault(ws.id), "Europe/Berlin", "an invalid zone is skipped");
    assert.equal(store.getSetting(`manager.timeZone.${ws.id}`, ""), "");
  });
});
