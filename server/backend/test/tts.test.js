import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";

// Read-aloud: key management, speech-text preparation, cache — and the keyless path on which the clients fall back
// to the system voice.
async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tts-"));
  let server;
  // Double for ElevenLabs: records every request and returns a pseudo MP3.
  const calls = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      calls.push({ url: req.url, key: req.headers["xi-api-key"], body });
      if (req.url === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ voices: [{ voice_id: "v1", name: "Clara", labels: { language: "de" } }] }));
      }
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]));
    });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  try {
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await run({ base, root, fakeBase, calls });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
    // A test must not fail because its temp directory does not go away: a child process still writing causes
    // ENOTEMPTY, which says something about cleanup, not about the product. It is still reported — otherwise
    // garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

const json = async (url, init) => {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

test("read-aloud without a key points to the system voice", async () => {
  await withServer(async ({ base }) => {
    const config = await json(`${base}/api/tts/config`);
    assert.equal(config.status, 200);
    assert.equal(config.body.hasKey, false);
    assert.equal(config.body.modelId, "eleven_multilingual_v2");

    const spoken = await json(`${base}/api/tts`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello world" }),
    });
    assert.equal(spoken.status, 409);
    assert.equal(spoken.body.fallback, "system");

    const empty = await json(`${base}/api/tts`, { method: "POST", body: JSON.stringify({ text: "   " }) });
    assert.equal(empty.status, 400);
  });
});

test("with a key: markdown becomes speech text, the answer is MP3, the second call comes from the cache", async () => {
  await withServer(async ({ base, fakeBase, calls, root }) => {
    const saved = await json(`${base}/api/tts/config`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "secret", voiceId: "v1", baseUrl: fakeBase }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.hasKey, true);

    // An empty apiKey means "keep" (the UI never shows it).
    const kept = await json(`${base}/api/tts/config`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "", voiceId: "v1", baseUrl: fakeBase }),
    });
    assert.equal(kept.body.hasKey, true);

    const markdown = "## Title\n\nOne **important** note with [link](https://example.com).\n\n```js\nconst a = 1;\n```\n";
    const first = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: markdown }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "audio/mpeg");
    // The tunnel edge must not cache user audio publicly.
    assert.match(first.headers.get("cache-control") || "", /private/);
    assert.ok((await first.arrayBuffer()).byteLength > 0);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "secret");
    assert.equal(calls[0].url, "/v1/text-to-speech/v1");
    const sent = calls[0].body.text;
    assert.ok(!sent.includes("**"), `markup must be gone: ${sent}`);
    assert.ok(!sent.includes("https://example.com"), `link target must not be spoken: ${sent}`);
    assert.ok(sent.includes("Title") && sent.includes("important note"), sent);
    assert.ok(sent.includes("(Codeblock)"), `code is announced, not read aloud: ${sent}`);
    assert.equal(calls[0].body.model_id, "eleven_multilingual_v2");

    // Second identical call: from the cache, no further foreign call.
    const second = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: markdown }),
    });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 1, "the second call should have come from the cache");
    const cacheDir = path.join(root, "data-root", "data", "tts-cache");
    assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".mp3")).length, 1);

    // The voice list comes through.
    const voices = await json(`${base}/api/tts/voices`);
    assert.equal(voices.status, 200);
    assert.deepEqual(voices.body.voices.map((v) => v.name), ["Clara"]);

    // Delete the key (explicit null) → system voice again.
    const cleared = await json(`${base}/api/tts/config`, { method: "PUT", body: JSON.stringify({ apiKey: null }) });
    assert.equal(cleared.body.hasKey, false);
  });
});
