// Write a data event of the terminal stream (`GET /api/terminal/:id/stream`) into an xterm.
// Without DOM, React or xterm import, so `web/test/terminal-stream.test.mjs` can check it without a browser — the three components
// with a terminal (TerminalsPane, TerminalPanel, AuthLoginConsole) call in here, none writes by itself.
//
// The incident: the stream had no heartbeat, Cloudflare cut the silent connection, the EventSource reconnected by itself, and the
// server sent every new subscription the whole buffer — which the component wrote into the SAME xterm. An idle terminal showed hundreds
// of prompts in a row. Since then the server resumes at `Last-Event-ID` (the EventSource sets the header itself on reconnecting,
// server/backend/electron/server/terminal-stream.js) and sends only the rest. EVERY full fetch (without a point, or the point is no
// longer in the buffer) comes with `replaced: true` — then the xterm is reset first, otherwise the history would appear twice; for a
// fresh xterm (every mount opens a new EventSource) that has no effect.
// An empty `d` only sets the state (the `id:` line) and is not written.
//
// The reset goes via RIS (`ESC c`) IN the write stream, not via `term.reset()`: xterm parses `write` with a delay, so a direct
// `reset()` would run BEFORE older chunks still waiting, and they would be back afterwards. `ESC c` passes through the parser in order
// and triggers the same `reset()` there (xterm 6: InputHandler.fullReset → onRequestReset → Terminal.reset — size, theme and keyboard
// handler stay); reset and new content land in the same pass and the same frame, without flicker.

/** What a terminal must be able to do here — an xterm `Terminal` fulfills it. */
export interface TerminalTarget {
  write(data: string): void;
}

/** RIS (Reset to Initial State) — the sequence `reset`/`tput reset` send themselves. */
export const TERMINAL_RESET = "\x1bc";

/** The data of an event: `d` the text, `until` the server's state afterwards, `replaced` = reset first. */
export interface TerminalChunk {
  d: string;
  until: number | null;
  replaced: boolean;
}

/** Read `e.data`; unreadable input (not JSON, not an object, `d` not text) is `null` and skipped. */
export function terminalChunk(raw: string): TerminalChunk | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const { d, until, replaced } = o as { d?: unknown; until?: unknown; replaced?: unknown };
  if (typeof d !== "string") return null;
  return { d, until: typeof until === "number" ? until : null, replaced: replaced === true };
}

/** Write an event: `replaced` ⇒ RIS before the text (in ONE write); empty text without `replaced` ⇒ nothing. Without a terminal nothing. */
export function writeTerminalChunk(term: TerminalTarget | null | undefined, raw: string): void {
  if (!term) return;
  const s = terminalChunk(raw);
  if (!s) return;
  const text = s.replaced ? TERMINAL_RESET + s.d : s.d;
  if (text) term.write(text);
}
