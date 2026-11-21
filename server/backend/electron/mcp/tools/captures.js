// MCP tools: recordings of the agent's own chat browser (cbase_screenshot, recording_start/stop). They are shown by themselves at
// the end of the turn (server/chats/captures-show.js).
// One contiguous slice of the tool array, in source order: cbase-mcp.js spreads the groups back together into TOOLS; the order
// is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import process from "node:process";
import { CAPTURE_HINT, api, captureProfileKey, enc, int, needChat, obj, str } from "../lib.js";

const captureTools = [
  // ── Recordings: screenshots/screen videos of the OWN chat browser ──────
  // The server finds the browser through the Playwright profile: main agent = chatId, subagent = own key (CBASE_PROFILE_KEY).
  // CBASE_VISION=0 means the provider of this run cannot see images; the tools then answer in plain text instead of pushing MCP
  // image blocks through a CLI that does not understand them.
  {
    name: "cbase_screenshot",
    description: "Shows the user a screenshot of your own chat browser in the chat; use it only if the user should see the result. The capture appears by itself as a card in the chat, at the end of your turn after your last message (in capture order; collapsed from the seventh per turn). To check your own work use browser_take_screenshot, which never reaches the chat. You also get the image back yourself; the capture runs over a second CDP connection and does not disturb Playwright. Prerequisite: an open page (e.g. via browser_navigate).",
    inputSchema: obj({
      tab: str("Which tab: 1-based index or URL/title substring (empty = active tab)"),
      caption: str("Optional caption under the card: what the user sees"),
      show: { type: "boolean", description: "false = do NOT show in the chat (failed, only for you); stays in the folder. Default true" },
    }),
    handler: async (a) => {
      const chatId = needChat();
      const r = await api("POST", `/api/chats/${enc(chatId)}/captures`, { profileKey: captureProfileKey(), tab: a.tab || "", caption: a.caption || "", ...(a.show === false ? { show: false } : {}) });
      const info = { captureId: r.capture.id, w: r.capture.w, h: r.capture.h, url: r.capture.url, title: r.capture.title, hint: CAPTURE_HINT };
      if (process.env.CBASE_VISION === "0") return { ...info, note: "This provider cannot see images; the screenshot is saved and appears in the chat at the end of the turn." };
      return { __content: [{ type: "image", data: r.data, mimeType: "image/jpeg" }, { type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  },
  {
    name: "cbase_recording_start",
    description: "Starts a screen video (MP4) of your own chat browser that the user should see in the chat, for flows a screenshot does not show. Use it only if the user should see the result: the video appears by itself as a card in the chat, at the end of your turn after your last message; to check your own work use browser_take_screenshot. Afterwards you perform the steps to be shown (e.g. with the playwright tools) and finish with cbase_recording_stop; if the recording is still running at the end of the turn, it ends there. At most ONE recording at a time; after maxSeconds it stops by itself. Prerequisite: an open page and ffmpeg on the server.",
    inputSchema: obj({
      tab: str("Which tab: 1-based index or URL/title substring (empty = active tab)"),
      fps: int("Frames per second, 1-8 (default 4)"),
      maxSeconds: int("Auto-stop after this many seconds, max 300 (default 120)"),
    }),
    handler: async (a) => {
      const chatId = needChat();
      const r = await api("POST", `/api/chats/${enc(chatId)}/captures/record`, { action: "start", profileKey: captureProfileKey(), tab: a.tab || "", fps: a.fps, maxSeconds: a.maxSeconds });
      return { ...r.recording, note: "Recording is running. Now perform the steps to be shown and finish with cbase_recording_stop." };
    },
  },
  {
    name: "cbase_recording_stop",
    description: "Ends the running screen recording of this chat and creates the MP4 the user sees in the chat at the end of your turn. The video appears by itself as a card after your last message; you get back up to 4 evenly spaced check frames as images. To check your own work use browser_take_screenshot, not this recording.",
    inputSchema: obj({
      caption: str("Optional caption under the card: what the user sees in the video"),
      show: { type: "boolean", description: "false = do NOT show in the chat (failed, only for you); stays in the folder. Default true" },
    }),
    handler: async (a) => {
      const chatId = needChat();
      const r = await api("POST", `/api/chats/${enc(chatId)}/captures/record`, { action: "stop", profileKey: captureProfileKey(), caption: a.caption || "", ...(a.show === false ? { show: false } : {}) });
      const c = r.capture || {};
      const info = { captureId: c.id, durationMs: c.durationMs, frames: c.frames, bytes: c.bytes, autoStopped: c.autoStopped, video: !!c.video, ...(c.error ? { error: c.error } : {}), hint: CAPTURE_HINT };
      const samples = Array.isArray(r.samples) ? r.samples : [];
      if (process.env.CBASE_VISION === "0" || !samples.length) return info;
      return { __content: [...samples.map((s) => ({ type: "image", data: s.data, mimeType: "image/jpeg" })), { type: "text", text: JSON.stringify({ ...info, samplesNote: `The ${samples.length} images are evenly spaced check frames of the recording (timestamps ms: ${samples.map((s) => s.ts).join(", ")}).` }, null, 2) }] };
    },
  },
];

export { captureTools };
