// Show captures at the end of the turn: what the agent captures with cbase_screenshot or cbase_recording_start/_stop appears
// in the chat when the turn ends. Subscriber of the hook "beforeRunBroadcast" (registered in server.js): it fires in the
// finally of doRun on EVERY exit, after the agent's last message and before `running: false` — so the cards come after the
// last answer of the turn.
//
// What is shown is decided by the manifest (captures.js toShow): marked to show (main agent and subagents of the chat), not
// sent, showable. Hence no turn clock: a subagent's capture that finishes AFTER the turn end waits for the chat's next turn
// end — usually that of the completion notice the subagent itself triggers. Never twice: markSent throws the second time
// (409), and showCaptures runs without await, so two turn ends cannot interleave.
//
// A running capture of the MAIN AGENT ends with its turn (captures.js endCaptureAtTurnEnd) and is shown with the rest —
// nobody drives the browser anymore, and the video only exists once it ends. Encoding can take a while (ffmpeg); the cards
// then arrive shortly after `running: false`.
//
// Cap: CAPTURES_PER_TURN cards expanded; every further one still goes out, but with `collapsed: true` — web and iOS show it
// as a narrow row that opens on tap. Nothing is lost, and a turn with 20 screenshots does not bury the history.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice } from "../services.js";
import { sse } from "../runtime/sse.js";
import { endCaptureAtTurnEnd, markSent, toShow } from "../captures.js";

export const CAPTURES_PER_TURN = 6;

// Persist a capture as a message (the card survives reload/restart) and report it live — the same pattern as postAsk,
// only without an open question.
function postCaptureMessage(chatId, capture, { collapsed = false } = {}) {
  const payload = {
    captureId: capture.id, kind: capture.kind, caption: capture.caption || "",
    poster: capture.poster, video: capture.video, w: capture.w, h: capture.h,
    durationMs: capture.durationMs, url: capture.url, title: capture.title,
    ...(collapsed ? { collapsed: true } : {}),
  };
  store.addMessage(chatId, "capture", JSON.stringify(payload));
  sse(chatId, { type: "harness", subtype: "capture_message", ...payload });
  return payload;
}

/** Send all captures of the chat still to be shown as cards, in capture order; synchronous. → number sent. */
export function showCaptures(chatId) {
  let n = 0;
  for (const c of toShow(chatId)) {
    let m;
    try { m = markSent(chatId, c.id); } catch { continue; } // already sent (409) or gone (404): nothing to show
    postCaptureMessage(chatId, m, { collapsed: n >= CAPTURES_PER_TURN });
    n++;
  }
  if (n) {
    // ONE notice per turn instead of one per card.
    const chat = store.getChat(chatId);
    recordNotice({
      kind: "info",
      title: T`Capture: ${chat?.title || "cbase"}`,
      chatTitle: chat?.title || "",
      body: n === 1 ? T("1 capture in the chat") : T`${n} captures in the chat`,
      chatId,
      workspaceId: chat?.workspaceId || null,
      projectId: chat?.projectId || null,
    });
  }
  return n;
}

/** Hook "beforeRunBroadcast": end the main agent's running capture, then show. */
export async function capturesShowHook({ chat } = {}) {
  if (!chat?.id) return;
  try { await endCaptureAtTurnEnd(String(chat.id)); } catch (e) { console.error("[captures] capture not ended:", chat.id, e?.message || e); }
  showCaptures(String(chat.id));
}
