// The key of the height memory (lib/contain.tsx) per history bubble. The key used to be `${chatId}:${position}`, and the memory
// outlives a chat switch: whoever left a chat IN THE MIDDLE of an answer came back, and the FINISHED answer at the same position
// immediately got the height of the half-streamed bubble (`contain-intrinsic-size`); scrollTop clamped to the too-small scroll height
// and the history stood up to 823 px above the end.
//
// Now the key names the CONTENT: the id of the first log row `buildBubbles` built the bubble from, and a fingerprint of its content (the
// same row with more blocks, since a delta appends to the last answer, is a different height). The row id does NOT hang on the
// bubble (bubbles are data of the reducer anchors, web/test/fixtures/bubbles): `buildBubbles` registers every bubble it builds here
// (`rememberRow`), a WeakMap on the object. Every bubble the live stream creates or changes is a new object without an entry: it is
// called `live:<position>` and is NEVER served from the memory (`operable`): the brake measures its height only once it is drawn.
// Module without imports (web/test/chat-open.test.mjs).

const rowOf = new WeakMap<object, number>();
const fingerprintOf = new WeakMap<object, string>();

/** `buildBubbles`: this bubble arose from log row `id` (the FIRST row wins). */
export function rememberRow(bubble: object, id: unknown): void {
  const n = Number(id);
  if (!Number.isFinite(n) || rowOf.has(bubble)) return;
  rowOf.set(bubble, n);
}

/** The log row the bubble was built from; `undefined` for every bubble created or changed live. */
export const rowOfTheBubble = (bubble: object): number | undefined => rowOf.get(bubble);

// Content as a number: the length of the JSON form (once per object: a built bubble never changes again, every change is a new
// object). No hash: a length collision of two versions of the SAME row is possible, but then the height is almost equal.
function fingerprint(bubble: object): string {
  let a = fingerprintOf.get(bubble);
  if (a === undefined) {
    let n = 0;
    try { n = JSON.stringify(bubble)?.length ?? 0; } catch { n = -1; }
    a = String(n);
    fingerprintOf.set(bubble, a);
  }
  return a;
}

// The marker in the key of a live-created bubble. It stands IN the key (not as its own prop) because the blocks inside
// (AssistantBlocks, ToolBlock, subagent levels) derive their keys from the bubble's: the marker is inherited all the way down.
const LIVE = ":live:";

/** The key of a bubble at position `i` in chat `chatId` (position only for live-created bubbles). */
export function memoryKey(chatId: string, bubble: object, i: number): string {
  const z = rowOf.get(bubble);
  return z === undefined ? `${chatId}${LIVE}${i}` : `${chatId}:z${z}:${fingerprint(bubble)}`;
}

/** May the memory apply a known height for this key IMMEDIATELY (lib/contain.tsx `attach`)? Not for live-created bubbles and their
 *  blocks; they are still measured and locked as soon as they are drawn. */
export const operable = (ck: string): boolean => !ck.includes(LIVE);
