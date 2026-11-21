// A turn that dies at the end of the server is not a lost session. When the gateway replaces the backend it stops the
// project containers first (marker b-ends), the turn's CLI dies without a result — and do-run.js must not read that as
// "session gone" (session deleted, restart without memory into the stopped container, active_runs cleaned up, nobody
// continuing after the replacement).
//   (1) With the marker set (serverEndMarkerForTest — as endServer sets it FIRST; serverEnds() reads the gateway's foreign
//       marker the same way): ONE spawn, no retry, the session stays, the active_runs row stays (for resumeInterruptedWork),
//       one hint line "interrupted … continued", no "not found".
//   (2) Counter-test in the same test: WITHOUT the marker the old path stays — retry without resume, session empty.
// Without the guard (1) is red (two spawns, empty session, no active_runs row).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "spawns.jsonl"), JSON.stringify({ text, resume: arg("--resume") }) + "\\n");
  if (text.includes("DIE") && arg("--resume")) process.exit(1);
  finished();
  say({ type: "result", result: "ok", session_id: arg("--resume") || "s-new" });`;

const send = (base, chatId, text) => fetch(`${base}/api/chats/${chatId}/message`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ text }) });

test("(1)+(2) a CLI dying at server end keeps session and active_runs — without server end the old retry applies", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForTruthy } = ctx;
    const spawns = () => readJsonl(path.join(root, "spawns.jsonl"));
    store.updateChat(chat.id, { claudeSessionId: "s-old" });
    try {
      serverEndMarkerForTest(true);
      await send(base, chat.id, "DIE one");
      await waitForTruthy(() => store.listMessages(chat.id).some((m) => m.role === "hint"), "the hint line");
      await ctx.waitForQuiet();
      const s1 = spawns();
      assert.equal(s1.length, 1, `exactly one spawn, no retry: ${JSON.stringify(s1)}`);
      assert.equal(s1[0].resume, "s-old");
      assert.equal(store.getChat(chat.id).claudeSessionId, "s-old", "the session stays");
      assert.ok(store.listActiveRuns().some((r) => r.chatId === chat.id), "the active_runs row stays for the restart");
      const h = store.listMessages(chat.id).filter((m) => m.role === "hint").map((m) => m.text);
      assert.equal(h.length, 1, JSON.stringify(h));
      assert.match(h[0], /Neustart des Servers unterbrochen/);
    } finally {
      serverEndMarkerForTest(false);
      store.clearActiveRun(chat.id);
    }
    // (2) Counter-test without marker: the old path (retry without resume, session empty).
    await send(base, chat.id, "DIE two");
    await waitForTruthy(() => spawns().filter((s) => s.text.includes("DIE two")).length >= 2, "retry without resume");
    await ctx.waitForQuiet();
    const two = spawns().filter((s) => s.text.includes("DIE two"));
    assert.deepEqual(two.map((s) => Boolean(s.resume)), [true, false], "first with, then without resume");
    assert.equal(store.getChat(chat.id).claudeSessionId, "s-new", "the retry wrote its new session");
  }, { claude: fakeClaude({ main: MAIN }) });
});
