// The size guideline of dynamic workflows and the size warning. Both follow the baseline 1:1 (Claude Code setting
// "Dynamic workflow size").
//
// GUIDELINE — one global setting small · medium · large · unrestricted (default medium), `dyn_workflow_size` in
// app_settings; GET/PUT /api/dyn-workflow-size (settings/routes.js; missing or unknown value ⇒ 400). The model gets it
// as a HINT in the description of `cbase_dynamic_workflow` (mcp/tools/dynworkflows.js `sizesSet`, wording per level
// as in the baseline: under 5 · 10 · 50 agents, unrestricted without a guideline). That is where the baseline puts it
// too, and NOT in the system prompt: the description only changes when the user changes the setting (one cache miss per
// change, like a model switch), never from turn to turn. It is passed as environment of the MCP server
// (`CBASE_DYNWF_SIZE`, toolchain/mcp-config.js) — ONLY when it differs from the default: without it the MCP server
// writes the default's sentence, and the spawn bytes of a run with the default stay as they were (golden).
//
// WARNING — a run with more than 25 agents or more than 1.5 million projected tokens gets ONE warning (event "warning"
// in the run, run.js); never in ultracode mode (whoever picks ultracode wants it big). The thresholds apply regardless
// of the guideline (the baseline would use the guideline's agent count when one is set).
// PROJECTION (after the baseline):
//     projected = max(tokens, round(cut × scheduled)),  cut = tokens / finished  (70,000 while none has finished)
// `scheduled` = agent() calls of the run so far (waiting ones included), `finished` = ended agents, `tokens` = input +
// output of the ended agents (the completion notice's sum, `totalTokens`). Deviation from the baseline: the cut divides
// by the ENDED agents, not the started ones — cbase books an agent only at its end, a running one would count 0 and
// drag the cut down. The warning fires when `scheduled > 25` or `tokens > 1.5M` or `projected > 1.5M` (strictly
// greater, like the baseline). Checked at every agent() call and at every agent end.
//
// A leaf except for the data layer (store.js).
import * as store from "../store.js";

export const SIZES = Object.freeze(["small", "medium", "large", "unrestricted"]);
export const SIZE_DEFAULT = "medium";
export const SIZE_SETTING = "dyn_workflow_size";
export const WARNING_AGENTS = 25;
export const WARNING_TOKENS = 1_500_000;
export const CUT_WITHOUT_FINISHED = 70_000;

/** The chosen level — the default without a (valid) choice. */
export function size() {
  const v = store.getSetting(SIZE_SETTING, "");
  return SIZES.includes(v) ? v : SIZE_DEFAULT;
}

/** Set a level: `{ size }` or `{ error: "missing" | "unknown" }` — a missing field is not a statement. */
export function setSize(value) {
  if (value === undefined || value === null || value === "") return { error: "missing" };
  if (typeof value !== "string" || !SIZES.includes(value)) return { error: "unknown" };
  store.setSetting(SIZE_SETTING, value);
  return { size: value };
}

/** For the MCP server's environment: the level when it differs from the default, otherwise `""` (see header). */
export const sizeForMcp = () => { const g = size(); return g === SIZE_DEFAULT ? "" : g; };

/**
 * The size warning of a run — `null` = none.
 * @param {{ scheduled: number, finished: number, tokens: number, ultracode: boolean }} o
 * @returns {null | { axis: "agents"|"tokens"|"both", scheduled: number, tokens: number, projected: number }}
 */
export function sizesWarning({ scheduled = 0, finished = 0, tokens = 0, ultracode = false } = {}) {
  if (ultracode) return null;
  const cut = finished > 0 ? tokens / finished : CUT_WITHOUT_FINISHED;
  const projected = Math.max(tokens, Math.round(cut * scheduled));
  const agents = scheduled > WARNING_AGENTS;
  const tok = tokens > WARNING_TOKENS || projected > WARNING_TOKENS;
  if (!agents && !tok) return null;
  return { axis: agents && tok ? "both" : agents ? "agents" : "tokens", scheduled, tokens, projected };
}
