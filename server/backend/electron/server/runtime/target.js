// The target of a connection the backend opens ON BEHALF of an instance. A leaf with node:* only — the instance comes as an
// object (the mapped row from store/project-instances.js, `ip` is the project container's address in its project network).
//
// WHY. The loop engine runs in the backend, i.e. in B, also for a converted project. When its model calls "localhost:5173" it
// means the service of ITS project — and that listens in the project container, not in B. Without mapping, WebFetch, the
// WebSocket monitor or an HTTP MCP server on localhost would hit a service of B (worst case a foreign one on the same port).
// Claude and Codex run inside the container themselves and do not need this.
//
// targetFor(url, inst)      `null` without an instance or when the host is not local — then the plain path applies. Otherwise
//                          `{ ip, port, hostname, secure, serverName }`: the connection goes to `ip:port`; URL, Host header
//                          and SNI stay those of the URL (a dev server that checks the Host header sees "localhost:5173").
//                          Local are ONLY `localhost`, 127.0.0.0/8, `::1` and `0.0.0.0` — plus their equivalent spellings
//                          `localhost.`, `::` and 127/8 in IPv6 (`::ffff:127.0.0.1`, the URL writes `::ffff:7f00:1`); the URL
//                          itself normalises decimal and hex forms of 127/8. Everything else (also `<project>.cbase`, which
//                          /etc/hosts in B already points to the instance) is left alone. An instance without an IP THROWS:
//                          a local host without a target would otherwise silently run in B (empty is not unknown).
// connectionTo(target)     the `createConnection` for http(s).request and `ws`: TCP to `ip:port`, with TLS using SNI and
//                          certificate verification against the URL's host (never against the IP). Of the caller's options
//                          only the TLS settings are passed on — never `path`, `host`, `port` (a `path` would turn
//                          net.connect into a Unix socket connection).
// networkOptions(url, inst)  THE switch of the three callers: `null` without an instance (plain path), `{ createConnection }`
//                          for a mapped host, otherwise `{ lookup: lookupInProject }` — the WATCH: with an instance NO
//                          connection may hit a service of B, not even via a name that DNS points to 127.0.0.1
//                          ("localtest.me"), a redirect there, or B's own LAN address — the fence lets a source outside
//                          10.230/16 pass. What is checked is what is REALLY connected: the watch sits as `lookup` in
//                          net.connect and rejects as soon as ONE answer is `addressOfB` (no second resolution that DNS
//                          could answer differently). net.connect does not resolve an IP literal — it is checked here at
//                          once (throws). The watch knows the instance (closure and agent pool per identifier and IP):
//                          also off limits is every address in the range of the project networks (`PROJECT_NETWORKS`)
//                          except `inst.ip` — the network of a neighbouring project, by name or by literal.
// addressOfB(address)      loopback (127/8, ::1, also as ::ffff:127.x or v4-compatible ::7f00:1), unspecified (0.0.0.0/8, ::)
//                          or the address of an interface of B (`os.networkInterfaces()`, read per call — project networks
//                          come and go; the bridge `cbp-*` holds the .1 of every project network). The instance's own IP
//                          is not one.
// requestInProject(url, init, inst)
//                          a small `fetch` for the engine (WebFetch, HTTP MCP): `http(s).request` with `createConnection` or
//                          the watch (no new runtime dependency). Redirects by hand (at most 20, like fetch); EVERY hop goes
//                          through `networkOptions` again: a redirect to the outside goes outside (not to the IP, and never
//                          to B), one to localhost into the instance. 303 and 301/302 after POST become GET without a body;
//                          across an origin change `authorization`, `cookie`, `proxy-authorization` are dropped (like fetch).
//                          Without the caller's own `accept-encoding`, "gzip, deflate, br" is sent (like fetch);
//                          `content-encoding` gzip/deflate/br is unpacked — as a list, backwards ("gzip, br"; an unknown one
//                          ⇒ raw, more than five ⇒ error) —, an empty encoded body is empty, not an error (undici's flush
//                          levels). `init.maxBytes` caps the body read (unpacked); after that the connection is ended.
//                          Returns what the callers read of a fetch Response: `ok`, `status`, `url`, `headers.get(name)`,
//                          `text()`, `arrayBuffer()`.
// setNetworkSeam({ lookup, interfaces })
//                          tests ONLY: replaces the watch's `dns.lookup` / `os.networkInterfaces`; returns the undo.
//
// Callers: providers/tool-runtime.js (WebFetch), providers/monitor-runtime.js (WebSocket), providers/mcp-client.js (HTTP MCP)
// — each ONLY with an instance; without one they make the plain call (`fetch`, `new WebSocket(url, protocols)`).
// Guard: server/backend/test/network-target.test.js (a decoy on 127.0.0.1, the instance on the second loopback address; the
// watch with a test lookup onto the decoy).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import zlib from "node:zlib";

const LOCAL_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAX_FORWARDINGS = 20;
const FORWARDING = new Set([301, 302, 303, 307, 308]);
const TLS_TOGGLE = ["ca", "cert", "key", "pfx", "passphrase", "rejectUnauthorized", "ciphers", "minVersion", "maxVersion", "secureContext", "ALPNProtocols"];

const withoutBrackets = (h) => {
  const s = String(h || "");
  return s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
};

/** Is a URL's host the loopback or the unspecified address (see the header)? */
export function localHost(hostname) {
  let h = withoutBrackets(hostname).toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (LOCAL_V4.test(h)) return true;
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (hex) return (parseInt(hex[1], 16) >> 8) === 127;
  // The v4-compatible form `::hhhh:hhhh` (the URL writes `::127.0.0.1` as `::7f00:1`) — `::` and `::1` are handled above.
  const compatible = h.match(/^::([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (compatible && parseInt(compatible[1], 16) !== 0) return (parseInt(compatible[1], 16) >> 8) === 127;
  const point = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return Boolean(point) && LOCAL_V4.test(point[1]);
}

export function targetFor(url, inst) {
  if (!inst) return null;
  const u = url instanceof URL ? url : new URL(String(url));
  const hostname = withoutBrackets(u.hostname);
  if (!localHost(hostname)) return null;
  const ip = withoutBrackets(String(inst.ip || "").trim());
  if (!net.isIP(ip)) {
    throw new Error(`Instance ${inst.identifier || inst.projectId || "?"} has no IP — ${u.host} is not connected in B`);
  }
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const port = Number(u.port) || (secure ? 443 : 80);
  return { ip, port, hostname, secure, serverName: net.isIP(hostname) ? "" : hostname };
}

export function connectionTo(target) {
  return (opts = {}) => {
    if (!target.secure) return net.connect({ host: target.ip, port: target.port });
    const tlsOpts = {};
    for (const k of TLS_TOGGLE) if (opts[k] !== undefined) tlsOpts[k] = opts[k];
    return tls.connect({
      ...tlsOpts,
      host: target.ip,
      port: target.port,
      ...(target.serverName ? { serverName: target.serverName } : {}),
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(target.hostname, cert),
    });
  };
}

// ── The watch (see the header) ───────────────────────────────────────────────────────────────────────────────────────────
let seam = { lookup: null, interfaces: null };
/** Tests ONLY: `lookup` replaces dns.lookup (same signature), `interfaces` os.networkInterfaces. Returns the undo. */
export function setNetworkSeam({ lookup = null, interfaces = null } = {}) {
  const old = seam;
  seam = { lookup, interfaces };
  return () => { seam = old; };
}

// An IP in ONE spelling: IPv6 canonical (the URL compresses and lower-cases), without zone; ::ffff:a.b.c.d as a.b.c.d.
function canonical(address) {
  const a = withoutBrackets(address).split("%")[0].toLowerCase();
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return null;
  const k = new URL(`http://[${a}]/`).hostname.slice(1, -1);
  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (v4-compatible, high word ≠ 0; `::` and `::1` stay IPv6).
  const v4 = k.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) || k.match(/^::([1-9a-f][0-9a-f]{0,3}):([0-9a-f]{1,4})$/);
  if (!v4) return k;
  const up = parseInt(v4[1], 16);
  const deep = parseInt(v4[2], 16);
  return `${up >> 8}.${up & 255}.${deep >> 8}.${deep & 255}`;
}

export function addressOfB(address, interfaces = (seam.interfaces || os.networkInterfaces)()) {
  const a = canonical(address);
  if (!a) return false;
  if (a === "::" || a === "::1" || /^(127|0)\./.test(a)) return true;
  for (const list of Object.values(interfaces || {})) {
    for (const e of list || []) if (canonical(e?.address) === a) return true;
  }
  return false;
}

function denied(host, address) {
  const e = new Error(`"${host}" points to ${address}, an address of B — for a project in a container it is not connected; `
    + "you reach the project's service via localhost");
  e.code = "ECBASETARGET";
  return e;
}

// ── The project network of ANOTHER project ───────────────────────────────────────────────────────────────────────────────
// The range of the project networks — THE SAME as `LEVEL2_AREA` in projectbox/creation.js (this leaf imports only node:*;
// network-target.test.js keeps the two equal). With an instance every address in it is off limits except its own (`inst.ip`):
// otherwise a project's engine would reach a neighbouring project's service via a name or a literal — the bridges (`cbp-*`,
// .1 each) are interfaces of B and already fall under `addressOfB`.
export const PROJECT_NETWORKS = "10.230.0.0/16";
const PROJECT_NETWORK_PREFIX = "10.230.";
/** Is `address` in the range of the project networks but not the IP of the instance `inst`? */
export function foreignProjectNetwork(address, inst) {
  const a = canonical(address);
  if (!a || !net.isIPv4(a) || !a.startsWith(PROJECT_NETWORK_PREFIX)) return false;
  return a !== canonical(String(inst?.ip || ""));
}
function foreignDenied(host, address) {
  const e = new Error(`"${host}" points to ${address}, the project network of another project — for a project in a container it is not `
    + "connected; you reach the project's service via localhost");
  e.code = "ECBASETARGET";
  return e;
}

// The watch — `inst` null means without an instance (only B's addresses; that is how `lookupInProject` checks).
function watch(inst, hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const resolve = seam.lookup || dns.lookup;
  resolve(hostname, options || {}, (err, address, family) => {
    if (err) { callback(err); return; }
    const list = Array.isArray(address) ? address : [{ address, family }];
    const interfaces = (seam.interfaces || os.networkInterfaces)();
    const hits = list.find((e) => addressOfB(e?.address, interfaces));
    if (hits) { callback(denied(hostname, hits.address)); return; }
    const neighbor = inst ? list.find((e) => foreignProjectNetwork(e?.address, inst)) : null;
    if (neighbor) { callback(foreignDenied(hostname, neighbor.address)); return; }
    callback(null, address, family);
  });
}

/** `lookup` for net.connect: resolves like dns.lookup and rejects as soon as one answer is `addressOfB` (without an instance). */
export function lookupInProject(hostname, options, callback) {
  watch(null, hostname, options, callback);
}

// ONE watch and ONE agent pool per instance (key: identifier and IP — a new IP of the same identifier gets a new pool): a
// socket from another instance's pool was checked against that instance's IP and would be reused for the same name. Defaults
// like the globalAgent; idle sockets close after 5 s.
const WATCHES = new Map();
function watchOf(inst) {
  const key = `${inst.identifier || inst.projectId || "?"}\u0000${String(inst.ip || "")}`;
  let w = WATCHES.get(key);
  if (!w) {
    const lookup = (hostname, options, callback) => watch(inst, hostname, options, callback);
    w = {
      lookup,
      agent: {
        "http:": new http.Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000, lookup }),
        "https:": new https.Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000, lookup }),
      },
    };
    WATCHES.set(key, w);
  }
  return w;
}

export function networkOptions(url, inst) {
  if (!inst) return null;
  const u = url instanceof URL ? url : new URL(String(url));
  const target = targetFor(u, inst);
  if (target) return { createConnection: connectionTo(target) };
  const host = withoutBrackets(u.hostname);
  if (net.isIP(host) && addressOfB(host)) throw denied(host, host);
  if (net.isIP(host) && foreignProjectNetwork(host, inst)) throw foreignDenied(host, host);
  return { lookup: watchOf(inst).lookup };
}

// The agent pool of an instance's watch (see watchOf) — oneJump uses it for every unmapped host.
const watchAgent = (inst, log) => watchOf(inst).agent[log];

// The headers as an object with lower-case names (copies — a hop changes them).
function headersValue(h) {
  const out = {};
  const pairs = h && typeof h.get === "function" && typeof h.entries === "function" ? h.entries() : Object.entries(h || {});
  for (const [k, v] of pairs) if (v !== undefined) out[String(k).toLowerCase()] = v;
  return out;
}

// Flush levels like undici: an empty or at its end truncated encoded body (HEAD, 204, a compression middleware that writes
// "gzip" on an empty response too) ends empty instead of with "unexpected end of file" — we ask for compression, so this
// hits us.
//
// `content-encoding` is a LIST in encoding order ("gzip, br" = first gzip, then br) — unpacking goes backwards, each element
// its own stream. `identity` and empty entries do not count; an unknown encoding anywhere in the list means: do not unpack at
// all (raw); more than MAX_ENCODINGS is an error (like undici). Returns: list of unpackers (empty = raw).
const MAX_ENCODINGS = 5;
function unpacker(encoding) {
  const segments = String(encoding || "").split(",").map((k) => k.trim().toLowerCase()).filter((k) => k && k !== "identity");
  if (segments.length > MAX_ENCODINGS) throw new Error(`too many encodings in content-encoding (${segments.length}, at most ${MAX_ENCODINGS})`);
  const z = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const build = (k) => {
    if (k === "gzip" || k === "x-gzip") return () => zlib.createGunzip(z);
    if (k === "deflate") return () => zlib.createInflate(z);
    if (k === "br") return () => zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    return null;
  };
  const factories = segments.map(build);
  if (factories.some((f) => !f)) return [];
  return factories.reverse().map((f) => f());
}

// ONE hop: the response with the body read (unpacked, capped). `network` from networkOptions (null without an instance: the
// global agent without the watch — no caller does that, see the header); `inst` selects the watch's agent pool.
function oneJump(u, { method, headers, body, signal, maxBytes }, network, inst) {
  return new Promise((resolve, reject) => {
    const module = u.protocol === "https:" ? https : http;
    const opts = {
      protocol: u.protocol,
      hostname: withoutBrackets(u.hostname),
      port: u.port || undefined,
      path: `${u.pathname || "/"}${u.search || ""}`,
      method,
      headers,
      ...(signal ? { signal } : {}),
    };
    if (network?.createConnection) opts.createConnection = network.createConnection;
    else if (network?.lookup) { opts.agent = watchAgent(inst, u.protocol); opts.lookup = network.lookup; }
    let finished = false;
    const end = (fn, value) => { if (!finished) { finished = true; fn(value); } };
    const req = module.request(opts, (res) => {
      const status = res.statusCode || 0;
      if (FORWARDING.has(status) && res.headers.location) {
        res.resume();
        end(resolve, { status, headers: res.headers, location: String(res.headers.location), body: Buffer.alloc(0) });
        return;
      }
      let unpack;
      try { unpack = unpacker(res.headers["content-encoding"]); } catch (e) { res.destroy(); end(reject, e); return; }
      let stream = res;
      for (const segment of unpack) {
        segment.on("error", (e) => end(reject, e));
        stream = stream.pipe(segment);
      }
      const parts = [];
      let length = 0;
      const complete = () => end(resolve, { status, headers: res.headers, location: null, body: Buffer.concat(parts) });
      stream.on("data", (d) => {
        if (finished) return;
        parts.push(d);
        length += d.length;
        if (length >= maxBytes) { complete(); res.destroy(); }
      });
      stream.on("end", complete);
      stream.on("error", (e) => end(reject, e));
      res.on("error", (e) => end(reject, e));
      // The other side closed in the middle of the body (without `end`): an error, not a short response.
      res.on("close", () => { if (!res.complete) end(reject, new Error("connection closed in the middle of the response")); });
    });
    req.on("error", (e) => end(reject, e));
    if (body !== undefined && body !== null) req.end(body);
    else req.end();
  });
}

export async function requestInProject(url, init = {}, inst) {
  const { signal, redirect = "follow" } = init;
  const maxBytes = Number(init.maxBytes) > 0 ? Number(init.maxBytes) : Infinity;
  let u = new URL(String(url));
  let method = String(init.method || "GET").toUpperCase();
  let body = init.body;
  let headers = headersValue(init.headers);
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "gzip, deflate, br";
  for (let jump = 0; ; jump++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError(`Protocol not supported: ${u.protocol}`);
    const r = await oneJump(u, { method, headers, body, signal, maxBytes }, networkOptions(u, inst), inst);
    if (r.location && redirect === "follow") {
      if (jump >= MAX_FORWARDINGS) throw new Error(`too many redirects (${MAX_FORWARDINGS})`);
      const next = new URL(r.location, u);
      if ((r.status === 303 && method !== "HEAD") || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !["content-type", "content-length", "content-encoding", "content-language", "content-location"].includes(k)));
      }
      if (next.origin !== u.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !["authorization", "cookie", "proxy-authorization"].includes(k)));
      }
      u = next;
      continue;
    }
    const bodyText = r.body;
    const header = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: u.href,
      redirected: jump > 0,
      headers: {
        get: (name) => {
          const v = header[String(name).toLowerCase()];
          return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
        },
      },
      text: async () => bodyText.toString("utf8"),
      arrayBuffer: async () => bodyText.buffer.slice(bodyText.byteOffset, bodyText.byteOffset + bodyText.byteLength),
    };
  }
}
