// A Codex TEST model with a gap in the levels (no `max`) — harness, not a test.
//
// It carries EXACTLY the numbers of the removed gpt-5.5 catalog entry: no max ⇒ max runs as xhigh, `catalogLevel` xhigh, `context`
// 272000 (no `-c model_context_window`). No catalog model carries a gap any more, but the clamp itself stays (`codexEffortFallback` at
// spawn, `effortRunning` for main run, subagent, oneshot and display), because the next model with a gap will come; without this test
// model none of its guards would run over the way they must guard.
//
// `enterGapsModel()` appends it to the EXPORTED array — the same object that `providers/index.js` holds as `PROVIDERS.codex.models`;
// the clamp, catalog level and `/api/providers` see it in the same process (a server via `startServer`/`withAgentsServer` without
// `kind`). Never in a child process: there the real catalog stands. The return value removes it again — a test that compares a
// catalog list exactly afterwards would otherwise see one model too many. Called repeatedly it appends only once (and only the first
// call removes it).
import { CODEX_MODELS } from "../electron/server/providers/connectors/codex.js";

export const GAP = "gpt-gap-test";
export const GAPS_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);

export function enterGapsModel() {
  if (CODEX_MODELS.some((m) => m.id === GAP)) return () => {};
  const entry = { id: GAP, label: "GPT Gap (test)", context: 272000, efforts: [...GAPS_LEVELS], catalogLevel: "xhigh" };
  CODEX_MODELS.push(entry);
  return () => {
    const i = CODEX_MODELS.indexOf(entry);
    if (i >= 0) CODEX_MODELS.splice(i, 1);
  };
}

/** `fn` with the test model entered — sync or async; afterwards the catalog is the real one again. */
export function withGapsModel(fn) {
  const remove = enterGapsModel();
  let result;
  try { result = fn(GAP); } catch (e) { remove(); throw e; }
  if (result && typeof result.then === "function") return result.finally(remove);
  remove();
  return result;
}
