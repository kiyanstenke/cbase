// The output of the main run per turn. The counter used to be visible only INSIDE the run (runs/do-run.js `runOut`, for the figures
// at the turn end); the budget "+500k" computes it NEXT TO the consumption of the same turn's workflow agents
// (dynworkflows/budget.js) — `budget.spent()` sums the main run's output and that of every workflow agent of the turn.
//
// Counted at the same place as `runOut`: the `message_delta` of the MAIN STREAM (cumulative per API call — do-run passes the
// increment in). Attributed to the identifier of the running turn (runs/human-input.js turnIdentifier); whatever comes without a turn
// counts nowhere. A turn stays readable after it ended — a workflow it started outlives it, and its pot needs the final number.
// Capped to the newest TURN_MAX turns of this server run.
//
// Leaf: imports only the reading of the turn (runs/, domain-free).
import { turnIdentifier } from "./human-input.js";

const TURN_MAX = 500;
const counter = new Map(); // turn identifier → output tokens of the main run in this turn

/** Attribute the increment `n` of main-stream output tokens to the chat's running turn. */
export function countMainOutput(chatId, n) {
  if (!(n > 0)) return;
  const id = turnIdentifier(chatId);
  if (!id) return;
  counter.set(id, (counter.get(id) || 0) + n);
  if (counter.size > TURN_MAX) counter.delete(counter.keys().next().value);
}

/** The main run's output in this turn (0 = none counted, also for an unknown or empty identifier). */
export const mainOutput = (turnId) => (turnId ? counter.get(turnId) || 0 : 0);
