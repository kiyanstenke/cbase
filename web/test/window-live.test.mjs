// Older page and live history: the history window loads older pages (`loadOlder`, chat/chatCache.ts) — when scrolling up and BY
// ITSELF as long as the bubbles do not fill the scroll area (chat/chatOlder.ts). If a page arrived while a turn was already
// running, `applyRowsAn` built the history from the cache entry — which holds the rows of the last LOAD: the message just sent and
// the turn's tools came live and were not in it. The history lost the message until the end of the run reloaded.
//
// What runs is the REAL hook `useHistoryCache` (compiled with tsc; `react` and `@/lib/api` are stubs here: the refs live across the
// one call, `api` is an in-memory server) and the REAL reducer for the live events.
//
// Counter-test: remove the line `await syncOnce(id).catch(() => null);` from `applyRowsAn` in chat/chatCache.ts ⇒ "older page in
// the middle of a turn …" red (the sent message is missing after applying).
//
// Run:  node --test web/test/window-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");

const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".window-live-test-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "components", "chat", "chatCache.ts"), path.join(src, "components", "chat", "chatBubbles.ts"),
  path.join(src, "lib", "api", "log-window.ts"),
  "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022",
  "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
], { cwd: webDir, stdio: "pipe" });
// The stubs and the paths of the compiled files (tsc leaves `@/…` as it is).
fs.writeFileSync(path.join(out, "react-mock.js"), [
  "export const useRef = (v) => ({ current: v });",
  "export const useState = (v) => [v, () => {}];",
  "export const useCallback = (f) => f;",
  "export const useEffect = () => {};",
].join("\n"));
fs.writeFileSync(path.join(out, "api-mock.js"), "export const api = (p) => globalThis.__windowLiveServer(p);\n");
const onFile = (from, target) => { const r = path.relative(path.dirname(from), path.join(out, target)); return r.startsWith(".") ? r : "./" + r; };
for (const file of ["components/chat/chatCache.js", "lib/api/log-window.js"]) {
  const f = path.join(out, file);
  const s = fs.readFileSync(f, "utf8")
    .replace(/from "react"/g, `from "${onFile(f, "react-mock.js")}"`)
    .replace(/from "@\/lib\/api"/g, `from "${onFile(f, "api-mock.js")}"`)
    .replace(/from "\.\/core\.js"/g, `from "${onFile(f, "api-mock.js")}"`)
    .replace(/from "@\/lib\/api\/log-window"/g, `from "${onFile(f, "lib/api/log-window.js")}"`)
    .replace(/from "@\/components\/chat\/chatBubbles"/g, `from "${onFile(f, "components/chat/chatBubbles.js")}"`)
    .replace(/from "@\/lib\/history-reconcile"/g, `from "${onFile(f, "lib/history-reconcile.js")}"`);
  assert.doesNotMatch(s, /from "@\//, `${file}: an unknown import — update the stubs here`);
  fs.writeFileSync(f, s);
}
const { useHistoryCache } = await import(pathToFileURL(path.join(out, "components/chat/chatCache.js")).href);
const { buildBubbles, reduceChatEvent, streamAfterEvent } = await import(pathToFileURL(path.join(out, "components/chat/chatBubbles.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const CHAT = "c-orbit";
const tool = (id, tid, ts) => ({ id, role: "tool", text: JSON.stringify({ name: "Bash", detail: "echo", id: tid, input: { command: "echo" }, parent: null }), ts });
const result = (id, tid, ts) => ({ id, role: "tool_result", text: JSON.stringify({ id: tid, result: "ok", isError: false }), ts });
// Older page (before row 10), the window on opening (from 10), then the turn the user just starts (from 20).
const OLDER = [{ id: 1, role: "user", text: "first question", ts: 1 }, { id: 2, role: "assistant", text: "first answer", ts: 2 }];
const WINDOW = [{ id: 10, role: "user", text: "/status", ts: 10 }, tool(11, "t11", 11), result(12, "t11", 12), { id: 13, role: "assistant", text: "Scan running.", ts: 13 }];
const TURN = [{ id: 20, role: "user", text: "/status", ts: 20 }, tool(21, "t21", 21), result(22, "t21", 22)];

/** An in-memory server: the written rows, the window (`before`/`from`) and the delta — contract like server chats/log-window.js. */
function server() {
  const s = { rows: [...OLDER, ...WINDOW], requests: [], open: 0 };
  globalThis.__windowLiveOpen = () => s.open;
  globalThis.__windowLiveServer = async (p) => {
    s.requests.push(p);
    s.open++;
    try { await Promise.resolve(); } finally { s.open--; }
    const u = new URL(p, "http://x");
    if (u.pathname.endsWith("/log/delta")) {
      const since = Number(u.searchParams.get("since"));
      return { total: s.rows.length, lastId: s.rows.at(-1).id, rows: s.rows.filter((r) => r.id > since) };
    }
    if (u.pathname.endsWith("/log")) {
      const before = Number(u.searchParams.get("before")) || Infinity;
      const rows = s.rows.filter((r) => r.id < before && (before !== Infinity || r.id >= 10));
      return { total: s.rows.length, lastId: s.rows.at(-1).id, older: rows[0].id > 1, rows };
    }
    throw new Error("unexpected request " + p);
  };
  return s;
}

/** ChatPane in miniature: a React-like queue for `setBubbles`, refs, the hook, the reducer for live events. */
function chat() {
  const r = { state: [], queue: [] };
  const setBubbles = (u) => r.queue.push(u);
  r.render = () => { for (const u of r.queue.splice(0)) r.state = typeof u === "function" ? u(r.state) : u; };
  // To rest: render until no request is open and the queue is empty — wait for the state, not for a number of ticks.
  r.quiet = async () => { do { r.render(); await new Promise((f) => setImmediate(f)); } while ((globalThis.__windowLiveOpen?.() ?? 0) > 0 || r.queue.length > 0); };
  // A sync waits for the next render (`baseAfterQueued`) — render until it is done, then to rest.
  r.until = async (p) => { let finished = false; p.finally(() => { finished = true; }); while (!finished) { r.render(); await new Promise((f) => setImmediate(f)); } await p; await r.quiet(); };
  const refs = { activeIdRef: { current: CHAT }, openSeqRef: { current: 1 }, busyRef: { current: false }, targetStatusRef: { current: 0 }, joinedMidRunRef: { current: false } };
  r.refs = refs;
  r.hook = useHistoryCache(() => ({ ...refs, setBubbles, setCtxTokens() {}, setGoal() {}, loadArtifacts: async () => {} }));
  let stream = { open: false, gotText: false };
  r.event = (evt) => {
    const ctx = { stream, now: 1000, activeId: CHAT, joined: refs.joinedMidRunRef.current, runStart: null, inTok: 0, outTok: 0,
      t: (k) => k, resultToText: (c) => String(c ?? ""), lastId: r.hook.chatCacheRef.current.get(CHAT)?.lastId ?? 0 };
    setBubbles((prev) => reduceChatEvent(prev, evt, ctx));
    stream = streamAfterEvent(evt, ctx);
  };
  r.open = () => { // open() without cache: the window, built and put in
    const bs = buildBubbles(WINDOW);
    r.hook.putChatCache(CHAT, { rows: WINDOW, total: OLDER.length + WINDOW.length, older: true, bubbles: bs, chat: null, artifacts: [] });
    setBubbles(bs);
    r.render();
  };
  return r;
}
const userTexts = (bs) => bs.filter((b) => b.role === "user").map((b) => b.blocks[0].text);

test("older page in the middle of a turn: the message just sent and the live tools stay", async () => {
  const s = server();
  const c = chat();
  c.open();
  // The user sends: the server writes the rows, the stream reports them (user_message, run_started, a tool).
  s.rows.push(...TURN);
  c.refs.busyRef.current = true;
  c.event({ type: "harness", subtype: "user_message", text: "/status", attachments: [] });
  c.event({ type: "harness", subtype: "run_started" });
  c.event({ type: "assistant", message: { content: [{ type: "tool_use", id: "t21", name: "Bash", input: { command: "echo" } }] } });
  c.event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t21", content: "ok", is_error: false }] } });
  c.render();
  assert.deepEqual(userTexts(c.state), ["/status", "/status"], "before the older page: the sent message is there live");
  // The older page (scrolling up or the chain on opening) arrives while the turn runs.
  await c.until(c.hook.loadOlder());
  assert.deepEqual(userTexts(c.state), ["first question", "/status", "/status"], "the older page is in front, the sent message stays");
  const last = c.state.at(-1);
  assert.equal(last.role, "assistant", "the answer of the running turn is at the end");
  assert.ok(last.blocks.some((bl) => bl.kind === "tool" && bl.id === "t21"), "… including the tool that came live");
  assert.ok(s.requests.some((p) => p.includes("/log/delta?since=13")), "the entry is brought up to the server's state before applying");
});

test("older page without a run: the same bubbles as the window in one piece", async () => {
  server();
  const c = chat();
  c.open();
  await c.until(c.hook.loadOlder());
  assert.deepEqual(c.state.map((b) => b.role), buildBubbles([...OLDER, ...WINDOW]).map((b) => b.role));
  assert.equal(c.hook.windowOf(CHAT).older, false, "the chat's first row is loaded");
});

test("wiring: applyRowsAn syncs FIRST (in the queue, without waiting for itself), then builds", () => {
  const cache = read("components/chat/chatCache.ts");
  const body = cache.slice(cache.indexOf("async function applyRows"), cache.indexOf("function loadOlder"));
  const sync = body.indexOf("await syncOnce(id)");
  assert.ok(sync > 0 && sync < body.indexOf("chatCacheRef.current.get(id)"), "the delta before reading the entry");
  assert.ok(!body.includes("syncChatCache("), "not via the queue — applyRowsAn already runs in it (inQueue) and would wait for itself");
});
