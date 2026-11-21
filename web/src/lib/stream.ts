// What a reconnected event stream has to fill in.
//
// The "missing beginning" bug: joining in the middle of a running turn (chat opened, page reloaded, EventSource
// silently reconnected) used to show nothing until the NEXT delta, so the start of the answer was missing until the
// run ended — minutes for a long turn. The server now sends the text streamed so far along with "connected".
//
// The only rule that counts: afterwards the text must appear EXACTLY ONCE. What the bubble already holds is always a
// SUFFIX of the server state (the client read the stream from some point on, never skipped the middle and resumed
// later). Anything that does not fit this picture is NOT patched together: better a missing piece than a duplicate.

/**
 * The head the bubble is missing.
 * @param have   Text the running assistant bubble already shows (all text blocks concatenated).
 * @param server Text the server has streamed so far for this turn.
 * @returns The beginning to prepend, or "" if nothing (more) is missing or nothing is surely missing.
 */
export function missingBeginning(have: string, server: string): string {
  if (!server) return "";
  if (!have) return server;
  if (server === have) return "";
  // The client has the tail — the head is missing.
  if (server.endsWith(have)) return server.slice(0, server.length - have.length);
  // The client is AHEAD of the snapshot (the delta arrived before "connected"):
  // add nothing, or the beginning would appear twice.
  if (have.startsWith(server)) return "";
  // Neither head nor tail fit together — not reconstructible. The history is reloaded fresh at the
  // end of the run anyway (joinedMidRun), which is the more honest way.
  return "";
}
