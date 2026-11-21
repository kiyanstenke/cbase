// Pure rules of port forwarding in the cbase client — per instance.
//
// Runs without Electron and is therefore tested (client/test/forwarding-rules.test.mjs), like browser-rules.js: main.js
// only wires (listeners, tunnel, settings file) and asks here.
//
// WHY PER INSTANCE. A project listens in its project container, not on the loopback of the user container (B), and two
// projects commonly both listen on 3000. The key of a forward is therefore (instance, port).
//
// The instance is the identifier "<projectId>/<instance>" (projectbox/network-targets.js) or `null`. `null` does NOT mean
// "explicitly B" but "no instance given": the tunnel then carries NO `instance` parameter, and the server applies its rule
// for an old client (server/backend/electron/server/tunnel.js tunnelTarget: B if B holds the port, otherwise the ONE
// instance that holds it).
//
// EXCLUSIVE SELECTION. Exactly ONE instance (main or copy), or none, forwards; the choice is stored in
// client-settings.json as `activeInstance` and survives a restart. Three sources of a forward (`source`), three lifecycles:
//  · "selection" — bound by the choice or by bring-along, only ports of the active instance; stored WITH `source`, ends
//                  when another instance (or none) is chosen. A restart binds only those of the stored choice.
//  · "manual"    — created by hand; stored WITHOUT `source`, ends only with ×.
//  · "browser"   — created by the native browser; never stored.
// The choice is explicit and takes its numbers: whatever sits there (manual, browser, another instance) ends.
// Bring-along (services of the active instance that start LATER) is automatic and never takes a manual forward away: its
// port stays "occupied" until the user ends it with ×. Both are `switchoverPlan` with a `mode`.

// An instance identifier: non-empty, no whitespace, exactly one separator that is neither first nor last — the same form
// the server splits (network-targets.js identifierParts takes the LAST slash).
const IDENTIFIER = /^[^\s/]+\/[^\s/]+$/;
const IDENTIFIER_MAX = 200;

/**
 * The instance of an IPC call: `{ instance }` (identifier or null) or `{ error }`. A missing value (undefined, null, "")
 * is `null`. Anything else that is not an identifier is an error: silently falling to `null` would send a call meant for
 * an instance to the port of B.
 */
export function instanceFromIpc(value) {
  if (value === undefined || value === null || value === "") return { instance: null };
  if (typeof value !== "string" || value.length > IDENTIFIER_MAX || !IDENTIFIER.test(value)) return { error: "invalid instance" };
  return { instance: value };
}

/** The key of a forward: "<instance>:<port>", without instance ":<port>". */
export function forwardKey(instance, port) {
  return `${instance ?? ""}:${port}`;
}

/** The tunnel query (`/api/tunnel?…`). With an instance `&instance=<identifier>` is appended; without, the parameter is absent. */
export function tunnelSearch(port, ticket, instance) {
  const q = new URLSearchParams({ port: String(port), ticket: String(ticket) });
  if (instance) q.set("instance", instance);
  return `?${q.toString()}`;
}

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * The stored forwards (client-settings.json `forwards`), migrated once: an entry WITHOUT the `instance` field (from an
 * older client) gets `instance: null`. The `port` field stays — an old client after a rollback still reads it. An entry
 * with an invalid instance stays as it is, and restore skips it (`rememberedToBind`). `changed` says whether the file must
 * be rewritten.
 */
export function transferRemembered(list) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  let changed = false;
  const fresh = list.map((f) => {
    if (!f || typeof f !== "object" || "instance" in f) return f;
    changed = true;
    return { instance: null, ...f };
  });
  return { list: fresh, changed };
}

/**
 * What restore binds: per valid entry `{ instance, port, localPort, source }` — `localPort` is the WISH (binding moves
 * aside if it is taken; undefined if invalid). `source` is "selection" only for an entry of the choice WITH an instance,
 * otherwise "manual". A forward of the choice always wishes for its OWN number (`port`), not the stored one: what is
 * stored is what was bound, and had it moved aside once, it would stay moved aside across every restart — baked-in
 * addresses like localhost:3000 would lead nowhere, since bring-along deliberately does not fetch it back. A manual
 * forward keeps its stored local port: the user may have chosen a different number.
 */
export function rememberedToBind(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || !validPort(f.port)) continue;
    const i = instanceFromIpc(f.instance);
    if (i.error) continue;
    const source = f.source === "selection" && i.instance ? "selection" : "manual";
    out.push({
      instance: i.instance, port: f.port, localPort: source === "selection" ? f.port : validPort(f.localPort) ? f.localPort : undefined, source,
    });
  }
  return out;
}

/**
 * The stored list after remembering a forward: the same key is replaced, everything else stays. A forward of the choice
 * carries `source: "selection"`, a manual one NO field.
 */
export function remember(list, { instance, port, localPort, source }) {
  return [...without(list, { instance, port }), { instance: instance ?? null, port, localPort, ...(source === "selection" ? { source } : {}) }];
}

/**
 * Which `source` an existing forward carries after a new request for the SAME key (startForward then returns the existing
 * one): the choice takes over any; a manual click turns a browser forward into a manual one (it then survives a restart);
 * nothing else changes — a forward of the choice never becomes manual again, the browser never takes over.
 */
export function sourceTo(old, fresh) {
  const a = old === "browser" || old === "selection" ? old : "manual";
  if (fresh === "selection") return "selection";
  if (fresh === "manual" && a === "browser") return "manual";
  return a;
}

// Marker of the one-time migration in client-settings.json.
export const MIGRATION_MARKER = "forwardingsWithoutInstanceRemoved";

/** The stored choice (`activeInstance`): an identifier or `null` (none) — anything unreadable is none, never a guess. */
export function activeFromSettings(s) {
  const i = instanceFromIpc(s?.activeInstance);
  return i.error ? null : i.instance;
}

/**
 * The state at client start (restoreForwards): the forwards to bind, plus the settings as they should be in the file
 * afterwards (`changed`: rewrite).
 *  1. ONCE (marker `MIGRATION_MARKER`): every stored forward WITHOUT an instance falls. The marker is ALWAYS set
 *     afterwards, even if nothing fell: otherwise the next start would remove a manual forward created later. An entry
 *     with an unreadable instance stays (restore skips it).
 *     In the SAME migration, stored forwards WITH an instance but without `source` "selection" (the format before the
 *     selection existed — project forwards, not manual ones): if they all belong to ONE instance, it becomes the choice
 *     (`activeInstance`, entries then carry `source: "selection"`); otherwise they fall — nobody knows which was meant,
 *     and a guessed choice is worse than none. An already stored different choice never loses against them.
 *  2. An entry without `instance` that appears AFTER the migration (an old client after a rollback) is migrated to
 *     `instance: null` (`transferRemembered`) — it is then a manual forward.
 *  3. An entry of the choice (`source: "selection"`) whose instance is NOT the stored choice falls: the choice is
 *     exclusive, and such an entry can only stem from an aborted switch.
 */
export function startState(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  let list = Array.isArray(s.forwards) ? s.forwards : [];
  let changed = false;
  let removed = [];
  const fresh = { ...s };
  if (s[MIGRATION_MARKER] !== true) {
    const isEntry = (f) => f && typeof f === "object";
    const withoutInstance = (f) => isEntry(f) && (f.instance === null || f.instance === undefined || f.instance === "");
    const oldProject = (f) => isEntry(f) && !withoutInstance(f) && f.source !== "selection" && typeof instanceFromIpc(f.instance).instance === "string";
    const instances = new Set(list.filter(oldProject).map((f) => f.instance));
    const remembered = activeFromSettings(s);
    const gets = instances.size === 1 && [...instances].every((i) => remembered === null || remembered === i) ? [...instances][0] : null;
    removed = list.filter((f) => withoutInstance(f) || (oldProject(f) && gets === null));
    list = list.filter((f) => !removed.includes(f)).map((f) => (oldProject(f) ? { ...f, source: "selection" } : f));
    if (gets !== null) fresh.activeInstance = gets;
    fresh[MIGRATION_MARKER] = true;
    changed = true;
  }
  const u = transferRemembered(list);
  list = u.list;
  changed ||= u.changed;
  const active = activeFromSettings(fresh);
  const foreign = list.filter((f) => f && f.source === "selection" && (instanceFromIpc(f.instance).instance ?? null) !== active);
  if (foreign.length) {
    list = list.filter((f) => !foreign.includes(f));
    changed = true;
  }
  fresh.forwards = list;
  return { settings: fresh, changed, removed, bind: rememberedToBind(list), active };
}

/**
 * The options of a `select` call: none = plain switchover, otherwise `{ mode: "exclusive" | "bringAlong" }`, plus optional
 * `ifActive` (identifier or null = none): the selection only happens if THIS choice still holds when it runs in the chain.
 * A fallback is computed from one choice, and a user's selection already waiting in the chain would otherwise be set and
 * immediately replaced. If absent the field is not there (no condition); anything but identifier or null is an error.
 */
export function selectOptions(raw) {
  if (raw === undefined || raw === null) return { mode: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid options" };
  const condition = raw.ifActive === undefined ? null : instanceFromIpc(raw.ifActive);
  if (condition?.error) return { error: "invalid condition" };
  if (raw.mode === undefined) return condition ? { error: "condition without mode" } : { mode: undefined };
  if (raw.mode !== "exclusive" && raw.mode !== "bringAlong") return { error: "invalid mode" };
  return condition ? { mode: raw.mode, ifActive: condition.instance } : { mode: raw.mode };
}

/** The stored list without the forward (instance, port) — an old entry without the field counts as instance `null`. */
export function without(list, { instance, port }) {
  const k = forwardKey(instance, port);
  return (Array.isArray(list) ? list : []).filter((f) => forwardKey(f?.instance ?? null, f?.port) !== k);
}

/**
 * Switchover: the chosen instance gets ALL its ports on the local ports of the same number — baked-in addresses
 * (`VITE_API_BASE=http://localhost:8000`) then hit the same project. Its ports are the ones passed in plus the ones it
 * already forwards.
 *
 * `mode`: without it the plain switchover below; "exclusive" and "bringAlong" are the selection (`selectionPlan`).
 *
 * Input: `forwards` = [{ instance, port, localPort }] (the running ones), `instance` (chosen; identifier or null), `ports`.
 * Output: `{ stop: [{ instance, port }], bind: [port] }`, to be executed in this order:
 *  - stopped is every forward of ANOTHER instance whose local port is one of the chosen — and no other (ports without
 *    conflict all stay forwarded);
 *  - an own forward on a different local port (it had moved aside) is stopped and rebound, one on its own port stays;
 *  - bound is every chosen port that then has no own forward on its port.
 * Without an instance (`null`) there is no project group: `null` is the whole namespace B including every manual forward.
 * Then ONLY the passed ports count — otherwise a null forward of another project on a moved-aside port would drag its
 * port along and silently take the place of a foreign instance. An own null forward is only rebound if its port is passed.
 */
export function switchoverPlan({ forwards, instance, ports, mode }) {
  const selected = instance ?? null;
  const running = (Array.isArray(forwards) ? forwards : []).filter((f) => f && validPort(f.port));
  if (mode === "exclusive" || mode === "bringAlong") return selectionPlan(running, selected, ports, mode);
  const own = running.filter((f) => (f.instance ?? null) === selected);
  const all = new Set([...(Array.isArray(ports) ? ports : []).filter(validPort), ...(selected === null ? [] : own.map((f) => f.port))]);
  const stop = [];
  for (const f of running) {
    const foreign = (f.instance ?? null) !== selected;
    if (foreign ? all.has(f.localPort) : f.localPort !== f.port && all.has(f.port)) stop.push({ instance: f.instance ?? null, port: f.port });
  }
  const stays = new Set(own.filter((f) => f.localPort === f.port).map((f) => f.port));
  const bind = [...all].filter((p) => !stays.has(p)).sort((a, b) => a - b);
  return { stop, bind };
}

const sourceOf = (f) => (f?.source === "browser" || f?.source === "selection" ? f.source : "manual");
const sorted = (set) => [...set].sort((a, b) => a - b);

/**
 * The exclusive selection. `selected` is the instance (identifier) or `null` = none (NOT B as in the plain switchover —
 * a forward without an instance cannot be selected, only created by hand). `ports` are the ports of its running services
 * (`instancePorts` in web/src/lib/services-status.ts).
 *
 * "exclusive" (a click in the selection):
 *  - every forward of the choice ("selection") of ANOTHER instance ends — on whatever port;
 *  - every other forward of another instance (manual, browser, without instance) on one of the chosen local numbers ends;
 *  - an own forward that had moved aside (local ≠ port) ends and is rebound on its number;
 *  - an own one on its number stays; if it was manual or from the browser, the choice takes it over (`takeOver`).
 * "bringAlong" (services of the active instance that start later — only for the active one, main.js checks that):
 *  - nothing of the instance ends, and no manual forward — if one sits on a needed number, the port is listed under
 *    `occupied` and is NOT bound (not on another port either: the list says why it is missing);
 *  - a browser or selection forward of another instance on a needed number ends (the choice has priority);
 *  - an own, moved-aside one stays as it is: if a foreign program of this machine listens on its number, every new
 *    attempt would move aside again — dropped connections every 30 s for nothing. Only the explicit choice fetches it back.
 * Output: `{ stop: [{ instance, port }], bind: [port], takeOver: [port], occupied: [port] }` — stop first, then take
 * over and bind.
 */
function selectionPlan(running, selected, ports, mode) {
  const bringAlong = mode === "bringAlong";
  if (bringAlong && selected === null) return { stop: [], bind: [], takeOver: [], occupied: [] };
  const desired = new Set(selected === null ? [] : (Array.isArray(ports) ? ports : []).filter(validPort));
  const stop = [];
  const stays = new Set();
  const takeOver = new Set();
  const occupied = new Set();
  for (const f of running) {
    const q = sourceOf(f);
    if (selected !== null && (f.instance ?? null) === selected) {
      if (!desired.has(f.port)) continue;
      if (!bringAlong && f.localPort !== f.port) { stop.push({ instance: f.instance ?? null, port: f.port }); continue; }
      stays.add(f.port);
      if (q !== "selection") takeOver.add(f.port);
      continue;
    }
    if (!bringAlong && q === "selection") { stop.push({ instance: f.instance ?? null, port: f.port }); continue; }
    if (!desired.has(f.localPort)) continue;
    if (bringAlong && q === "manual") { occupied.add(f.localPort); continue; }
    stop.push({ instance: f.instance ?? null, port: f.port });
  }
  const bind = sorted([...desired].filter((p) => !stays.has(p) && !occupied.has(p)));
  return { stop, bind, takeOver: sorted(takeOver), occupied: sorted(occupied) };
}

// The project of an identifier "<projectId>/<instance>" (split at the LAST slash) — null without an identifier.
const projectOfTheIdentifier = (k) => (typeof k === "string" && k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : null);

/**
 * The fallback of a forward whose instance no longer exists: for a removed copy the server answers tunnel and port query
 * with 404 "unknown instance: <identifier>" (the server's wording, matched below). Then `<project>/main` applies — the
 * main instance always exists. `null`: no fallback (no 404, another reason, no identifier, or already main). `text` is the
 * response body (plain text or JSON — the wording is searched).
 */
export function fallbackInstance(instance, status, text) {
  if (status !== 404 || typeof text !== "string" || !text.includes("unknown instance")) return null;
  if (instanceFromIpc(instance).instance === null) return null;
  const project = projectOfTheIdentifier(instance);
  if (!project || instance === `${project}/main`) return null;
  return `${project}/main`;
}

/** Does the identifier belong to the project of the scope `proj:<id>`? A `ws:` scope has no project of its own. */
export function instanceInScope(identifier, scope) {
  const m = /^proj:(.+)$/.exec(String(scope || ""));
  return Boolean(m) && projectOfTheIdentifier(identifier) === m[1];
}

/**
 * Where a tunnel WITHOUT an instance on `port` leads — the same rule the server applies for an old client
 * (server/backend/electron/server/tunnel.js tunnelTarget): B (`null`) if B holds the port, otherwise the ONE instance that
 * holds it. `undefined`: nobody or several instances — the tunnel then lands in B where nobody listens.
 * `open` is `open` from `/api/ports/running?ports=<P>` (per entry `instance`, null/missing = B).
 */
export function tunnelTargetWithoutInstance(open, port) {
  const hits = (Array.isArray(open) ? open : []).filter((e) => Number(e?.port) === port);
  if (hits.some((e) => !e.instance)) return null;
  return hits.length === 1 ? hits[0].instance : undefined;
}

/**
 * The native browser: which instance has the port a page of the scope addressed? `open` is `open` from
 * `/api/ports/running?ports=<P>`. First the ACTIVE instance (`active`, the client's choice): if it holds the port the
 * browser takes it — even in a scope of another project; it must not silently displace the choice. Otherwise the scope
 * `proj:<id>` prefers ITS project, otherwise — and for `ws:<id>` — B, otherwise the one instance that has it. Output:
 * `{ hat, instance }` plus `nullTarget` (where a tunnel WITHOUT instance leads, `tunnelTargetWithoutInstance`). Several
 * instances and none of the own project: no guessing — `has: "ambiguous"` with the `candidates`, and the main frame asks
 * the user (browser-rules.js forwardDecision "choice").
 */
export function instanceForScope(open, scope, port, active = null) {
  const hits = (Array.isArray(open) ? open : []).filter((e) => Number(e?.port) === port);
  const nullTarget = tunnelTargetWithoutInstance(hits, port);
  if (!hits.length) return { has: false, instance: null, nullTarget };
  if (active && hits.some((e) => e.instance === active)) return { has: true, instance: active, nullTarget };
  const own = hits.find((e) => instanceInScope(e.instance, scope));
  if (own) return { has: true, instance: own.instance, nullTarget };
  if (hits.some((e) => !e.instance)) return { has: true, instance: null, nullTarget };
  if (hits.length === 1) return { has: true, instance: hits[0].instance, nullTarget };
  return { has: "ambiguous", instance: null, nullTarget, candidates: [...new Set(hits.map((e) => e.instance))] };
}

/**
 * Which LOCAL ports do we serve for a page of this scope (browser-rules.js rule 1: let through)? A local port drops out
 * if the measurement says the scope's OWN project holds the port (`measurement.instance` is an identifier of the project)
 * and the forward there does not lead to it — a foreign instance, or one without an instance whose tunnel (`nullTarget`)
 * ends elsewhere; otherwise a page of project B would silently show the app of project A. The main frame then gets the
 * hint with its own instance. Without a measurement or without an own project all forwards count.
 */
export function localPortsForScope(forwards, scope, measurement) {
  const own = measurement?.containerHas === true && instanceInScope(measurement.instance, scope) ? measurement.instance : null;
  const out = new Set();
  for (const f of Array.isArray(forwards) ? forwards : []) {
    if (!f || !validPort(f.localPort)) continue;
    if (own && f.localPort === measurement.port && !forwardingHits(f, own, measurement)) continue;
    out.add(f.localPort);
  }
  return out;
}

/** Does the forward `f` lead to the instance `target`? The own instance yes; without an instance only via its tunnel target. */
function forwardingHits(f, target, measurement) {
  if (f.instance) return f.instance === target;
  return f.port === measurement.port && measurement.nullTarget === target;
}

/** Does a main-frame request to the local port of a forward need a measurement? Only in the scope of a project that is
 * not its instance — for `ws:` and the own instance it is let through without asking the server. */
export function forwardingNeedsMeasurement(f, scope) {
  if (!/^proj:/.test(String(scope || ""))) return false;
  return !instanceInScope(f?.instance, scope);
}
