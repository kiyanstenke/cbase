// The start folder of a terminal: "open in integrated terminal" starts a shell in the chosen folder - `POST …/terminal` with `cwd`
// (devtools/code-route.js), checked in devtools/terminal-folder.js.
//
// The promises:
//   (a) Without an instance (B): `cwd` empty/missing => the root; a folder inside it => that one (a leading "/" counts from the root);
//       ".." out, a missing folder, a file, a link that leads out and a non-text => 400 `TERMINAL_FOLDER`; a link that stays INSIDE is a
//       start folder (returned lexically, as chosen).
//   (b) With an instance the check asks the CONTAINER (`stat` there, never B): a folder that exists only there passes; one whose real
//       location leads out does not; one that does not exist there does not.
//   (c) The route: `cwd` starts the shell THERE (it reports `pwd`), a folder outside => 400 and NO terminal.
//
// COUNTER-TESTS built in (test "Counter-tests"): ONE place of terminal-folder.js changed each, loaded as a copy in the temp folder (the
// imports point to the real files) - the assigned check must fail; if it stays green it measures nothing at that place.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/terminal-folder.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { terminalFolder } from "../electron/server/devtools/terminal-folder.js";
import { codeRoute } from "../electron/server/devtools/code-route.js";
import { countTerminalsByTag, killTerminalsByTag, subscribeTerminal, writeTerminal } from "../electron/server/terminal.js";
import { waitForTruthy } from "./agent-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "../electron/server/devtools/terminal-folder.js");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-terminal-folder-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// The root: sub/deep, file.txt, link-inside -> sub, link-out -> a folder outside.
const ROOT = path.join(TMP, "root");
const OUTSIDE = path.join(TMP, "outside");
fs.mkdirSync(path.join(ROOT, "sub", "deep"), { recursive: true });
fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(ROOT, "file.txt"), "x");
fs.symlinkSync(path.join(ROOT, "sub"), path.join(ROOT, "link-inside"));
fs.symlinkSync(OUTSIDE, path.join(ROOT, "link-out"));
// Outside, a link pointing INTO the root: lexically outside, inside at its real location - only the lexical boundary catches it.
fs.symlinkSync(path.join(ROOT, "sub"), path.join(TMP, "back"));

const denied = async (p) => {
  try { await p; } catch (e) { assert.equal(e?.status, 400, `status: ${e?.message}`); assert.equal(e?.code, "TERMINAL_FOLDER"); return; }
  assert.fail("accepted instead of rejected");
};

const CHECKS = {
  b: async (fn) => {
    assert.equal(await fn(ROOT, undefined), ROOT, "without cwd the root");
    assert.equal(await fn(ROOT, ""), ROOT);
    assert.equal(await fn(ROOT, "sub"), path.join(ROOT, "sub"));
    assert.equal(await fn(ROOT, "/sub/deep"), path.join(ROOT, "sub", "deep"), "a leading / counts from the root");
    assert.equal(await fn(ROOT, "link-inside"), path.join(ROOT, "link-inside"), "a link that stays inside, as chosen");
  },
  hinaus: async (fn) => {
    await denied(fn(ROOT, "../outside"));
    await denied(fn(ROOT, "sub/../../outside"));
    await denied(fn(ROOT, "../back"));
  },
  reference: async (fn) => { await denied(fn(ROOT, "link-out")); },
  noFolder: async (fn) => {
    await denied(fn(ROOT, "missing"));
    await denied(fn(ROOT, "file.txt"));
    await denied(fn(ROOT, 42));
  },
  container: async (fn) => {
    // An instance: B does not know the root at all - only the container (the stub) is asked, with absolute paths.
    const root = "/projects/p1";
    const asked = [];
    const world = {
      "/projects/p1": { kind: "folder", real: "/projects/p1" },
      "/projects/p1/only-there": { kind: "folder", real: "/projects/p1/only-there" },
      "/projects/p1/out": { kind: "reference", target: { kind: "folder" }, real: "/etc" },
      "/projects/p1/inside": { kind: "reference", target: { kind: "folder" }, real: "/projects/p1/only-there" },
    };
    const stat = async (inst, p) => { assert.equal(inst.identifier, "p1/copy-k1"); assert.ok(path.isAbsolute(p)); asked.push(p); return world[p] ?? null; };
    const inst = { identifier: "p1/copy-k1" };
    assert.equal(await fn(root, "only-there", inst, { stat }), "/projects/p1/only-there");
    assert.ok(asked.includes("/projects/p1/only-there"), "the container was not asked");
    assert.equal(await fn(root, "inside", inst, { stat }), "/projects/p1/inside");
    await denied(fn(root, "out", inst, { stat }));
    await denied(fn(root, "exists-not", inst, { stat }));
  },
};

test("(a)(b) the start folder stays inside the root - in B and in the container", async () => {
  for (const [name, p] of Object.entries(CHECKS)) {
    try { await p(terminalFolder); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

// ── (c) the route ──
function stubResponse() {
  const r = { status: 0, parts: [], headersSent: false, writeHead(c) { r.status = c; r.headersSent = true; }, setHeader() {}, write(d) { r.parts.push(Buffer.from(d)); return true }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function terminalRoute(body) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = stubResponse();
  await codeRoute(ROOT, "/terminal", "POST", req, res, new URL("http://x/api/x/terminal"), {});
  return { status: res.status, body: res.json };
}

test("(c) the route starts the shell in the chosen folder, a folder outside starts none", async () => {
  const DAY = "test:terminal-folder";
  const saved = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  try {
    const r = await terminalRoute({ cols: 80, rows: 24, tag: DAY, cwd: "sub/deep" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (!r.body.available) { assert.fail(`node-pty missing: ${r.body.error}`); }
    assert.equal(r.body.shell, "sh", "the response does not name the shell (the terminal's title, as in VS Code)");
    const parts = [];
    assert.ok(subscribeTerminal(r.body.id, { write(d) { parts.push(String(d)); return true; }, end() {}, on() {} }));
    writeTerminal(r.body.id, "pwd -P\r");
    const target = fs.realpathSync(path.join(ROOT, "sub", "deep"));
    await waitForTruthy(() => parts.join("").includes(target));
    const out = await terminalRoute({ cols: 80, rows: 24, tag: DAY, cwd: "../outside" });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.code, "TERMINAL_FOLDER");
    assert.equal(countTerminalsByTag(DAY), 1, "a rejected folder started a terminal after all");
  } finally {
    killTerminalsByTag(DAY);
    if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved;
  }
});

// ── Counter-tests ──
const SABOTAGES = [
  ["without lexical boundary", "if (!inside(base, abs)) throw error(", "if (false) throw error(", "hinaus"],
  ["without real location", "if (!real || !rootReal || !inside(rootReal, real)) throw", "if (false) throw", "reference"],
  ["file as folder", "if (!isFolder) throw error(", "if (false) throw error(", "noFolder"],
  ["instance asked in B", "  if (inst) {\n", "  if (false) {\n", "container"],
  ["always the root", "  return abs;\n}", "  return base;\n}", "b"],
];

test("Counter-tests: every sabotage of terminal-folder.js is caught", async () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const real = (rel) => pathToFileURL(path.join(path.dirname(SOURCE), rel)).href;
  const base = source.replace(`from "../i18n.js"`, `from "${real("../i18n.js")}"`).replace(`from "../runtime/fileAccess.js"`, `from "${real("../runtime/fileAccess.js")}"`);
  assert.notEqual(base, source, "the imports of the copy are outdated");
  for (const [name, old, fresh, check] of SABOTAGES) {
    assert.equal(base.split(old).length - 1, 1, `counter-test "${name}" is outdated: the place does not appear exactly once in the source`);
    const file = path.join(TMP, `sabotage-${Object.keys(CHECKS).indexOf(check)}-${SABOTAGES.findIndex((s) => s[0] === name)}.mjs`);
    fs.writeFileSync(file, base.replace(old, fresh));
    const m = await import(pathToFileURL(file).href);
    await assert.rejects(CHECKS[check](m.terminalFolder), `counter-test "${name}" stayed green - "${check}" measures nothing there`);
  }
});
