// Pure rules of the client shell at its outer boundaries.
//
// Like browser-rules.js and forwarding-rules.js: runs without Electron and is tested
// (client/test/shell-client.test.mjs). main.js measures (which window, which frame, which URL) and asks here; browser.js
// receives the finished checks from main.js (`senderMay`, `openExternally`) — so every decision lives in exactly one
// place, and `shell.openExternal` has exactly ONE caller in the client.
//
// Three boundaries:
//  • outward: what the shell hands to the operating system to open;
//  • the OAuth relay: which paths from 127.0.0.1:1455 are passed on with the gateway session;
//  • inward: which sender may use an IPC channel of the shell.

// ── Opening externally ───────────────────────────────────────────────────────
// `shell.openExternal` hands a URL to the operating system, and macOS starts the program of its scheme: `smb://host/x`
// makes Finder mount a foreign server; `ssh://`, `x-…://` and URI handlers of other programs start their app with data
// from the URL. Whatever a page names as a target — a click, a `window.open`, agent output inside it — is untrusted text.
// Allowed is what a browser itself opens (http, https, mailto) and the one desktop link cbase builds itself:
// `vscode://vscode-remote/<authority>/…` — and ONLY with the two authorities web/src/lib/vscode-tunnel.ts builds:
// `tunnel+<name>` and `attached-container+<hex>@tunnel+<name>`. The authority selects the remote resolver in VS Code,
// and the others connect elsewhere: `ssh-remote+<host>` opens an SSH connection to an arbitrary host,
// `dev-container+…`/`attached-container+…` without a tunnel reach the local Docker, likewise `wsl+`, `codespaces+` and
// resolvers of third-party extensions. Checked is the first segment of the PARSED path — `tunnel+x/../ssh-remote+h/`
// reads `/ssh-remote+h/` after parsing and is rejected. Other `vscode://` targets are rejected as well.
// Returned is the PARSED form: what was checked is what gets opened. The parser strips a control character before the
// scheme (`\u0001smb://…`) — with the raw string the operating system would decide a second time, and differently.
export const EXTERN_SCHEMATA = Object.freeze(["http:", "https:", "mailto:"]);
export const VSCODE_AUTHORITY = /^\/(?:tunnel\+[a-z0-9][a-z0-9-]{0,19}|attached-container\+(?:[0-9a-f]{2})+@tunnel\+[a-z0-9][a-z0-9-]{0,19})(?:\/|$)/;

export function externalTarget(url) {
  if (typeof url !== "string" || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (EXTERN_SCHEMATA.includes(u.protocol)) return u.href;
  if (u.protocol === "vscode:" && u.host === "vscode-remote" && VSCODE_AUTHORITY.test(u.pathname)) return u.href;
  return null;
}

// What may be logged about a rejected target: only the scheme. The URL itself can carry credentials (`?token=…`, an
// OAuth callback) and does not belong in a console that someone copies into a ticket.
export function schemaOf(url) {
  try { return new URL(String(url)).protocol || "?"; } catch { return "unreadable"; }
}

// ── OAuth relay ──────────────────────────────────────────────────────────────
// After a Codex login the relay listens on 127.0.0.1:1455 for ten minutes and passes every request on WITH the gateway
// session. Meant is only `/api/codex-oauth/…` (the callback from OpenAI, `/auth/callback?code=…&state=…`). If the raw
// request path were appended to the gateway URL, `net.request` would normalize it: `GET /../../api/runs/active` or
// `/%2e%2e/…` from any process on this machine would reach the gateway as `GET /api/runs/active` with the session
// cookie, and the answer would go back to the asker. Hence two checks:
//  (1) BEFORE building: the path (without search) must not carry a dot segment (".", ".."), a backslash or a
//      control/space character at any decoding stage — `%2e%2e` is ".." to the URL parser, `\` is "/", and a double
//      encoding (`%252e%252e`) is decoded until stable (at most DECODE_STAGES times, otherwise rejected). A broken escape
//      (`%zz`) is a no as well.
//  (2) AFTER normalization: the final target is on the origin of the gateway URL and under its prefix.
// The search (`?code=…`) stays as it is — it does not change the path. Only origin-form paths (`/…`); the absolute form
// (`GET http://other/…`) and `*` are not callbacks.
export const OAUTH_PREFIX = "/api/codex-oauth";
export const DECODE_STAGES = 4;
const CONTROL_OR_EMPTY = /[\u0000- \u007f]/;

export function oauthRelayTarget(serverUrl, reqUrl) {
  if (typeof reqUrl !== "string" || !reqUrl.startsWith("/") || CONTROL_OR_EMPTY.test(reqUrl) || reqUrl.includes("#")) return null;
  let base;
  try { base = new URL(String(serverUrl || "")); } catch { return null; }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  const question = reqUrl.indexOf("?");
  let stage = question < 0 ? reqUrl : reqUrl.slice(0, question);
  for (let i = 0; ; i++) {
    if (stage.includes("\\") || CONTROL_OR_EMPTY.test(stage)) return null;
    if (stage.split("/").some((seg) => seg === "." || seg === "..")) return null;
    let next;
    try { next = decodeURIComponent(stage); } catch { return null; }
    if (next === stage) break;
    if (i >= DECODE_STAGES) return null;
    stage = next;
  }
  const prefix = base.pathname.replace(/\/+$/, "") + OAUTH_PREFIX;
  let target;
  try { target = new URL(`${base.origin}${prefix}${reqUrl}`); } catch { return null; }
  if (target.origin !== base.origin) return null;
  if (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  return target.href;
}

// ── Who may address the shell via IPC ────────────────────────────────────────
// The preload exposes the bridge only to the server origin, and `contextIsolation` keeps `ipcRenderer` away from the
// page — but a promise that hangs on one place in the renderer breaks with the first page that looks different there.
// So the main process checks every channel, with ONE rule:
//  • the sender is the cbase window itself (not a child window, not a browser view) — `fromTheWindow`;
//  • its main frame speaks, not an embedded one (`frame.parent` is null);
//  • and the frame's origin matches the surface: "server" = the origin of the stored server URL (the UI), "connect" =
//    the connect page (`file:`, connect.html), "window" = any page in the window's main frame — only for the preload's
//    one question whether its page is the server origin (`cbase:get-server-sync`): it arrives BEFORE the bridge is
//    exposed, and `location.origin` decides there.
// `frame` is Electron's `senderFrame` (WebFrameMain: `url`, `parent`); null means "already navigated away" — then no.
export const IPC_SURFACES = Object.freeze(["server", "connect", "window"]);

export function ipcSenderAllowed({ fromTheWindow, frame } = {}, surface, serverUrl) {
  if (fromTheWindow !== true || !frame || typeof frame !== "object" || frame.parent != null) return false;
  if (surface === "window") return true;
  let u;
  try { u = new URL(String(frame.url ?? "")); } catch { return false; }
  if (surface === "connect") return u.protocol === "file:";
  if (surface !== "server") return false;
  let s;
  try { s = new URL(String(serverUrl || "")); } catch { return false; }
  return (s.protocol === "http:" || s.protocol === "https:") && u.origin === s.origin;
}
