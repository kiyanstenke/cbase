// A tab from ANOTHER window. VS Code opens an editor dropped onto a group from another window there as a file (`editorDropTarget`: the
// drag data carries the URI). The paths of a cbase tab are relative to their location (route `apiBase` of the workspace/project, and
// instance) — a drag therefore carries that location (`LOCATION_TYPE`, JSON) and, readable already during the drag (the browser shows
// only the TYPES until the drop), the location's identifier as its own type (`locationType`) and the identifier of ITS window
// (`windowType`). A surface accepts a foreign tab only if it comes from another window AND has the same location — the same origin
// (same account in the same browser), the same route (workspace/project, identifiers are UUIDs) and the same instance. Otherwise it
// stays rejected (never as text into the editor).
// A leaf module without imports (guard web/test/tab-foreign.test.mjs runs it).

/** The location of a tab: origin, route and instance (null = main). */
export type TabLocation = { origin: string; apiBase: string; instance: string | null };

/** The location data plus path (JSON). */
export const LOCATION_TYPE = "application/x-cbase-tab-location";
const LOCATION_PREFIX = "application/x-cbase-location-";
const WINDOW_PREFIX = "application/x-cbase-window-";

/** FNV-1a over UTF-16 units, twice with different starts — 16 hex characters (types are lowercase). */
function identifier(text: string): string {
  const fnv = (h: number) => {
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x01000193);
}

/** The identifier of a location — equal exactly when origin, route and instance are equal. */
export const locationIdentifier = (o: TabLocation): string => identifier(JSON.stringify([o.origin, o.apiBase, o.instance ?? null]));
/** The type that reveals the location already during the drag. */
export const locationType = (o: TabLocation): string => LOCATION_PREFIX + locationIdentifier(o);

/** The identifier of THIS window (new on each page load). */
const WINDOW = (() => {
  try { const z = new Uint32Array(2); globalThis.crypto.getRandomValues(z); return [...z].map((x) => x.toString(16).padStart(8, "0")).join(""); }
  catch { return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`; }
})();
export const windowType = (window: string = WINDOW): string => WINDOW_PREFIX + window;

/** What a tab additionally carries when dragged: always its window, with location and path (a file) those too. */
export function tabDragData(foreign: { location: TabLocation; path: string } | null, window: string = WINDOW): [string, string][] {
  const out: [string, string][] = [[windowType(window), "1"]];
  if (foreign && foreign.path) out.push([LOCATION_TYPE, JSON.stringify({ ...foreign.location, instance: foreign.location.instance ?? null, path: foreign.path })], [locationType(foreign.location), "1"]);
  return out;
}

/** Does the drag come from another window (a tab carrying its window — just not this one)? */
export function fromOtherWindow(types: readonly string[], window: string = WINDOW): boolean {
  return types.some((t) => t.startsWith(WINDOW_PREFIX)) && !types.includes(windowType(window));
}
/** Does a surface at `location` accept this drag as a foreign tab (other window, same location)? From the types only — during the drag. */
export function foreignTabHere(types: readonly string[], location: TabLocation, window: string = WINDOW): boolean {
  return fromOtherWindow(types, window) && types.includes(locationType(location));
}
/** Do a drag's data name EXACTLY this location (origin, route, instance)? */
function sameLocation(x: { origin?: unknown; apiBase?: unknown; instance?: unknown }, location: TabLocation): boolean {
  return x.origin === location.origin && x.apiBase === location.apiBase && (x.instance ?? null) === (location.instance ?? null);
}
/** On drop: the foreign tab's path if its data name EXACTLY this location — otherwise null (no path with `..`, no absolute one). */
export function foreignPath(json: string, location: TabLocation): string | null {
  let d: unknown;
  try { d = JSON.parse(json); } catch { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const x = d as { origin?: unknown; apiBase?: unknown; instance?: unknown; path?: unknown };
  if (!sameLocation(x, location)) return null;
  if (typeof x.path !== "string" || !x.path || x.path.startsWith("/") || x.path.split("/").includes("..")) return null;
  return x.path;
}
/** This window's location for a route and instance. */
export const tabLocation = (apiBase: string, instance: string | null): TabLocation => ({
  origin: typeof location === "undefined" ? "" : location.origin, apiBase, instance: instance ?? null,
});

// ── Explorer entries from another window ─────────────────────────────────────────────────────────────────────────────────────────────
// VS Code treats entries coming from another window's explorer like files from outside: dragged onto an editor group they open
// (`editorDropTarget`), dropped in the explorer they are COPIED (`ExplorerDragAndDrop.drop` → `handleExternalDrop`, never moved). A drag
// from the explorer carries the same types as a tab (its window, its location's identifier) and the origin in its data; it is accepted
// only for EXACTLY this location (origin, route, instance) — otherwise rejected as before.

/** What a drag from the explorer additionally carries: its window and its location's identifier. */
export function treeDragTypes(location: TabLocation, window: string = WINDOW): [string, string][] {
  return [[windowType(window), "1"], [locationType(location), "1"]];
}
/** On drop: the paths of an explorer drag if its data name EXACTLY this location — otherwise null (no paths with `..`, no absolute ones). */
export function foreignTreePaths(json: string, location: TabLocation): string[] | null {
  let d: unknown;
  try { d = JSON.parse(json); } catch { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const x = d as { origin?: unknown; apiBase?: unknown; instance?: unknown; paths?: unknown };
  if (!sameLocation(x, location)) return null;
  if (!Array.isArray(x.paths)) return null;
  const paths = x.paths.filter((p): p is string => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").includes(".."));
  return paths.length && paths.length === x.paths.length ? paths : null;
}
/** On drop of a drag from another window: the files it names at this location — a tab (`LOCATION_TYPE`) or explorer entries
 *  (`treeType`, JSON with origin); null: nothing for this location. */
export function foreignFiles(data: (type: string) => string, types: readonly string[], location: TabLocation, treeType: string): string[] | null {
  if (types.includes(LOCATION_TYPE)) { const p = foreignPath(data(LOCATION_TYPE), location); return p ? [p] : null; }
  if (types.includes(treeType)) return foreignTreePaths(data(treeType), location);
  return null;
}
