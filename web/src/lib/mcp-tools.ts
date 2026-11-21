// The tool choice of a coding MCP server (coding MCP airlock): the ONE calculation of the web client for rows, counter, label and the
// next choice after a click. Swift twin mobile/CbaseMobile/Code/McpTools.swift, bound in web/test/mcp-tools-binding.test.mjs. Leaf module
// without imports.
//
// The meaning comes from the server (server/backend/electron/server/toolchain/mcp-tools.js `verdict`): `choice = null` means "all", a
// list exactly these, `[]` none; a marker means "card before the call" and only takes effect on a selected tool. A name that stands in
// `choice` or `markers` but is no longer in the cache is kept when toggling — if the tool comes back, the old decision applies (the
// server accepts such names as long as they are already in the choice).

export interface McpTool {
  name: string;
  description?: string;
  /** The coding rule: readOnlyHint false ⇒ true, true ⇒ false, otherwise null (unresolved). */
  writing: boolean | null;
  /** Newly appeared since the last choice, not yet ticked (only with `choice !== null`). */
  fresh?: boolean;
}

export type McpLabel = "reads" | "writes" | "unresolved";

export interface McpToolRow {
  name: string;
  description: string;
  label: McpLabel;
  selected: boolean;
  /** Marker set (only takes effect if selected). */
  card: boolean;
  fresh: boolean;
}

export interface McpCounter {
  /** selected (free or with card) */
  free: number;
  /** of those with card */
  card: number;
  total: number;
}

export function labelOf(writing: boolean | null | undefined): McpLabel {
  return writing === true ? "writes" : writing === false ? "reads" : "unresolved";
}

export function isSelected(choice: string[] | null, name: string): boolean {
  return choice === null || choice.includes(name);
}

/** The rows in the order of the cache (= the server's tools/list). */
export function toolRows(tools: McpTool[], choice: string[] | null, markers: string[]): McpToolRow[] {
  return tools.map((w) => ({
    name: w.name,
    description: String(w.description || ""),
    label: labelOf(w.writing),
    selected: isSelected(choice, w.name),
    card: markers.includes(w.name),
    fresh: w.fresh === true,
  }));
}

export function counter(tools: McpTool[], choice: string[] | null, markers: string[]): McpCounter {
  const rows = toolRows(tools, choice, markers);
  const selected = rows.filter((z) => z.selected);
  return { free: selected.length, card: selected.filter((z) => z.card).length, total: rows.length };
}

/** The choice after a click on the checkbox of `name`. From `null` (all) it becomes the list of all names of the cache without `name`. */
export function toggleChoice(tools: McpTool[], choice: string[] | null, name: string): string[] {
  const base = choice === null ? tools.map((w) => w.name) : choice;
  return base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
}

export function toggleMarker(markers: string[], name: string): string[] {
  return markers.includes(name) ? markers.filter((n) => n !== name) : [...markers, name];
}

/** State of the cache: never loaded, loaded N minutes ago, or the last error (an error does not replace the cache). */
export function statusOf(toolsAt: number, error: string, now: number): { kind: "never" | "loaded" | "error"; minutes: number } {
  const minutes = toolsAt > 0 ? Math.max(0, Math.floor((now - toolsAt) / 60_000)) : 0;
  if (error) return { kind: "error", minutes };
  return { kind: toolsAt > 0 ? "loaded" : "never", minutes };
}
