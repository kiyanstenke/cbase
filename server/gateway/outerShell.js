// The gateway's outer shell: what index.js reads from every request before it decides — as pure functions, so they can be
// tested without a running server (index.js starts a server on load). Wired and checked against the real process in
// index.test.js.
import net from "node:net";

// ── The request URL ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// `new URL(req.url, "http://gateway")` throws for `GET //`, `GET ///`, `GET /\` (the backslash counts as a slash in the http
// scheme) or an absolute target with an impossible authority (`GET http://a:99999/`); an unhandled rejection from there would end
// the gateway for ALL users, unauthenticated and repeatably. Hence null instead of a throw; the caller answers 400.
export function requestUrl(rawUrl) {
  try { return new URL(String(rawUrl ?? ""), "http://gateway"); } catch { return null; }
}

// ── Cookies ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// An unguarded `decodeURIComponent` would let a FOREIGN cookie containing `%` (a sibling app with a domain cookie,
// `other_app=50%`) turn EVERY /gw and /api request into a 500. An unreadable value therefore stays raw, and only the first `=`
// separates name and value (a value may contain `=`).
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    const name = (i < 0 ? s : s.slice(0, i)).trim();
    if (!name) continue;
    const raw = i < 0 ? "" : s.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* unreadable: keep raw */ }
    out[name] = value; // like Object.fromEntries: on a duplicate name the last wins
  }
  return out;
}

// ── who is really asking? ───────────────────────────────────────────────────────────────────────────────────────────────────
// Behind a local tunnel (e.g. cloudflared) EVERY connection comes from 127.0.0.1 — the login limit per socket address would apply to all users
// together. The real address is carried by Cloudflare in `CF-Connecting-IP`. The header is believed ONLY if the connection comes
// from a trusted hop: loopback, or what `GW_TRUSTED_PROXYS` names (comma list, read at runtime) — if cloudflared ever does not
// run on the host itself, its address goes there. Any other connection (e.g. a user container via the host's bridge address)
// counts with its own address; it cannot claim a foreign one.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function trustedProxys() {
  const extra = String(process.env.GW_TRUSTED_PROXYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...LOOPBACK, ...extra]);
}
export function clientAddress(req) {
  const plinth = String(req?.socket?.remoteAddress || "");
  if (trustedProxys().has(plinth)) {
    const cf = String(req?.headers?.["cf-connecting-ip"] || "").trim();
    if (cf && net.isIP(cf)) return cf;
  }
  return plinth || "?";
}

// ── The key of an address for the brake ──────────────────────────────────────────────────────────────────────────────────────
// Counting per FULL address would mean /128 for IPv6, yet a connection gets a whole /64 (often more), and a requester could take
// a new address from it per attempt: no limit reached, and every attempt costing a scrypt. A phone with privacy addresses also
// arrives with a new address of the SAME /64 after a network or day change — the proof (below) would miss it. Hence the key is
// the /64 prefix for IPv6 ("2001:db8:1:2::/64"), the address for IPv4; an IPv4 in IPv6 form (`::ffff:a.b.c.d`) counts as IPv4.
// What is not an address (the "?" fallback of clientAddress) stays as it is.
function ipv6Groups(address) {
  let s = address.toLowerCase();
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/); // embedded IPv4 at the end (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = s.split("::"); // net.isIP has checked: at most one "::"
  const header = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const gap = parts.length > 1 ? 8 - header.length - tail.length : 0;
  return [...header, ...Array(gap).fill("0"), ...tail].map((g) => parseInt(g, 16) || 0);
}
export function addressKey(address) {
  const raw = String(address ?? "").trim();
  const withoutZone = raw.replace(/%.*$/, "");
  const kind = net.isIP(withoutZone);
  if (kind === 4) return withoutZone;
  if (kind !== 6) return raw;
  const g = ipv6Groups(withoutZone);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

// ── The login brake ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//  · only FAILURES count (after the check) — a correct password costs nothing;
//  · per address KEY (addressKey: IPv4 address, IPv6 /64): `perAddress` failures in the window ⇒ that key waits (before the
//    check, so one connection cannot keep the gateway busy with scrypt);
//  · per user name across all addresses: `perName` failures in the window ⇒ the name waits for NEW addresses. A key from which
//    this name logged in successfully within the last `provenMs` is exempt (not from the address limit). The proof lives in
//    `storage` (in operation gateway.db, the login_proven table) and therefore survives a gateway restart. A stranger thus cannot lock
//    a user out of the connections they have already logged in from. A distributed guesser stays at `perName`. Honest limit: from
//    a connection the name has NOT logged in from in the last 30 days (new network, holiday) even the right password waits
//    WHILE someone keeps guessing the name — existing sessions keep working. Without `storage` (unit tests) the proof is in memory.
//  · the maps are capped (`maxEntries` per map, the oldest drop) and emptied on sweep.
export function loginBrake({ windowMs = 5 * 60_000, perAddress = 10, perName = 30, provenMs = 30 * 24 * 3600_000, maxEntries = 10_000, storage = null } = {}) {
  const failedAddress = new Map(); // address key → [timestamps]
  const failedName = new Map(); // name → [timestamps]
  const proven = new Map(); // name → Map(address key → timestamp) — only without `storage`
  const key = (name) => String(name || "").trim().toLowerCase().slice(0, 64);
  const fresh = (list, now) => (list || []).filter((t) => now - t < windowMs);
  const deckle = (map) => { while (map.size > maxEntries) map.delete(map.keys().next().value); };
  const book = (map, k, now) => {
    const list = fresh(map.get(k), now);
    list.push(now);
    map.delete(k); // to the end: the oldest sit at the front and drop first
    map.set(k, list);
    deckle(map);
  };
  const provenSince = (k, a) => {
    if (!storage) return proven.get(k)?.get(a) || 0;
    try { return Number(storage.read(k, a)) || 0; } catch { return 0; } // unreadable: not proven (the name limit applies)
  };
  return {
    // null = may check; otherwise the reason ("address" | "name").
    locked(address, name, now = Date.now()) {
      const a = addressKey(address);
      if (fresh(failedAddress.get(a), now).length >= perAddress) return "address";
      const k = key(name);
      if (fresh(failedName.get(k), now).length < perName) return null;
      const b = provenSince(k, a);
      return b && now - b < provenMs ? null : "name";
    },
    failure(address, name, now = Date.now()) {
      book(failedAddress, addressKey(address), now);
      book(failedName, key(name), now);
    },
    success(address, name, now = Date.now()) {
      const k = key(name);
      const a = addressKey(address);
      if (storage) { try { storage.remember(k, a, now); } catch { /* the login stands anyway */ } return; }
      const m = proven.get(k) || new Map();
      m.delete(a);
      m.set(a, now);
      while (m.size > 64) m.delete(m.keys().next().value); // at most 64 keys per name
      proven.delete(k);
      proven.set(k, m);
      deckle(proven);
    },
    sweep(now = Date.now()) {
      for (const map of [failedAddress, failedName]) {
        for (const [k, v] of map) { const f = fresh(v, now); if (f.length) map.set(k, f); else map.delete(k); }
      }
      for (const [k, m] of proven) {
        for (const [a, t] of m) if (now - t >= provenMs) m.delete(a);
        if (!m.size) proven.delete(k);
      }
      if (storage) { try { storage.sweep(now - provenMs); } catch { /* next sweep */ } }
    },
    size: () => ({ addresses: failedAddress.size, names: failedName.size, proven: proven.size }),
  };
}

// ── concurrent password checks ───────────────────────────────────────────────────────────────────────────────────────────────
// scrypt runs asynchronously (users.verifyLogin) in libuv's thread pool, not on the event loop. The pool is small (4) and also
// serves reading the web UI files; hence at most `max` checks at once, above that the gateway answers 429 at once, without
// scrypt. `proofs()` → true (slot taken) or false (full); `gib()` returns the slot.
export function checkSlots(max = 2) {
  let occupied = 0;
  return {
    proofs() { if (occupied >= max) return false; occupied += 1; return true; },
    gib() { if (occupied > 0) occupied -= 1; },
    get occupied() { return occupied; },
  };
}

// ── Error policy for unhandled rejections ───────────────────────────────────────────────────────────────────────────────────
// The gateway is ONE process for all users: login, proxy, event streams, tunnel, push. By Node's default a single unhandled
// rejection would end it, and with it every open stream of every user. A rejection here always arises in an asynchronous path
// whose state belongs to it alone (a request, a tick, a delivery) — so: report and keep running.
// Deliberately NOT for `uncaughtException`: a synchronous throw from an event (e.g. an 'error' without a listener on a socket)
// can leave shared state half-changed; there Node's exit stays, and the answer is the listener at the seam.
export function installErrorPolicy(proc = process, report = console.error) {
  proc.on("unhandledRejection", (reason) => {
    report("[gateway] unhandled rejection — reported, the process keeps running:", reason?.stack || reason);
  });
}
