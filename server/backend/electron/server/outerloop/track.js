// The TRACK of a gapless agent (only the timeline agent, `gapless`) — how much history a run reads at once.
//
// Why: a run that reads the full track (history up to CHANNEL_STATUS_RAW_MAX, tool index up to TOOL_INDEX_MAX) may not
// get through it within the step cap of the loop engine and end `error`. The watermark only advances with a FINISHED run
// — so the next one would read the same track and fail the same way: over a million input tokens per attempt, no
// progress, forever.
//
// THE RULE — computed from the row of the last run of this pair that says something about its track (store
// outerLoopLastTrackRun: `finished`, or `error` after the core has worked), without own state (survives restarts):
//   · none               ⇒ stage 0 (full track)
//   · `error`            ⇒ its stage + 1 — half the track
//   · `finished`         ⇒ its stage − 1 (not below 0) — the track grows back step by step instead of failing again at
//                          the same size right away
// Stage s reads 2^-s of both caps (history and index). At least ONE row always remains (lifecycle.js, timeline.js).
// If even the smallest track fails (stage STAGE_MAX), the next stage is STAGE_MAX + 1: then this smallest track is
// SKIPPED — a row `finished` with the reason in the error field (like "no note") and the watermark behind the track,
// visible in the run log and in the log. The gap is thereby reported, not silent; without it the agent would be stuck on
// this chat forever. A failure without work (`input` 0: gate, spawn, provider unreachable) does not count — it says
// nothing about the track, and a provider outage must not skip a track.
import * as store from "../store.js";

export const STAGE_MAX = 4;

/** The stage of the next run of this pair. 0 for every non-gapless agent. Can be STAGE_MAX + 1 (= skip). */
export function nextStage(agent, chat) {
  if (!agent?.gapless) return 0;
  const last = store.outerLoopLastTrackRun(agent.id, chat.id);
  if (!last) return 0;
  const s = Math.max(0, Math.min(STAGE_MAX, Number(last.stage) || 0));
  return last.state === "finished" ? Math.max(0, s - 1) : s + 1;
}

/** A cap on stage `stage`: `full` · 2^-stage, an integer, at least 1. */
export const capOnStage = (full, stage) => Math.max(1, Math.floor(Number(full) / 2 ** Math.max(0, Math.min(STAGE_MAX, Number(stage) || 0))));
