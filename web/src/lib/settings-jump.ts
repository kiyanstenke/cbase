// Open a given settings page from outside (e.g. "Share link" without ngrok access jumps to Integrations → ngrok).
// TopNav owns the modal and listens for the window event; `page` is a key from `SECTIONS` in
// components/settings/SettingsModal.tsx, optionally with a subpage (`integrations:ngrok`). A leaf module: callers
// that only want to jump do not pull the settings pages into their bundle.
export const SETTINGS_OPEN = "cbase-settings";

export function openSettings(page: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SETTINGS_OPEN, { detail: { page } }));
}

/**
 * CLOSE the modal from inside: the wait list under Usage → At limit jumps into a row's chat. If that chat is on THIS
 * page, the chat list's event opens it and the modal would cover it. The page cannot reach TopNav's state (which owns
 * the modal), so this uses the same event form as the way in.
 */
export const SETTINGS_CLOSE = "cbase-settings-close";

export function closeSettings() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SETTINGS_CLOSE));
}

/**
 * The second way in, via the ADDRESS: `GET /gw/admin` redirects to `/?settings=administration` (ADMINISTRATION_JUMP in
 * lib/api/administration.ts, bound to the gateway contract in web/test/administration-binding.test.mjs). TopNav reads
 * it once on load and opens the page.
 */
export const SETTINGS_PARAMETER = "settings";

/**
 * The page from an address, plus the same address WITHOUT the parameter so a reload does not reopen the modal. `null`
 * if the address carries none. An empty value (`?settings=`) opens the modal on its first page (`page: ""`).
 */
export function settingsFromAddress(href: string): { page: string; without: string } | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  const page = u.searchParams.get(SETTINGS_PARAMETER);
  if (page === null) return null;
  u.searchParams.delete(SETTINGS_PARAMETER);
  return { page: page.trim(), without: u.toString() };
}
