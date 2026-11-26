// Fixture routes: usage, providers, chat folders, artifacts, /api/chats, /api/events, main chat (GET/PATCH/DELETE, log, stream, message, queue, control, stop, compact), channels, and the two /api/chats/<id> catch-alls (they stay LAST).
import { randomUUID } from "node:crypto";
import { S, json, framePng, defaultLevelOf, OPENROUTER_MODELS, creditSeed, CREDIT_GATE_THRESHOLD, body, extraChats, workspaceId, artifactMeta, artifactSha, chatId, globalStreams, AUTOCOMPACT_STAGES, AUTOCOMPACT_MAX_STAGES, publicQueue, chatStreams, limitWaitFor, chatEvent, clearRun, globalEvent, channelView, channelSystem, archivePage, matchesArchive, withArchive, archiveOpen, finalSet, NEXT } from "./state.mjs";
import { scheduledChats, withJob } from "./routes-scheduled.mjs";
import { startFixtureRun, mainHistory, historyStatus } from "./seeds.mjs";

// Attachments of the main chat (images from the clipboard): records what was uploaded — name, size and the first eight bytes as
// base-16 (a PNG signature proves "the image arrived", not just "something arrived"). Here instead of `state.mjs` (that file sits at
// the 2,000-line guard); `/fixture/reset-run` clears the list through `resetAttachmentUploads`.
let attachmentUploads = [];
export function resetAttachmentUploads() {
  attachmentUploads = [];
}
const ATTACHMENT_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// The agenda as a tree: `POST /fixture/agenda { tree: true }` makes the main chat carry a tree agenda in the server's shape (flat in
// pre-order, per item parent/depth/subitems/done/total/project, the status of parent items COMPUTED). Here instead of `state.mjs`
// (guard); `/fixture/reset-run` undoes it through `resetAgendaTree` — so the switch belongs in `launchApp(preparation:)`.
let agendaTree = false;
export function resetAgendaTree() {
  agendaTree = false;
}
const agendaItem = (id, parent, depth, text, status, o = {}) => ({
  id, parent, depth, text, note: "", status, subitems: 0, done: 0, total: 0, project: null, upkeep: null,
  createdAt: 1_790_000_000_000, changedAt: 1_790_000_000_000, doneAt: status === "done" ? 1_790_000_000_000 : null, ...o,
});
// The agenda keeper's marker on TWO items, in exactly the shape the server writes (agenda/operations.js bringAlongUpkeep —
// agenda.test.js (8) recomputes it through the keeper's write path and requires one per kind): the keeper set s2 from in_work to
// done (`status` with `prior`) and created s9 (`fresh`, as the last item — it gets the next id). Chosen because no UI test checks
// the label or value of these rows. With `afterwards`: the main agent edited s2 afterwards (`confirmed`), nobody touched s9 (`open`).
const keeperMarker = (kind, prior = null, afterwards = "open") => ({ agentId: `${workspaceId}-a9e0da`, runId: "40000000-0000-4000-8000-0000000000a9", at: 1_790_000_000_000, kind, prior, afterwards });
// Exported for the seam: server/backend/test/agenda.test.js (8) computes the same tree on the server and requires equality.
export function agendaTreeOf(id) {
  const steps = [
    agendaItem("s1", null, 0, "Shop: Checkout", "in_work", { subitems: 2, done: 1, total: 3, project: { id: "30000000-0000-4000-8000-000000000001", name: "Fixture-Projekt" } }),
    agendaItem("s2", "s1", 1, "Warenkorb", "done", { upkeep: keeperMarker("status", "in_work", "confirmed") }),
    agendaItem("s3", "s1", 1, "Zahlung", "in_work", { subitems: 2, done: 0, total: 2 }),
    agendaItem("s4", "s3", 2, "Stripe anbinden", "in_work", { note: "Den **Webhook** zuerst prüfen — Agenda-Notiz-Probe." }),
    agendaItem("s5", "s3", 2, "Belege", "open"),
    agendaItem("s6", null, 0, "Blog: Umzug", "done", { subitems: 2, done: 2, total: 2 }),
    agendaItem("s7", "s6", 1, "Export", "done"),
    agendaItem("s8", "s6", 1, "Import", "done"),
    agendaItem("s9", null, 0, "Aufräumen", "open", { upkeep: keeperMarker("fresh") }),
  ];
  return {
    chatId: id, title: "Zwei Vorhaben", description: "## Ziel\n\nShop und Blog — Agenda-Beschreibung-Probe.", steps,
    version: 3, changedAt: 1_790_000_000_000, counter: { open: 2, in_work: 1, done: 3 }, archived: 0,
  };
}

export async function routesChat(ctx) {
  const { req, res, url, path, method } = ctx;
    if (path === "/api/usage" && method === "GET") {
      // AT THE LIMIT: the SESSION WINDOW itself is full, and the legacy fields stay EMPTY (the
      // endpoint then lists the window only in limits[]) — `ring` alone carries the state.
      // This is exactly where the ring used to vanish.
      // `credit` and `gate` appear in BOTH branches: they are views of the same raw data and do not
      // depend on the window state. An account can hold credit and still deliver no window value
      // at all — exactly the limit branch here. If the field were missing there, the credit row
      // would vanish in exactly the situation it exists for.
      if (S.usageAtLimit) {
        return json(res, 200, {
          fiveHour: { utilization: null, resetsAt: null },
          sevenDay: { utilization: null, resetsAt: null },
          ring: { percent: 100, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: true },
          blocking: { percent: 100, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: true },
          credit: creditSeed(),
          // At the limit the window is above the threshold — the gate WOULD take effect if it were on.
          gate: {
            enabled: S.creditGate, threshold: CREDIT_GATE_THRESHOLD,
            window: { percent: 100, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: true },
          },
        });
      }
      // Normal case WITH a model-specific limit at the stop: the ring stays at the
      // session window (12 %), the model limit only sits beside it.
      return json(res, 200, {
        fiveHour: { utilization: 12, resetsAt: null },
        sevenDay: { utilization: 4, resetsAt: null },
        ring: { percent: 12, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: false },
        blocking: { percent: 100, resetsAt: null, group: "weekly", scope: "Fable", windowMinutes: null, reached: true },
        credit: creditSeed(),
        // The gate means the same window as `blocking` here: the model-specific weekly limit
        // is at 100 % and thus above the threshold. It does NOT belong in the ring (that would
        // show 100 % although 88 % of the session is free) — but it does hold back a start,
        // and `gateWindow` on the server only cuts off Codex windows, not model windows.
        gate: {
          enabled: S.creditGate, threshold: CREDIT_GATE_THRESHOLD,
          window: { percent: 100, resetsAt: null, group: "weekly", scope: "Fable", windowMinutes: null, reached: true },
        },
      });
    }
    if (path === "/api/usage/codex" && method === "GET") {
      // At the limit the Codex CLI writes the windows as null and names only the kind.
      if (S.usageAtLimit) {
        return json(res, 200, {
          connected: true, primary: null, secondary: null, planType: "team", reachedType: "credits",
          ring: { percent: 100, resetsAt: null, group: "credits", scope: "", windowMinutes: null, reached: true },
          blocking: { percent: 100, resetsAt: null, group: "credits", scope: "", windowMinutes: null, reached: true },
        });
      }
      return json(res, 200, {
        connected: true,
        primary: { usedPercent: 21, windowMinutes: 10080, resetsAt: null },
        secondary: { usedPercent: 8, windowMinutes: 300, resetsAt: null },
        // Ring = short window (8 % / 5 h), not the fuller long one.
        ring: { percent: 8, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: false },
        blocking: null,
      });
    }
    // Switch for the limit case (both providers at the stop).
    if (path === "/fixture/usage-limit" && method === "POST") {
      const request = await body(req);
      S.usageAtLimit = !(request && request.clear);
      return json(res, 200, { atLimit: S.usageAtLimit });
    }
    // Subscription usage is gone — usage reads `/api/usage/*` (routes-usage.mjs).
    // The provider catalog as `account/routes.js` really sends it:
    //   • `authMethod` is "chatgpt" | "apikey" | "" — NEVER "subscription". The backend uses the marker to control which
    //     models go out at all (`visibleModels`), so it must not be invented here. For claude the server always sends ""
    //     — there are no account kinds there.
    //   • `efforts` per model are carried by Codex (measured, in `CODEX_MODELS`) and Claude (`CLAUDE_MODELS`, Haiku 4.5
    //     EMPTY = no levels, no picker); third-party providers omit the field, and `EffortLevels` then falls back to the
    //     five default levels. Without the field EVERY UI test ran in the fallback — nobody saw the levels the picker
    //     really shows (without `max` for 5.5). Sol carries exactly the five levels of the ordering.
    //   • GPT-5.5 carries NO `max` — the only model where the effort tests of the four pickers see the marked entry
    //     "Max · runs as X-High".
    // The values are taken from `CODEX_MODELS`, not chosen: a fixture that invents its own levels tests its own invention.
    // Every provider carries `caps` like the server (`normalizeCaps`), and a third provider has `caps.effort: false` —
    // a third-party provider without a thinking level. On it NO selection shows an effort picker (chat sheet, new
    // chat, post, workflow run), and `/effort` says so. Its model carries no `efforts` (third-party providers omit
    // it): it is the provider's switch that takes the selection.
    if (path === "/api/providers" && method === "GET") {
      const caps = (effort) => ({ ownsAgentLoop: true, nativeToolCalling: true, streaming: true, reasoning: effort, vision: false, documents: false, permissionPrompt: false, fork: false, effort, plan: false });
      return json(res, 200, {
        active: "codex",
        providers: [
          {
            id: "codex",
            label: "OpenAI Codex",
            connected: true,
            authMethod: "chatgpt",
            defaultModel: S.defaultModel.codex || "gpt-5.6-sol",
            defaultEffort: defaultLevelOf("codex"),
            caps: caps(true),
            models: [
              { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", context: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
              { id: "gpt-5.5", label: "GPT-5.5", context: 272000, efforts: ["low", "medium", "high", "xhigh"] },
            ],
          },
          {
            id: "claude",
            label: "Claude Code",
            connected: true,
            authMethod: "",
            defaultModel: S.defaultModel.claude || "claude-sonnet-5",
            defaultEffort: defaultLevelOf("claude"),
            caps: caps(true),
            models: [
              { id: "claude-opus-5-5", label: "Opus 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] },
              { id: "claude-sonnet-5", label: "Sonnet 5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] },
              { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", context: 200000, efforts: [] },
            ],
          },
          {
            id: "flat",
            label: "Ohne Denkgrad",
            connected: true,
            authMethod: "apikey",
            defaultModel: "flat-1",
            defaultEffort: defaultLevelOf("flat"),
            caps: caps(false),
            models: [{ id: "flat-1", label: "Flach 1", context: 128000 }],
          },
          // OpenRouter built in: connected exactly when a key is set (`PUT /api/openrouter` or `POST /fixture/openrouter`) — NOT
          // by default, so that every model choice of the other tests keeps its menu. The catalog is an excerpt
          // (`OPENROUTER_MODELS`), more than a menu would carry.
          {
            id: "openrouter",
            label: "OpenRouter",
            connected: Boolean(S.openrouter.key),
            authMethod: "apikey",
            defaultModel: S.defaultModel.openrouter || "z-ai/glm-5.3-flash",
            defaultEffort: defaultLevelOf("openrouter"),
            caps: caps(true),
            models: OPENROUTER_MODELS.map((m) => ({ ...m })),
          },
        ],
      });
    }
    // `/api/profiles` no longer exists — like the server: 404.
    // ── Chat folders ──
    if (path === "/api/chat-folders" && method === "GET") {
      // Archive: `archive=without|only|with` like the server — the page applies to the folders AND their count.
      const page = archivePage(url);
      if (!page) return json(res, 400, { error: "archive must be \"without\", \"only\" or \"with\"" });
      const counts = {};
      for (const entry of [S.chat, ...extraChats]) {
        if (S.archive.deleted.has(entry.id) || !matchesArchive(page, S.archive.chats.has(entry.id))) continue;
        if (entry.folderId) counts[entry.folderId] = (counts[entry.folderId] || 0) + 1;
      }
      // Only coding folders exist — like the server: `kind` is missing or "normal", otherwise 400.
      const kind = url.searchParams.get("kind");
      if (kind !== null && kind !== "normal") return json(res, 400, { error: "kind is unknown — only coding folders (normal) remain" });
      return json(res, 200, S.chatFolders
        .filter((f) => matchesArchive(page, S.archive.folder.has(f.id)))
        .map((f) => ({ ...f, chatCount: counts[f.id] || 0, archivedAt: S.archive.folder.get(f.id) ?? null })));
    }
    if (path === "/api/chat-folders" && method === "POST") {
      const payload = await body(req);
      if (payload.kind !== undefined && payload.kind !== "normal") return json(res, 400, { error: "kind is unknown — only coding folders (normal) remain" });
      S.chatFolderCounter += 1;
      const folder = {
        id: `70000000-0000-4000-8000-00000000000${S.chatFolderCounter}`,
        workspaceId,
        projectId: payload.projectId || null,
        kind: "normal",
        name: String(payload.name || "Ordner"),
        chatCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      S.chatFolders.push(folder);
      return json(res, 201, folder);
    }
    // ── Archive and context files of a folder ──
    const folderSubMatch = path.match(/^\/api\/chat-folders\/([0-9a-f-]+)\/(archive|context)$/);
    if (folderSubMatch) {
      const folder = S.chatFolders.find((f) => f.id === folderSubMatch[1]);
      if (!folder) return json(res, 404, { error: "folder not found" });
      // Context files: only their COUNT matters (the delete prompt names it) — the fixture has no content.
      if (folderSubMatch[2] === "context" && method === "GET") {
        const n = Number(S.archive.contextFiles[folder.id]) || 0;
        return json(res, 200, Array.from({ length: n }, (_, i) => ({
          name: `context-${i + 1}.md`, path: `context-${i + 1}.md`, size: 12, mime: "text/markdown", modifiedAt: 1_800_000_000_000,
        })));
      }
      const inside = (onlyArchive) => [S.chat, ...extraChats]
        .filter((c) => c.folderId === folder.id && !S.archive.deleted.has(c.id) && S.archive.chats.has(c.id) === onlyArchive);
      const turnKind = "normal";
      // Answer shape like the server: `chats` names what the NEXT action hits — on the active folder the chats that
      // archiving would take along, on the archived one EXACTLY those that `?permanently=1` deletes (`finalSet`: only
      // the folder's kind); `contextFiles` in both cases.
      if (folderSubMatch[2] === "archive" && method === "GET") {
        const archivedValue = S.archive.folder.has(folder.id);
        const activeValue = archivedValue ? [] : inside(false);
        return json(res, 200, {
          archived: archivedValue, archivedAt: S.archive.folder.get(folder.id) ?? null,
          chats: archivedValue ? finalSet(folder).length : activeValue.length,
          contextFiles: Number(S.archive.contextFiles[folder.id]) || 0,
          open: activeValue.map((c) => ({ chatId: c.id, title: c.title || "", open: archiveOpen(c.id) })).filter((x) => x.open.length),
          terminals: activeValue.length * S.archive.shells,
        });
      }
      if (folderSubMatch[2] === "archive" && method === "PUT") {
        const b = await body(req);
        if (typeof b.archived !== "boolean") return json(res, 400, { error: "archived (true/false) required" });
        if (b.archived === S.archive.folder.has(folder.id)) return json(res, 200, { ok: true, unchanged: true, chatIds: [], terminalsEnded: 0 });
        if (b.archived) {
          const activeValue = inside(false);
          const locked = activeValue.map((c) => ({ chatId: c.id, title: c.title || "", open: archiveOpen(c.id) })).filter((x) => x.open.length);
          if (locked.length) return json(res, 409, { error: "Work is still open in this folder — nothing archived", chats: locked });
          const nowValue = Date.now();
          S.archive.folder.set(folder.id, nowValue);
          for (const c of activeValue) { S.archive.chats.set(c.id, nowValue); S.archive.withFolder.set(c.id, folder.id); }
          const chatIds = activeValue.map((c) => c.id);
          globalEvent({ type: "chat_archive", workspaceId, kind: turnKind, chatIds, folderIds: [folder.id], archived: true, reason: "user" });
          return json(res, 200, { ok: true, chatIds, terminalsEnded: activeValue.length * S.archive.shells });
        }
        // Only the chats that went WITH the folder come back.
        S.archive.folder.delete(folder.id);
        const chatIds = inside(true).filter((c) => S.archive.withFolder.get(c.id) === folder.id).map((c) => c.id);
        for (const id of chatIds) { S.archive.chats.delete(id); S.archive.withFolder.delete(id); }
        globalEvent({ type: "chat_archive", workspaceId, kind: turnKind, chatIds, folderIds: [folder.id], archived: false, reason: "user" });
        return json(res, 200, { ok: true, chatIds, terminalsEnded: 0 });
      }
    }
    const folderMatch = path.match(/^\/api\/chat-folders\/([0-9a-f-]+)$/);
    if (folderMatch) {
      const folder = S.chatFolders.find((f) => f.id === folderMatch[1]);
      if (!folder) return json(res, 404, { error: "folder not found" });
      if (method === "PATCH") {
        folder.name = String((await body(req)).name || folder.name);
        return json(res, 200, folder);
      }
      // `?permanently=1` ONLY on an archived folder — it goes along with its archived chats.
      if (method === "DELETE" && url.searchParams.has("permanently")) {
        if (url.searchParams.get("permanently") !== "1") return json(res, 400, { error: "permanently must be 1" });
        if (!S.archive.folder.has(folder.id)) return json(res, 400, { error: "Only an archived folder can be deleted permanently — archive it first" });
        // The same set as the question (GET …/archive on the archived folder) — ONE function, like the server.
        const gone = finalSet(folder);
        const contextFiles = Number(S.archive.contextFiles[folder.id]) || 0;
        for (const c of gone) S.archive.deleted.add(c.id);
        S.archive.folder.delete(folder.id);
        delete S.archive.contextFiles[folder.id];
        S.chatFolders = S.chatFolders.filter((f) => f.id !== folder.id);
        return json(res, 200, { ok: true, chats: gone.length, contextFiles });
      }
      if (method === "DELETE") {
        S.chatFolders = S.chatFolders.filter((f) => f.id !== folder.id);
        if (S.chat.folderId === folder.id) S.chat.folderId = null;
        for (const entry of extraChats) if (entry.folderId === folder.id) entry.folderId = null;
        return json(res, 200, { ok: true });
      }
    }
    // ── The chat's artifacts (list, read, write) ──
    const artifactMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)\/artifacts(\/file)?$/);
    if (artifactMatch) {
      const isFile = Boolean(artifactMatch[2]);
      if (!isFile && method === "GET") {
        return json(res, 200, [...S.artifacts.keys()].sort().map(artifactMeta));
      }
      if (isFile && method === "GET") {
        const wanted = url.searchParams.get("path") || "";
        if (!S.artifacts.has(wanted)) return json(res, 404, { error: "artifact not found" });
        return json(res, 200, {
          ...artifactMeta(wanted),
          offset: 0, nextOffset: null, truncated: false,
          encoding: "utf8", content: S.artifacts.get(wanted),
        });
      }
      if (isFile && method === "PUT") {
        const payload = await body(req);
        const wanted = String(payload.path || "");
        // Exactly like the real server: no overwriting without the state that was read.
        if (S.artifacts.has(wanted) && payload.expectedSha256 !== artifactSha(S.artifacts.get(wanted))) {
          return json(res, 409, { error: "Artifact was changed in the meantime" });
        }
        S.artifacts.set(wanted, String(payload.content ?? ""));
        return json(res, 200, artifactMeta(wanted));
      }
    }
    if (path === "/api/chats" && method === "GET") {
      // Archive: by default only active ones, `archive=only` the archive, unknown 400 — like the server.
      const page = archivePage(url);
      if (!page) return json(res, 400, { error: "archive must be \"without\", \"only\" or \"with\"" });
      // Plus the chats of the scheduled jobs and on EVERY row the field `job` (server: `scheduled/chat-field.js`) —
      // `null` without a job; routes-scheduled.mjs carries both.
      return json(res, 200, [S.chat, ...extraChats, ...scheduledChats()]
        .filter((c) => !S.archive.deleted.has(c.id) && matchesArchive(page, S.archive.chats.has(c.id)))
        .map(withArchive)
        .map(withJob));
    }
    if (path === "/api/chats" && method === "POST") {
      const payload = await body(req);
      S.chatCreateCount += 1;
      if (payload.folderId) S.chat.folderId = payload.folderId;
      S.lastChatCreate = payload;
      return json(res, 201, S.chat);
    }
    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "init", running: S.running ? [chatId] : [] })}\n\n`);
      globalStreams.add(res);
      req.on("close", () => globalStreams.delete(res));
      return;
    }
    if (path === `/api/chats/${chatId}` && method === "GET") return json(res, 200, withArchive(S.chat));
    if (path === `/api/chats/${chatId}` && method === "PATCH") {
      const patch = await body(req);
      // Like the real server: only stages or null (default); anything else is a 400.
      if ("autocompact" in patch && patch.autocompact !== null && !(patch.autocompact === 0 || AUTOCOMPACT_STAGES.includes(Number(patch.autocompact)))) {
        return json(res, 400, { error: "invalid stage" });
      }
      if ("autocompactMax" in patch && patch.autocompactMax !== null && !(patch.autocompactMax === 0 || AUTOCOMPACT_MAX_STAGES.includes(Number(patch.autocompactMax)))) {
        return json(res, 400, { error: "invalid cap" });
      }
      // Like the real server ("Auto" is gone): an empty level is a 400, a missing one means "unchanged".
      if (patch.effort === "") return json(res, 400, { error: "A chat needs an effort level — “Auto” no longer exists." });
      // Ultracode like the real server (chats/routes.js): not a boolean ⇒ 400, missing ⇒ unchanged; on ⇒ the level
      // becomes xhigh, clamped to the model (a level sent along yields to the mode), off ⇒ the level stays. The clamp
      // is a lookup table here: of the fixture models only Haiku 4.5 and Flach 1 carry no xhigh — neither has any level.
      if ("ultracode" in patch && typeof patch.ultracode !== "boolean") return json(res, 400, { error: "ultracode must be true or false." });
      // `goalPaused` (pause button of the goal row) like the server's contract (`targetPauseError`): a boolean, missing
      // ⇒ unchanged, `true` only with a goal; `goal` WITHOUT `goalPaused` undoes the pause, with both both apply.
      const pauseError = targetPauseError(patch, S.chat);
      if (pauseError) return json(res, 400, { error: pauseError });
      // `effortChoice` like the real server: the explicit choice of the level — a boolean, only next to `effort` or
      // `ultracode`; it is no field of the chat row (the server remembers it as `effortOwn`).
      const choiceError = effortChoiceError(patch);
      if (choiceError) return json(res, 400, { error: choiceError });
      S.lastChatPatch = patch;
      const { effortChoice, ...fields } = patch;
      const next = { ...S.chat, ...fields };
      if ("goal" in patch && !("goalPaused" in patch)) next.goalPaused = false;
      if (effortChoice === true) next.effortOwn = true;
      if (patch.ultracode === true) next.effort = ["claude-haiku-4-5-20251001", "flat-1"].includes(next.model) ? "" : "xhigh";
      S.chat = next;
      // Like the server: goal and pause on the chat stream as soon as a PATCH touches one of them — the app
      // takes over both, without a row in the history.
      if ("goal" in patch || "goalPaused" in patch) {
        chatEvent({ type: "harness", subtype: "target", goal: S.chat.goal || "", goalPaused: !!S.chat.goalPaused });
      }
      return json(res, 200, withArchive(S.chat));
    }
    if (path === `/api/chats/${chatId}` && method === "DELETE") {
      // Switch `delete409`: like the server for a running chat.
      if (S.archive.delete409) return json(res, 409, { error: "Chat is running — wait for the agent to finish" });
      return json(res, 200, { ok: true });
    }
    if (path === `/api/chats/${chatId}/log` && method === "GET") {
      if (S.seededHistoryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, S.seededHistoryDelayMs));
      }
      // Including `S.addenda` (seeds.mjs `mainHistory`) — the same list as `/log/delta` and `connected`.
      // `?window=1` (server `chats/log-window.js`, `logWindow`): the app asks only this way and reads the window shape
      // `{ total, lastId, older, rows }`; it cannot read the bare list (APIClient turns the read failure into an APIError,
      // its fallback to the full list never applies). The fixture's histories are below the server window's 300 rows —
      // so all rows, nothing older; nothing is cut here.
      if (url.searchParams.get("window") === "1") {
        const rows = mainHistory();
        json(res, 200, { ...historyStatus(rows), older: false, rows });
      } else {
        json(res, 200, mainHistory());
      }
      // (`POST /fixture/gap`): the row appears RIGHT AFTER this fetch — like a message stored between loading the history
      // and the first `connected`. Open streams get their event like from the server.
      if (S.gapRow) {
        const line = S.gapRow;
        S.gapRow = null;
        S.addenda.push({ ...line, ts: Date.now(), attachments: [] });
        chatEvent({ type: "harness", subtype: "user_message", text: line.text, attachments: [] });
      }
      return;
    }
    // The delta like `contextChatRoutes` on the server — rows AFTER `since`, plus total count and highest id.
    if (path === `/api/chats/${chatId}/log/delta` && method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const rowsValue = mainHistory();
      S.deltaRetrievals += 1;
      return json(res, 200, { ...historyStatus(rowsValue), rows: rowsValue.filter((z) => z.id > since) });
    }
    // Upload like the server (`chats/routes.js`, `sub === "/attachments" && m === "POST"`): body = file, name via `?name=`, 201 with
    // the attachment. Read through `GET /fixture/attachments`.
    if (path === `/api/chats/${chatId}/attachments` && method === "POST") {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const data = Buffer.concat(parts);
      if (!data.length) return json(res, 400, { error: "empty file" });
      const name = String(url.searchParams.get("name") || "file");
      const suffix = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      attachmentUploads.push({ name, size: data.length, header: data.subarray(0, 8).toString("hex"), artifact: url.searchParams.get("artifact") !== "0" });
      return json(res, 201, { name, file: `${Date.now().toString(36)}-${name}`, mime: ATTACHMENT_MIME[suffix] || "application/octet-stream", size: data.length });
    }
    if (path === "/fixture/attachments" && method === "GET") return json(res, 200, { uploads: attachmentUploads });
    if (path === "/fixture/agenda" && method === "POST") {
      agendaTree = ((await body(req)) || {}).tree === true;
      return json(res, 200, { tree: agendaTree });
    }
    // Image attachment of the main chat (`POST /fixture/image`): only after the delay, a PNG in the aspect ratio of `w`/`h`.
    if (path.startsWith(`/api/chats/${chatId}/attachments/`) && method === "GET") {
      const file = decodeURIComponent(path.slice(`/api/chats/${chatId}/attachments/`.length));
      const image = S.imageAttachment;
      if (!image || image.file !== file) return json(res, 404, { error: "Not found" });
      image.retrieved += 1;
      if (image.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, image.delayMs));
      const png = framePng(image.w, image.h);
      image.supplied += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      return res.end(png);
    }
    if (path === `/api/chats/${chatId}/stream` && method === "GET") {
      // A gateway that is just replacing the container answers 503 — the app sees a stream error (a torn stream does NOT:
      // `URLSession` reports it as a clean end). `/fixture/stream-abort { failedAttempts }` or every second connection
      // under `/fixture/stream-flapping`.
      const flapping = S.streamFlapping;
      if (flapping) flapping.times.push(Date.now());
      if (S.streamFailedAttempts > 0 || (flapping && flapping.times.length % 2 === 0)) {
        if (S.streamFailedAttempts > 0) S.streamFailedAttempts -= 1;
        S.streamFailedResponses += 1;
        return json(res, 503, { error: "The container is restarting." });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({
        type: "harness",
        subtype: "connected",
        // The state of the history at connection time — the app reconciles against it.
        ...historyStatus(mainHistory()),
        // The not-yet-stored text of the running turn (`runStreamText` on the server) — only the stream run carries it.
        streamText: S.running ? S.runStreamText : "",
        // Like the server (`length >= RUN_STREAM_MAX`): only a stream run with `cap` truncates.
        streamTextTruncated: Boolean(S.running && S.runStreamCap && S.runStreamText.length >= S.runStreamCap),
        running: S.running,
        waiting: S.waiting,
        monitors: [],
        // A background agent that outlived its turn is in the first event even without a run.
        agents: S.agentAfterRun ? [S.agentAfterRun] : [],
        // Like the real server: the context state of the RUNNING run belongs in the first event,
        // otherwise a re-entry in the middle of the run shows "0".
        contextTokens: S.chat.contextTokens ?? 0,
        queued: publicQueue(),
      })}\n\n`);
      chatStreams.add(res);
      req.on("close", () => { chatStreams.delete(res); S.silentStreams.delete(res); });
      S.streamConnections += 1;
      // `/fixture/stream-flapping`: accepted, then gone right away (alternating with the 503 above), like a gateway
      // replacing the container. The times show how fast the app reconnects.
      if (flapping) setTimeout(() => res.end(), 50);
      return;
    }
    // The effective saved dynamic workflows — for every chat (like the skills route).
    if (/^\/api\/chats\/[0-9a-f-]+\/dyn-workflows$/.test(path) && method === "GET") return json(res, 200, S.dynWorkflows);
    if (path === `/api/chats/${chatId}/message` && method === "POST") {
      const message = await body(req);
      const text = String(message.display || message.text || "").trim();
      // `/name` of a saved dynamic workflow no longer starts anything — the server answers 404 `dyn_slash`, stores nothing
      // and starts no turn.
      const call = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+([\s\S]*))?$/.exec(String(message.text || "").trim());
      const dynWf = call && S.dynWorkflows.find((w) => w.name.toLowerCase() === call[1].toLowerCase());
      if (dynWf) {
        return json(res, 404, { error: `"/${dynWf.name}" is not a command — saved dynamic workflows start from the library or through the model (cbase_dynamic_workflow). Nothing was sent.`, reason: "dyn_slash" });
      }
      // "Parked counts as running": if a run-wait row stands for this chat (parked at the time limit or at the credit
      // gate), the real server puts the message into the queue BEHIND the continuation — no turn, no process, and the
      // answer says `parked: true`. The app must take back its `busy` on that: otherwise the spinner turns for nothing
      // until the reset comes.
      const parkedValue = !S.running && limitWaitFor(chatId)?.kind === "run";
      if (!S.running && !parkedValue) {
        json(res, 202, { ok: true, queued: false, injected: false });
        startFixtureRun(text);
        return;
      }
      const entry = { id: randomUUID(), text };
      S.queue.push(entry);
      chatEvent({ type: "harness", subtype: "message_queue", queued: publicQueue() });
      if (parkedValue) {
        return json(res, 202, { ok: true, queued: true, injected: false, parked: true, position: S.queue.length, queue: publicQueue(), entryId: entry.id });
      }
      return json(res, 202, {
        ok: true,
        queued: true,
        injected: false,
        position: S.queue.length,
        queue: publicQueue(),
      });
    }
    const queueMatch = path.match(new RegExp(`^/api/chats/${chatId}/message/queue/([0-9a-f-]+)$`));
    if (queueMatch && method === "DELETE") {
      S.queue = S.queue.filter((entry) => entry.id !== queueMatch[1]);
      chatEvent({ type: "harness", subtype: "message_queue", queued: publicQueue() });
      return json(res, 200, { ok: true, queue: publicQueue() });
    }
    // "Control": abort the run and send the whole queue as ONE run.
    // The fixture replicates what is observable — run ends, queue empty, the rows
    // are in the history.
    if (path === `/api/chats/${chatId}/control` && method === "POST") {
      const withQueue = S.queue.slice();
      if (!withQueue.length) return json(res, 409, { error: "no queued message" });
      S.queue = [];
      clearRun();
      chatEvent({ type: "harness", subtype: "run_aborted" });
      chatEvent({ type: "harness", subtype: "message_queue", queued: publicQueue() });
      for (const e of using) chatEvent({ type: "harness", subtype: "user_message", text: e.text, attachments: [] });
      globalEvent({ type: "run", chatId, running: false, answered: true });
      return json(res, 200, { ok: true, sent: withQueue.length, queue: publicQueue() });
    }
    if (path === `/api/chats/${chatId}/stop` && method === "POST") {
      clearRun();
      S.queue = [];
      chatEvent({ type: "harness", subtype: "run_aborted" });
      globalEvent({ type: "run", chatId, running: false, answered: true });
      return json(res, 200, { ok: true });
    }
    if (path === `/api/chats/${chatId}/compact` && method === "POST") {
      return json(res, 200, { ok: false, note: "Fixture history stays unchanged." });
    }
    // The decision on a dynamic workflow's approval card — like the server (dynworkflows/run.js decideApproval): both
    // fields required (400), a card is decided exactly once (409), the decision goes out live as
    // `workflow_approval_decided` (under `ruling`). Before the catch-all.
    if (path === `/api/chats/${chatId}/dyn-workflows/approval` && method === "POST") {
      const request = (await body(req)) || {};
      const word = { accept: "accepted", reject: "rejected" }[request.decision];
      if (typeof request.requestId !== "string" || !request.requestId || typeof word !== "string") {
        return json(res, 400, { error: "Fields \"requestId\" and \"decision\" (accept | reject) are required." });
      }
      if (!S.workflowApproval) return json(res, 404, { error: "No such approval card in this chat." });
      S.workflowApproval.requests.push(request);
      const priorValue = S.workflowApproval.decide[request.requestId];
      if (priorValue) return json(res, 409, { reason: "decided", decision: priorValue, error: "This card has already been decided." });
      S.workflowApproval.decide[request.requestId] = word;
      const rulingValue = { requestId: request.requestId, decision: word, at: Date.now() };
      chatEvent({ type: "harness", subtype: "workflow_approval_decided", ruling: rulingValue });
      return json(res, 200, { ok: true, ...rulingValue });
    }
    // The progress tree (state.mjs `S.dynTree`) — like the server (dynworkflows/routes.js): the route answers for EVERY
    // chat (without a seed and outside the fixture chat with an empty list — "no workflow"), transcript and human stop
    // only in the fixture chat. The stop requires `from` (human | agent, otherwise 400, like stopDynWorkflow), sets the
    // run to "stopped" together with its running and waiting agents and reports the new state live as `dynwf_tree`. Every
    // stop request is in `S.dynTree.stops` with run id and body. Plus skip and restart per agent
    // (`S.dynTree.interventions`). Before the catch-all.
    {
      if (/^\/api\/chats\/[0-9a-f-]+\/dyn-workflows\/tree$/.test(path) && method === "GET") {
        const ownValueOf = path === `/api/chats/${chatId}/dyn-workflows/tree`;
        return json(res, 200, ownValueOf && S.dynTree ? { runs: S.dynTree.runs, additional: S.dynTree.additional ?? 0 } : { runs: [], additional: 0 });
      }
      const transcript = path.match(/^\/api\/chats\/([0-9a-f-]+)\/dyn-workflows\/runs\/([^/]+)\/agents\/(\d+)$/);
      if (transcript && method === "GET") {
        const runValue = transcript[1] === chatId && S.dynTree?.runs.find((l) => l.runId === decodeURIComponent(transcript[2]));
        if (!runValue) return json(res, 404, { error: "No dynamic workflow with this id in this chat." });
        const n = Number(transcript[3]);
        return json(res, 200, { runId: runValue.runId, n, rows: S.dynTree.transcripts[`${runValue.runId}#${n}`] || [] });
      }
      const stopFlag = path.match(/^\/api\/chats\/([0-9a-f-]+)\/dyn-workflows\/runs\/([^/]+)\/stop$/);
      if (stopFlag && method === "POST") {
        const request = (await body(req)) || {};
        const runId = decodeURIComponent(stopFlag[2]);
        if (S.dynTree) S.dynTree.stops.push({ runId, ...request });
        if (request.from !== "human" && request.from !== "agent") return json(res, 400, { error: "Field \"from\" is missing (human | agent)." });
        const i = stopFlag[1] === chatId && S.dynTree ? S.dynTree.runs.findIndex((l) => l.runId === runId) : -1;
        if (i < 0) return json(res, 404, { error: "No dynamic workflow with this id in this chat." });
        const old = S.dynTree.runs[i];
        if (old.status !== "running") return json(res, 200, { ok: true, runId, status: old.status, running: false, stoppedOf: old.stoppedOf || null });
        const added = {
          ...old, status: "stopped", stoppedOf: request.from, endedAt: Date.now(),
          // Like agentState on the server: without a result in the stopped run it reads "stopped" (a reason applies only while waiting).
          agents: old.agents.map((a) => {
            if (a.status !== "running" && a.status !== "waiting") return a;
            const { reason: _reason, cap: _cap, ...rest } = a;
            return { ...rest, status: "stopped" };
          }),
        };
        S.dynTree.runs[i] = added;
        chatEvent({ type: "harness", subtype: "dynwf_tree", tree: added });
        return json(res, 200, { ok: true, runId, status: "stopped", running: false, stoppedOf: request.from });
      }
      // Skip and restart of ONE workflow agent — like the server (run.js skipDynAgent / restartDynAgent): only in a running
      // run (otherwise 409 "run-closed"), only on a started, running or parked agent (otherwise 409). Skipping sets it to
      // "skipped", restart counts `restarts` up; both live as `dynwf_tree`. Every request is in `S.dynTree.interventions`.
      const agentAction = path.match(/^\/api\/chats\/([0-9a-f-]+)\/dyn-workflows\/runs\/([^/]+)\/agents\/(\d+)\/(skip|restart)$/);
      if (agentAction && method === "POST") {
        const runId = decodeURIComponent(agentAction[2]);
        const n = Number(agentAction[3]);
        const turnKind = agentAction[4];
        if (S.dynTree) S.dynTree.interventions.push({ runId, n, kind: turnKind });
        const i = agentAction[1] === chatId && S.dynTree ? S.dynTree.runs.findIndex((l) => l.runId === runId) : -1;
        if (i < 0) return json(res, 404, { error: "No dynamic workflow with this id in this chat." });
        const old = S.dynTree.runs[i];
        if (old.status !== "running") return json(res, 409, { reason: "run-closed", error: "The workflow is no longer running." });
        const a = old.agents.find((x) => x.n === n);
        const allowed = a && a.agentId && (turnKind === "restart" ? a.status === "running" : a.status === "running" || a.status === "waiting");
        if (!allowed) return json(res, 409, { reason: "agent-closed", error: `Agent ${n} is not running.` });
        const added = { ...old, agents: old.agents.map((x) => (x.n !== n ? x
          : turnKind === "restart" ? { ...x, restarts: (x.restarts || 0) + 1 }
            : (({ reason: _g, cap: _d, ...rest }) => ({ ...rest, status: "skipped" }))(x))) };
        S.dynTree.runs[i] = added;
        chatEvent({ type: "harness", subtype: "dynwf_tree", tree: added });
        return json(res, 200, turnKind === "restart" ? { ok: true, runId, n, agentId: a.agentId, restart: true } : { ok: true, runId, n, agentId: a.agentId, status: "skipped" });
      }
    }

    // The fixture chat's graph-workflow starts (state.mjs `S.graphRuns`) — like the server (workflows/graph-routes.js): the
    // list answers for EVERY chat (empty outside the fixture chat), newest first. The stop takes `from` (human | agent,
    // missing = human, otherwise 400 `reason: "from"`); an unknown start is 404 `unknown`, an earmarked or waiting one
    // becomes "stopped" (answer `{ run }` AND live as `graph_run`), any other is 409 `to_end`. Before the catch-all.
    {
      if (/^\/api\/chats\/[0-9a-f-]+\/graph-workflows$/.test(path) && method === "GET") {
        const ownValueOf = path === `/api/chats/${chatId}/graph-workflows`;
        const runsValue = ownValueOf ? [...S.graphRuns.runs].sort((a, b) => b.startedAt - a.startedAt) : [];
        return json(res, 200, { runs: runsValue });
      }
      const stopFlag = path.match(/^\/api\/chats\/([0-9a-f-]+)\/graph-workflows\/([^/]+)\/stop$/);
      if (stopFlag && method === "POST") {
        const request = (await body(req)) || {};
        const startId = decodeURIComponent(stopFlag[2]);
        S.graphRuns.stops.push({ startId, ...request });
        if (request.from !== undefined && request.from !== "human" && request.from !== "agent") {
          return json(res, 400, { error: "from must be \"agent\" or \"human\".", reason: "from" });
        }
        const i = stopFlag[1] === chatId ? S.graphRuns.runs.findIndex((l) => l.startId === startId) : -1;
        if (i < 0) return json(res, 404, { error: `There is no graph workflow start "${startId}" in this chat.`, reason: "unknown" });
        const old = S.graphRuns.runs[i];
        if (!["earmarked", "waiting_lock", "waiting_storage"].includes(old.state)) {
          return json(res, 409, { error: `"${old.name}" has already ended — nothing to stop.`, reason: "to_end" });
        }
        const nowValue = Date.now();
        const added = { ...old, state: "stopped", stoppedOf: request.from ?? "human", updatedAt: nowValue, endedAt: nowValue };
        S.graphRuns.runs[i] = added;
        chatEvent({ type: "harness", subtype: "graph_run", run: added });
        return json(res, 200, { run: added });
      }
    }

    // The agenda per coding chat: every chat answers with an EMPTY agenda in the server's shape (agenda/routes.js,
    // `agendaResponse`) — the app loads it at every stream connection, and without the route there would be a 404 instead
    // of "no agenda yet". No writing (the app never writes). Before the catch-all. After `POST /fixture/agenda { tree: true }`
    // the main chat carries a tree agenda (`agendaTreeOf`, see above).
    {
      const agenda = path.match(/^\/api\/chats\/([0-9a-f-]+)\/agenda$/);
      if (agenda && method === "GET" && agendaTree && agenda[1] === chatId) {
        return json(res, 200, { agenda: agendaTreeOf(chatId), keepsAgenda: true });
      }
      if (agenda && method === "GET") {
        return json(res, 200, {
          agenda: { chatId: agenda[1], title: "", description: "", steps: [], version: 0, changedAt: null, counter: { open: 0, in_work: 0, done: 0 }, archived: 0 },
          keepsAgenda: true,
        });
      }
    }

    // The two extra chats (search/sort/filter) are deliberately empty: if a test opens them anyway,
    // the app should see an empty history instead of a 404 error band.
    // ── Channels: lists, single view, control actions ──
    if (path === `/api/workspaces/${workspaceId}/channels` && method === "GET") {
      return json(res, 200, { items: S.channel ? [channelView(S.channel)] : [] });
    }
    const channelChatMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)\/channels$/);
    if (channelChatMatch && method === "GET") {
      const ownOnes = S.channel && S.channel.participants.some((t) => t.chatId === channelChatMatch[1]) ? [S.channel] : [];
      return json(res, 200, { channels: ownOnes.map((k) => ({ ...channelView(k), unread: 0 })) });
    }
    const channelMatch = path.match(/^\/api\/channels\/([0-9a-f-]+)(\/messages|\/pause|\/resume|\/close|\/read)?$/);
    if (channelMatch) {
      if (!S.channel || S.channel.id !== channelMatch[1]) return json(res, 404, { error: "kanal not found" });
      const sub = channelMatch[2] || "";
      if (!sub && method === "GET") return json(res, 200, channelView(S.channel, { messages: true }));
      if (!sub && method === "PATCH") {
        const request = await body(req);
        if (typeof request.cap === "number") S.channel.cap = Math.max(0, Math.min(1000, Math.floor(request.cap)));
        if (typeof request.name === "string" && request.name.trim()) S.channel.name = request.name.trim();
        return json(res, 200, channelView(S.channel));
      }
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const request = await body(req);
      if (sub === "/read") {
        S.channel.readSeq = Math.max(S.channel.readSeq, Math.min(Number(request.seq) || 0, S.channel.lastSeq));
        return json(res, 200, channelView(S.channel));
      }
      if (sub === "/pause") {
        if (S.channel.status === "open") { S.channel.status = "paused"; channelSystem(S.channel, "pause", "Der Nutzer hat den Kanal pausiert."); }
        return json(res, 200, channelView(S.channel));
      }
      if (sub === "/resume") {
        if (S.channel.status === "paused") {
          S.channel.status = "open";
          if (Number(request.rounds) > 0) S.channel.cap = Number(request.rounds);
          S.channel.agentsSinceHuman = 0;
          channelSystem(S.channel, "resumed", "Der Nutzer hat den Kanal fortgesetzt.");
        }
        return json(res, 200, channelView(S.channel));
      }
      if (sub === "/close") {
        if (S.channel.status !== "closed") { S.channel.status = "closed"; channelSystem(S.channel, "closed", "Der Nutzer hat den Kanal geschlossen."); }
        return json(res, 200, channelView(S.channel));
      }
      if (sub === "/messages") {
        S.channel.lastSeq += 1;
        const m = { messageId: S.channel.lastSeq, seq: S.channel.lastSeq, sender: { kind: "chat", chatId, name: "Queue-Test" }, systemKind: "", text: String(request.text || ""), files: [], at: Date.now() };
        S.channel.messages.push(m);
        return json(res, 201, { seq: m.seq });
      }
    }

    // ── Archive of a chat ──
    // Pre-check and toggle like `archiveChatRoutes` on the server: 409 with the reasons, the question as the ONLY reason
    // may be dismissed with `dismissQuestion`, a chat from an archived folder brings the folder back with it (the other
    // chats stay in the archive), and the `chat_archive` event.
    const archiveMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)\/archive$/);
    if (archiveMatch && (method === "GET" || method === "PUT")) {
      const id = archiveMatch[1];
      const entry = [S.chat, ...extraChats].find((c) => c.id === id);
      if (!entry || S.archive.deleted.has(id)) return json(res, 404, { error: "chat not found" });
      const turnKind = "normal";
      const response = () => withArchive(entry);
      if (method === "GET") {
        return json(res, 200, {
          archived: S.archive.chats.has(id), archivedAt: S.archive.chats.get(id) ?? null,
          open: archiveOpen(id), terminals: S.archive.shells,
        });
      }
      const b = await body(req);
      if (typeof b.archived !== "boolean") return json(res, 400, { error: "archived (true/false) required" });
      if ("dismissQuestion" in b && typeof b.dismissQuestion !== "boolean") {
        return json(res, 400, { error: "dismissQuestion must be true or false" });
      }
      if (b.archived === S.archive.chats.has(id)) return json(res, 200, { ok: true, unchanged: true, chat: response() });
      if (!b.archived) {
        S.archive.chats.delete(id);
        S.archive.withFolder.delete(id);
        const folderIds = entry.folderId && S.archive.folder.has(entry.folderId) ? [entry.folderId] : [];
        for (const f of folderIds) S.archive.folder.delete(f);
        globalEvent({ type: "chat_archive", workspaceId, kind: turnKind, chatIds: [id], folderIds, archived: false, reason: "user" });
        return json(res, 200, { ok: true, chat: response(), folderIds, terminalsEnded: 0 });
      }
      const opened = archiveOpen(id);
      if (opened.length) {
        const onlyQuestion = opened.length === 1 && opened[0].reason === "question";
        if (!(b.dismissQuestion === true && onlyQuestion)) {
          return json(res, 409, { error: "Work is still open in this chat — not archived", open: opened });
        }
        // The card is dismissed — the pre-check reports nothing afterwards.
        S.archive.open = null;
        S.archive.dismissed += 1;
      }
      S.archive.chats.set(id, Date.now());
      const terminalsEnded = S.archive.shells;
      globalEvent({ type: "chat_archive", workspaceId, kind: turnKind, chatIds: [id], folderIds: [], archived: true, reason: "user" });
      return json(res, 200, { ok: true, chat: response(), folderIds: [], terminalsEnded });
    }

    const extraMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)(\/log|\/stream)?$/);
    if (extraMatch && extraChats.some((entry) => entry.id === extraMatch[1])) {
      const entry = extraChats.find((item) => item.id === extraMatch[1]);
      if (extraMatch[2] === "/log") return json(res, 200, url.searchParams.get("window") === "1" ? { total: 0, lastId: 0, older: false, rows: [] } : []);
      if (extraMatch[2] === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        // The extra chats' history is empty — `lastId` 0, `total` 0.
        res.write(`data: ${JSON.stringify({ type: "harness", subtype: "connected", lastId: 0, total: 0, running: false, waiting: false, monitors: [], queued: [] })}\n\n`);
        return;
      }
      if (S.archive.deleted.has(entry.id)) return json(res, 404, { error: "chat not found" });
      if (method === "GET") return json(res, 200, withArchive(entry));
      // Folder assignment changes on the extra chats too — otherwise the folder test would
      // run only on the main chat.
      if (method === "PATCH" && !extraMatch[2]) {
        const patch = await body(req);
        if (patch.effort === "") return json(res, 400, { error: "A chat needs an effort level — “Auto” no longer exists." });
        const pauseError = targetPauseError(patch, entry);
        if (pauseError) return json(res, 400, { error: pauseError });
        const choiceError = effortChoiceError(patch);
        if (choiceError) return json(res, 400, { error: choiceError });
        const { effortChoice, ...fields } = patch;
        Object.assign(entry, fields);
        // Like on the main chat: `goal` without `goalPaused` undoes the pause, with both both apply.
        if ("goal" in patch && !("goalPaused" in patch)) entry.goalPaused = false;
        if (effortChoice === true) entry.effortOwn = true;
        return json(res, 200, withArchive(entry));
      }
      // Deleting: remembered instead of removed from the shared constant; `reset-run` brings it back.
      if (method === "DELETE" && !extraMatch[2]) {
        if (S.archive.delete409) return json(res, 409, { error: "Chat is running — wait for the agent to finish" });
        S.archive.deleted.add(entry.id);
        return json(res, 200, { ok: true });
      }
    }
    return NEXT;
}

/// `goalPaused` in PATCH /api/chats/:id — wording and rule of the server (chats/routes.js): missing ⇒ nothing; otherwise a
/// boolean, and `true` only with a goal that is not empty AFTER the PATCH (the one sent counts, otherwise the stored one).
/// Checked before any write.
function targetPauseError(patch, chat) {
  if (!("goalPaused" in patch)) return "";
  if (typeof patch.goalPaused !== "boolean") return "goalPaused is true or false.";
  const targetValue = typeof patch.goal === "string" ? patch.goal : chat.goal;
  if (patch.goalPaused && !String(targetValue || "").trim()) return "There is no goal to pause.";
  return "";
}

/// `effortChoice` in PATCH /api/chats/:id — the same rule as the server (chats/routes.js): missing ⇒ nothing; otherwise a boolean,
/// and `true` only next to `effort` or `ultracode`. A PATCH with a valid `effortChoice` is NOT a 400 (the app sends it on every
/// explicit path: `/effort`, Ultracode, the chat sheet's effort selection).
function effortChoiceError(patch) {
  if (!("effortChoice" in patch)) return "";
  if (typeof patch.effortChoice !== "boolean") return "effortChoice must be true or false.";
  if (patch.effortChoice && !("effort" in patch) && !("ultracode" in patch)) return "effortChoice applies only next to effort or ultracode.";
  return "";
}
