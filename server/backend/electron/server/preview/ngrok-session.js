// The ONE ngrok session of the backend (preview links).
//
// All links of a backend run over ONE session to the ngrok edge: the Free plan and Hobbyist allow three agents at a
// time, and a session per link would use them up (and build a new TLS connection for every link). The session is
// created on the first `open` and closes when links.js says so (no active link left, access deleted, server end).
//
// `@ngrok/ngrok` (a native module) is loaded only on first need, via createRequire like `ws` in tunnel.js — if it is
// missing (a build without a prebuild for the platform), the routes answer 501 with the reason instead of the server
// failing to start.
//
// setNgrokSdk(fake)   the test seam: a fake SDK of the same shape (`{ SessionBuilder }`); `null` loads the real one again
// sdkExisting()       can the SDK be loaded?  sdkReason() — the load error if not
// open({ authtoken, target, domain, metadata, stoppedText })  → { url, id, proxy, close() } — a listener on the shared
//                     session; `stoppedText` goes to the proxy (a stopped instance ⇒ 502 "instance stopped"); without
//                     `domain` ngrok assigns the account's dev address (mode `dev`). The listener does NOT forward to
//                     `target` but to its own rewrite proxy (rewrite-proxy.js) on 127.0.0.1, which forwards to `target`;
//                     `close` and `sessionClosed` close both (no open port remains)
// checkAuthtoken(t)   build a SEPARATE session and close it at once (the check on saving, never the shared one)
// sessionClosed()     close all listeners and the session
// sessionsCounted()   { built, open, listener, proxys } — for the counter-check "one session for all links"
import { createRequire } from "node:module";

import { startRewriteProxy } from "./rewrite-proxy.js";

const require = createRequire(import.meta.url);
let sdk = null;
let sdkError = null;

export function setNgrokSdk(fake) {
  sdk = fake || null;
  sdkError = null;
}

function loadSdk() {
  if (sdk || sdkError) return sdk;
  try { sdk = require("@ngrok/ngrok"); } catch (e) { sdkError = String(e?.message || e); }
  return sdk;
}

export const sdkExisting = () => Boolean(loadSdk());
export const sdkReason = () => (loadSdk() ? "" : `@ngrok/ngrok cannot be loaded: ${sdkError}`);

// The shared session: `{ authtoken, p: Promise<Session> }`. The promise exists AT ONCE — two concurrent `open` calls wait
// for the same connection instead of building two.
let session = null;
let built = 0;
const listener = new Set();
const proxys = new Set();

function fetchSession(authtoken) {
  // A new authtoken (settings) applies only to the NEXT session: while listeners are open, the running one stays.
  if (session && (session.authtoken === authtoken || listener.size > 0)) return session.p;
  const old = session;
  const { SessionBuilder } = loadSdk() || {};
  if (!SessionBuilder) throw new Error(sdkReason());
  const entry = { authtoken, p: null };
  entry.p = (async () => {
    if (old) { try { await (await old.p).close(); } catch { /* was already closed */ } }
    // handleDisconnection → true: the session reconnects by itself after a drop, its listeners with it.
    const s = await new SessionBuilder().authtoken(authtoken).handleDisconnection(() => true).connect();
    built += 1;
    return s;
  })();
  entry.p.catch(() => { if (session === entry) session = null; });
  session = entry;
  return entry.p;
}

export async function open({ authtoken, target, domain = null, metadata = "", stoppedText = null }) {
  if (!authtoken) throw new Error("no authtoken");
  const s = await fetchSession(authtoken);
  let b = s.httpEndpoint();
  if (domain) b = b.domain(domain);
  if (metadata) b = b.metadata(metadata);
  // First the proxy, then the listener on it — if opening fails, the proxy closes again (no port without a link).
  const proxy = await startRewriteProxy({ target, stoppedText, log: (what, e) => console.error(`[preview] ${what}:`, e) });
  proxys.add(proxy);
  let l;
  try {
    l = await b.listenAndForward(proxy.url);
  } catch (e) {
    proxys.delete(proxy);
    await proxy.close();
    throw e;
  }
  listener.add(l);
  let to = false;
  return {
    url: l.url() || (domain ? `https://${domain}` : ""),
    id: typeof l.id === "function" ? l.id() : "",
    proxy: proxy.url,
    async close() {
      if (to) return;
      to = true;
      listener.delete(l);
      try { await l.close(); } catch { /* already closed (session gone) */ }
      proxys.delete(proxy);
      await proxy.close();
    },
  };
}

export async function checkAuthtoken(authtoken) {
  const { SessionBuilder } = loadSdk() || {};
  if (!SessionBuilder) throw new Error(sdkReason());
  // No reconnecting: a wrong token must fail, not silently keep trying.
  const s = await new SessionBuilder().authtoken(authtoken).handleDisconnection(() => false).connect();
  try { await s.close(); } catch { /* checked is checked */ }
}

export async function sessionClosed() {
  const s = session;
  session = null;
  const open2 = [...listener];
  listener.clear();
  for (const l of open2) { try { await l.close(); } catch { /* gone with the session */ } }
  const px = [...proxys];
  proxys.clear();
  await Promise.all(px.map((p) => p.close()));
  if (!s) return;
  try { await (await s.p).close(); } catch { /* never connected or already closed */ }
}

export const sessionsCounted = () => ({ built, open: session ? 1 : 0, listener: listener.size, proxys: proxys.size });
