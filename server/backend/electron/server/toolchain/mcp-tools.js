// The tool choice of a coding MCP server: the ONE computation over cache, choice and marks. A leaf without imports — pure, so
// that the airlock (toolchain/airlock-routes.js), loading (POST /api/mcp-servers/:id/tools), the run's configuration
// (toolchain/mcp-config.js) and tests give the same answer.
//
// Coding and managing are separate systems: this file does not know `manager_mcp_servers`, and its rule for "writing" is
// Coding's own — no import from manager.js or managing/ (guard server/backend/test/import-direction.test.js).
//
// The server (mapMcp + `autoMarkerFirst`, store/toolchain.js getMcpServerInternal):
//   tools            cache [{ name, description (≤ 600), writing: true|false|null, fresh: bool }] — state of
//                    the last SUCCESSFUL load
//   toolsAt          time of that load, 0 = never loaded
//   choice           null = all tools (factory default); list = exactly these; [] = none
//   markers          names with a card
//   autoMarkerFirst  false = pre-existing row: the first successful load sets the baseline WITHOUT marks; true = newly created,
//                    auto-marking from the first load on
//
// carryForward(server, list) ⇒ { tools, markers } after a tools/list. If the baseline is open, only the cache is set.
//                            Otherwise every tool the cache does not know and that carries `readOnlyHint: false` gets a mark
//                            (auto mark); with `choice !== null` such a new tool is set to `fresh: true` (it is then off).
//                            `fresh` only drops when it is checked (`withoutNew`). Vanished tools drop out of the cache and stay
//                            in choice and marks: if one returns, the old decision applies — recognizable only by choice or
//                            mark; a returning tool that was in neither is "seen for the first time" again.
// verdict(server, name)      ⇒ "free" | "locked" | "card". A name the choice does not list is locked when `choice !== null` —
//                            also one the cache does not know. With `choice = null` every name is free or card.
// hasFree(server)            at least one tool "free" or "card"; with `choice = null` always yes (even with an empty cache). A
//                            server without anything free is not in a run's configuration at all.
// filtered(server, tools)    the tools/list response without locked tools (the wrapper passes on only "free" and "card").
// withoutNew(tools, choice)  the cache after `choice` was saved: `fresh` drops for every checked tool.
//
export const DESCRIPTION_MAX = 600;
/** Coding's rule for "writing": readOnlyHint false ⇒ true, true ⇒ false, otherwise null (undetermined). */
export function writingOf(tool) {
  const h = tool?.annotations?.readOnlyHint;
  return h === false ? true : h === true ? false : null;
}

/** The baseline is open: never loaded successfully AND a pre-existing row. */
export function baselineOpen(server) {
  return !Number(server?.toolsAt) && !server?.autoMarkerFirst;
}

const isList = (w) => Array.isArray(w);
const checked = (choice, name) => !isList(choice) || choice.includes(name);

export function carryForward(server, list) {
  const old = new Map((server?.tools || []).map((w) => [w.name, w]));
  const choice = isList(server?.choice) ? server.choice : null;
  const markers = [...new Set(server?.markers || [])];
  const open = baselineOpen(server);
  const tools = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const writing = writingOf(t);
    const description = String(t.description || "").slice(0, DESCRIPTION_MAX);
    const prior = old.get(name);
    if (prior) {
      tools.push({ name, description, writing, fresh: prior.fresh === true && !checked(choice, name) });
      continue;
    }
    // Seen for the first time. A tool that choice or marks already name has returned: the old decision applies.
    const back = (choice && choice.includes(name)) || markers.includes(name);
    if (!open && !back && writing === true) markers.push(name);
    tools.push({ name, description, writing, fresh: !open && !back && choice !== null });
  }
  return { tools, markers };
}

export function verdict(server, name) {
  if (!checked(isList(server?.choice) ? server.choice : null, name)) return "locked";
  return (server?.markers || []).includes(name) ? "card" : "free";
}

export function hasFree(server) {
  const choice = isList(server?.choice) ? server.choice : null;
  if (choice === null) return true;
  if (!choice.length) return false;
  const cache = server?.tools || [];
    // Without a cache (never loaded) nobody knows whether the names of the choice still exist — then the choice itself counts.
  return cache.length ? cache.some((w) => choice.includes(w.name)) : true;
}

export function filtered(server, tools) {
  return (Array.isArray(tools) ? tools : []).filter((t) => t && verdict(server, t.name) !== "locked");
}

export function withoutNew(tools, choice) {
  return (tools || []).map((w) => (w.fresh && checked(isList(choice) ? choice : null, w.name) ? { ...w, fresh: false } : w));
}
