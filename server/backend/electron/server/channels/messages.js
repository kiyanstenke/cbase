// Channel messages and files: CHANNEL_FILES_MAX, channelFileDir, channelOriginText, channelFileRoots, channelOwnAttachment,
// resolve/reload/deposit/stage of channel files, sendToChannel.

import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { DIRS } from "../app-state.js";
import { attachmentFolderToRead, attachmentLocation, locationForProject } from "../runs/runtime-location.js";
import { copyInRuntimeFolder, openFromRuntimeFolder } from "../runs/runtime-write.js";
import { instanceFromIdentifier, instanceIsCopy, instanceOfChat, projectFromIdentifier, turnIdentifier, turnProject } from "../runs/instance.js";
import { areaInB, rootsOfTheInstance } from "../runs/runtime-limit.js";
import * as access from "../runtime/fileAccess.js";
import { realLocation, openInArea } from "../runtime/real-path.js";
import { broadcast } from "../runtime/sse.js";
import { insideRoots } from "../runs/permissions.js";
import { channelCapReached, channelCard, writeChannelCard, deliverChannel } from "./delivery.js";
import { safeFileName } from "../runtime/http.js";
import { channelOfEndedChildChat, runningNotMore } from "../communication/child-chat-end.js";
import { channelFrozen, channelFrozenError } from "./freeze.js";

// ── Files in the channel ─────────────────────────────────────────────────────
// A message carries files. The sender names them within ITS reach — paths of its working tree or its own attachments. The
// bytes live ONCE under channel-files/<channel>/ and are copied into the recipient's attachments on delivery: its Read may
// already read there, read limit and sandbox stay unchanged. Every refusal (reach, missing file, cap) is an error of
// WRITING — nothing is dropped silently, because a prompt that names a file that never arrived is worse than one without
// a file.
const CHANNEL_FILES_MAX = 25 * 1024 * 1024;
const channelFilesMax = () => Number(process.env.CBASE_CHANNEL_FILES_MAX) || CHANNEL_FILES_MAX;
// The cap on the NUMBER per message — the byte cap would let 0-byte files in any number run through a copy's container one
// by one. Checked before any resolution; the tool cbase_agent_send carries the same number as maxItems.
const CHANNEL_FILES_COUNT = 50;
const channelFilesCount = () => Number(process.env.CBASE_CHANNEL_FILES_COUNT) || CHANNEL_FILES_COUNT;
const channelFileDir = (channelId) => path.join(DIRS.channelFiles, channelId);
const channelSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n | 0} B`);
// Per call, not at module load: T() reads the user's language, and that can change. "deposit" and "readLimit" no longer
// arise; they stay for the messages in the log that carry them (a card is history).
function channelOriginText(kind) {
  switch (kind) {
    case "deposit": return T("from the manager's document store");
    case "attachment": return T("attachment of the sender");
    case "readLimit": return T("from the manager's read scope");
    case "workspace": return T("from the coding chat's working tree");
    default: return kind || "";
  }
}
// A coding chat of a project that runs in a project container (`inst` = its instance, runs/instance.js): its reach is the
// attachments (in the runtime folder, until the relocation also at the old place) and the project folder — NOT the
// workspace, which contains the neighbouring projects. There the check goes by the real location (`channelInReach`): the
// agent's Bash runs in the project container, and a symlink from there would point in B to a neighbour's file. Without an
// instance the roots and the literal check apply.
//
// WHOSE PROJECT: not simply the chat's CURRENT one — switching projects mid-turn is allowed, and the running turn with its
// subagents keeps working in the old project until it ends. The situation (`channelSituation`) therefore comes, in this
// order, from
//   1. the ORIGIN of the request: ctx.fence of the route (channels/routes.js) — the project container it came from; only
//      this also covers a subagent that lives on in the old project after the switch;
//   2. the chat's running turn (runs/instance.js turnIdentifier) — pinned to the instance it began in;
//   3. otherwise the current project.
// From the situation follow instance, project folder (root and cwd) and the runtime location of the attachments. Without
// an instance row and without a fence there is neither origin nor identifier: the situation is then the plain one.
//
// THE ROOTS THEMSELVES: the attachment folder is an ordinary subfolder of the runtime folder — the project container can
// replace it with a link. With an instance it therefore counts only through the trusted anchors (runs/runtime-limit.js,
// runtime/real-path.js), never through its realpath.
//
// A COPY: its project folder is in the roots but exists only in its container — B would see the main instance there. An
// attachment or path that literally does not lie below it (a link in the attachment folder, `/proc/self/root<P>/…`) is
// checked in B, STRICTLY and LOCKED (runs/runtime-limit.js areaInB): the project folder does not count as a root in B, and
// no real location below it is within reach. What literally lies below it, `reloadChannelFiles` fetches from the container.
function channelSituation(chat, { origin = null } = {}) {
  const now = { inst: null, projectId: chat.projectId || null, location: undefined };
  // The origin is the IDENTIFIER "<projectId>/<instance>" of the token (ctx.fence.identifier) — from a project network the
  // token decides the instance, never the chat and never the project alone: with the project alone a copy would be "the
  // main instance of its project", and a copy chat's files would be looked up in and deposited from the main instance. If
  // the instance does not exist (anymore), the request fails; never a fallback to the main instance or the chat.
  if (origin) {
    const inst = instanceFromIdentifier(String(origin));
    if (!inst) throw new Error(T`The instance ${origin} of this request no longer exists — nothing read, nothing sent.`);
    return situationIn(chat, inst, projectFromIdentifier(String(origin)));
  }
  const identifier = turnIdentifier(chat.id);
  if (identifier) return situationIn(chat, instanceFromIdentifier(identifier), projectFromIdentifier(identifier));
  const inst = chat.projectId ? instanceOfChat(chat) : null; // the chat's copy if it carries one
  // A turn WITHOUT an instance (in B, its project not in a container) in another project than the chat's current one, while
  // the current one carries an instance — the turn keeps working in B in the old one until it ends: the situation of its
  // project in B, without an instance, instead of the project container's reach. Without an instance of the current
  // project everything stays plain.
  const tp = inst ? turnProject(chat.id) : null;
  if (tp && (tp.projectId || null) !== (chat.projectId || null)) return situationIn(chat, null, tp.projectId);
  return { ...now, inst };
}
// The situation in a project — in the chat's current one with its runtime location (default of attachmentFolderToRead), otherwise with its own.
const situationIn = (chat, inst, projectId) => ({
  inst: inst || null, projectId, location: projectId && projectId !== (chat.projectId || null) ? locationForProject(projectId) : undefined,
});
function channelFileRoots(chat, situation = channelSituation(chat)) {
  // The chat's own attachments — after a project switch, until the relocation, also those at the old place (attachmentFolderToRead).
  const roots = [...attachmentFolderToRead(chat, situation.location)];
  const ws = !situation.inst && chat.workspaceId ? store.getWorkspace(chat.workspaceId) : null;
  if (ws?.path) roots.push(ws.path);
  const proj = situation.projectId ? store.getProject(situation.projectId) : null;
  if (proj?.path) roots.push(proj.path);
  return roots.map((r) => path.resolve(r));
}
const channelInReach = (abs, roots, inst) => (inst ? realLocation(abs, roots, { area: areaInB(inst, roots) }).inside : insideRoots(abs, roots));
// Find an attachment of the chat itself — by the stored name (with timestamp prefix) or by the name it was uploaded
// under (the latest). Searched in every attachment folder of the chat: after a project switch its attachments still lie
// at the old place until the relocation (runs/runtime-location.js attachmentFolderToRead). → { file, path } or null.
function channelOwnAttachment(chat, wish, location) {
  const folder = attachmentFolderToRead(chat, location);
  const file = safeFileName(wish);
  for (const dir of folder) if (fs.existsSync(path.join(dir, file))) return { file, path: path.join(dir, file) };
  const hits = [];
  for (const dir of folder) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.replace(/^[0-9a-z]+-/, "") === file) hits.push({ file: n, path: path.join(dir, n) });
  }
  hits.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  return hits.length ? hits[hits.length - 1] : null;
}
// Resolve the sender's file entries → [{ name, size, origin, src }] (for a file from the project folder of a COPY also
// `copy: inst`, `size` 0 until reloadChannelFiles has fetched it). `origin`: the identifier of the instance of the token
// the request came from (ctx.fence.identifier, see channelSituation) — otherwise null.
//
// THE SOURCE THROUGH THE DESCRIPTOR. With an instance the source lies in the project or runtime folder — both rw in the
// project container. If its location were checked on resolving (realpath) but read only on depositing through the path
// (`copyFileSync` follows links), the container could in between swap `plan.md` for a link to a credentials file, and B
// would put B's file into the channel — it lands in the recipient's attachments. A FIFO in its place would stall B. So
// with an instance the source is opened within the instance's area (runtime/real-path.js openInArea with
// runs/runtime-limit.js areaInB — the same as the reach; without an instance but inside the runtime folder, without any
// link: runs/runtime-write.js openFromRuntimeFolder), a regular file only; device, inode and size go along as `source`, and
// `depositChannelFiles` opens it the same way once more, compares and copies from THAT descriptor. Another file in its
// place is an error of writing (nothing sent). Without an instance and outside every runtime folder the plain path applies.
function channelSourceOpen(src, area) {
  if (!area) return openFromRuntimeFolder(src);
  const fd = openInArea(src, area);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`Not a regular file: ${src}`), { code: "ENOFILE" });
  } catch (e) { fs.closeSync(fd); throw e; }
  return fd;
}
function resolveChannelFiles(chat, details, { origin = null } = {}) {
  const list = Array.isArray(details) ? details : [];
  if (!list.length) return [];
  const count = channelFilesCount();
  if (list.length > count) throw new Error(T`too many files: ${list.length}, cap ${count} per message — nothing sent`);
  const situation = channelSituation(chat, { origin });
  const { inst } = situation;
  const roots = channelFileRoots(chat, situation);
  const ws = chat.workspaceId ? store.getWorkspace(chat.workspaceId) : null;
  const proj = situation.projectId ? store.getProject(situation.projectId) : null;
  const cwd = proj?.path || ws?.path || attachmentLocation(chat, situation.location);
  const out = [];
  for (const raw of list) {
    const a = typeof raw === "string" ? { path: raw } : (raw && typeof raw === "object" ? raw : null);
    if (!a) throw new Error(T("files: unreadable entry (attachment or path)"));
    let src; let name; let origin;
    // (`docId` — a document of the manager's store — no longer exists.)
    if (a.docId) throw new Error(T("docId: store documents no longer exist — name paths of your working tree or your own attachments"));
    if (a.attachment) {
      const found = channelOwnAttachment(chat, String(a.attachment), situation.location);
      if (!found) throw new Error(T`Attachment "${a.attachment}" does not exist in this chat`);
      // The attachment folder of a project in a container lies in the runtime folder, and the project container sees it:
      // an "attachment" that points out of it there as a symlink is none.
      if (inst && !channelInReach(found.path, roots, inst)) throw new Error(T`Attachment "${a.attachment}" leads outside your working scope`);
      src = found.path;
      name = found.file.replace(/^[0-9a-z]+-/, "");
      origin = "attachment";
    } else if (a.path) {
      const abs = path.resolve(cwd, String(a.path));
      // A path below the project folder of a COPY lies in its container — B would see the main instance. Here only the
      // reach (literally: the container is the boundary); size and bytes are fetched by `reloadChannelFiles` (async) from the copy.
      if (channelInContainer(inst, abs)) {
        if (!insideRoots(abs, roots)) throw new Error(T`Path outside your working scope: ${a.path}`);
        out.push({ name: safeFileName(a.name || path.basename(abs)), size: 0, origin: "workspace", src: abs, copy: inst });
        continue;
      }
      if (!channelInReach(abs, roots, inst)) throw new Error(T`Path outside your working scope: ${a.path}`);
      src = abs;
      name = path.basename(abs);
      origin = "workspace";
    } else throw new Error(T("files: give attachment or path per entry"));
    // Through the descriptor (see above): with an instance within the instance's area, otherwise only in the runtime folder — outside `null`, the plain path.
    const area = inst ? areaInB(inst, roots) : null;
    let st;
    let fd = null;
    try {
      fd = channelSourceOpen(src, area);
      st = fd === null ? fs.statSync(src) : fs.fstatSync(fd);
    } catch (e) {
      if (e?.code === "EOUTSIDE") throw new Error(T`File "${name}" leads outside your working scope`);
      if (e?.code === "ENOFILE") throw new Error(T`Not a file: ${name}`);
      throw new Error(T`File missing: ${name}`);
    } finally { if (fd !== null) fs.closeSync(fd); }
    if (!st.isFile()) throw new Error(T`Not a file: ${name}`);
    const source = fd === null ? {} : { source: { area, dev: st.dev, ino: st.ino, size: st.size } };
    out.push({ name: safeFileName(a.name || name), size: st.size, origin, src, ...source });
  }
  if (!out.some((d) => d.copy)) channelCapCheck(out); // with files from a copy only after reloading (sizes unknown)
  return out;
}
// The cap per message over all files.
function channelCapCheck(out) {
  const sum = out.reduce((n, d) => n + d.size, 0);
  const max = channelFilesMax();
  if (sum > max) throw new Error(T`Files too large: ${channelSize(sum)}, cap ${channelSize(max)} per message — nothing sent`);
}
// Does this path go through a copy's container? Only a COPY knows the way (main instance and "no instance" stay in B); if
// its project folder cannot be determined, the request fails (never B).
function channelInContainer(inst, abs) {
  if (!instanceIsCopy(inst)) return false;
  const roots = rootsOfTheInstance(inst);
  if (!roots.project) throw new Error(T`The project folder of the copy ${inst.identifier || inst.projectId} cannot be determined — nothing read, nothing sent.`);
  return access.fileWay(inst, abs, roots) === "copy";
}
/**
 * The second step of `resolveChannelFiles` for files from a COPY — size and bytes come from its container
 * (runtime/fileAccess.js), never from B. Without such files it does nothing. A missing file, a folder, a cap or an access
 * error is an error of writing as in B: nothing is sent, nothing dropped silently.
 */
async function reloadChannelFiles(resolved) {
  const max = channelFilesMax();
  // The running total — it starts with the files from B (size known from statSync); every copy file may read only the REST
  // of the cap, and if that breaks, the message ends at once (B never holds more than the cap plus one response in memory).
  let sum = (resolved || []).reduce((n, d) => n + (d.copy ? 0 : d.size), 0);
  const tooBig = (n) => new Error(T`Files too large: ${channelSize(n)}, cap ${channelSize(max)} per message — nothing sent`);
  for (const d of resolved || []) {
    if (!d.copy) continue;
    let r;
    try { r = await access.read(d.copy, d.src, { maxBytes: Math.max(0, max - sum) }); } catch (e) {
      if (e?.code === "ENOENT") throw new Error(T`File missing: ${d.name}`);
      throw new Error(T`File ${d.name} cannot be read from the copy (${e?.code || e?.message}) — nothing sent`);
    }
    if (r.kind !== "file") throw new Error(T`Not a file: ${d.name}`);
    if (r.tooBig || sum + r.size > max) throw tooBig(sum + r.size);
    sum += r.size;
    d.size = r.size;
    d.data = r.data;
  }
  channelCapCheck(resolved || []);
}
// Deposit the bytes per message; what comes back are the entries as they stand in the log (name, size, origin, file name
// on the recipient's side). The sequence number is in the name: two messages with the same file never collide, two equal
// names in ONE message get their position. The stored name keeps its prefix `channel-`.
function depositChannelFiles(channel, resolved) {
  if (!resolved?.length) return [];
  const seq = (store.getChannel(channel.id)?.lastSeq | 0) + 1;
  const dir = channelFileDir(channel.id);
  fs.mkdirSync(dir, { recursive: true });
  return resolved.map((d, i) => {
    const file = `channel-${seq}-${i + 1}-${d.name}`;
    if (d.copy) { // fetched from the copy's container (reloadChannelFiles); without bytes never the main instance's file in its place
      if (!Buffer.isBuffer(d.data)) throw new Error(T`File ${d.name} from the copy was not loaded — nothing sent`);
      fs.writeFileSync(path.join(dir, file), d.data);
    } else if (d.source) channelSourceCopy(d, path.join(dir, file)); // through the descriptor (see resolveChannelFiles)
    else fs.copyFileSync(d.src, path.join(dir, file));
    return { name: d.name, size: d.size, origin: d.origin, file };
  });
}
// Open the source once more as on resolving, compare with what was seen and copy from THAT descriptor (see above).
function channelSourceCopy(d, target) {
  const fd = channelSourceOpen(d.src, d.source.area);
  if (fd === null) throw new Error(T`File ${d.name}: no longer in the runtime folder — nothing sent`);
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== d.source.dev || st.ino !== d.source.ino || st.size !== d.source.size) {
      throw new Error(T`File ${d.name} changed since it was resolved — nothing sent`);
    }
    copyInRuntimeFolder({ fd }, target);
  } finally { fs.closeSync(fd); }
}
// On delivery: put the messages' files into the recipient's attachments. If those lie in a project's runtime folder, B
// copies through the descriptor (runs/runtime-write.js): the project container mounts it rw, and a dangling link in the
// file's place (`existsSync` saw it as "missing") or a link `attachments/<chat> → /somewhere` would otherwise deposit the
// sender's file in B. Otherwise the plain copy.
function stageChannelFiles(channel, chat, messages) {
  const target = attachmentLocation(chat);
  for (const n of messages) {
    for (const d of n.files || []) {
      if (!d.file) continue;
      const src = path.join(channelFileDir(channel.id), d.file);
      const dst = path.join(target, d.file);
      try {
        if (!fs.existsSync(src)) continue;
        if (copyInRuntimeFolder(src, dst, { onlyIfMissing: true })) continue;
        if (fs.existsSync(dst)) continue;
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (e) { console.error("[channel] staging file:", e?.message || e); }
    }
  }
}
function sendToChannel(channel, { ofChatId = null, senderKind = "chat", systemKind = "", text = "", files = [], except = null }) {
  // A frozen channel (channels/freeze.js) accepts nothing — BEFORE any other check, nothing is deposited.
  if (channelFrozen(channel.id)) throw channelFrozenError();
  if (channel.status === "closed" || channel.status === "rejected") {
    throw new Error(T`Channel "${channel.name}" is ${channel.status} — cannot send`);
  }
  if (senderKind === "chat" && !store.getChannelParticipants(channel.id, ofChatId)) {
    throw new Error(T("This chat is not a participant of the channel"));
  }
  // Another participant is the child chat of an ended graph run — nothing is deposited (both send routes answer 409 with
  // this sentence; communication/child-chat-end.js).
  const ended = senderKind === "chat" ? channelOfEndedChildChat(channel.id, ofChatId) : null;
  if (ended) throw new Error(runningNotMore(ended.workflowName));
  const message = store.addChannelMessage({ channelId: channel.id, senderKind, senderChatId: senderKind === "chat" ? ofChatId : null, systemKind, text, files: depositChannelFiles(channel, files) });
  if (senderKind === "chat") {
    // The chat's own message counts as read, and it stands as a card in its own history.
    store.setChannelCursor(channel.id, ofChatId, message.seq);
    writeChannelCard(ofChatId, channelCard(channel, message, "out"));
    // Cap: agent messages since the last human involvement. At the cap the channel pauses and THIS message stays buffered
    // — instead of throttling silently.
    const fresh = store.updateChannel(channel.id, { agentsSinceHuman: (store.getChannel(channel.id)?.agentsSinceHuman | 0) + 1 });
    if (fresh.status === "open" && fresh.cap > 0 && fresh.agentsSinceHuman >= fresh.cap) {
      channelCapReached(fresh, message);
      return message;
    }
  }
  if (except) {
    writeChannelCard(except, channelCard(channel, message, "in"));
    store.setChannelCursor(channel.id, except, message.seq);
  }
  broadcast({ type: "channel", workspaceId: channel.workspaceId, channelId: channel.id, seq: message.seq });
  // The state of the node path per child-chat participant: not stored, only for the response to the sender
  // (communication/target-channel.js) — it takes it instead of guessing it from running and card.
  const deliveries = [];
  for (const t of store.listChannelParticipants(channel.id)) {
    if (t.chatId === ofChatId || t.chatId === except) continue;
    const r = deliverChannel(channel.id, t.chatId);
    if (r?.graph) deliveries.push({ chatId: t.chatId, graph: r.graph });
  }
  if (deliveries.length) message.deliveries = deliveries;
  return message;
}

export { channelFileDir, resolveChannelFiles, stageChannelFiles, reloadChannelFiles, channelSize, channelOriginText, sendToChannel };
// Only for server/backend/test/runtime-read.test.js: depositing the resolved files without a channel row and delivery.
export const _channelFilesDeposit = depositChannelFiles;
