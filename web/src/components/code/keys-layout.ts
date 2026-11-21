// The keyboard layout for the shortcuts: VS Code resolves a shortcut by the LABEL of the key — ⌥Z on QWERTZ is the key labelled "Z"
// (`KeyY`), not the one in the place of the US "Z". This file reads the layout from `navigator.keyboard.getLayoutMap()` (Chromium and the
// desktop client) and gives it to lib/commandPalette.ts (`setKeyBindings`); it is re-read when the system changes the layout
// (`layoutchange`) and when the window comes back. Without the API (Safari, Firefox) the map stays empty, and `keyCode` says the label
// (lib/commandPalette.ts `keyLabel`).
import { setKeyBindings } from "@/lib/commandPalette";

type Keyboard = { getLayoutMap?: () => Promise<Iterable<[string, string]>>; addEventListener?: (kind: string, fn: () => void) => void };
let registered = false;

/** Once per window: read the layout and follow it. */
export function followUpKeyBinding(): void {
  if (registered || typeof navigator === "undefined" || typeof window === "undefined") return;
  registered = true;
  const kb = (navigator as Navigator & { keyboard?: Keyboard }).keyboard;
  if (!kb?.getLayoutMap) return;
  const read = () => { void kb.getLayoutMap!().then((m) => setKeyBindings(new Map(m)), () => { /* unknown: keyCode decides */ }); };
  read();
  try { kb.addEventListener?.("layoutchange", read); } catch { /* without the event: on coming back */ }
  window.addEventListener("focus", read);
}
