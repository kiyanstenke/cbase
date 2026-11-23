// Outputs as download: a FOLDER of a chat's output location (or the whole location) as a streamed ZIP —
// GET /api/chats/:id/outputs/folder?path=<rel> (chats/outputs-routes.js → runs/outputs-view.js openOutputFolder → zip.js `area`).
//
// What this guard holds:
//   (1) A subfolder and the whole location (`path=` empty) come as ZIP with the files under `<name>/`; headers: application/zip,
//       attachment `<name>.zip`, `private, no-store`.
//   (2) Boundary: `..`, absolute, empty part, backslash, a MISSING `path` => 400; a folder that is a link leading out, and a
//       location that is itself a link => 403/404 and never the content behind it; a file path is 404 (not a folder).
//   (3) Links INSIDE the packed folder are not followed: the file behind them is missing from the archive, the link is named in
//       `_CBASE-SKIPPED.txt`.
//   (4) Archive: an archived chat may still download.
//
// COUNTER-TESTS (each shown red, then restored):
//   outputs-view.js openOutputFolder `relativeOutputPath(rel)` -> `rel.split("/")` => (2) red ("../" packs the neighbour);
//   outputs-view.js openOutputFolder without `O_NOFOLLOW` in the openInArea flags => (2) red (a folder that is a link inside the
//     location is packed; one leading out stays 403 through the area check alone);
//   outputs-routes.js the `area: folder.area` option removed (zip.js plain mode follows links that stay in the folder) => (3) red;
//   outputs-view.js openOutputFolder `rel === ""` -> `!rel` => (2) red (a missing path packs the whole location).
//
// Run: ./check (a single file only with the gate environment)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { outputLocation } from "../electron/server/runs/outputs.js";
import { makeChat, makeWorkspace, withServer } from "./server-harness.mjs";

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const folder = (base, id, rel) =>
  fetch(`${base}/api/chats/${id}/outputs/folder${rel === null ? "" : `?path=${encodeURIComponent(rel)}`}`);

// The ZIP is read by Python's zipfile (an independent reader, testzip() recomputes every CRC) — never by the product's own code.
function readZip(buf, dir) {
  const file = path.join(dir, `z-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, buf);
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": sorted(z.namelist()),
  "texts": {n: z.read(n).decode("utf-8", "replace") for n in z.namelist() if not n.endswith("/")}}))
`;
  return JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));
}

test("(1) a subfolder and the whole location as ZIP, with headers", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    write(path.join(location, "report.md"), "# Report\n");
    write(path.join(location, "screens", "a.png"), "PNG-A");
    write(path.join(location, "screens", "deep", "b.txt"), "B");

    const r = await folder(base, chat.id, "screens");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/zip");
    assert.match(r.headers.get("content-disposition"), /^attachment;.*screens\.zip/);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    const z = readZip(Buffer.from(await r.arrayBuffer()), root);
    assert.equal(z.bad, null, "every CRC holds");
    assert.deepEqual(z.names, ["screens/a.png", "screens/deep/", "screens/deep/b.txt"]);
    assert.equal(z.texts["screens/a.png"], "PNG-A");

    const all = await folder(base, chat.id, "");
    assert.equal(all.status, 200);
    assert.match(all.headers.get("content-disposition"), /outputs\.zip/);
    const za = readZip(Buffer.from(await all.arrayBuffer()), root);
    assert.deepEqual(za.names.filter((n) => !n.endsWith("/")), ["outputs/report.md", "outputs/screens/a.png", "outputs/screens/deep/b.txt"]);
    assert.equal(za.texts["outputs/report.md"], "# Report\n");
  });
});

test("(2) boundary: invalid and missing path, link folder leading out, location itself a link, a file is not a folder", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    const outside = path.join(root, "outside");
    write(path.join(outside, "secret.txt"), "SECRET");
    write(path.join(location, "ok", "ok.txt"), "ok");
    // Next to the location (the folder of all chats' locations) — `..` points exactly here.
    write(path.join(path.dirname(location), "neighbor", "n.txt"), "NEIGHBOR");
    fs.symlinkSync(outside, path.join(location, "screens"));
    fs.symlinkSync(path.join(location, "ok"), path.join(location, "alias"));

    for (const malicious of ["..", "../neighbor", "ok/../../neighbor", "/etc", "a//b", "./ok", "a\\b", null]) {
      const r = await folder(base, chat.id, malicious);
      const text = Buffer.from(await r.arrayBuffer()).toString("latin1");
      assert.equal(r.status, 400, `400 for ${JSON.stringify(malicious)}`);
      assert.doesNotMatch(text, /NEIGHBOR|SECRET/);
    }
    const linked = await folder(base, chat.id, "screens");
    assert.ok(linked.status === 403 || linked.status === 404, `link folder: ${linked.status}`);
    assert.doesNotMatch(Buffer.from(await linked.arrayBuffer()).toString("latin1"), /SECRET/, "never the content behind the link");
    const alias = await folder(base, chat.id, "alias");
    // macOS answers O_DIRECTORY|O_NOFOLLOW on a link with ENOTDIR (404), Linux with ELOOP (403): either way not packed.
    assert.ok(alias.status === 403 || alias.status === 404, `a folder that is itself a link is never packed, even one staying inside: ${alias.status}`);
    await alias.arrayBuffer();
    const notAFolder = await folder(base, chat.id, "ok/ok.txt");
    assert.equal(notAFolder.status, 404);
    await notAFolder.arrayBuffer();

    // The location itself a link leading out: nothing is packed.
    const second = await makeChat(base, ws.id);
    fs.symlinkSync(outside, outputLocation(second.id));
    for (const rel of ["", "."]) {
      const r = await folder(base, second.id, rel);
      assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(rel)}: ${r.status}`);
      assert.doesNotMatch(Buffer.from(await r.arrayBuffer()).toString("latin1"), /SECRET/);
    }
  });
});

test("(3) links inside the packed folder are skipped and named, never followed", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    const outside = path.join(root, "outside");
    write(path.join(outside, "secret.txt"), "SECRET");
    write(path.join(location, "out", "real.txt"), "REAL");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(location, "out", "reference.txt"));
    fs.symlinkSync(outside, path.join(location, "out", "away"));
    fs.symlinkSync(path.join(location, "out", "real.txt"), path.join(location, "out", "alias.txt"));

    const r = await folder(base, chat.id, "out");
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.includes(Buffer.from("SECRET")), false, "the bytes behind a link never go out");
    const z = readZip(buf, root);
    assert.equal(z.bad, null);
    assert.deepEqual(z.names, ["out/_CBASE-SKIPPED.txt", "out/real.txt"]);
    assert.match(z.texts["out/_CBASE-SKIPPED.txt"], /out\/reference\.txt/);
    assert.match(z.texts["out/_CBASE-SKIPPED.txt"], /out\/away/);
    assert.match(z.texts["out/_CBASE-SKIPPED.txt"], /out\/alias\.txt/, "a link staying inside the folder is not followed either");
  });
});

test("(4) archive: an archived chat may still download a folder", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    write(path.join(outputLocation(chat.id), "rep", "x.md"), "X");
    store.archiveChat(chat.id, Date.now(), "user");
    const r = await folder(base, chat.id, "rep");
    assert.equal(r.status, 200);
    assert.deepEqual(readZip(Buffer.from(await r.arrayBuffer()), root).names, ["rep/x.md"]);
  });
});
