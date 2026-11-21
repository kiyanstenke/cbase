// The protocol of the terminal stream (`GET /api/terminal/:id/stream`): offset instead of full replay. A leaf without imports —
// `terminal.js` computes with it, and the iOS fixture (`mobile/test-fixtures/chat-gateway/`) models the server with the SAME
// functions instead of rewriting them.
//
// The incident, measured in the user container: an IDLE terminal showed hundreds of prompts in a row. The stream had no
// heartbeat, Cloudflare cut the silent connection after ≈ 100 s, the browser's EventSource reconnected by itself — and every new
// subscription got the WHOLE buffer, which the client wrote into the SAME xterm. For an idle terminal the buffer is exactly the
// prompt; every reconnect appended one (with content: the whole history once more at the cursor position).
//
// The protocol: `end` counts the characters (UTF-16 units, like `buffer.length`) the session has ever output; the buffer covers
// [end − buffer.length, end). Every data event carries `id: <end after the piece>` — the browser itself sets that line as the
// `Last-Event-ID` header when reconnecting — and the same number as `until` in the data (iOS reads only `data:` lines and sends
// it back as `?ab=`). A subscription with a valid resume point gets only the rest from there. EVERY full fetch — without a
// point, with an unreadable one or with one no longer in the buffer — carries `replaced: true`: the client resets instead of
// appending. For a fresh terminal the reset has no effect; a client that shows something and reconnects without a point (an old
// one, or iOS against an old server without `until`) would otherwise append the whole history once more.
// Clients NEVER count characters themselves: they only return the last number from the server (Swift counts characters
// differently from JS).

/** Scrollback text per session (characters). */
export const MAX_BUFFER = 200_000;

// A buffer that starts with a LOW surrogate at the front has cut a character outside the BMP (emoji) in half. JSON.stringify
// turns that into a `\udc..` without a partner, and Swift's JSONDecoder silently discards the WHOLE event because of it — when
// catching up an overflowed buffer, everything. The half unit is dropped; `end` stays, the start moves by one.
const withoutHalfCharacter = (s) => {
  const c = s.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? s.slice(1) : s;
};

/** Shorten the buffer to `max` characters (at the front) without cutting a surrogate pair. */
export function truncateBuffer(buffer, max = MAX_BUFFER) {
  return buffer.length > max ? withoutHalfCharacter(buffer.slice(-max)) : buffer;
}

// JSON.stringify leaves U+2028, U+2029 and U+0085 raw. The browser splits SSE only at CR/LF, but Swift's `AsyncBytes.lines`
// (older iOS versions, before `sseLines` in APIClient.swift) splits there too — the event tore and was lost. As `\uXXXX` they are
// equivalent JSON. (The iOS app now splits only at CR/LF itself; the escape keeps installed older versions working.)
const LINE_SEPARATOR = /[\u2028\u2029\u0085]/g;
const asEscape = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** One data row of the stream: `id: <until>` and `{d, until}` (with `replaced: true` when the client should reset). */
export function dataRow(d, until, replaced = false) {
  const json = JSON.stringify(replaced ? { d, until, replaced: true } : { d, until }).replace(LINE_SEPARATOR, asEscape);
  return `id: ${until}\ndata: ${json}\n\n`;
}

// What a new subscription gets. `ab`: the resume point (header `last-event-id` or `?ab=`, raw); if it is missing (null,
// undefined, ""), it is a first fetch. Only a digit sequence counts — "12abc", "-1", "1e3" are unreadable. A valid point lies
// in [start, end]; the rest never begins with a half unit (a point a client invents could point into the middle of a pair —
// the server's own always lie at piece boundaries, and node-pty delivers whole characters). → { d, until, replaced }
export function catchUpTerminal({ buffer, end }, from) {
  const whole = { d: buffer, until: end, replaced: true };
  if (from === undefined || from === null || from === "") return whole;
  const raw = String(from).trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const beginning = end - buffer.length;
  if (!Number.isSafeInteger(n) || n < beginning || n > end) return whole;
  return { d: withoutHalfCharacter(buffer.slice(n - beginning)), until: end, replaced: false };
}
