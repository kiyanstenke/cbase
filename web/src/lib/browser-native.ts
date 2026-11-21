// The pure rules of the NATIVE browser in the cbase client.
//
// In the client (Electron) the user browser is no longer a streamed surface but a WebContentsView of the main window, which the main
// process binds to the pane's rectangle. The web only sees the bridge `window.cbaseClient.browser` (client/preload.cjs) and this
// module: everything computable without DOM and without Electron lives here and is checked in the gate
// (web/test/browser-native.test.mjs). The component BrowserNative.tsx calls what is here.
//
// No imports except types: the module runs in the test under Node without React and without DOM.

// ── The bridge contract (shape of the data as the client sends it) ──────────────────────────────
export type NativeRect = { x: number; y: number; width: number; height: number };
export type NativeTab = { id: string; title: string; url: string; active: boolean; loading: boolean; canBack: boolean; canForward: boolean };
export type NativeState = {
  scope: string;
  tabs: NativeTab[];
  devtools: boolean;
  error: string | null;
  bounds: NativeRect | null;
  visible: boolean;
};
// `kind`: “port-occupied” (something already listens locally, the human picks another local port) or “ambiguous”: several project
// containers hold the port and none belongs to the scope; `candidates` are their instances (“<projectId>/<instance>”), and the answer
// `instance:<identifier>` picks one (the client checks that it is among them). An older client only sends “port-occupied”.
export type NativeHint = { id: string; scope: string; kind: "port-occupied" | "ambiguous"; port: number; url: string; process?: string; candidates?: string[] };
export type HintChoice = "other-port" | "abort" | `instance:${string}`;
export type NativeBridge = {
  open: (scope: string) => Promise<NativeState>;
  bounds: (scope: string, hostId: string, rect: NativeRect | null) => void;
  stillFrame: (scope: string, on: boolean) => Promise<string | null>;
  navigate: (scope: string, url: string) => Promise<void>;
  back: (scope: string) => Promise<void>;
  forward: (scope: string) => Promise<void>;
  reload: (scope: string) => Promise<void>;
  stop: (scope: string) => Promise<void>;
  newTab: (scope: string, url?: string) => Promise<NativeState>;
  tabClose: (scope: string, tabId: string) => Promise<NativeState>;
  selectTab: (scope: string, tabId: string) => Promise<NativeState>;
  devtools: (scope: string, open: boolean) => Promise<void>;
  extern: (url: string) => void;
  hintResponse: (id: string, choice: HintChoice) => Promise<void>;
  onState: (cb: (z: NativeState) => void) => () => void;
  onHint: (cb: (h: NativeHint) => void) => () => void;
  onAddressBar: (cb: (scope: string) => void) => () => void;
};

// The functions the bridge MUST carry. An old client (without `browser`) or a half one (a function missing) falls back to the stream:
// a version switch, not an error path. The list is the truth for `nativeAvailable`; the type above is its transcript for the
// compiler, and the test holds both against each other.
export const BRIDGE_FUNCTIONS = [
  "open", "bounds", "stillFrame", "navigate", "back", "forward", "reload", "stop",
  "newTab", "tabClose", "selectTab", "devtools", "extern", "hintResponse",
  "onState", "onHint", "onAddressBar",
] as const;

// True only if `w.cbaseClient.browser` is an object carrying EVERY function of the contract.
// Takes `unknown` because the caller passes `window` and this module knows no DOM types.
export function nativeAvailable(w: unknown): boolean {
  if (!w || typeof w !== "object") return false;
  const client = (w as { cbaseClient?: unknown }).cbaseClient;
  if (!client || typeof client !== "object") return false;
  const browser = (client as { browser?: unknown }).browser;
  if (!browser || typeof browser !== "object") return false;
  return BRIDGE_FUNCTIONS.every((name) => typeof (browser as Record<string, unknown>)[name] === "function");
}

// The bridge itself: safe after `nativeAvailable`, else null.
export function nativeBridge(w: unknown): NativeBridge | null {
  return nativeAvailable(w) ? (w as { cbaseClient: { browser: NativeBridge } }).cbaseClient.browser : null;
}

// ── Scope ────────────────────────────────────────────────────────────────────────────────────────
// The pane gets its scope as apiBase (“/api/projects/<id>” or “/api/workspaces/<id>”); the client knows it as the key `proj:<id>` /
// `ws:<id>` (same form as the profile of the streamed browser, browsers.js). Anything else is no scope, and the stream stays.
export function scopeFromApiBase(apiBase: string): string | null {
  const m = /^\/api\/(projects|workspaces)\/([^/?#]+)$/.exec(String(apiBase || ""));
  if (!m) return null;
  return `${m[1] === "projects" ? "proj" : "ws"}:${decodeURIComponent(m[2])}`;
}

// ── Bounds ───────────────────────────────────────────────────────────────────────────────────────
// The host surface reports its rectangle in CSS pixels relative to the window content (getBoundingClientRect). Invisible (tab closed,
// `hidden`, unmount) means null: the main process then hides the view. A surface without extent is invisible: `display:none` measures
// 0 × 0. Rounded, because setBounds takes integers and a half edge only flickers.
export function hostRect(rect: { x: number; y: number; width: number; height: number }, visible: boolean): NativeRect | null {
  if (!visible) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!(width >= 1) || !(height >= 1)) return null;
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  if (![x, y].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

// Two rectangles are equal if all four numbers are equal: the pane reports only changes, otherwise every scroll event would send an
// IPC that changes nothing.
export function rectEqual(a: NativeRect | null, b: NativeRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// The counterpart to this thrift: bounds go out without a reply, and the client drops its host entries itself on every navigation of
// the window. If its state says “I have no surface” while we reported one, our report was lost: it must go out once more, otherwise
// the surface would stay empty until something happens to move.
export function reportAgainNeeded(z: NativeState | null, reported: NativeRect | null): boolean {
  return Boolean(z) && Boolean(reported) && z!.bounds === null;
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────
export function stateEmpty(scope: string): NativeState {
  return { scope, tabs: [], devtools: false, error: null, bounds: null, visible: false };
}

// On every change the client sends the WHOLE state of the scope; it replaces the old one. An error stays in it until the next state
// without an error arrives: the pane shows exactly what the client said last and keeps none of it itself. States of a foreign scope
// (the bridge sends to all listeners) change nothing.
export function reduceState(old: NativeState, fresh: NativeState): NativeState {
  if (!fresh || fresh.scope !== old.scope) return old;
  return fresh;
}

export function activeTab(z: NativeState): NativeTab | undefined {
  return z.tabs.find((tb) => tb.active) || z.tabs[0];
}

// What the address bar shows: about:blank is an empty tab, no address.
export function addressText(url: string | undefined): string {
  return !url || url === "about:blank" ? "" : url;
}

// ── Overlays ─────────────────────────────────────────────────────────────────────────────────────
// A native view ALWAYS lies above the web content: a modal, menu or palette above it would be covered. So as soon as an overlay stands
// ABOVE the pane, the client hides the view and the pane shows a still frame. Overlays are recognized by the markers the UI already
// carries: `.cb-overlay` (a modal's scrim, CbKit `Modal` and the own sheets), `.cb-pop` (every menu), `[role="dialog"]` (lightbox, tasks
// pill sheet, ArtifactBrowser). Also `.cb-overlay-in`: the SettingsModal scrim carries ONLY the fade-in class, not the glass; without it
// the settings sheet would lie behind the view. And `[data-overlay]` for everything that floats without carrying glass: the dropdown
// sheets of the header (ports, VS Code, runs, agent browser, bell, design) draw their own background (`bg-panel`) and so must not get
// `cb-pop`: as an unlayered rule it would beat every utility on the element and recolor it. A marker without looks.
// The test binds the list to the places under web/src/components: every marker occurs there, and every floating, opaque sheet there
// carries a marker of the list.
export const OVERLAY_MARKER = [".cb-overlay", ".cb-overlay-in", ".cb-pop", "[role=\"dialog\"]", "[data-overlay]"] as const;
export const OVERLAY_SELECTOR = OVERLAY_MARKER.join(", ");

type RectLike = { x: number; y: number; width: number; height: number };
// Two rectangles overlap if both have an area and they intersect. A 0 × 0 (hidden, `display:none`) overlaps nothing; neither does a
// menu in another corner of the window.
export function cuts(a: RectLike, b: RectLike): boolean {
  if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// An element the browser draws but makes invisible covers nothing. This was measured: the “jump to end” button (ChatStage) once carried
// `.cb-pop` PERMANENTLY and only toggles its opacity; without this check a still frame would stand next to a chat forever instead of
// the view. The pane passes the computed values in so this module stays checkable without DOM.
export function visibleLoudStyle(style: { visibility?: string; opacity?: string; display?: string }): boolean {
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (style.display === "none") return false;
  return Number(style.opacity ?? "1") > 0;
}

type OverlayElement = { matches: (selector: string) => boolean; getBoundingClientRect?: () => RectLike };
// Is there an overlay ABOVE the host among the elements? Checked marker by marker (an element without `matches`, such as a text node,
// is skipped), then the position: only an overlay whose rectangle intersects the host covers the view. The position check exists for a
// measured reason: the chat's “jump to end” button once carried `.cb-pop` PERMANENTLY (only its opacity toggles), and a palette was a
// `.cb-pop` side sheet; “any marker in the document” would have frozen the chat bar's browser forever. Without a host (pane invisible)
// there is nothing to cover. An element that cannot deliver a rectangle counts as an overlay: better one still frame too many than a
// menu behind the view.
export function hasOverlay(elements: Iterable<OverlayElement>, host: RectLike | null): boolean {
  if (!host) return false;
  for (const el of elements) {
    if (typeof el?.matches !== "function") continue;
    if (!OVERLAY_MARKER.some((m) => el.matches(m))) continue;
    if (typeof el.getBoundingClientRect !== "function") return true;
    if (cuts(el.getBoundingClientRect(), host)) return true;
  }
  return false;
}

type NodeLike = { nodeType?: number; matches?: (s: string) => boolean; querySelector?: (s: string) => unknown };
type MutationLike = {
  type: string;
  target?: NodeLike;
  addedNodes?: Iterable<NodeLike>;
  removedNodes?: Iterable<NodeLike>;
};

const carriesMarker = (k: NodeLike | undefined, onlySelf = false): boolean => {
  if (!k || (k.nodeType !== undefined && k.nodeType !== 1)) return false; // 1 = ELEMENT_NODE
  if (typeof k.matches === "function" && OVERLAY_MARKER.some((m) => k.matches!(m))) return true;
  if (onlySelf) return false;
  return typeof k.querySelector === "function" && !!k.querySelector(OVERLAY_SELECTOR);
};

// Does a DOM mutation touch the markers? The observer must run over the WHOLE tree (an overlay is not always a portal child of the
// body: prompts and side sheets render in place), and a streaming chat mutates the document dozens of times per second. This pre-check
// cheaply decides whether to recompute at all: for child changes the added and removed nodes count (itself or a descendant with a
// marker), for attribute changes the target. Attributes must be included: the kit menu first attaches its sheet INVISIBLE
// (`visibility: hidden` until the layout effect has measured the position), so the child mutation alone would see only an invisible
// element and leave the view above the menu. For an attribute change ONLY the target itself counts, not its subtree: a changed `class`
// on any ancestor opens no overlay, and looking into the subtree would make the pre-check worthless, since the “jump to end” button
// hangs deep in the chat stage and every ancestor hit would match it. An overlay that becomes visible changes its OWN `class`/`style`
// (that is how the kit menu attaches its sheet).
export function touchedOverlay(mutations: Iterable<MutationLike>): boolean {
  for (const m of mutations) {
    if (!m) continue;
    if (m.type === "attributes") { if (carriesMarker(m.target, true)) return true; continue; }
    for (const k of m.addedNodes || []) if (carriesMarker(k)) return true;
    for (const k of m.removedNodes || []) if (carriesMarker(k)) return true;
  }
  return false;
}
