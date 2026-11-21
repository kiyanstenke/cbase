// The `.env*` files of a project, only as KEYS and CLASSIFICATION. A leaf: only node:* and runtime/real-path.js, no store,
// no docker.
//
// THE CONTRACT: no value leaves this file. Every exported function returns key names, line numbers and classifications — never
// the value, never a path from the value, never a host name. The only number taken from a value is a PORT (a port key or the port
// of a target): without it there would be neither the port dismantling nor the random hits, and a number up to 65535 carries no
// secret. The parser that knows values (`split`) is NOT exported.
// Guard: server/backend/test/relocation-plan.test.js ("no value appears …", with counter-proof).
//
// WHAT IS HERE
//   ENV_FILE(name)                  does a file count as `.env*`? (`.env`, `.env.local`, `.env.example`, …)
//   SKIP_ENV_FOLDER, ENV_DEPTH      the folders the walk does not descend into and its default depth — ONCE;
//                                   stacks/result.js searches with the same ones in the copy container
//   stageValue(key, value, ctx) → { targets, port, path, inB, empty, variable, unclear } — the classification of ONE value, without it:
//       targets [{ host, port }] per target (URL, host:port, *_HOST key); `host` is a CLASS:
//               "local"   this machine: localhost, *.localhost, 127/8, ::1, 0.0.0.0, ::, host.docker.internal,
//                         gateway.docker.internal — in the project container that means the project container, no longer B
//               "stack"   a name from `ctx.localNames` (compose services and aliases of the own stack)
//               "cbase"   an instance name `*.cbase` (projectbox/names.js NAMES_SUFFIX; the guard binds both). With
//                         `ctx.ownCbase` (the names that are THIS machine from the source's view — the copy's name) only
//                         those; every other `*.cbase` is then "foreign": seen from the copy `<project>.cbase` is main,
//                         `<other>.cbase` is the main of another project
//               "foreign"   everything else (FQDN, LAN, cloud) — the "real target" of a copy
//               Plus the FURTHER FORMS: nested scheme (`jdbc:postgresql://…`), Oracle (`…:@host:1521…`), `key=value;…` (ADO.NET,
//               Npgsql, ODBC, MySQL, Azure with EndpointSuffix/AccountName/*Endpoint, PDO `mysql:host=…;…`, libpq `host=… port=…`,
//               TNS `(HOST=…)`), lists `a:9092,b:9092` (also with a scheme per entry) and JSON (list or object). Their targets NEVER
//               carry a port (port null): the port dismantling and the random hits are fed only by the old forms — where
//               urlPortPattern can change it. A class the old forms already found is not added twice.
//       unclear true: the value looks like a target (target key such as `*_URL`/`*_DSN`/`*_HOST`/`ConnectionStrings__*`, `://`,
//               `host=`/`server=`/`endpoint=` …) but at least one part could not be classified (e.g. `${HOST}`) — a copy names
//               such keys as "not classified" instead of silently counting them as local
//       port    the number of a port key (`PORT`, `*_PORT`) with a plain number as value, else null
//       path    "inside" (under the `target` of a mount, a file line only exactly), "system" (SYSTEM_PREFIXES: in the project
//               container from its own image), "outside" (else) or null (no path). `~/`, `$HOME/`, `${HOME}/` go through
//               `ctx.home`, `./`/`../` through `ctx.base` (the file's folder).
//       inB     only for "outside": does the path exist in B? (`ctx.exists(path)` → true/false; without a function null = unknown,
//               and unknown is not "missing"). A path that does not exist in B usually means a place INSIDE the stack container
//               (`/app/uploads`) — then it is no hold.
//       empty, variable  empty value; the value contains `$NAME`/`${NAME}` (classification then only as far as readable)
//   stageEntries(pairs, ctx)       [[key, value, row?], …] → [{ key, row, …stageValue }] (for `environment` from an inspect)
//   envKey(text, ctx)              the content of a `.env*` file → { entries, unreadable: [line numbers] }
//   readEnvFiles(root, opts)       every `.env*` file under `root` (depth `depth`, default 3), read WITHOUT following a reference
//                                  (runtime/real-path.js traverseWithoutReferences: the project folder is foreign data for B — a
//                                  `.env` pointing to `~/.claude-login/…` is never read), at most MAX_BYTES per file (cap, with
//                                  a reason). → [{ file, rel, entries, unreadable, reason }]
//
// LINEAR. Every value is foreign data up to MAX_BYTES and is classified synchronously on B's main thread: no regex here may
// backtrack quadratically over a value. `/\s+#.*$/` did (80,000 spaces 3.4 s, 1 MiB ≈ 10 min, B stood still) — the comment is now
// found with indexOf. Rule for every regex literal of this file: anchored at the start (`^`), or the first element carries no
// quantifier. Guard: server/backend/test/stacks-result.test.js ("(5) … linear", the form over every literal of the file, plus a line
// of 64 KiB whitespace).
import fs from "node:fs";
import path from "node:path";
import { traverseWithoutReferences, realRoots, inArea } from "../runtime/real-path.js";

/** The suffix of instance names (= projectbox/names.js NAMES_SUFFIX; names.js pulls in the store, this leaf does not). */
export const SUFFIX_CBASE = ".cbase";
/** Cap per file: a `.env` over 1 MiB is no configuration any more — it is named, not read. */
export const MAX_BYTES = 1024 * 1024;
/** Roots that come from the project container's own image (no mount needed, no hold). */
export const SYSTEM_PREFIXES = Object.freeze(["/tmp", "/var/tmp", "/dev", "/proc", "/sys", "/run", "/var/run", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]);
// Folders without project configuration (dependencies, build output) — the walk does not descend. Exported as a list:
// stacks/result.js searches the `.env*` INSIDE the copy container with `find` and the same list and depth — two walks, ONE rule
// for which files belong.
export const SKIP_ENV_FOLDER = Object.freeze(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"]);
const SKIP_ENV = new Set(SKIP_ENV_FOLDER);
/** The default depth of the walk (readEnvFiles; the copy container too). */
export const ENV_DEPTH = 3;

export const ENV_FILE = (name) => typeof name === "string" && (name === ".env" || name.startsWith(".env."));

const under = (p, w) => inArea(p, [w]);
const LOCAL_NAMES = new Set(["localhost", "host.docker.internal", "gateway.docker.internal", "0.0.0.0", "::", "::1"]);

const contains = (set, h) => (set instanceof Set ? set.has(h) : Array.from(set).includes(h));

/** The class of a host (see header) — the name itself never leaves the function. `ctx`: { localNames, ownCbase }. */
function hostClass(host, ctx = {}) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return null;
  if (LOCAL_NAMES.has(h) || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "0:0:0:0:0:0:0:1") return "local";
  if (h.endsWith(SUFFIX_CBASE)) return !ctx.ownCbase || contains(ctx.ownCbase, h) ? "cbase" : "foreign";
  if (ctx.localNames && contains(ctx.localNames, h)) return "stack";
  return "foreign";
}

const portCount = (s) => (/^\d{1,5}$/.test(String(s)) && Number(s) >= 1 && Number(s) <= 65535 ? Number(s) : null);
const HOSTNAME = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/;

// The targets of an authority "user:pw@h1:p1,h2:p2" (mongodb) — credentials drop before anything is read.
function targetsFromAuthority(auth, ctx) {
  const withoutUser = auth.includes("@") ? auth.slice(auth.lastIndexOf("@") + 1) : auth;
  const targets = [];
  for (const part of withoutUser.split(",")) {
    const m = part.match(/^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/);
    if (!m || !m[1] || !HOSTNAME.test(m[1])) continue;
    const host = hostClass(m[1], ctx);
    if (host) targets.push({ host, port: m[2] ? portCount(m[2]) : null });
  }
  return targets;
}

// ── The further forms — targets WITHOUT port (header) ──────────────────────────────────────────────────────────────────
// Every function here collects into `erg` ({ targets: [{ host, port: null }] once per class, open: number of parts that looked
// like a target and could not be classified }). No name, no value leaves them.

// A key under which a value names a target; `ConnectionStrings__<name>` is the .NET form (ASP.NET Core).
const TARGET_KEY = /(?:^|[_.])(?:URLS?|URIS?|DSN|HOST|HOSTNAME|SERVERS?|ADDR|ADDRESS|ENDPOINTS?|BROKERS?|NODES|CONNECTION|CONNECTIONSTRING|CONNECTION_STRING|CONN_?STR(?:ING)?)$/i;
const DOTNET_KEY = /^ConnectionStrings(?:__|:)/i;
// A key under which a bare name (no port, no scheme) is also a target — lists included. NOT `*_HOSTS`: `ALLOWED_HOSTS`
// (Django) names the names under which the app is reachable, no target.
const HOST_KEY = /(?:^|[_.])(?:HOST|HOSTNAME|SERVER|SERVERS|ADDR|ADDRESS|BROKERS?|NODES|ENDPOINTS?)$/i;
// `key=value` with a target key somewhere in the value (ADO.NET, Npgsql, ODBC, MySQL, Azure, PDO, libpq).
const KV_TARGET = /(?:^|[;\s(:])(?:host|hostname|hostaddr|server|serverName|data source|datasource|address|addr|network address|endpoint|accountendpoint|blobendpoint|queueendpoint|tableendpoint|fileendpoint|dfsendpoint|endpointsuffix|accountname|usedevelopmentstorage)\s*=/i;
// Nested scheme (`jdbc:postgresql://`, `jdbc:sqlserver://`) — every member without `:`, so unambiguous and linear.
const SCHEMA_URL = /^[A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)*:\/\/([^/?#]*)/;
// Oracle: `jdbc:oracle:thin:@host:1521:SID`, `…:@//host:1521/service`.
const ORACLE = /^[A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)*:@(?:\/\/)?(\[[^\]]*\]|[^:/?#;]+)/;
// `host:port`, also with a variable as port (`host:${PORT}`) — the host counts, the port stays null.
const HOST_PORT = /^(?:\[[^\]]*\]|[^\s:/@]+):(?:\d{1,5}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/;
const FILE_SUFFIX = /\.(?:db|sqlite3?|db3|s3db|sl3|mdf|sdf|fdb)$/i;
const JSON_CAP = 2000; // nodes of a JSON value; above that "not classified" (cap, estimated, not measured)

function classAlongside(kind, result) {
  if (kind && !result.targets.some((z) => z.host === kind)) result.targets.push({ host: kind, port: null });
}

function hostAlongside(raw, ctx, result) {
  const h = String(raw).trim();
  if (h && HOSTNAME.test(h)) classAlongside(hostClass(h, ctx), result);
  else result.open += 1;
}

// An authority, leniently: credentials dropped, parameters from `;` on (jdbc:sqlserver), per part the host before the last `:`.
function hostsFromAuthority(auth, ctx, result) {
  let a = auth.includes("@") ? auth.slice(auth.lastIndexOf("@") + 1) : auth;
  if (a.includes(";")) a = a.slice(0, a.indexOf(";"));
  for (const raw of a.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("[")) { hostAlongside(t.slice(0, t.indexOf("]") + 1), ctx, result); continue; }
    hostAlongside(t.includes(":") ? t.slice(0, t.indexOf(":")) : t, ctx, result);
  }
}

// A part of a list (or the whole value): URL, also with a nested scheme, Oracle, host:port, under a host key a bare name.
// → true if the part looked like a target (classified or counted open).
function singleTarget(part, k, ctx, result) {
  const url = part.match(SCHEMA_URL);
  if (url) { hostsFromAuthority(url[1], ctx, result); return true; }
  const ora = part.match(ORACLE);
  if (ora) { hostAlongside(ora[1], ctx, result); return true; }
  if (HOST_PORT.test(part)) { hostAlongside(part.slice(0, part.lastIndexOf(":")), ctx, result); return true; }
  if (HOST_KEY.test(k) && HOSTNAME.test(part)) { hostAlongside(part, ctx, result); return true; }
  if (part.includes("://") || part.includes(":@")) { result.open += 1; return true; }
  return false;
}

// The value of a server/host key in `key=value;…`: ADO.NET `tcp:host,1433`, `host\INSTANCE`, `(localdb)\…`, `.`,
// Npgsql/libpq `h1,h2:5432`, a unix socket `/var/run/postgresql`, EZConnect `//host:1521/service`.
function serverValue(v, ctx, result) {
  let x = v.trim();
  if (/^lpc:/i.test(x)) { classAlongside("local", result); return; }
  x = x.replace(/^(?:tcp|np|admin):/i, "");
  if (x.startsWith("//")) x = x.slice(2);
  for (const raw of x.split(",")) {
    let h = raw.trim();
    if (!h || /^\d{1,5}$/.test(h)) continue; // the ADO port behind the comma
    if (h.startsWith("\\\\")) h = h.slice(2); // Named Pipe \\host\pipe\…
    if (h.includes("\\")) h = h.slice(0, h.indexOf("\\")); // host\INSTANCE
    if (h.startsWith("/")) { classAlongside("local", result); continue; } // Unix-Socket
    if (h.includes("/")) h = h.slice(0, h.indexOf("/"));
    const k = h.toLowerCase();
    if (k === "." || k === "(local)" || k === "(localdb)") { classAlongside("local", result); continue; }
    if (h.startsWith("[")) { hostAlongside(h.slice(0, h.indexOf("]") + 1), ctx, result); continue; }
    hostAlongside(h.includes(":") ? h.slice(0, h.indexOf(":")) : h, ctx, result);
  }
}

// `Data Source` is a file for SQLite, a server for SQL Server and Oracle.
const fileLike = (v) => /^(?::memory:|\|DataDirectory\|)/i.test(v) || /^(?:\.{0,2}\/|~|[A-Za-z]:\\)/.test(v) || FILE_SUFFIX.test(v);

function kvTargets(t, ctx, result) {
  const prefix = t.match(/^[A-Za-z][A-Za-z0-9+.-]*:(?=[A-Za-z][A-Za-z ]*=)/); // PDO `mysql:`, `sqlsrv:`
  const s = prefix ? t.slice(prefix[0].length) : t;
  let parts = s.split(";");
  if (parts.length === 1) parts = s.split(" "); // libpq: `host=… port=… dbname=…`
  result.read = true; // the form carries its keys itself: what is not classified here counts as `open`
  let account = false;
  let azure = false;
  for (const raw of parts) {
    const i = raw.indexOf("=");
    if (i < 0) { if (raw.trim()) singleTarget(raw.trim(), "", ctx, result); continue; } // `jdbc:sqlserver://host:1433;…`
    if (i === 0) continue;
    const key = raw.slice(0, i).trim().toLowerCase().split(" ").join("");
    let v = raw.slice(i + 1).trim();
    const q = v[0];
    if (v.length > 1 && ((q === "{" && v.endsWith("}")) || ((q === "'" || q === '"') && v.endsWith(q)))) v = v.slice(1, -1).trim();
    if (!v) continue;
    if (key === "datasource") { if (!fileLike(v)) serverValue(v, ctx, result); }
    else if (["server", "host", "hostname", "hostaddr", "serverName", "address", "addr", "networkaddress"].includes(key)) serverValue(v, ctx, result);
    else if (key.endsWith("endpoint")) { azure = true; if (!singleTarget(v, "ENDPOINT", ctx, result)) result.open += 1; }
    else if (key === "endpointsuffix") { azure = true; hostAlongside(v, ctx, result); }
    else if (key === "usedevelopmentstorage") { azure = true; if (v.toLowerCase() === "true") classAlongside("local", result); }
    else if (key === "accountname") account = true;
  }
  // Azure Storage without endpoint and suffix: the SDK takes the public `<account>.<service>.core.windows.net`.
  if (account && !azure) classAlongside("foreign", result);
}

// TNS descriptor (Oracle): every `(HOST=…)`.
function tnsTargets(t, ctx, result) {
  result.read = true;
  let n = 0;
  for (const m of t.matchAll(/\(\s*HOST\s*=\s*([^)\s]+)/gi)) {
    if (++n > JSON_CAP) { result.open += 1; break; }
    hostAlongside(m[1], ctx, result);
  }
}

// A JSON value (list or object): every string with the key of its object (in a list: the list's key).
function jsonTargets(j, k, ctx, result, state, depth) {
  if (++state.n > JSON_CAP || depth > 16) { state.full = true; return; }
  if (typeof j === "string") {
    for (const z of oldTargets(k, j, ctx)) classAlongside(z.host, result);
    textTargets(k, j, ctx, result);
  } else if (Array.isArray(j)) { for (const x of j) jsonTargets(x, k, ctx, result, state, depth + 1); }
  else if (j && typeof j === "object") { for (const [kk, v] of Object.entries(j)) jsonTargets(v, kk, ctx, result, state, depth + 1); }
}

// Does a new target begin here? A comma after which none begins belongs to the previous part (a comma in the password
// `amqp://u:pa,ss@host` or in the path) — otherwise a piece of password would be classified as a host.
const targetBeginning = (s, k) => SCHEMA_URL.test(s) || ORACLE.test(s) || HOST_PORT.test(s) || (HOST_KEY.test(k) && HOSTNAME.test(s));

// The further forms of a text without JSON: TNS, `key=value;…`, else a list of parts (comma; a part without a scheme also
// separated by spaces).
function textTargets(k, t, ctx, result) {
  if (/\(\s*HOST\s*=/i.test(t)) { tnsTargets(t, ctx, result); return; }
  if (KV_TARGET.test(t)) { kvTargets(t, ctx, result); return; }
  const parts = [];
  for (const raw of t.split(",")) {
    const s = raw.trim();
    if (parts.length && !targetBeginning(s, k)) parts[parts.length - 1] += `,${raw}`;
    else parts.push(s);
  }
  for (const part of parts) {
    if (SCHEMA_URL.test(part) || ORACLE.test(part)) singleTarget(part, k, ctx, result);
    else for (const chunk of part.split(" ")) if (chunk) singleTarget(chunk, k, ctx, result);
  }
}

function additionalTargets(k, w, ctx) {
  const result = { targets: [], open: 0, read: false };
  const t = w.trim();
  if (t[0] === "[" || t[0] === "{") {
    let j;
    try { j = JSON.parse(t); } catch { j = undefined; }
    if (j !== undefined && j !== null && typeof j === "object") {
      const state = { n: 0, full: false };
      jsonTargets(j, k, ctx, result, state, 0);
      if (state.full) result.open += 1;
      return result;
    }
  }
  textTargets(k, t, ctx, result);
  return result;
}

// Without a classified target: does the value look like one anyway? (A `key=value;…` form or TNS decides about `open` itself —
// `Data Source=app.db` is a file, no open target.)
const looksLikeTarget = (k, w) => TARGET_KEY.test(k) || DOTNET_KEY.test(k) || w.includes("://") || w.includes(":@");

// The old forms (unchanged): ONE URL, ONE host:port, a *_HOST key — with port.
function oldTargets(k, w, ctx) {
  const url = w.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/);
  if (url) return targetsFromAuthority(url[2], ctx);
  if (/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):\d{1,5}$/.test(w.trim())) return targetsFromAuthority(w.trim(), ctx);
  if (/(?:^|_)(?:HOST|HOSTNAME|SERVER|ADDR|ADDRESS)$/i.test(k) && HOSTNAME.test(w.trim())) return targetsFromAuthority(w.trim(), ctx);
  return [];
}

function pathFromValue(value) {
  const w = String(value);
  // `file:///abs`; SQLAlchemy: `sqlite:////abs` absolute, `sqlite:///rel` relative.
  const file = w.match(/^file:\/\/(\/[^?#]*)/i);
  if (file) return file[1];
  const sqlite = w.match(/^sqlite3?:\/\/\/([^?#]*)/i);
  if (sqlite) return sqlite[1] ? (sqlite[1].startsWith("/") ? sqlite[1] : `./${sqlite[1]}`) : null;
  if (/^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/|\.\.?\/)/.test(w)) return w;
  return null;
}

/** The classification of a path against the mounts of the future project container (without returning the path). */
export function stagePath(raw, { mounts = [], home = "", base = "", exists = null } = {}) {
  let p = String(raw);
  if (/^(?:~|\$HOME|\$\{HOME\})\//.test(p)) {
    if (!home) return { path: "outside", inB: null };
    p = path.join(home, p.slice(p.indexOf("/") + 1));
  } else if (!path.isAbsolute(p)) {
    if (!base) return { path: "outside", inB: null };
    p = path.resolve(base, p);
  }
  p = path.normalize(p);
  for (const m of mounts || []) {
    const target = m?.target || m?.source;
    if (!target) continue;
    if (m.kind === "file" ? p === path.normalize(target) : under(p, path.normalize(target))) return { path: "inside", inB: null };
  }
  if (SYSTEM_PREFIXES.some((s) => under(p, s))) return { path: "system", inB: null };
  let inB = null;
  if (typeof exists === "function") { try { inB = Boolean(exists(p)); } catch { inB = null; } }
  return { path: "outside", inB };
}

/** The classification of ONE value (see header). `key` also decides whether a plain number is a port. */
export function stageValue(key, value, ctx = {}) {
  const w = String(value ?? "");
  const out = { targets: [], port: null, path: null, inB: null, empty: w === "", variable: /\$(?:\{[A-Za-z_]|[A-Za-z_])/.test(w), unclear: false };
  if (out.empty) return out;
  const k = String(key || "");
  if (/(?:^|_)PORT$/i.test(k)) out.port = portCount(w.trim());
  const filePath = pathFromValue(w);
  if (filePath !== null) return Object.assign(out, stagePath(filePath, ctx));
  out.targets = oldTargets(k, w, ctx);
  // The further forms: only classes the old ones did not find already, and never with a port (header).
  const additional = additionalTargets(k, w, ctx);
  for (const z of additional.targets) if (!out.targets.some((a) => a.host === z.host)) out.targets.push({ host: z.host, port: null });
  out.unclear = additional.open > 0 || (out.targets.length === 0 && !additional.read && looksLikeTarget(k, w));
  return out;
}

export function stageEntries(pairs, ctx = {}) {
  const out = [];
  for (const p of pairs || []) {
    const [key, value, row = null] = Array.isArray(p) ? p : [];
    if (!key) continue;
    out.push({ key: String(key), row, ...stageValue(key, value, ctx) });
  }
  return out;
}

// Without `#` comment (a `#` after whitespace): the first such `#` via indexOf — linear (header).
function withoutComment(rest) {
  for (let j = rest.indexOf("#", 1); j > 0; j = rest.indexOf("#", j + 1)) {
    if (/\s/.test(rest[j - 1])) return rest.slice(0, j);
  }
  return rest;
}

// The parser (dotenv subset: `export`, `=` or `:`, "…"/'…'/`…` also across lines, `#` comment after whitespace). NOT
// exported: it is the only place that holds values. Linear (header): an open quote looks for its end only in the NEW line,
// not in the whole value collected so far.
function split(text) {
  const rows = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const pairs = [];
  const unreadable = [];
  for (let i = 0; i < rows.length; i++) {
    const z = rows[i];
    if (/^\s*(?:#.*)?$/.test(z)) continue;
    const m = z.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s?(.*)$/);
    if (!m) { unreadable.push(i + 1); continue; }
    const row = i + 1;
    let rest = m[2].trimStart();
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      const parts = [rest.slice(1)];
      let end = parts[0].indexOf(q);
      while (end < 0 && i + 1 < rows.length) { i += 1; parts.push(rows[i]); end = rows[i].indexOf(q); }
      if (end < 0) { unreadable.push(row); continue; }
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, end);
      pairs.push([m[1], parts.join("\n"), row]);
    } else {
      rest = withoutComment(rest).trim();
      pairs.push([m[1], rest, row]);
    }
  }
  return { pairs, unreadable };
}

export function envKey(text, ctx = {}) {
  const { pairs, unreadable } = split(text);
  return { entries: stageEntries(pairs, ctx), unreadable };
}

const existsInB = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : null; } };

/**
 * Every `.env*` file under `root` (see header). `opts`: `{ depth, maxBytes, mounts, home, localNames, exists }` — `base` is the
 * file's folder. A file that cannot be read (too large, not a regular object, error) stands with `reason` and without `entries`:
 * not read is not "empty".
 */
export function readEnvFiles(root, { depth = ENV_DEPTH, maxBytes = MAX_BYTES, exists = existsInB, ...ctx } = {}) {
  const abs = path.resolve(String(root));
  const realW = realRoots([abs], [abs]);
  if (!realW.length) return [];
  const out = [];
  traverseWithoutReferences(abs, realW, (full, e, { open }) => {
    const rel = path.relative(abs, full);
    const t = rel.split(path.sep).length;
    if (e.isDirectory()) return !SKIP_ENV.has(e.name) && t <= depth;
    if (!e.isFile() || !ENV_FILE(e.name)) return false;
    const entry = { file: full, rel, entries: null, unreadable: [], reason: null };
    let fd = null;
    try {
      fd = open();
      const st = fs.fstatSync(fd);
      if (!st.isFile()) entry.reason = "not a regular file";
      else if (st.size > maxBytes) entry.reason = `larger than ${maxBytes} bytes — not read (cap)`;
      else {
        const r = envKey(fs.readFileSync(fd, "utf8"), { ...ctx, exists, base: path.dirname(full) });
        entry.entries = r.entries;
        entry.unreadable = r.unreadable;
      }
    } catch (err) {
      entry.reason = `unreadable (${err?.code || "Error"})`;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
    out.push(entry);
    return false;
  });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
