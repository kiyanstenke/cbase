import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-artifacts-api-"));
  let server;
  try {
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const workspace = (await json(`${base}/api/workspaces`, {
      method: "POST", body: JSON.stringify({ name: "Test", path: workspacePath }),
    })).body;
    const chat = (await json(`${base}/api/chats`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id }),
    })).body;
    await run({ base, root, workspace, chat });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("artifact API persists files, guards updates and copies them on fork", async () => {
  await withServer(async ({ base, root, chat }) => {
    const file = `${base}/api/chats/${chat.id}/artifacts/file`;
    const created = await json(file, {
      method: "PUT",
      body: JSON.stringify({ path: "issues/01-login.md", content: "# Login\n" }),
    });
    assert.equal(created.status, 200);
    assert.match(created.body.sha256, /^[a-f0-9]{64}$/);

    const list = await json(`${base}/api/chats/${chat.id}/artifacts`);
    assert.deepEqual(list.body.map((a) => a.path), ["issues/01-login.md"]);

    const conflict = await json(file, {
      method: "PUT",
      body: JSON.stringify({ path: "issues/01-login.md", content: "changed" }),
    });
    assert.equal(conflict.status, 409);

    const updated = await json(file, {
      method: "PUT",
      body: JSON.stringify({
        path: "issues/01-login.md", content: "# Login\n\nFinished.\n", expectedSha256: created.body.sha256,
      }),
    });
    assert.equal(updated.status, 200);

    const read = await json(`${file}?path=${encodeURIComponent("issues/01-login.md")}`);
    assert.equal(read.body.content, "# Login\n\nFinished.\n");
    assert.equal(read.body.encoding, "utf8");

    const download = await fetch(`${base}/api/chats/${chat.id}/artifacts/download?path=${encodeURIComponent("issues/01-login.md")}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(await download.text(), read.body.content);

    const fork = await json(`${base}/api/chats/${chat.id}/fork`, { method: "POST", body: "{}" });
    assert.equal(fork.status, 201);
    const forkList = await json(`${base}/api/chats/${fork.body.id}/artifacts`);
    assert.deepEqual(forkList.body.map((a) => [a.path, a.sha256]), [[read.body.path, read.body.sha256]]);

    const removed = await json(`${base}/api/chats/${chat.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(path.join(root, "data-root/data/artifacts", chat.id)), false);
    assert.equal(fs.existsSync(path.join(root, "data-root/data/artifacts", fork.body.id)), true);
  });
});

test("manual upload creates artifacts and overwrites only after confirmation", async () => {
  await withServer(async ({ base, chat }) => {
    const upload = (name, body, overwrite = false) =>
      fetch(`${base}/api/chats/${chat.id}/artifacts/upload?path=${encodeURIComponent(name)}${overwrite ? "&overwrite=1" : ""}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body,
      });

    const created = await upload("Notes v2.md", "# Notes\n");
    assert.equal(created.status, 201);
    assert.equal((await created.json()).path, "Notes v2.md");

    // Second upload of the same name: the server does NOT overwrite on its own but
    // reports `exists` — the client prompt hangs on that.
    const conflict = await upload("Notes v2.md", "# Other\n");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).exists, true);

    const replaced = await upload("Notes v2.md", "# Other\n", true);
    assert.equal(replaced.status, 201);
    const read = await json(`${base}/api/chats/${chat.id}/artifacts/file?path=${encodeURIComponent("Notes v2.md")}`);
    assert.equal(read.body.content, "# Other\n");

    // A file name from the user's file system is trimmed, not rejected.
    const messy = await upload("../../etc/passwd", "x");
    assert.equal(messy.status, 201);
    assert.equal((await messy.json()).path, "etc/passwd");

    const empty = await upload("empty.md", "");
    assert.equal(empty.status, 400);

    const list = await json(`${base}/api/chats/${chat.id}/artifacts`);
    assert.deepEqual(list.body.map((a) => a.path).sort(), ["Notes v2.md", "etc/passwd"]);
  });
});

// ── Active types never run under the cbase origin ───────────────────────────
// An agent (also one in a project container) writes `report.html` and links it; "show in window" fetches the same route
// with `inline=1`. Without a CSP its script would run with the user's session (full API, terminal). Counter-test: drop the
// sandbox CSP in the serving header and the first two tests turn red. The same rule covers a folder's context files and is
// ONE list (runtime/serving.js), not one per route.
test("artifact and context download: html/svg/xml/js only in the sandbox, image and PDF untouched", async () => {
  await withServer(async ({ base, workspace, chat }) => {
    const probes = [
      ["report.html", "<script>fetch('/api/chats')</script>", true],
      ["image.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", true],
      ["data.xml", "<?xml version='1.0'?><x/>", true],
      ["script.js", "alert(1)", true],
      ["module.mjs", "export default 1", true],
      ["note.md", "# Note\n", false],
    ];
    for (const [p, content] of probes) {
      const w = await json(`${base}/api/chats/${chat.id}/artifacts/file`, { method: "PUT", body: JSON.stringify({ path: p, content: content }) });
      assert.equal(w.status, 200, `${p}: ${JSON.stringify(w.body)}`);
    }
    for (const [p, , active] of probes) {
      for (const inline of [true, false]) {
        const r = await fetch(`${base}/api/chats/${chat.id}/artifacts/download?path=${encodeURIComponent(p)}${inline ? "&inline=1" : ""}`);
        assert.equal(r.status, 200);
        await r.arrayBuffer();
        assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${p}: nosniff missing`);
        const csp = r.headers.get("content-security-policy");
        if (active) assert.match(csp || "", /^sandbox;/, `${p} (inline=${inline}): no sandbox under the cbase origin`);
        else assert.equal(csp, null, `${p}: a passive type needs no sandbox`);
      }
    }
    // A PDF gets NO sandbox — Chromium refuses its viewer inside one, the preview (iframe) would break.
    const pdf = await fetch(`${base}/api/chats/${chat.id}/artifacts/upload?path=${encodeURIComponent("plan.pdf")}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });
    assert.equal(pdf.status, 201);
    const pdfOut = await fetch(`${base}/api/chats/${chat.id}/artifacts/download?path=plan.pdf&inline=1`);
    await pdfOut.arrayBuffer();
    assert.match(pdfOut.headers.get("content-type") || "", /^application\/pdf/);
    assert.equal(pdfOut.headers.get("content-security-policy"), null);

    // The second download: a folder's context file.
    const folder = (await json(`${base}/api/chat-folders`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "sandbox" }),
    })).body;
    const up = await fetch(`${base}/api/chat-folders/${folder.id}/context/upload?path=briefing.html`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "<script>1</script>",
    });
    assert.equal(up.status, 201);
    const ctx = await fetch(`${base}/api/chat-folders/${folder.id}/context/download?path=briefing.html&inline=1`);
    await ctx.arrayBuffer();
    assert.equal(ctx.status, 200);
    assert.equal(ctx.headers.get("x-content-type-options"), "nosniff");
    assert.match(ctx.headers.get("content-security-policy") || "", /^sandbox;/, "the context file runs without a sandbox");
  });
});

// The chat attachment slipped past the first fix. It is typed via `attachmentMime` (`.svg` → image/svg+xml, inline, no
// nosniff or CSP), and its folder sits in the runtime folder that a project container writes rw. Both ways in: the upload
// route and a file an agent drops into the attachment folder itself. Counter-test: CSP null turns the test red.
test("chat attachment: an SVG with script is served only in the sandbox, a PNG without, nosniff always", async () => {
  await withServer(async ({ base, chat }) => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>fetch('/api/chats')</script></svg>";
    const up = await fetch(`${base}/api/chats/${chat.id}/attachments?name=report.svg&artifact=0`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: svg,
    });
    assert.equal(up.status, 201);
    const { file } = await up.json();
    const { attachmentLocation } = await import("../electron/server/runs/runtime-location.js");
    fs.writeFileSync(path.join(attachmentLocation(chat.id), "from-agents.svg"), svg);
    fs.writeFileSync(path.join(attachmentLocation(chat.id), "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    for (const [name, active] of [[file, true], ["from-agents.svg", true], ["image.png", false]]) {
      const r = await fetch(`${base}/api/chats/${chat.id}/attachments/${encodeURIComponent(name)}`);
      await r.arrayBuffer();
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${name}: nosniff missing`);
      const csp = r.headers.get("content-security-policy");
      if (active) assert.match(csp || "", /^sandbox;/, `${name}: an SVG runs without a sandbox under the cbase origin`);
      else assert.equal(csp, null, `${name}: an image needs no sandbox`);
    }
  });
});

// The module itself: an allowlist of PASSIVE types — an unknown type counts as active.
test("runtime/serving.js: everything outside the allowlist is active, the sandbox carries no allow tokens", async () => {
  const { isActiveContent, servingHeader, SANDBOX_CSP } = await import("../electron/server/runtime/serving.js");
  for (const t of ["text/html; charset=utf-8", "image/svg+xml", "application/xml", "text/xml", "application/xhtml+xml",
    "text/javascript", "application/javascript", "text/xsl", "application/x-unknown"]) {
    assert.equal(isActiveContent(t), true, `${t} counts as passive`);
  }
  for (const t of ["image/png", "image/jpeg", "application/pdf", "text/plain; charset=utf-8", "text/markdown", "application/json",
    "", "application/octet-stream", "video/mp4", "audio/mpeg"]) {
    assert.equal(isActiveContent(t), false, `${t} counts as active`);
  }
  assert.match(SANDBOX_CSP, /^sandbox;/);
  assert.doesNotMatch(SANDBOX_CSP, /allow-/, "an allow token reopens the sandbox");
  assert.deepEqual(servingHeader("image/png"), { "X-Content-Type-Options": "nosniff" });
  assert.equal(servingHeader("text/html")["Content-Security-Policy"], SANDBOX_CSP);
});
