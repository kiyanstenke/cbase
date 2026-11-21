import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import { supplyFile, send, serveDownload, serveRanged } from "../electron/server/runtime/http.js";
import { zipDirectory } from "../electron/server/zip.js";
import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";

// A ZIP is NOT checked with the product's own reader — that would be circular. Instead Python's `zipfile` reads it (independent
// implementation, `testzip()` recomputes every CRC); without Python `unzip -t` steps in. Without both the test fails loudly, not silently.
function haveTool(bin, args) {
  try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS_PYTHON = haveTool("python3", ["-c", "import zipfile"]);
const HAS_UNZIP = haveTool("unzip", ["-v"]);

function inspectZip(file) {
  if (HAS_PYTHON) {
    const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = {"bad": z.testzip(), "names": z.namelist(), "sizes": {i.filename: i.file_size for i in z.infolist()}}
out["texts"] = {}
for name in z.namelist():
    if name.endswith((".txt", ".md", ".json")):
        out["texts"][name] = z.read(name).decode("utf-8", "replace")
print(json.dumps(out))
`;
    return JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));
  }
  if (HAS_UNZIP) {
    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" });
    execFileSync("unzip", ["-t", file], { stdio: "ignore" }); // throws on CRC errors
    const names = listing.split("\n").filter(Boolean);
    return { bad: null, names, sizes: {}, texts: {} };
  }
  assert.fail("Neither python3 (zipfile) nor unzip is available — the ZIP cannot be checked independently");
}

// Real server on a throw-away data directory, a workspace with a project in it. Both levels have their own routes (codeRoute vs. the
// project inline block) — both are checked.
async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dl-"));
  let server;
  try {
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "till");
    fs.mkdirSync(projPath, { recursive: true });
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await (await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", path: wsPath }),
    })).json();
    const proj = await (await fetch(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Till", path: projPath }),
    })).json();
    await run({ base, root, wsPath, projPath, wsId: ws.id, projId: proj.id, server });
  } finally {
    // Cut open connections first: a download that never ends would otherwise hold `close`.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    // A test must not fail because its temp directory does not go away: a child still writing causes ENOTEMPTY, and that is a statement
    // about the cleanup, not about the product. It is still not kept quiet — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

const dl = (base, scope, rel, extra = "") =>
  fetch(`${base}${scope}/files/download?path=${encodeURIComponent(rel)}${extra}`);

// A tiny, valid 1×1 PNG — real bytes, so the sniff/MIME path is right too.
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000a49444154789c6300010000050001" +
  "0d0a2db40000000049454e44ae426082", "hex");

test("file download delivers the bytes as an attachment — at project and workspace level", async () => {
  await withServer(async ({ base, wsPath, projPath, wsId, projId }) => {
    const text = "Line one\nline two\n";
    fs.writeFileSync(path.join(projPath, "notiz ä.md"), text, "utf8");
    fs.writeFileSync(path.join(wsPath, "top.txt"), "workspace", "utf8");

    for (const [scope, rel, expected] of [
      [`/api/projects/${projId}`, "notiz ä.md", text],
      [`/api/workspaces/${wsId}`, "top.txt", "workspace"],
    ]) {
      const res = await dl(base, scope, rel);
      assert.equal(res.status, 200, `${scope} → ${res.status}`);
      const cd = res.headers.get("content-disposition") || "";
      assert.match(cd, /^attachment;/);
      // Umlauts survive only through filename*; the ASCII filename is the fallback.
      assert.match(cd, /filename\*=UTF-8''/);
      assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(expected)));
      assert.equal(await res.text(), expected);
    }

    const dec = decodeURIComponent(
      ((await dl(base, `/api/projects/${projId}`, "notiz ä.md")).headers.get("content-disposition") || "")
        .split("filename*=UTF-8''")[1] || "");
    assert.equal(dec, "notiz ä.md");
  });
});

test("folder download is a valid ZIP with the folder as root", async () => {
  await withServer(async ({ base, root, projPath, projId }) => {
    fs.mkdirSync(path.join(projPath, "src/deep"), { recursive: true });
    fs.mkdirSync(path.join(projPath, "empty"));
    fs.writeFileSync(path.join(projPath, "src/index.ts"), "export const a = 1;\n".repeat(200));
    fs.writeFileSync(path.join(projPath, "src/deep/ä.txt"), "Ümlaut\n", "utf8");
    fs.writeFileSync(path.join(projPath, "src/image.png"), PNG_1x1);
    fs.mkdirSync(path.join(projPath, ".git"));
    fs.writeFileSync(path.join(projPath, ".git/HEAD"), "ref: refs/heads/main\n");

    const res = await dl(base, `/api/projects/${projId}`, "src");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") || "", /^attachment; filename="src\.zip"/);

    const file = path.join(root, "src.zip");
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const zip = inspectZip(file);
    assert.equal(zip.bad, null, "CRC check failed");
    assert.deepEqual(zip.names.sort(), [
      "src/image.png", "src/index.ts", "src/deep/", "src/deep/ä.txt",
    ].sort());
    if (HAS_PYTHON) {
      assert.equal(zip.sizes["src/index.ts"], 20 * 200);
      assert.equal(zip.texts["src/deep/ä.txt"], "Ümlaut\n");
    }

    // The whole project (empty path) — empty folders are kept, .git stays out.
    const whole = await dl(base, `/api/projects/${projId}`, "");
    const wholeFile = path.join(root, "till.zip");
    fs.writeFileSync(wholeFile, Buffer.from(await whole.arrayBuffer()));
    assert.match(whole.headers.get("content-disposition") || "", /filename="till\.zip"/);
    const all = inspectZip(wholeFile);
    assert.equal(all.bad, null);
    assert.ok(all.names.includes("till/empty/"), "empty folder is missing from the archive");
    assert.ok(!all.names.some((n) => n.includes(".git/")), `.git is in the archive: ${all.names}`);
  });
});

test("symlinks: outward ones are skipped and documented in the archive", async () => {
  await withServer(async ({ base, root, projPath, projId }) => {
    const outside = path.join(root, "secret.txt");
    fs.writeFileSync(outside, "DO NOT DELIVER", "utf8");
    fs.mkdirSync(path.join(projPath, "mix"));
    fs.writeFileSync(path.join(projPath, "mix/inside.txt"), "inside", "utf8");
    fs.symlinkSync(outside, path.join(projPath, "mix/out.txt"));
    fs.symlinkSync(path.join(projPath, "mix"), path.join(projPath, "mix/cycle"));

    const res = await dl(base, `/api/projects/${projId}`, "mix");
    const file = path.join(root, "mix.zip");
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const zip = inspectZip(file);
    assert.equal(zip.bad, null);
    assert.ok(zip.names.includes("mix/inside.txt"));
    assert.ok(!zip.names.includes("mix/out.txt"), "outward symlink was delivered");
    assert.ok(zip.names.includes("mix/_CBASE-SKIPPED.txt"), "notice file is missing");
    if (HAS_PYTHON) {
      const notes = zip.texts["mix/_CBASE-SKIPPED.txt"];
      assert.match(notes, /out\.txt/);
      assert.match(notes, /cycle/);
      assert.ok(!notes.includes("DO NOT DELIVER"));
    }

    // Direct download of an outward-pointing symlink: rejected, not delivered.
    const leak = await dl(base, `/api/projects/${projId}`, "mix/out.txt");
    assert.equal(leak.status, 400);
    assert.doesNotMatch(JSON.stringify(await leak.json()), /DO NOT DELIVER/);
  });
});

test("path escape is rejected", async () => {
  await withServer(async ({ base, root, projId, wsId }) => {
    fs.writeFileSync(path.join(root, "extern.txt"), "extern", "utf8");
    for (const scope of [`/api/projects/${projId}`, `/api/workspaces/${wsId}`]) {
      for (const rel of ["../../extern.txt", "/etc/hosts", "../extern.txt"]) {
        const res = await dl(base, scope, rel);
        assert.equal(res.status, 400, `${scope} ${rel} → ${res.status}`);
      }
    }
  });
});

test("images: read reports image+mime, inline delivers the bytes for display", async () => {
  await withServer(async ({ base, projPath, projId }) => {
    fs.writeFileSync(path.join(projPath, "logo.png"), PNG_1x1);

    const meta = await (await fetch(`${base}/api/projects/${projId}/files/read?path=logo.png`)).json();
    assert.equal(meta.binary, true);
    assert.equal(meta.image, true);
    assert.equal(meta.mime, "image/png");
    assert.equal(meta.size, PNG_1x1.length);

    const res = await dl(base, `/api/projects/${projId}`, "logo.png", "&inline=1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_1x1);

    // Without inline=1 the same bytes, but for saving.
    const attach = await dl(base, `/api/projects/${projId}`, "logo.png");
    assert.match(attach.headers.get("content-disposition") || "", /^attachment;/);
  });
});

test("upload lands in the chosen folder — at project and workspace level", async () => {
  await withServer(async ({ base, wsPath, projPath, wsId, projId }) => {
    fs.mkdirSync(path.join(projPath, "assets"), { recursive: true });
    const put = (scope, body) => fetch(`${base}${scope}/upload`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    // Into a subfolder (exactly what "into the selected folder" means).
    const r1 = await put(`/api/projects/${projId}`, {
      dir: "assets",
      files: [{ path: "logo.png", dataB64: PNG_1x1.toString("base64") }],
    });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).written, 1);
    assert.deepEqual(fs.readFileSync(path.join(projPath, "assets/logo.png")), PNG_1x1);

    // Without dir → root; subpaths in the file name create folders.
    await put(`/api/projects/${projId}`, {
      files: [{ path: "docs/deep/note.txt", dataB64: Buffer.from("hello", "utf8").toString("base64") }],
    });
    assert.equal(fs.readFileSync(path.join(projPath, "docs/deep/note.txt"), "utf8"), "hello");

    // The workspace level works too (not only projects).
    const r3 = await put(`/api/workspaces/${wsId}`, {
      dir: "", files: [{ path: "top.txt", dataB64: Buffer.from("ws", "utf8").toString("base64") }],
    });
    assert.equal(r3.status, 200);
    assert.equal(fs.readFileSync(path.join(wsPath, "top.txt"), "utf8"), "ws");

    // In pieces: the second call appends instead of overwriting.
    await put(`/api/projects/${projId}`, { dir: "assets", files: [{ path: "large.bin", dataB64: Buffer.from("AAA").toString("base64") }] });
    await put(`/api/projects/${projId}`, { dir: "assets", files: [{ path: "large.bin", dataB64: Buffer.from("BBB").toString("base64"), append: true }] });
    assert.equal(fs.readFileSync(path.join(projPath, "assets/large.bin"), "utf8"), "AAABBB");
  });
});

test("upload does not break out of the folder", async () => {
  await withServer(async ({ base, root, projPath, projId }) => {
    const put = (body) => fetch(`${base}/api/projects/${projId}/upload`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const malicious = [
      { dir: "", files: [{ path: "../escape.txt", dataB64: "eA==" }] },
      { dir: "..", files: [{ path: "escape.txt", dataB64: "eA==" }] },
      { dir: "../..", files: [{ path: "escape.txt", dataB64: "eA==" }] },
      { dir: "", files: [{ path: "/etc/escape.txt", dataB64: "eA==" }] },
      { dir: "", files: [{ path: "a/../../escape.txt", dataB64: "eA==" }] },
    ];
    for (const body of malicious) {
      const res = await put(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status}`);
    }
    // And really nothing written — neither next to the project nor above it.
    assert.equal(fs.existsSync(path.join(projPath, "..", "escape.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "escape.txt")), false);

    // A non-existent target folder is rejected, not silently created.
    const missing = await put({ dir: "nonexistent", files: [{ path: "a.txt", dataB64: "eA==" }] });
    assert.equal(missing.status, 400);
    assert.equal(fs.existsSync(path.join(projPath, "nonexistent")), false);
  });
});

test("ZIP64: 64-bit fields and completion stay readable", async () => {
  // The real triggers (>4 GiB file or >65535 entries) are too expensive for a test — so exactly the code paths that then apply are forced.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-zip64-"));
  try {
    const src = path.join(root, "source");
    fs.mkdirSync(path.join(src, "under"), { recursive: true });
    fs.writeFileSync(path.join(src, "large.txt"), "abcdefghij".repeat(5000));
    fs.writeFileSync(path.join(src, "under/small.txt"), "x", "utf8");

    for (const [label, opts] of [
      ["fields", { forceZip64: true }],
      ["completion", { forceEocd64: true }],
      ["both", { forceZip64: true, forceEocd64: true }],
    ]) {
      const file = path.join(root, `${label}.zip`);
      const out = fs.createWriteStream(file);
      const stats = await zipDirectory(src, "source", out, opts);
      await new Promise((resolve) => out.end(resolve));
      assert.equal(stats.files, 2);
      const zip = inspectZip(file);
      assert.equal(zip.bad, null, `${label}: CRC check failed`);
      assert.deepEqual(zip.names.sort(), ["source/large.txt", "source/under/", "source/under/small.txt"]);
      if (HAS_PYTHON) assert.equal(zip.sizes["source/large.txt"], 50000);
    }
  } finally {
    // A test must not fail because its temp directory does not go away: a child still writing causes ENOTEMPTY, and that is a statement
    // about the cleanup, not about the product. It is still not kept quiet — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// ══ Serving from a file (runtime/http.js) ═══════════════════════════════════════════════════════════════════════════════════════
//   open failure  a download whose OPENING fails (mode 000, a folder, a missing file): the error used to arrive AFTER the 200 head
//                 as 'error' on a stream without listener — process end (B including the project containers). Now a response with status.
//   abort         an aborted download (seeking in web video): `pipe` did not destroy the source, stream and descriptor stayed open.
// COUNTER-TESTS (each red): open failure 200 instead of 403/400/404 and "EACCES"/"EISDIR" as uncaught exception in the test process;
// abort `destroyed: false` on the read stream after the abort.

// Only the status line, then close. And raced against an uncaught exception in the test process: in the old state the stream died
// without listener BEFORE a byte went — and since the head goes out only with the first byte, no status line ever came. Without the
// race the red would turn into a hang.
function onlyStatus(url) {
  let listener;
  const uncaught = new Promise((_, reject) => { listener = (e) => reject(e); process.once("uncaughtException", listener); });
  const status = new Promise((resolve, reject) => {
    const r = http.get(url, { agent: false }, (res) => { resolve(res.statusCode); res.socket.destroy(); });
    r.on("error", reject);
  });
  return Promise.race([status, uncaught]).finally(() => process.off("uncaughtException", listener));
}

// A server whose handler calls the serving like the routes do (a throw becomes a response, as in the dispatcher).
async function withServing(handler, run) {
  const srv = http.createServer(async (req, res) => {
    try { await handler(req, res); }
    catch (e) { if (!res.headersSent) send(res, Number(e?.status) || 500, { error: String(e?.message || e) }); else res.destroy(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { await run(`http://127.0.0.1:${srv.address().port}/`); } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

const IS_ROOT = process.getuid?.() === 0; // root reads even mode 000 — there the folder case carries the path alone

test("open failure: the download of a file without read permission is 403 — on the real server, no stream error without listener", { skip: IS_ROOT && "runs as root" }, async () => {
  await withServer(async ({ base, wsPath, wsId, projId }) => {
    const file = path.join(wsPath, "till", "locked.txt");
    fs.writeFileSync(file, "secret");
    fs.chmodSync(file, 0o000);
    try {
      for (const scope of [`/api/workspaces/${wsId}`, `/api/projects/${projId}`]) {
        const rel = scope.startsWith("/api/workspaces") ? "till/locked.txt" : "locked.txt";
        assert.equal(await onlyStatus(`${base}${scope}/files/download?path=${encodeURIComponent(rel)}`), 403, scope);
        assert.equal(await onlyStatus(`${base}${scope}/files/download?path=${encodeURIComponent(rel)}&inline=1`), 403, `${scope} inline`);
      }
      // And the server keeps answering afterwards.
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});

test("open failure: serveRanged and serveDownload open BEFORE the head — folder 400, missing 404, without read permission 403", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dl-a1-"));
  try {
    fs.mkdirSync(path.join(root, "folder"));
    fs.writeFileSync(path.join(root, "locked.txt"), "secret");
    fs.chmodSync(path.join(root, "locked.txt"), 0o000);
    fs.writeFileSync(path.join(root, "free.txt"), "hallo äöü");
    let fall = null;
    await withServing(async (req, res) => {
      if (fall === "ranged-folder") return serveRanged(req, res, path.join(root, "folder"), "video/mp4");
      if (fall === "ranged-missing") return serveRanged(req, res, path.join(root, "missing.mp4"), "video/mp4");
      if (fall === "ranged-locked") return serveRanged(req, res, path.join(root, "locked.txt"), "text/plain");
      if (fall === "ranged-free") return serveRanged(req, res, path.join(root, "free.txt"), "text/plain");
      if (fall === "download-locked") return serveDownload(root, "locked.txt", res);
      if (fall === "download-free") return serveDownload(root, "free.txt", res);
      return send(res, 404, {});
    }, async (url) => {
      // A folder as file (EISDIR — also as root), a missing file: the asynchronous open used to throw AFTER the 200.
      fall = "ranged-folder";
      assert.equal(await onlyStatus(url), 400);
      fall = "ranged-missing";
      assert.equal(await onlyStatus(url), 404);
      if (!IS_ROOT) {
        fall = "ranged-locked";
        assert.equal(await onlyStatus(url), 403);
        fall = "download-locked";
        assert.equal(await onlyStatus(url), 403);
      }
      // The ordinary path stays: whole file, range, download.
      fall = "ranged-free";
      const whole = await fetch(url);
      assert.deepEqual([whole.status, await whole.text()], [200, "hallo äöü"]);
      const part = await fetch(url, { headers: { range: "bytes=0-4" } });
      assert.deepEqual([part.status, part.headers.get("content-range"), await part.text()], [206, `bytes 0-4/${Buffer.byteLength("hallo äöü")}`, "hallo"]);
      const beside = await fetch(url, { headers: { range: "bytes=999-" } });
      assert.equal(beside.status, 416);
      fall = "download-free";
      const dl = await fetch(url);
      assert.deepEqual([dl.status, dl.headers.get("content-length"), await dl.text()], [200, String(Buffer.byteLength("hallo äöü")), "hallo äöü"]);
    });
  } finally {
    try { fs.chmodSync(path.join(root, "locked.txt"), 0o600); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("abort: an aborted download destroys its read stream (and so closes the descriptor)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-abort-"));
  const file = path.join(root, "large.mp4");
  fs.closeSync(fs.openSync(file, "w"));
  fs.truncateSync(file, 64 * 1024 * 1024); // sparse: 64 MB never fit into the buffers before the client aborts
  // Record the streams that runtime/http.js creates (the same module object `fs`).
  const created = [];
  const original = fs.createReadStream;
  fs.createReadStream = function (...a) { const s = original.apply(this, a); created.push(s); return s; };
  let fall = null;
  let to = null;
  try {
    await withServing(async (req, res) => {
      to = once(res, "close");
      if (fall === "ranged" || fall === "area") return serveRanged(req, res, file, "video/mp4");
      if (fall === "fd") return serveRanged(req, res, file, "video/mp4", { fd: fs.openSync(file, "r") });
      return serveDownload(root, "large.mp4", res);
    }, async (url) => {
      for (const [f, header] of [["ranged", {}], ["area", { range: "bytes=1000-" }], ["fd", {}], ["download", {}]]) {
        fall = f;
        const prior = created.length;
        await new Promise((resolve, reject) => {
          const r = http.get(url, { agent: false, headers: header }, (res) => {
            res.socket.destroy(); // abort like a video being seeked
            resolve();
          });
          r.on("error", (e) => (e.code === "ECONNRESET" ? resolve() : reject(e)));
        });
        await to; // the response is closed on the server side
        await new Promise((r) => setImmediate(r));
        const stream = created[prior];
        assert.ok(stream, `${f}: a read stream was created`);
        assert.equal(stream.destroyed, true, `${f}: the read stream is destroyed after the abort`);
        // And its descriptor is closed. No `once` — it rejects on the 'error' with which pipeline destroys the stream (Premature close).
        if (!stream.closed) await new Promise((r) => stream.once("close", r));
      }
    });
  } finally {
    fs.createReadStream = original;
    // In the old state the streams stayed open (the defect itself) — destroying them here keeps the red from becoming a hang.
    for (const s of created) { try { s.destroy(); } catch { /* already closed */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ══ The same defects at the routes ═══════════════════════════════════════════════════════════════════════════════════════════════
// The open-failure and abort fixes were first only in runtime/http.js. Six routes still wrote the 200 head first and then attached
// `fs.createReadStream(path).pipe(res)` WITHOUT an error listener: chats/routes.js (folder context, chat attachment, artifact),
// channels/routes.js (channel file) and others. A read error (EACCES, EISDIR) was again a stream error without listener — without
// a catcher the process end (attachment with mode 000 => SIGABRT of the server), in B the response hung; an aborted download left
// stream and descriptor open. Now all go through `supplyFile` (runtime/http.js).
// COUNTER-TESTS (each red): mode 000 and folder => "EACCES"/"EISDIR" as uncaught exception in the test process instead of 403/400; the
// abort => `destroyed: false` on the read stream; in the server tree six `createReadStream(…).pipe(res)` stand.

// A file under `root` with exactly this name (the server computes the storage locations, the test searches for them).
function findFile(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const t = findFile(p, name); if (t) return t; }
  }
  return null;
}
const jsonPost = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.ok, `${url}: ${r.status} ${text}`);
  return JSON.parse(text);
};
const rawPost = async (url, bytes) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
  const text = await r.text();
  assert.ok(r.ok, `${url}: ${r.status} ${text}`);
  return JSON.parse(text);
};

// The file routes, each with a file in it. `opensSelf`: the route opens the file only in supplyFile (attachment, channel); artifact and
// folder context read it whole beforehand (artifacts.js artifactMeta, for the checksum) and answer on mode 000 or a folder already
// there — for them the abort carries the path.
async function fileRoutes({ base, root, wsId }) {
  const content = "Content äöü";
  const chat = await jsonPost(`${base}/api/chats`, { workspaceId: wsId });
  const attachment = await rawPost(`${base}/api/chats/${chat.id}/attachments?name=attachment.txt&artifact=0`, content);
  await rawPost(`${base}/api/chats/${chat.id}/artifacts/upload?path=report.txt`, content);
  const folder = await jsonPost(`${base}/api/chat-folders`, { workspaceId: wsId, name: "Folder A1" });
  await rawPost(`${base}/api/chat-folders/${folder.id}/context/upload?path=context.md`, content);
  // The channel file through the store (its way in needs a channel with a message — only the serving is measured here).
  const channel = store.createChannel({ id: randomUUID(), workspaceId: wsId, name: "A1" });
  const channelFile = path.join(DIRS.channelFiles, channel.id, "channel.txt");
  fs.mkdirSync(path.dirname(channelFile), { recursive: true });
  fs.writeFileSync(channelFile, content);
  const data = path.join(root, "data-root");
  return {
    content,
    routes: [
      { name: "Chat attachment", url: `${base}/api/chats/${chat.id}/attachments/${encodeURIComponent(attachment.file)}`, file: findFile(data, attachment.file), opensSelf: true },
      { name: "Artifact", url: `${base}/api/chats/${chat.id}/artifacts/download?path=report.txt`, file: findFile(data, "report.txt"), opensSelf: false },
      { name: "Folder context", url: `${base}/api/chat-folders/${folder.id}/context/download?path=context.md`, file: findFile(data, "context.md"), opensSelf: false },
      { name: "Channel file", url: `${base}/api/channels/${channel.id}/files/channel.txt`, file: channelFile, opensSelf: true },
    ],
  };
}

test("file routes: open BEFORE the head — without read permission 403, a folder 400, the server lives", async () => {
  await withServer(async (ctx) => {
    const { content, routes } = await fileRoutes(ctx);
    assert.deepEqual(routes.map((r) => r.name), ["Chat attachment", "Artifact", "Folder context", "Channel file"]);
    for (const r of routes) {
      assert.ok(r.file && fs.existsSync(r.file), `${r.name}: file found on disk (${r.file})`);
      // The ordinary path: the bytes.
      const ok = await fetch(r.url);
      const length = ok.headers.get("content-length");
      assert.deepEqual([ok.status, await ok.text()], [200, content], r.name);
      if (r.opensSelf) {
        if (!IS_ROOT) {
          fs.chmodSync(r.file, 0o000);
          try { assert.equal(await onlyStatus(r.url), 403, `${r.name}: without read permission`); }
          finally { fs.chmodSync(r.file, 0o600); }
        }
        // A folder in place of the file (EISDIR — also as root): the stream used to throw AFTER the 200.
        fs.rmSync(r.file);
        fs.mkdirSync(r.file);
        try { assert.equal(await onlyStatus(r.url), 400, `${r.name}: a folder is not a file`); }
        finally { fs.rmdirSync(r.file); fs.writeFileSync(r.file, content); }
      }
      // The length from the opened descriptor (attachment and channel file used to go without, chunked).
      assert.equal(length, String(Buffer.byteLength(content)), `${r.name}: Content-Length`);
    }
    assert.equal((await fetch(`${ctx.base}/api/health`)).status, 200, "the server keeps answering afterwards");
  });
});

test("abort: an aborted download on every file route destroys its read stream", async () => {
  const created = [];
  const original = fs.createReadStream;
  try {
    await withServer(async (ctx) => {
      const { routes } = await fileRoutes(ctx);
      fs.createReadStream = function (...a) { const s = original.apply(this, a); created.push(s); return s; };
      for (const r of routes) {
        fs.truncateSync(r.file, 64 * 1024 * 1024); // sparse: 64 MB never fit into the buffers before the client aborts
        const prior = created.length;
        // The end of the connection on the SERVER side (the response is closed as soon as its socket is).
        const to = new Promise((resolve) => ctx.server.once("connection", (s) => s.once("close", resolve)));
        await new Promise((resolve, reject) => {
          const q = http.get(r.url, { agent: false }, (res) => {
            assert.equal(res.statusCode, 200, r.name);
            res.socket.destroy(); // abort like a video being seeked
            resolve();
          });
          q.on("error", (e) => (e.code === "ECONNRESET" ? resolve() : reject(e)));
        });
        await to;
        await new Promise((resolve) => setImmediate(resolve));
        const stream = created[prior];
        assert.ok(stream, `${r.name}: a read stream was created`);
        assert.equal(created.length, prior + 1, `${r.name}: exactly one read stream`);
        assert.equal(stream.destroyed, true, `${r.name}: the read stream is destroyed after the abort`);
        if (!stream.closed) await new Promise((resolve) => stream.once("close", resolve));
      }
    });
  } finally {
    fs.createReadStream = original;
    // In the old state the streams stayed open (the defect itself) — destroying them here keeps the red from becoming a hang.
    for (const x of created) { try { x.destroy(); } catch { /* already closed */ } }
  }
});

test("supplyFile: path or checked descriptor, opened before the head, length from fstat", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-supply-"));
  try {
    fs.mkdirSync(path.join(root, "folder"));
    fs.writeFileSync(path.join(root, "free.txt"), "hallo äöü");
    fs.writeFileSync(path.join(root, "locked.txt"), "secret");
    fs.chmodSync(path.join(root, "locked.txt"), 0o000);
    let fall = null;
    const open = [];
    await withServing(async (req, res) => {
      const header = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private" };
      if (fall === "path") return supplyFile(res, { path: path.join(root, "free.txt") }, header);
      if (fall === "fd") { const fd = fs.openSync(path.join(root, "free.txt"), "r"); open.push(fd); return supplyFile(res, { fd }, header); }
      if (fall === "fd-folder") { const fd = fs.openSync(path.join(root, "folder"), "r"); open.push(fd); return supplyFile(res, { fd }, header); }
      if (fall === "folder") return supplyFile(res, { path: path.join(root, "folder") }, header);
      if (fall === "missing") return supplyFile(res, { path: path.join(root, "missing.txt") }, header);
      if (fall === "locked") return supplyFile(res, { path: path.join(root, "locked.txt") }, header);
      return send(res, 404, {});
    }, async (url) => {
      for (const f of ["path", "fd"]) {
        fall = f;
        const r = await fetch(url);
        assert.deepEqual([r.status, r.headers.get("content-length"), r.headers.get("cache-control"), await r.text()], [200, String(Buffer.byteLength("hallo äöü")), "private", "hallo äöü"], f);
      }
      fall = "folder";
      assert.equal(await onlyStatus(url), 400);
      fall = "fd-folder";
      assert.equal(await onlyStatus(url), 400);
      fall = "missing";
      assert.equal(await onlyStatus(url), 404);
      if (!IS_ROOT) { fall = "locked"; assert.equal(await onlyStatus(url), 403); }
    });
    // Every descriptor handed over is closed — served (autoClose) or rejected (closed before the response). The read stream closes its
    // descriptor AFTER the last byte (autoClose, 'close' follows 'end') — the response is then already complete at the client. Under load
    // the closing lay behind the fetch. So wait for the closing (no deadline — if it hangs the suite ends the run), then check.
    const to = (fd) => { try { fs.fstatSync(fd); return false; } catch (e) { return e.code === "EBADF"; } };
    for (const fd of open) while (!to(fd)) await new Promise((r) => setImmediate(r));
    for (const fd of open) assert.throws(() => fs.fstatSync(fd), /EBADF/, `descriptor ${fd} is closed`);
  } finally {
    try { fs.chmodSync(path.join(root, "locked.txt"), 0o600); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("server tree: no read stream without listener hangs on a response any more (`createReadStream(…).pipe(res)`)", () => {
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");
  const hits = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") go(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      fs.readFileSync(p, "utf8").split("\n").forEach((z, i) => {
        if (/^\s*(\/\/|\*)/.test(z)) return; // a comment describing the old way is no hit
        if (/createReadStream\(.*\.pipe\(\s*res\s*\)/.test(z)) hits.push(`${path.relative(tree, p)}:${i + 1}: ${z.trim().slice(0, 140)}`);
      });
    }
  };
  go(tree);
  assert.deepEqual(hits, [], `serve files through runtime/http.js supplyFile (open before the head, pipeline):\n${hits.join("\n")}`);
});
