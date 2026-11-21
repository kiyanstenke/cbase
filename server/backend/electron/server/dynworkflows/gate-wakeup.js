// Wakes workflow agents parked at the credit gate as soon as a NEWER measurement shows the gate free for every model.
// Without this they would only wake when the gate is switched off (`PUT /api/credit-gate`) or when the window that held
// them resets — after an account switch that is the reset of the OLD account, up to seven days away.
//
// Called on the tick of the wait-row sweeper (server.js, `autoContinueSweepMs`), without a network call: whoever asks
// anyway (client poll, gate, wakeup) keeps the measurement fresh. The question is strict (runs/limit-gate.js
// gateFreeForAllByMeasurement: no time lock at the gate threshold, no model-specific window either) — the woken agents
// ask the gate again themselves (dynworkflows/run.js), so none parks again on the same measurement. One measurement wakes
// at most once.
import { gateWaitingCount, wakeGateWaiting } from "./parking.js";
import { gateFreeForAllByMeasurement } from "../runs/limit-gate.js";

let wokenMeasurement = 0;

/** → how many workflow agents waiting at the gate were woken (0: none waiting, no newer measurement, or the gate holds). */
export function wakeGateWaitingIfFree() {
  if (!gateWaitingCount()) return 0;
  const measuredAt = gateFreeForAllByMeasurement({ since: wokenMeasurement });
  if (!measuredAt) return 0;
  wokenMeasurement = measuredAt;
  return wakeGateWaiting();
}
