// The "open chat" seam: server, web, iOS and the UI-test fixture bound to the SAME field names.
//
//   N1: the `connected` of every stream carries the state of the history (`lastId`, `total`) and the not yet stored text of the
//       running turn (`streamText`, `streamTextTruncated`); `GET .../log/delta` answers `{ total, lastId, rows }`. Both clients
//       reconcile against it (`web/src/lib/history-reconcile.ts`, `chatCache.ts`; iOS `ChatViewModel+Reconcile.swift`).
//   N2: a row written outside the turn stream arrives as the event `{ type: "row", row }` (server.js, `store.setRowsObserver`;
//       web `chatBubbles.ts`, iOS `ChatViewModel+Stream.swift` -> `rowFromStream`).
//   N3: an image attachment carries `w`/`h` from the file header (`runtime/image-dimensions.js:withImageDimensions`; web `Attachment`
//       + `imageFrame(a.w, a.h, ...)`, iOS `Attachment.w/h`; OPTIONAL, because a synthesized Decodable would otherwise demand
//       every key and every older attachment would make the history unreadable).
// A field renamed on ONE side would be noticed nowhere: `ChatEvent` is `Record<string, any>` in the web, iOS reads `JSONValue`
// by index (nil => "server without N1" => silent fallback), and the fixture would check its own invention.
//
// Read as TEXT: no compiler, no xcrun, runs on any machine, NOT `onlyMacOS`. Plus once EXECUTED: `withImageDimensions`. Per side
// one built-in sabotage on an in-memory copy, each => deviation; before each sabotage the test checks that its line is still
// there (otherwise the sabotage would prove nothing).
//
// Counter-test: in ChatViewModel+Reconcile.swift `event["total"]` to `event["total"]` => red
// ('iOS ChatViewModel+Reconcile.swift does not read event["total"]').
//
// Run:  node --test --test-reporter=tap web/test/chat-seam-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

/** The names of the seam: ONE list for all four sides. */
const SEAM = {
  connected: ["lastId", "total", "streamText", "streamTextTruncated"],
  state: ["lastId", "total"],
  delta: ["total", "lastId", "rows"],
  row: { type: "row", field: "row" },
  attachment: ["w", "h"],
};

const SOURCES = {
  server: {
    routes: "server/backend/electron/server/chats/routes.js",
    serverJs: "server/backend/electron/server/server.js",
    image: "server/backend/electron/server/runtime/image-dimensions.js",
  },
  web: {
    reconcile: "web/src/lib/history-reconcile.ts",
    cache: "web/src/components/chat/chatCache.ts",
    bubbles: "web/src/components/chat/chatBubbles.ts",
    types: "web/src/lib/api/workspace.ts",
    rowRow: "web/src/components/chat/ChatBubbleRow.tsx",
  },
  ios: {
    reconcile: "mobile/CbaseMobile/Chat/ChatViewModel+Reconcile.swift",
    stream: "mobile/CbaseMobile/Chat/ChatViewModel+Stream.swift",
    models: "mobile/CbaseMobile/Models/Models.swift",
  },
  fixture: {
    chat: "mobile/test-fixtures/chat-gateway/routes-chat.mjs",
    fixture: "mobile/test-fixtures/chat-gateway/routes-fixture.mjs",
    seeds: "mobile/test-fixtures/chat-gateway/seeds.mjs",
  },
};

const texts = (page) => Object.fromEntries(Object.entries(SOURCES[page]).map(([k, p]) => [k, read(p)]));
const rowsWith = (text, marker) => text.split("\n").filter((z) => z.includes(marker));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The block from `header` to the first line that holds only `}` (type, function, struct); "" without a header. */
function block(text, header) {
  const i = text.indexOf(header);
  if (i < 0) return "";
  const end = text.indexOf("\n}", i);
  return text.slice(i, end < 0 ? undefined : end + 2);
}

/** `{ type: "row", row }` or `{ type: "row", row: x }`: the N2 event on one line. */
const carriesRow = (z) => new RegExp(`type:\\s*"${SEAM.row.type}"\\s*,\\s*${SEAM.row.field}\\s*(?::[^}]*)?\\}`).test(z);
/** A field as key of an object literal (`{ f: ...`, `, f: ...` or at the line start of a multi-line literal). */
const key = (z, f) => new RegExp(`(?:[{,]|^)\\s*${f}:`, "m").test(z);

// ── The four sides ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function serverDeviations(t) {
  const deviations = [];
  const connected = rowsWith(t.routes, 'subtype: "connected"');
  if (connected.length !== 1) deviations.push(`Server: ${connected.length} 'connected' lines in chats/routes.js (expected 1)`);
  for (const z of connected) for (const f of SEAM.connected) if (!key(z, f)) deviations.push(`Server connected: '${f}' missing`);
  const delta = rowsWith(t.routes, "stats.lastId").filter((z) => z.includes("send(res, 200"));
  if (delta.length < 2) deviations.push(`Server: the answers of GET .../log/delta not found (${delta.length} instead of 2)`);
  for (const z of delta) for (const f of SEAM.delta) if (!key(z, f)) deviations.push(`Server .../log/delta: '${f}' missing in ${z.trim()}`);
  const observer = rowsWith(t.serverJs, "setRowsObserver(");
  if (observer.length !== 1 || !carriesRow(observer[0])) deviations.push(`Server server.js: the event is not { type: "${SEAM.row.type}", ${SEAM.row.field} }`);
  for (const f of SEAM.attachment) if (!new RegExp(`\\b${f}: dimensions\\.${f}\\b`).test(t.image)) deviations.push(`Server image-dimensions.js: withImageDimensions does not set '${f}'`);
  return deviations;
}

function webDeviations(t) {
  const deviations = [];
  for (const f of SEAM.state) {
    if (!new RegExp(`evt\\.${f}\\b`).test(block(t.reconcile, "export function reconcileNeeded("))) deviations.push(`Web history-reconcile.ts: reconcileNeeded does not read '${f}'`);
    if (!new RegExp(`\\b${f}: evt\\.${f}\\b`).test(t.cache)) deviations.push(`Web chatCache.ts: the remembered 'connected' does not carry '${f}'`);
  }
  const connected = block(t.bubbles, 'if (evt.subtype === "connected")');
  for (const f of ["streamText", "streamTextTruncated"]) if (!new RegExp(`evt\\.${f}\\b`).test(connected)) deviations.push(`Web chatBubbles.ts: 'connected' does not read '${f}'`);
  const logDelta = block(t.types, "export interface LogDelta {");
  for (const f of SEAM.delta) if (!new RegExp(`^\\s*${f}:`, "m").test(logDelta)) deviations.push(`Web lib/api/workspace.ts: LogDelta without '${f}'`);
  for (const f of ["total", "rows"]) if (!new RegExp(`delta\\.${f}\\b`).test(t.cache)) deviations.push(`Web chatCache.ts: the delta does not read '${f}'`);
  const branch = rowsWith(t.bubbles, `evt.type === "${SEAM.row.type}"`);
  if (branch.length !== 1 || !branch[0].includes(`evt.${SEAM.row.field}`)) deviations.push(`Web chatBubbles.ts: no branch for '${SEAM.row.type}' that reads evt.${SEAM.row.field}`);
  const attachment = block(t.types, "export interface Attachment {");
  for (const f of SEAM.attachment) if (!new RegExp(`^\\s*${f}\\?: number;`, "m").test(attachment)) deviations.push(`Web lib/api/workspace.ts: Attachment without '${f}?: number'`);
  const [w, h] = SEAM.attachment;
  if (!new RegExp(`imageFrame\\(a\\.${w}, a\\.${h}\\b`).test(t.rowRow)) deviations.push(`Web ChatBubbleRow.tsx: the attachment does not reserve its space via imageFrame(a.${w}, a.${h}, ...)`);
  return deviations;
}

function iosDeviations(t) {
  const deviations = [];
  for (const f of [...SEAM.connected, SEAM.row.field]) if (!t.reconcile.includes(`event["${f}"]`)) deviations.push(`iOS ChatViewModel+Reconcile.swift does not read event["${f}"]`);
  if (!new RegExp(`type == "${SEAM.row.type}"`).test(t.stream)) deviations.push(`iOS ChatViewModel+Stream.swift: no branch for '${SEAM.row.type}'`);
  const attachment = block(t.models, "struct Attachment: Codable");
  if (!attachment) deviations.push("iOS Models.swift: struct Attachment not found");
  for (const f of SEAM.attachment) if (!new RegExp(`^\\s*var ${f}: Int\\?$`, "m").test(attachment)) deviations.push(`iOS Attachment: '${f}' missing or not optional (Int?); an attachment without dimensions would make the history unreadable`);
  const keyAttachment = /enum CodingKeys[^{]*\{([^}]*)\}/.exec(attachment)?.[1];
  if (keyAttachment) for (const f of SEAM.attachment) if (!new RegExp(`\\b${f}\\b`).test(keyAttachment)) deviations.push(`iOS Attachment: CodingKeys without '${f}'`);
  const delta = block(t.models, "struct LogDelta: Decodable");
  const keys = /enum CodingKeys: String, CodingKey \{ case ([^}]*)\}/.exec(delta)?.[1].split(",").map((s) => s.trim()) ?? [];
  for (const f of SEAM.delta) if (!keys.includes(f)) deviations.push(`iOS LogDelta: CodingKeys without '${f}'`);
  return deviations;
}

function fixtureDeviations(t) {
  const deviations = [];
  const seed = block(t.seeds, "function historyStatus(");
  for (const f of SEAM.state) if (!key(seed, f)) deviations.push(`Fixture seeds.mjs: historyStatus without '${f}'`);
  // Every `connected` of the fixture (main and additional chats) carries the state, directly or via `historyStatus(...)`.
  const places = [];
  for (let i = t.chat.indexOf('subtype: "connected"'); i >= 0; i = t.chat.indexOf('subtype: "connected"', i + 1)) {
    places.push(t.chat.slice(i, t.chat.indexOf("})}", i)));
  }
  if (places.length < 2) deviations.push(`Fixture routes-chat.mjs: ${places.length} 'connected' instead of at least 2`);
  for (const s of places) {
    for (const f of SEAM.state) if (!key(s, f) && !/\.\.\.historyStatus\(/.test(s)) deviations.push(`Fixture connected without '${f}': ${s.slice(0, 80)}`);
  }
  const main = places.filter((s) => /\bstreamText:/.test(s));
  if (main.length !== 1) deviations.push(`Fixture routes-chat.mjs: ${main.length} 'connected' with streamText (expected 1, the main chat)`);
  for (const s of main) for (const f of ["streamText", "streamTextTruncated"]) if (!key(s, f)) deviations.push(`Fixture connected: '${f}' missing`);
  if (!/\{ \.\.\.historyStatus\(rowsValue\), rows:/.test(t.chat)) deviations.push(`Fixture routes-chat.mjs: .../log/delta does not answer { ...historyStatus(rowsValue), rows }`);
  const events = rowsWith(t.fixture, `chatEvent({ type: "${SEAM.row.type}"`);
  if (events.length !== 1 || !carriesRow(events[0])) deviations.push(`Fixture routes-fixture.mjs: the event is not { type: "${SEAM.row.type}", ${SEAM.row.field} }`);
  const [w, h] = SEAM.attachment;
  if (!new RegExp(`Object\\.assign\\(attachment, \\{ ${w}, ${h} \\}\\)`).test(t.fixture)) deviations.push(`Fixture routes-fixture.mjs: the image attachment does not carry '${w}'/'${h}'`);
  return deviations;
}

/** A copy with ONE replacement; the line must be there, otherwise the sabotage would prove nothing. */
function sabotaged(t, keyName, old, fresh) {
  assert.ok(t[keyName].includes(old), `the line for the sabotage is gone ('${old}'): update it`);
  return { ...t, [keyName]: t[keyName].split(old).join(fresh) };
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("server: connected carries lastId/total/streamText/streamTextTruncated, delta { total, lastId, rows }, event row with row, attachment w/h", async () => {
  assert.deepEqual(serverDeviations(texts("server")), []);
  // Executed once: the same keys the text shows.
  const { withImageDimensions } = await import(pathToFileURL(path.join(repo, SOURCES.server.image)).href);
  const including = withImageDimensions({ name: "a.png" }, { w: 640, h: 960 });
  assert.deepEqual(SEAM.attachment.map((f) => including[f]), [640, 960]);
  assert.deepEqual(withImageDimensions({ name: "a.png" }, null), { name: "a.png" }, "without dimensions no guessed field");
});

test("web: history-reconcile, chatCache, chatBubbles, types and ChatBubbleRow read the same names", () => {
  assert.deepEqual(webDeviations(texts("web")), []);
});

test("iOS: ChatViewModel+Reconcile/+Stream and Models.swift read the same names (w/h optional)", () => {
  assert.deepEqual(iosDeviations(texts("ios")), []);
});

test("fixture: every connected carries the state, the delta, the event row and the image attachment like the server", () => {
  assert.deepEqual(fixtureDeviations(texts("fixture")), []);
});

test("counter-test (built in): a renamed field is noticed on every side", () => {
  const server = sabotaged(texts("server"), "routes", "lastId: state.lastId", "letzteId: state.lastId");
  assert.ok(serverDeviations(server).some((a) => a.includes("'lastId'")), "server sabotage went unnoticed");
  const serverRow = sabotaged(texts("server"), "serverJs", '{ type: "row", row }', '{ type: "row", line: row }');
  assert.ok(serverDeviations(serverRow).some((a) => a.includes("server.js")), "server sabotage at the event went unnoticed");

  const web = sabotaged(texts("web"), "bubbles", 'evt.type === "row"', 'evt.type === "line"');
  assert.ok(webDeviations(web).some((a) => a.includes("no branch")), "web sabotage went unnoticed");
  const webTruncated = sabotaged(texts("web"), "bubbles", "evt.streamTextTruncated", "evt.streamTextCut");
  assert.ok(webDeviations(webTruncated).some((a) => a.includes("'streamTextTruncated'")), "web sabotage at the buffer went unnoticed");

  const ios = sabotaged(texts("ios"), "reconcile", 'event["lastId"]', 'event["letzteId"]');
  assert.ok(iosDeviations(ios).some((a) => a.includes('event["lastId"]')), "iOS sabotage went unnoticed");
  const iosRequired = sabotaged(texts("ios"), "models", "    var w: Int?\n", "    var w: Int\n");
  assert.ok(iosDeviations(iosRequired).some((a) => a.includes("'w' missing or not optional")), "iOS sabotage at the attachment went unnoticed");

  const fixture = sabotaged(texts("fixture"), "fixture", 'chatEvent({ type: "row", row })', 'chatEvent({ type: "row", line: row })');
  assert.ok(fixtureDeviations(fixture).some((a) => a.includes("routes-fixture.mjs: the event")), "fixture sabotage went unnoticed");
  const fixtureState = sabotaged(texts("fixture"), "chat", "lastId: 0, total: 0", "lastId: 0");
  assert.ok(fixtureDeviations(fixtureState).some((a) => a.includes("connected without 'total'")), "fixture sabotage at the state went unnoticed");
});

test("the sabotage helper itself: a missing line is an error, not a silent copy", () => {
  assert.throws(() => sabotaged(texts("ios"), "stream", "exists-not-" + esc("("), "x"), /is gone/);
});
