// The bridge from the Electron shell to the web UI: `window.cbaseShell`, exposed by `preload.cjs` of the
// app(s) (server/backend/electron, client). A leaf module without imports — theme.ts and TopNav.tsx read it,
// web/test/window-buttons-theme.test.mjs compiles it with tsc and runs it.
//
// Every function may be missing, and its ABSENCE is the message: presence is the version switch
// (as with the native browser, lib/browser-native.ts). The web client in a browser has no bridge at all;
// a shell older than Electron 44 has the three window actions but no `setTheme`.

export type ShellThemeMode = "light" | "dark" | "system";

export type CbaseShell = {
  windowClose?: () => void;
  windowMinimize?: () => void;
  windowZoom?: () => void;
  // Since Electron 44: channel `cbase:theme`. The main process sets `nativeTheme.themeSource`,
  // remembers the mode for the next start and stops hiding THIS window's native window buttons on
  // focus loss. Anything but the three modes is discarded.
  setTheme?: (mode: ShellThemeMode) => void;
  // App-wide text size, client only (client/preload.cjs): channel `cbase:textSize` reports the chosen
  // step — the main process sets the check mark under "View → Text size", and only from this report on
  // are ⌘+ / ⌘− / ⌘0 the text size instead of the zoom. `onTextSize` receives "+1", "-1", "0" from the
  // menu or a step (radio item); it returns the unsubscribe function.
  setTextSize?: (stage: string) => void;
  onTextSize?: (cb: (command: unknown) => void) => () => void;
};

// The bridge of window `w`, else null (browser, foreign page in the client). Takes `unknown` because
// the caller passes `window` and this leaf module knows no DOM types.
export function shellBridge(w: unknown): CbaseShell | null {
  if (!w || typeof w !== "object") return null;
  const s = (w as { cbaseShell?: unknown }).cbaseShell;
  return s && typeof s === "object" ? (s as CbaseShell) : null;
}

// Report the CHOSEN mode to the shell — "system" stays "system", never the resolved theme.
// `themeSource` shifts `prefers-color-scheme` in the renderer; reporting "dark" because the system is
// dark right now would pin `matchMedia` to dark forever, and the "System" mode would never follow the
// OS again.
// A throw from the bridge (foreign code, other shell version) must not abort the switch:
// setThemeMode notifies its listeners AFTER applyMode, and a throw here would leave the check mark in
// the switcher on the old mode. true means: reported.
export function reportThemeMode(w: unknown, mode: ShellThemeMode): boolean {
  const s = shellBridge(w);
  if (!s || typeof s.setTheme !== "function") return false;
  try {
    s.setTheme(mode);
    return true;
  } catch {
    return false;
  }
}

// Does the header draw the window buttons itself? Exactly when a shell is present that does NOT know the
// mode: only it hides the native buttons on focus loss (they looked invisible there). A shell with
// `setTheme` keeps them — drawn ones would sit ON TOP of the native ones.
// Without a bridge (browser) there are no window buttons.
export function drawsWindowButtons(w: unknown): boolean {
  const s = shellBridge(w);
  return !!s && typeof s.setTheme !== "function";
}

// Report the chosen text size to the shell (step name, e.g. "gross"). Same build as reportThemeMode:
// a missing function is the message (browser, older client), a throw from the bridge does not abort
// the switch. true means: reported.
export function reportTextSize(w: unknown, stage: string): boolean {
  const s = shellBridge(w);
  if (!s || typeof s.setTextSize !== "function") return false;
  try {
    s.setTextSize(stage);
    return true;
  } catch {
    return false;
  }
}

// Listen to the shell's commands (⌘+ / ⌘− / ⌘0, "View" menu). Without a bridge: an unsubscribe that
// does nothing — and then there are no shortcuts the UI may name (see `hasTextShortcut`).
export function listenShellTextSize(w: unknown, cb: (command: unknown) => void): () => void {
  const s = shellBridge(w);
  if (!s || typeof s.onTextSize !== "function") return () => {};
  try {
    const off = s.onTextSize(cb);
    return typeof off === "function" ? off : () => {};
  } catch {
    return () => {};
  }
}

// Are ⌘+ / ⌘− the text size here? Exactly when the shell can listen. In a browser the same keys are the
// zoom — the UI must not promise them there.
export function hasTextShortcut(w: unknown): boolean {
  const s = shellBridge(w);
  return !!s && typeof s.onTextSize === "function";
}

// Does the page run in a shell (the client)? For the sentence on how to enlarge "everything together":
// in a shell a shortcut, in a browser its own zoom.
export function inShell(w: unknown): boolean {
  return shellBridge(w) !== null;
}
