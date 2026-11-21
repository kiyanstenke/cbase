// The codes with which the server ends an outer loop run ON PURPOSE: `state` "aborted", `error` = the code — not a
// sentence. Such a run is not an error: the server ended it deliberately and the next trigger catches up. Both clients show
// every code calmly (grey instead of red) with their own text — web `components/outerloop/outerLoopText.ts` runError, iOS
// `Code/OuterLoopPane.swift`; a code a client does not know would appear there raw and red.
//
// The list exists ONCE, here. Whoever ends a run for a new, intended reason enters the code here and writes it via this
// constant — the guard (web/test/outerloop-keeper.test.mjs, run in web/test/outerloop-set-binding.test.mjs) reads the
// codes from this module and is red as long as a client does not show one of them calmly with its own text.
//
// A leaf without imports: the web tests load it directly, and `abort.js` (a leaf every delete path pulls in) stays
// cycle-free.
//
// Intended, but NOT a code (deliberately): the general aborts of every outer loop agent in `run.js` (agent or chat gone,
// no longer active, nothing new, server restarted) and those of the delete paths (agent, project, workspace deleted,
// layout) keep writing a sentence or reason — they apply to every agent, not only the keeper.

export const INTENDED_END = Object.freeze({
  // A turn starts in the observed chat (abort.js outerLoopTurnStart, switch abortingTurn) — the keeper decided on a state
  // the main agent now continues to write; the next quiet trigger restarts it.
  turn: "turn",
  // The wakeup of a parked keeper run arrives in a chat that is not quiet (run.js startOuterLoopRun, agenda/upkeep.js
  // upkeepQuietReason) — no watermark, the next trigger catches up.
  quiet: "quiet",
});
