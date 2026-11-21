// Guard "captures at the turn end": what the agents of a chat record with cbase_screenshot or cbase_recording_start/_stop
// appears at the end of the turn as a card in the chat (cbase_capture_send is gone; Playwright's browser_take_screenshot stays
// the self-check and never reaches the chat). Real server, real cbase MCP server, real routes and a real turn (agent-harness.mjs);
// faked are the provider (fake Claude), the browser (initCaptures({ browser })) and ffmpeg (CBASE_FFMPEG).
//
// The promises, each with the sabotage that breaks it:
//   (1) At the turn end the turn's recordings appear AFTER the last answer, in recording order, with the caption from the tool;
//       a recording still running at the turn end ends there and comes along. Cap: the first six expanded, every further one
//       with `collapsed: true` — none gets lost. Breaks: the "captures-show" registration in server.js is missing (no card);
//       `collapsed` is missing (the collapse assertion goes red); endCaptureAtTurnEnd is missing (the video is missing).
//   (2) Never twice: the next turn end shows no recording a second time. Breaks: markSent without the 409 lock, or toShow
//       without `!m.sent`.
//   (3) A subagent's recording that finishes AFTER the main run's turn end (own profile key, same chat) is not lost: the next
//       turn end shows it. Breaks: `show` only for profileKey = chat id.
//   (4) A turn without a recording tool (the agent only checked with browser_take_screenshot) shows nothing, and a recording
//       from before the change (manifest without the `show` mark) never suddenly appears. cbase_capture_send is in no offer.
// Counter-tests: the "captures-show" registration removed from server.js ⇒ (1) red ("seen 0"); `showsTheChat` narrowed to
// profileKey = chat id ⇒ (3) red; `collapsed` always false ⇒ (1) red; `!m.sent` and the 409 in markSent removed ⇒ (2) red
// ("seen 10"); endCaptureAtTurnEnd without finalize ⇒ (1) red ("seen 8").
// No clock: it waits for the server to be quiet (quiet.mjs; the hook counts as open work until the video is encoded).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { initCaptures, listCaptures, takeScreenshot } from "../electron/server/captures.js";

// Minimal "JPEG" (SOI + SOF0) so that captures.js finds the dimensions — ffmpeg is stubbed.
function fakeJpeg(w, h) {
  const b = Buffer.alloc(16, 0);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(11, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
}
function fakeBrowser() {
  const frame = { data: fakeJpeg(64, 48).toString("base64"), w: 64, h: 48 };
  const tab = { targetId: "t1", title: "Test page", url: "http://localhost:3100/", lastFrame: frame };
  const session = { kind: "agent", tabs: new Map([["t1", tab]]), activeTargetId: "t1" };
  return {
    findAgentBrowser: (dir) => (String(dir).startsWith("chat-") ? session : null),
    findChatBrowser: () => session,
    resolveTab: () => tab,
    tabList: () => [{ id: "t1", title: tab.title, url: tab.url, active: true }],
    captureTabScreenshot: async () => ({ data: fakeJpeg(64, 48).toString("base64"), w: 64, h: 48, url: tab.url, title: tab.title }),
    acquireFrameSink: async (s, t) => ({ getFrame: () => t.lastFrame, release: () => {} }),
  };
}

// The main agent reads its plan from <LOCATION>/plan.json: `shots` screenshots (caption "Image n"), `capture` = start a recording
// and do NOT end it. It writes its tool list to <LOCATION>/tools.json.
const FAKE = fakeClaude({
  main: `
    const plan = JSON.parse(fs.readFileSync(path.join(LOCATION, "plan.json"), "utf8"));
    say({ type: "system", subtype: "init", session_id: "main-session" });
    for (let i = 1; i <= plan.shots; i++) {
      const r = await mcpCall("cbase_screenshot", { caption: "Image " + i });
      if (r.result && r.result.isError) throw new Error("Screenshot: " + textOf(r));
    }
    if (plan.dismissed) {
      const r = await mcpCall("cbase_screenshot", { caption: "dismissed", show: false });
      if (r.result && r.result.isError) throw new Error("Screenshot: " + textOf(r));
    }
    if (plan.capture) {
      const r = await mcpCall("cbase_recording_start", { fps: 4 });
      if (r.result && r.result.isError) throw new Error("Recording: " + textOf(r));
    }
    fs.writeFileSync(path.join(LOCATION, "tools.json"), JSON.stringify(await mcpTools()));
    say({ type: "assistant", message: { id: "main-" + plan.n, content: [{ type: "text", text: "Answer " + plan.n }] } });
    finished();
    say({ type: "result", result: "Answer " + plan.n, session_id: "main-session" });`,
});

test("captures at the turn end: after the answer, in order, cap collapsed, never twice, subagent not lost", async () => {
  const priorFf = process.env.CBASE_FFMPEG;
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    const bin = path.join(root, "fake-ffmpeg");
    fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv[process.argv.length - 1], "MP4-STUB");\n`, { mode: 0o755 });
    process.env.CBASE_FFMPEG = bin;
    initCaptures({ browser: fakeBrowser() });
    const turn = async (plan) => {
      fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(plan));
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `Turn ${plan.n}` }) });
      await ctx.waitForLog(chat.id, (log) => log.some((m) => m.role === "assistant" && m.text === `Answer ${plan.n}`));
      await ctx.waitForQuiet();
      return json(`${base}/api/chats/${chat.id}/log`);
    };
    const cards = (log) => log.filter((m) => m.role === "capture").map((m) => JSON.parse(m.text));

    // (1) Eight screenshots and a recording that is still running at the turn end.
    let log = await turn({ n: 1, shots: 8, capture: true });
    let k = cards(log);
    assert.equal(k.length, 9, `nine cards at the turn end (8 screenshots + the running recording), seen ${k.length}`);
    const response1 = log.findIndex((m) => m.role === "assistant" && m.text === "Answer 1");
    const firstCard = log.findIndex((m) => m.role === "capture");
    assert.ok(response1 >= 0 && firstCard > response1, "the cards stand after the turn's last answer");
    assert.deepEqual(k.slice(0, 8).map((c) => c.caption), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `Image ${i}`), "recording order, caption from the tool");
    assert.equal(k[8].kind, "recording");
    assert.equal(k[8].video, "video.mp4", "the running recording ended at the turn end and came with its video");
    assert.deepEqual(k.map((c) => c.collapsed === true), [false, false, false, false, false, false, true, true, true], "collapsed from the seventh on");
    const tools = JSON.parse(fs.readFileSync(path.join(root, "tools.json"), "utf8"));
    assert.ok(tools.includes("cbase_screenshot"));
    assert.equal(tools.includes("cbase_capture_send"), false, "cbase_capture_send is in no offer");

    // (3)(4) Between the turns: a subagent finishes after the turn end (own profile key, same chat), and a recording from before
    // the change is in the folder (manifest without `show`).
    const sub = (await takeScreenshot({ chatId: chat.id, profileKey: `${chat.id}-agent-sub1`, caption: "from the subagent" })).capture;
    const old = (await takeScreenshot({ chatId: chat.id, profileKey: chat.id })).capture;
    const oldManifest = path.join(ctx.dataRoot, "data", "attachments", chat.id, "captures", old.id, "manifest.json");
    assert.ok(fs.existsSync(oldManifest), oldManifest);
    const m = JSON.parse(fs.readFileSync(oldManifest, "utf8"));
    delete m.show;
    fs.writeFileSync(oldManifest, JSON.stringify(m));

    // (2)(3)(4) The next turn records nothing (it only checked with browser_take_screenshot): only the subagent's recording comes.
    // In addition the main agent holds back a failed screenshot (`show: false`, skill review-video): it stays in the folder.
    log = await turn({ n: 2, shots: 0, capture: false, dismissed: true });
    k = cards(log);
    assert.equal(k.length, 10, `exactly one new card (the subagent's), seen ${k.length - 9}`);
    assert.equal(k[9].captureId, sub.id);
    assert.equal(k[9].caption, "from the subagent");
    assert.ok(log.findIndex((x) => x.role === "assistant" && x.text === "Answer 2") < log.findLastIndex((x) => x.role === "capture"));
    assert.equal(k.some((c) => c.captureId === old.id), false, "a recording without the mark never appears");
    assert.equal(k.some((c) => c.caption === "dismissed"), false, "show: false never appears");
    const dismissed = listCaptures(chat.id).find((c) => c.caption === "dismissed");
    assert.ok(dismissed && dismissed.show === false && !dismissed.sent, "the held-back screenshot stays in the folder");
    assert.equal(new Set(k.map((c) => c.captureId)).size, k.length, "no card twice");

    // (2) And a third turn without recordings: nothing new.
    log = await turn({ n: 3, shots: 0, capture: false });
    assert.equal(cards(log).length, 10, "the third turn end shows nothing again");
  }, { claude: FAKE }).finally(() => {
    if (priorFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = priorFf;
  });
});
