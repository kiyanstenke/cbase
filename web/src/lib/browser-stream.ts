// The pure rules of the streamed browser: the loop breaker and the ack channel. No DOM and no React, so
// `web/test/browser-stream.test.mjs` can check them without a browser; BrowserPane recomputes none of it, it calls in here.
//
// The incident: after closing the LAST tab the session lived on without a tab, the stream said “gone”, the pane called ensure(), ensure
// found the SAME session, the next stream said “gone” again: the endless “reload tab” loop. The server now creates replacement tabs
// (browsers.js, saveTab); this module is the second half: even if the server does not cooperate, “gone” may trigger ensure() at most
// ONCE per incident. An incident ends with the first FRAME (the browser delivers a picture again) or with the click on “Start
// browser”, not with “hello”: if Chromium dies after the CDP connect, the viewer sees “hello” and then “gone”, never a frame, and a
// reset on “hello” would count every round from scratch: a start loop with one Chromium start per second.

/** The state: how many “gone” have arrived since the last frame (or the last click). */
export type GoneState = number;

export const GONE_STATE_START: GoneState = 0;

/** Advance by one stream event: “gone” counts up, a frame resets. */
export function countGone(state: GoneState, event: "frame" | "gone"): GoneState {
  if (event === "gone") return state + 1;
  return GONE_STATE_START;
}

/** Whether the pane may call ensure() by itself after this state: only after the FIRST “gone” in a row. From the second on it shows
 *  “Browser was terminated.” with the button: the human decides. */
export function ensureAfterGone(state: GoneState): boolean {
  return state <= 1;
}

// ── The ack channel ───────────────────────────────────────────────────────────────────────────
// The server keeps a window of unacknowledged frames per viewer (browsers.js, ackWindow) and releases credit only on the receipt. The
// receipt used to ride in the input POST, serialized behind mouse and keyboard so events do not overtake each other. Measured: that
// sent ONE receipt per round trip and released ONE frame: fps ≈ 1/RTT, 2 fps over Cloudflare. For receipts the order does not matter
// (seq is monotonic, the server takes the maximum), so they get their own channel: at most one POST in flight, always only the NEWEST
// seq (folding), after the return the then newest.
//
// And the receipt waits for the BURST: “immediately when the channel is free” acknowledged the FIRST frame of a burst alone; the rest
// arrived while the POST ran and their receipt went only after its return. Two round trips per window, measured 16.8 fps at 150 and
// at 300 ms, where the window (5 resp. 9) would carry 30. So the receipt goes ACK_BUNDLE_MS after the LAST received frame (a burst
// arrives ≈ 16 ms apart, the deadline only expires after its end), but at the latest ACK_AT_LATEST_MS after the FIRST unacknowledged
// one, otherwise a continuous 60 fps stream would never acknowledge. The price sits in the server: its RTT measurement now includes
// up to ACK_AT_LATEST_MS of client wait, and the window covers it. The clock comes from outside (now) so the rule stays checkable
// without Date.now.

/** After the last received frame: the receipt waits this long for another. */
export const ACK_BUNDLE_MS = 20;
/** After the first unacknowledged frame: the receipt goes at the latest then, burst or not. */
export const ACK_AT_LATEST_MS = 50;

/** The channel state: the newest received seq, the last one sent, whether a POST is running, the time of the first unacknowledged
 *  frame (null: nothing open) and that of the last received one. */
export type AckChannel = { newest: number; sent: number; inFlight: boolean; firstOpen: number | null; lastFrame: number | null };

export const ACK_CHANNEL_START: AckChannel = { newest: 0, sent: 0, inFlight: false, firstOpen: null, lastFrame: null };

/** A new viewer (hello): seq counts from scratch. A POST still in flight stays so: only its return frees the channel, otherwise two
 *  receipts would briefly run side by side. */
export function ackNewViewer(k: AckChannel): AckChannel {
  return { ...ACK_CHANNEL_START, inFlight: k.inFlight };
}

/** A frame has arrived (at time now): only the newest seq counts (a later frame acknowledges all before it); it is the last received
 *  one and, if nothing was open, the first unacknowledged. */
export function rememberAck(k: AckChannel, seq: number, now: number): AckChannel {
  if (seq <= k.newest) return k;
  return { ...k, newest: seq, lastFrame: now, firstOpen: k.firstOpen ?? now };
}

/** When the next receipt is due (time): ACK_BUNDLE_MS after the last frame, at the latest ACK_AT_LATEST_MS after the first
 *  unacknowledged one; or null: a POST is in flight, or there is nothing new. If the time lies in the past (the frames arrived while
 *  the POST ran), it is NOW. */
export function ackDueFrom(k: AckChannel): number | null {
  if (k.inFlight || k.newest <= k.sent || k.firstOpen === null || k.lastFrame === null) return null;
  return Math.min(k.lastFrame + ACK_BUNDLE_MS, k.firstOpen + ACK_AT_LATEST_MS);
}

/** What goes out NOW: the newest seq if the receipt is due, else nothing (null; when it becomes due, ackDueFrom says). The caller
 *  sends it and calls ackSent. */
export function ackDue(k: AckChannel, now: number): number | null {
  const from = ackDueFrom(k);
  return from !== null && from <= now ? k.newest : null;
}

/** What goes out when waiting gains nothing: the newest seq as soon as the channel is free and something new is there; the deadlines
 *  do not count. For the HIDDEN tab (measured in the built-in Chromium): there the browser aligns setTimeout to full seconds (20 ms ⇒
 *  925–1077 ms, 21 in the visible tab), the bundled receipt would come up to 1 s late, and the server would read the BASE RTT from it:
 *  ackWindow(1000) = 24, on a narrow link a 3 s queue that stands after the return until the next probe (ten seconds). The browser does
 *  not throttle fetch; so the receipt goes at once there, as before the bundling. */
export function ackWithoutWait(k: AckChannel): number | null {
  return ackDueFrom(k) === null ? null : k.newest;
}

/** The POST with this seq is in flight; nothing is open until then. */
export function ackSent(k: AckChannel, seq: number): AckChannel {
  return { ...k, sent: seq, inFlight: true, firstOpen: null };
}

/** The POST is back (success or error: both free the channel; a lost ack is caught by the server's credit reset). */
export function ackBack(k: AckChannel): AckChannel {
  return { ...k, inFlight: false };
}

// ── The browser of a chat ─────────────────────────────────────────────────────────────────────────────────────────────
// A pane's TARGET is its apiBase together with the chat; when it changes, BrowserPane resets everything (session, tabs, selection,
// picture) and discards an answer from ensure() that was in flight for the OLD target, otherwise it would put the old chat's session
// into the new chat's pane.

/** The key of a pane's target. */
export function ensureTarget(apiBase: string | undefined, chatId: string | null | undefined): string {
  return `${apiBase || ""}\n${chatId || ""}`;
}

/** Does the answer of an ensure() still apply, i.e. is the target it was fetched for still the pane's? */
export function responseApplies(asked: string, now: string): boolean {
  return asked === now;
}

// The tab choice in a chat's browser: human and main agent work in the same browser there. The view NEVER jumps to the agent's tab by
// itself: it is only marked (`agent` on the tab list), the human switches by click. The one exception: if no tab is chosen at all (the
// bar freshly opened) and the agent is working (`agentTab` set; the server sets it on a chat's browser only while a turn holds it), it
// takes the agent's. The viewer of an agent browser (`fixed`: subagent, workflow; no human works there) keeps following the agent.

/** The tab after `hello`: the human's choice stays; without a choice, on a chat's browser the working agent's, else the active one. */
export function tabAfterHello(a: { sel: string; tab: string; agentTab: string; fixed: boolean }): string {
  if (a.sel) return a.sel;
  if (!a.fixed && a.agentTab) return a.agentTab;
  return a.tab;
}

/** The tab after a `tabs` event, or null (the selection stays). Only an agent viewer follows a NEW tab of the agent. */
export function tabAfterTabs(a: { sel: string; agentTab: string; prior: string; fixed: boolean }): string | null {
  if (!a.fixed || !a.agentTab || a.agentTab === a.prior) return null;
  return a.agentTab === a.sel ? null : a.agentTab;
}

// ── The input queue ─────────────────────────────────────────────────────────────────────────────────────────────────
// Inputs go strictly one after the other (one POST in flight, otherwise mouseReleased overtakes mousePressed). What accumulates while
// one is in flight is folded: a hover replaces the previous one (only the last position counts), a wheel adds its deltas to the previous
// wheel (the distance counts, not the number of events; position = the last). Everything else (click, key, text) stays single and in
// order.

/** An event of the queue (the fields the folding reads; the rest travels along). */
export type Input = { t?: string; type?: string; x?: number; y?: number; deltaX?: number; deltaY?: number; [k: string]: unknown };

/** The queue after the new event e: a new list, the old one stays unchanged. */
export function foldInput(q: readonly Input[], e: Input): Input[] {
  const last = q[q.length - 1];
  if (e.type === "mouseMoved" && last?.type === "mouseMoved") return [...q.slice(0, -1), e];
  if (e.type === "mouseWheel" && last?.type === "mouseWheel") {
    return [...q.slice(0, -1), { ...last, deltaX: (last.deltaX || 0) + (e.deltaX || 0), deltaY: (last.deltaY || 0) + (e.deltaY || 0), x: e.x, y: e.y }];
  }
  return [...q, e];
}
