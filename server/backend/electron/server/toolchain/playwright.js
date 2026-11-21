// Playwright MCP: pinned version, prewarming, entry point, configuration and profile paths, browser modes and
// resolveChatHeadless (visibility of the browser per chat).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workspaceProfileDir } from "../browser-profiles.js";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { playwrightOutputLocation, playwrightConfigFile } from "../runs/runtime-location.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";


// Playwright MCP for browser debugging (official @playwright/mcp, started via npx; the browser itself only starts on first
// tool use, default channel is Chrome).
//  • headless: no visible window — e2e tests run in the background. Does NOT restrict automation (click/type/navigate/
//    screenshots/JS all work).
//  • userDataDir = persistent profile so logins survive across runs. Deliberately under the app data folder instead of
//    ~/Library/Caches (which macOS may purge under storage pressure) → lasting logins.
// Configured through a --config file instead of CLI flags: only that way launchOptions.args can be set.
// --remote-debugging-port=0 makes Chromium write its CDP address to <profile>/DevToolsActivePort — that is how browsers.js
// discovers running agent browsers (display "browser active" + viewer window) without disturbing Playwright (second CDP
// client). Config launchOptions are merged, the default channel stays Chrome.
//
// Version PINNED instead of @latest: npx resolves "latest" through the registry on EVERY start — and the server is started
// anew for every chat turn or workflow step (per CLI process). The local cbase MCP connected at once while playwright hung as
// "pending" and then reported all tools as "readded" — an agent read that as "server constantly disconnecting" and avoided the
// browser entirely. An exact version comes from the npx cache without network; it is updated deliberately with an app update.
const PLAYWRIGHT_MCP_VERSION = "0.0.84";
const playwrightMcpPkg = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
// Fill the cache once in the background so that even the FIRST browser chat connects at once.
const prewarmPlaywrightMcp = () => {
  try {
    execFile(process.env.NPX_BIN || "npx", ["-y", playwrightMcpPkg, "--version"], { timeout: 300_000 }, () => {});
  } catch { /* best effort — on failure the first real start downloads it */ }
};
// `outputDir`: screenshots, recordings and downloads of the MCP land in the working folder by default (`.playwright-mcp/`) —
// in a project container that is the project folder, i.e. the project repo. For a profile in a project's runtime folder it
// therefore points to the chat's output location (runs/runtime-location.js playwrightOutputLocation); otherwise the key is
// absent and the configuration stays byte-identical.
//
// `cdpEndpoint`: the main agent drives the user's OWN browser — Playwright then starts no Chromium but connects to it. No
// `userDataDir`, no `launchOptions` (they would apply only to a launch). `userDataDir` then only determines the LOCATION
// (configuration file, output location) — the profile itself is not created. At the end Playwright only disconnects
// (`ownership: "attached"`), browser and tabs stay.
//
// Tools and window: by default the MCP exposes only the `core*` groups (click, type, tabs, navigation, snapshot, screenshot,
// console, network list, evaluate). Added via `PLAYWRIGHT_CAPABILITIES`: `network` (mock responses, offline), `storage`
// (cookies, local/sessionStorage, login state), `testing` (assertions, locators for e2e tests), `vision` (mouse by
// coordinates — canvases like the workflow editor). Deliberately NOT: `devtools` (video, trace), `pdf`, `config` — rarely
// needed, and every description costs context every turn. The window of the agent's OWN browser is 1440×900 (desktop layouts
// as a human sees them; default 1280×720); never at the user's browser (cdpEndpoint) — their window applies there.
const PLAYWRIGHT_CAPABILITIES = Object.freeze(["network", "storage", "testing", "vision"]);
const PLAYWRIGHT_WINDOW = Object.freeze({ width: 1440, height: 900 });
const playwrightMcpEntry = (npxCmd, { headless = true, userDataDir = "", cdpEndpoint = "" } = {}) => {
  const cfg = cdpEndpoint
    ? { browser: { browserName: "chromium", cdpEndpoint: String(cdpEndpoint) } }
    : { browser: { launchOptions: { headless: !!headless, args: ["--remote-debugging-port=0"] }, contextOptions: { viewport: { ...PLAYWRIGHT_WINDOW } } } };
  cfg.capabilities = [...PLAYWRIGHT_CAPABILITIES];
  if (userDataDir && !cdpEndpoint) cfg.browser.userDataDir = userDataDir;
  const output = playwrightOutputLocation(userDataDir);
  if (output) cfg.outputDir = output;
  if (process.env.CBASE_CONTAINER === "1" && !cdpEndpoint) {
    // There is no Google Chrome in the container — use the apt Chromium explicitly.
    cfg.browser.browserName = "chromium";
    cfg.browser.launchOptions.executablePath = process.env.CBASE_CHROMIUM || "/usr/bin/chromium";
    cfg.browser.launchOptions.args.push("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  }
  const cfgPath = playwrightConfigPath(userDataDir, headless);
  // In a project's runtime folder (`<runtime>/playwright-configs/…`) via the descriptor (runs/runtime-write.js): a link in
  // place of the file or folder would otherwise make B write the configuration through a file of B. Otherwise directly.
  if (!writeInRuntimeFolder(cfgPath, JSON.stringify(cfg, null, 2))) {
    fs.mkdirSync(path.dirname(playwrightConfigPath(userDataDir, headless)), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  return { command: npxCmd, args: ["-y", playwrightMcpPkg, "--config", cfgPath] };
};
// Config file per profile and visibility (h=headless, s=shown) — the cleanup path when deleting a chat needs this name too,
// hence its own function. It lives next to the profile root of its profile (in the project's runtime folder if the profile
// is there) — runs/runtime-location.js.
const playwrightConfigPath = (userDataDir, headless) => playwrightConfigFile(userDataDir, headless);
// Whether the Playwright browser runs headless (background): ALWAYS. The setting `playwright_headless` and the column
// `chats.browser_mode` remain but have no effect — watching and intervening goes through the browser stream.
const playwrightHeadless = () => true;
// Root of the login STOCK (under the app data folder, not ~/Library/Caches). It stays FLAT, also for chats of converted
// projects (the login stock stays outside, the backend copies in and back) — the named exception of the path guard
// (server/backend/test/runtime-location.test.js). The profiles of chats and subagents live in their chat's runtime folder
// (runs/runtime-location.js playwrightProfileRoot) — flat, the same root as here.
const loginStockRoot = () => path.join(DIRS.data, "playwright-profiles");
// Workspace profile: shared login STOCK (and the profile of manual claude calls in the workspace folder, see
// writeWorkspaceMcpJson). Chats do NOT browse in it — each gets its own profile, otherwise Chromium's profile lock blocks the
// second chat (browser-profiles.js).
const playwrightProfileDir = (workspaceId) => workspaceProfileDir(loginStockRoot(), workspaceId);
// The visibility per chat (column chats.browser_mode: '', 'shown', 'hidden') no longer applies; every chat is headless
// whatever it says. `BROWSER_MODES` remains the list of values a PATCH accepts (legacy data).
const BROWSER_MODES = ["", "shown", "hidden"];
const resolveChatHeadless = (_chat) => playwrightHeadless();

export { BROWSER_MODES, PLAYWRIGHT_CAPABILITIES, PLAYWRIGHT_WINDOW, loginStockRoot, playwrightConfigPath, playwrightHeadless, playwrightMcpEntry, playwrightProfileDir, prewarmPlaywrightMcp, resolveChatHeadless };
