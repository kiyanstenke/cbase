// Guard "files in the copy", channel part (project container stage 2; channels/messages.js resolveChannelFiles/reloadChannelFiles/
// depositChannelFiles, channels/routes.js).
//
// THE GAP. `cbase_channel_send` with `files: [path]` resolved the path in B and copied the bytes from B into the channel: a chat in
// its copy sent the file of the MAIN. Now the copy's container fetches size and bytes (reloadChannelFiles), B only deposits.
//
// The promises, each with the sabotage that breaks it:
//   (1) The copy's version: a file the copy changed goes into the channel as ITS version (bytes in the channel folder, sha256); a
//       file that exists only in the copy goes along; one deleted in the copy (whiteout) is "file missing"; the main stays
//       byte-exact. Counter-check, read in B: the same message from a chat in the main carries the main's version.
//   (2) What the copy has no business reading stays rejected as in B: a folder ("not a file"), a path outside the working area,
//       the cap per message (with a message); nothing is sent, no partial deposit.
//   (3) Own attachments live in the runtime folder and stay in B: no call in the copy container.
//   (4) No fallback: if the container is down, the message fails (400) — neither the main's file nor a part goes into the channel.
//   (5) A caller that forgets the reload step gets no file of the main: sendToChannel throws (closed).
//   (6) The cap per message breaks already while reloading: the running sum counts, each copy file reads only the rest (maxBytes),
//       on overflow the message ends at once — many entries of the same file do not all run through the container.
//   (7) With a token: the copy token sends the copy's version, the main token with the main's chat the main's, a copy token with
//       the main's chat is 403. (8) An origin whose instance no longer exists throws. (9) The main token of a chat that now lives
//       in the copy (a workflow core still open in the main) sends the main's version — the origin counts, not the binding.
//   (10) No way through B into the main: an attachment or path of a copy chat that lands in the main's project folder through a
//       link in the attachment folder or a prefix on "/" (like /proc/self/root) is not in reach — with and without a token, 400
//       over the route, nothing in the channel; a real attachment still goes through. (Before the fix the project folder came
//       into reach as a root without anchor via realpath in B (= the main): channels/messages.js channelInReach →
//       runs/runtime-limit.js areaInB.)
//
// No clock: the copy is built through the real queue (stacks-copy-harness.mjs); it waits for states. The route is called over HTTP
// of the test server (in (1)–(6) without a token: the instance follows the chat; in (7)–(9) with a token: the instance follows
// the token, channels/messages.js channelSituation).
//
// Counter-tests, one sabotage each on the real tree:
//   channels/messages.js  resolveChannelFiles: paths under the copy are resolved in B           ⇒ (1) (2) (4) (5) red
//                         depositChannelFiles copies the file from B instead of the copy's bytes  ⇒ (1) (5) red
//                         reloadChannelFiles: an error of the container is passed over         ⇒ (1) (4) red
//                         depositChannelFiles without the check for unloaded bytes              ⇒ (5) red
//   Run and NOT red — reasoned, no proof needed:
//   reloadChannelFiles without the `r.tooBig` branch is an EQUIVALENT mutant: `tooBig` means `size > maxBytes` (full size — held
//      by fileAccess.test.js), and maxBytes is the rest `max − sum`; so `sum + r.size > max` is true in exactly the same cases, the
//      second part of the condition catches every first.
//   resolveChannelFiles also checking the cap before reloading is HARMLESS: a copy file carries size 0 there, the check sees only
//      the sum of the files from B — the same one reloadChannelFiles starts with; at most it aborts earlier with the same message.
//
//   channelInReach without the copy's area (`area: null` — every root via realpath)   ⇒ (1) red (10)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { channelFileDir, resolveChannelFiles, sendToChannel } from "../electron/server/channels/messages.js";
import { TOKEN_HEADER } from "../electron/server/projectbox/fence.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { openAgents } from "../electron/server/runs/agents.js";
import { agentContextWithoutTurn } from "../electron/server/runs/do-run.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import { attachmentLocation } from "../electron/server/runs/runtime-location.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, inCopy, situationDefault, withCopy, withEnvironment, writeInCopy } from "./stacks-copy-harness.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function mainState(filePath) {
  const write = (rel, content) => { const p = path.join(filePath, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write("plan.md", "MAIN-PLAN\n");
  write("only-main.md", "ONLY-IM-MAIN\n");
  write("folder/inside.md", "inside\n");
  write("large.bin", "x".repeat(4096));
}
async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  const inst = instanceForProject(pid, "copy-k1");
  assert.ok(inst && instanceIsCopy(inst), "the copy's instance must resolve");
  // A channel with the copy chat as its only participant: there is no delivery, the deposit is what is checked.
  const channel = store.createChannel({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, name: "Copy channel" });
  store.addChannelParticipants(channel.id, { chatId: ctx.chat.id });
  return { inst, channel };
}
const send = (ctx, channel, chatId, files, text = "enclosed", token = null) => fetch(`${ctx.base}/api/channels/${channel.id}/messages`, {
  method: "POST", headers: { "Content-Type": "application/json", Connection: "close", ...(token ? { [TOKEN_HEADER]: token } : {}) }, body: JSON.stringify({ chatId, text, files }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const execInCopy = (b) => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(b.copy)).length;
// The `maxBytes` of the read calls into the copy container (the options stand as JSON after `--`, runtime/file-access.js), in order.
const readLimits = (b, mark) => b.fd.calls().slice(mark).filter((a) => a.args[0] === "exec" && a.args.includes(b.copy))
  .map((a) => { const i = a.args.lastIndexOf("--"); return i >= 0 && a.args[i + 1] === "read" ? JSON.parse(a.args[i + 2]).maxBytes : null; }).filter((n) => n !== null);
const channelFiles = (channel) => { try { return fs.readdirSync(channelFileDir(channel.id)).sort(); } catch { return []; } };
const messages = (channel) => store.getChannel(channel.id).lastSeq;

test("(1) A file of the copy goes into the channel as the copy's version; one that exists only there goes along; one deleted in the copy is “file missing”; the main stays byte-exact", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const p = (rel) => path.join(b.s.path, rel);
    writeInCopy(b, p("plan.md"), "COPY-PLAN\n");
    writeInCopy(b, p("only-copy.md"), "ONLY-IN-THE-COPY\n");
    inCopy(b, b.s.path, "rm", "-f", "only-main.md");
    const mainPrior = sha(fs.readFileSync(p("plan.md")));

    const r = await send(ctx, channel, ctx.chat.id, ["plan.md", { path: "only-copy.md" }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const files = r.body.channel?.message?.files || r.body.files || [];
    assert.deepEqual(channelFiles(channel), ["channel-1-1-plan.md", "channel-1-2-only-copy.md"], JSON.stringify(r.body).slice(0, 400));
    assert.equal(fs.readFileSync(path.join(channelFileDir(channel.id), "channel-1-1-plan.md"), "utf8"), "COPY-PLAN\n", "not the copy's version in the channel");
    assert.equal(fs.readFileSync(path.join(channelFileDir(channel.id), "channel-1-2-only-copy.md"), "utf8"), "ONLY-IN-THE-COPY\n");
    assert.ok(files.length === 0 || files.every((d) => d.size > 0), JSON.stringify(files));
    assert.equal(sha(fs.readFileSync(p("plan.md"))), mainPrior, "the main was touched");
    assert.equal(fs.existsSync(p("only-copy.md")), false, "the copy's file is in B");

    // Deleted in the copy, present in the main: not found, nothing sent.
    const n = messages(channel);
    const missing = await send(ctx, channel, ctx.chat.id, ["only-main.md"]);
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.match(missing.body.error, /Datei fehlt: only-main\.md/);
    assert.equal(messages(channel), n, "a message went out despite the error");
    assert.deepEqual(channelFiles(channel), ["channel-1-1-plan.md", "channel-1-2-only-copy.md"], "a partial deposit remained");

    // Counter-check, read in B: a chat in the main (instance of the main) sends the same entry with the main's version.
    const mainChat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, projectId: b.s.projectId, provider: "claude" }) });
    store.addChannelParticipants(channel.id, { chatId: mainChat.id });
    const inMain = await send(ctx, channel, mainChat.id, ["plan.md"]);
    assert.equal(inMain.status, 201, JSON.stringify(inMain.body));
    const fresh = channelFiles(channel).filter((f) => f.includes("plan.md") && !f.startsWith("channel-1-"));
    assert.equal(fresh.length, 1, channelFiles(channel).join(", "));
    assert.equal(fs.readFileSync(path.join(channelFileDir(channel.id), fresh[0]), "utf8"), "MAIN-PLAN\n", "the chat in the main sends the main");
  });
});

test("(2) Rejections as in B: folder, path outside, cap per message — nothing sent, no partial deposit", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const n = messages(channel);
    let r = await send(ctx, channel, ctx.chat.id, ["folder"]);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /Keine Datei: folder/);
    r = await send(ctx, channel, ctx.chat.id, [{ path: "../../etc/passwd" }]);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /außerhalb deines Arbeitsbereichs/);
    await withEnvironment({ CBASE_CHANNEL_FILES_MAX: "1000" }, async () => {
      r = await send(ctx, channel, ctx.chat.id, ["large.bin"]);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /Dateien zu groß/);
      // The sum over several files counts as well (each alone under the cap).
      writeInCopy(b, path.join(b.s.path, "a.md"), "a".repeat(700));
      writeInCopy(b, path.join(b.s.path, "b.md"), "b".repeat(700));
      r = await send(ctx, channel, ctx.chat.id, ["a.md", "b.md"]);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /Dateien zu groß/);
    });
    assert.equal(messages(channel), n);
    assert.deepEqual(channelFiles(channel), []);
  });
});

test("(3) Own attachments live in the runtime folder and stay in B: no call in the copy container", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const attachment = await json(`${ctx.base}/api/chats/${ctx.chat.id}/attachments?name=note.txt`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "Note of the copy" });
    assert.ok(attachment);
    const prior = execInCopy(b);
    const r = await send(ctx, channel, ctx.chat.id, [{ attachment: "note.txt" }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(execInCopy(b), prior, "an attachment was fetched through the copy container");
    assert.deepEqual(channelFiles(channel), ["channel-1-1-note.txt"]);
    assert.equal(fs.readFileSync(path.join(channelFileDir(channel.id), "channel-1-1-note.txt"), "utf8"), "Note of the copy");
  });
});

test("(4) No fallback: if the container is down, the message fails — neither the main's file nor a part goes into the channel", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const cfg = path.join(b.fd.dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [b.copy] }));
    const n = messages(channel);
    const r = await send(ctx, channel, ctx.chat.id, ["plan.md"]);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /aus der Kopie nicht lesbar/);
    assert.equal(messages(channel), n);
    assert.deepEqual(channelFiles(channel), []);
  });
});

test("(5) A caller that forgets the reload step gets no file of the main: sendToChannel throws and creates nothing", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const chat = store.getChat(ctx.chat.id);
    const raw = resolveChannelFiles(chat, ["plan.md"]);
    assert.ok(raw[0].copy && raw[0].size === 0, "resolving a copy file does not know its size — it appears only after reloading");
    assert.throws(() => sendToChannel(store.getChannel(channel.id), { ofChatId: chat.id, text: "without reloading", files: raw }), /nicht geladen/);
    assert.deepEqual(channelFiles(channel), []);
    assert.equal(messages(channel), 0);
  });
});

test("(6) The cap per message breaks at once while reloading: many entries of the same copy file, each alone under the cap, do not all run through the container", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    writeInCopy(b, path.join(b.s.path, "medium.md"), "m".repeat(700));
    await withEnvironment({ CBASE_CHANNEL_FILES_MAX: "1000" }, async () => {
      const n = messages(channel);
      const before = execInCopy(b);
      const mark = b.fd.calls().length;
      const r = await send(ctx, channel, ctx.chat.id, Array.from({ length: 12 }, () => "medium.md"));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /Dateien zu groß/);
      // The first entry (700) fits, the second would have only 300 bytes left: it aborts — the other ten are never read.
      const read = execInCopy(b) - before;
      assert.ok(read <= 2, `the container read ${read}× instead of at most 2× (the rest of the cap is not carried along)`);
      assert.deepEqual(readLimits(b, mark), [1000, 300], "each file may read only the rest of the cap (maxBytes)");
      assert.equal(messages(channel), n);
      assert.deepEqual(channelFiles(channel), []);
      // What fits into the cap goes through (sum 700 + 300).
      writeInCopy(b, path.join(b.s.path, "rest.md"), "r".repeat(300));
      const ok = await send(ctx, channel, ctx.chat.id, ["medium.md", "rest.md"]);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });
  });
});

test("(7) From a project network the TOKEN decides the instance: the copy token sends the copy's version, the main token the main's; a copy token with the main's chat does not get through", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const tK = tokenFor(store.projectInstance(pid, "copy-k1"));
    const tH = tokenFor(store.projectInstance(pid, "main"));
    writeInCopy(b, path.join(b.s.path, "plan.md"), "COPY-PLAN\n");
    const content = (f) => fs.readFileSync(path.join(channelFileDir(channel.id), f), "utf8");

    const r = await send(ctx, channel, ctx.chat.id, ["plan.md"], "enclosed", tK);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(channelFiles(channel), ["channel-1-1-plan.md"]);
    assert.equal(content("channel-1-1-plan.md"), "COPY-PLAN\n", "the copy token did not send the copy's version");

    // Counter-check: the main token with the main's chat sends the main's version.
    const mainChat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, projectId: pid, provider: "claude" }) });
    store.addChannelParticipants(channel.id, { chatId: mainChat.id });
    const h = await send(ctx, channel, mainChat.id, ["plan.md"], "enclosed", tH);
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal(content("channel-2-1-plan.md"), "MAIN-PLAN\n", "the main token did not send the main's version");

    // A copy token does not speak as the main's chat: the fence rejects, nothing goes out.
    const n = messages(channel);
    const wrong = await send(ctx, channel, mainChat.id, ["plan.md"], "enclosed", tK);
    assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
    assert.equal(messages(channel), n);
    assert.deepEqual(channelFiles(channel), ["channel-1-1-plan.md", "channel-2-1-plan.md"]);
  });
});

test("(8) An instance that no longer exists fails the request — never the path in B and never the main", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    const chat = store.getChat(ctx.chat.id);
    assert.throws(() => resolveChannelFiles(chat, ["plan.md"], { origin: `${b.s.projectId}/copy-away` }), /gibt es nicht mehr/);
    assert.throws(() => resolveChannelFiles(chat, [{ path: path.join(b.s.path, "plan.md") }], { origin: `${b.s.projectId}/copy-away` }), /gibt es nicht mehr/);
    assert.deepEqual(channelFiles(channel), []);
    assert.equal(messages(channel), 0);
  });
});

test("(9) The main token also counts when its chat now lives in the copy — the message carries the main's version, not that of the chat's binding", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b); // the chat is bound to the copy ...
    const pid = b.s.projectId;
    writeInCopy(b, path.join(b.s.path, "plan.md"), "COPY-PLAN\n");
    // ... but a core of its workflow still works in the main (chatAliveInInstance): the fence lets the main token through for this chat.
    const ctl = openAgents({ ...agentContextWithoutTurn(ctx.chat.id, { identifier: `${pid}/main` }), hold: true, deliver: null }, { event: () => {}, atEnd: () => {} }, { own: true });
    try {
      const r = await send(ctx, channel, ctx.chat.id, ["plan.md"], "enclosed", tokenFor(store.projectInstance(pid, "main")));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(fs.readFileSync(path.join(channelFileDir(channel.id), "channel-1-1-plan.md"), "utf8"), "MAIN-PLAN\n", "the token's origin (main) counts, not the chat's current binding (copy)");
    } finally { ctl.close(); }
  });
});

test("(10) No way through B into the main: an attachment or path of a copy chat that lands in the main's project folder through a link in the runtime folder or a prefix on “/” (like /proc/self/root) is rejected — nothing goes into the channel", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { inst, channel } = await copyWithChat(ctx, b);
    const chat = store.getChat(ctx.chat.id);
    const attachments = attachmentLocation(chat);
    fs.mkdirSync(attachments, { recursive: true });
    const target = path.join(b.s.path, "plan.md");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-channel-root-"));
    try {
      // What the copy's bash can create in the rw-mounted attachment folder, and a "/" outside all roots.
      fs.symlinkSync(target, path.join(attachments, "x-link.txt"));
      fs.symlinkSync("/", path.join(attachments, "root"));
      fs.symlinkSync("/", path.join(outside, "root"));
      const details = [
        { attachment: "x-link.txt" },
        { path: path.join(attachments, "x-link.txt") },
        { path: path.join(attachments, "root") + target },
        { path: path.join(outside, "root") + target },
      ];
      for (const detail of details) {
        for (const origin of [null, inst.identifier]) { // without a token (the instance follows the chat) and with the copy's token
          assert.throws(() => resolveChannelFiles(chat, [detail], { origin }), /führt aus deinem Arbeitsbereich hinaus|außerhalb deines Arbeitsbereichs/,
            `accepted: ${JSON.stringify(detail)} (origin ${origin})`);
        }
      }
      // Over the route: 400, nothing in the channel.
      for (const detail of details) {
        const r = await send(ctx, channel, ctx.chat.id, [detail]);
        assert.equal(r.status, 400, `${JSON.stringify(detail)}: ${JSON.stringify(r.body)}`);
      }
      assert.equal(messages(channel), 0);
      assert.deepEqual(channelFiles(channel), [], "a file of the main is in the channel");
      // A real attachment in the runtime folder still goes through.
      fs.writeFileSync(path.join(attachments, "real.txt"), "REAL");
      const ok = await send(ctx, channel, ctx.chat.id, [{ attachment: "real.txt" }]);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.deepEqual(channelFiles(channel), ["channel-1-1-real.txt"]);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

// Counter-tests for (7)–(9) (a test gap filled in later):
//   messages.js: channelSituation maps the copy's identifier to <project>/main                  ⇒ (1) red (7)
//   messages.js: `if (!inst) throw` in channelSituation removed                                  ⇒ (1) red (8)
//   routes.js:   `origin: ctx.fence?.identifier` replaced by `origin: null`                      ⇒ (1) red (9)
// And for (6): reloadChannelFiles carries the running sum, gives each copy file only the rest of the cap (maxBytes) and aborts on
// overflow at once. The final check channelCapCheck stays as a safeguard.
//   messages.js: read with maxBytes: max instead of the rest   ⇒ (1) red (6)
//   messages.js: sum += 0 (running sum missing)                ⇒ (1) red (6)

// (11) The count per message: the cap counts bytes — 0-byte files ran through the copy's container in any number, once each. So
// resolveChannelFiles checks the COUNT BEFORE any resolution (CBASE_CHANNEL_FILES_COUNT, default 50; the cbase_channel_send tool
// carries the same number as maxItems): too many ⇒ 400 with a message, nothing in the channel, no call in the container.
// Counter-test: the count check in resolveChannelFiles removed ⇒ (11) red (201 and m+1 calls in the copy container).
test("(11) The count per message: m+1 entries of a 0-byte file of the copy ⇒ 400, nothing in the channel, no call in the copy container", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainState(b.s.path); }, async ({ ctx, b }) => {
    const { channel } = await copyWithChat(ctx, b);
    writeInCopy(b, path.join(b.s.path, "empty.md"), "");
    await withEnvironment({ CBASE_CHANNEL_FILES_COUNT: "3" }, async () => {
      const n = messages(channel);
      const before = execInCopy(b);
      const r = await send(ctx, channel, ctx.chat.id, Array.from({ length: 4 }, () => "empty.md"));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /zu viele Dateien: 4, Deckel 3 je Nachricht — nichts gesendet/);
      assert.equal(execInCopy(b) - before, 0, "the container was asked despite too many entries");
      assert.equal(messages(channel), n);
      assert.deepEqual(channelFiles(channel), []);
      // Exactly at the cap it works (once each through the container).
      const ok = await send(ctx, channel, ctx.chat.id, Array.from({ length: 3 }, () => "empty.md"));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });
  });
});
