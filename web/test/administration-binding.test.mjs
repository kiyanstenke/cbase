// The seam of the administration: gateway, web and iOS on ONE sheet.
//
// `server/gateway/administration-contract.js` (a leaf module without imports) carries the lists the gateway
// computes with: levels and weights of the CPU priority, the RAM limits, roles, states and actions, the required
// keys of the bodies (RESOURCES_/PATCH_/CREATE_/PASSWORD_FIELDS), the fields of the responses and the jump
// `/?settings=administration`. Gateway and clients were built in parallel against this sheet; without this test a
// renamed field would keep running silently in both clients with default values (a missing `cpuMax` would mean "no
// limit", a missing state "no container").
//
// What is bound here:
//   (a) Web, EXECUTED: `web/src/lib/api/administration.ts` and `web/src/lib/settings-jump.ts` (compiled without
//       tsconfig, like preview-binding.test.mjs). EVERY export of the contract is either mirrored (`MIRROR`, same
//       value) or named "gateway only" (`ONLY_GATEWAY`); a new export without a row here is red. The normalizers
//       get an object of EXACTLY the contract's fields (nested: container, resources, actual, consumption) and return
//       every field with its value, in contract order; every state, role and level survives normalization, unknowns
//       become `null`. The bodies that go out (fetch intercepted) carry exactly their required keys, `cpuMax` also
//       as `null`; PATCH carries EXACTLY one of PATCH_FIELDS per call and both together all of them. The jump from
//       ADMINISTRATION_JUMP yields the PAGE, and SettingsModal leads to it. In the types the lists are bound to the
//       types via `ADMINISTRATION_TYPES_BOUND` (tsc).
//   (b) iOS, read as TEXT: `Models/AdministrationModels.swift`: the `CodingKeys` of each type equal the contract's
//       list, every key read in the decoder or encoded in the body, an optional one with `encodeNil` (a synthesized
//       Encodable would drop `nil` and the server answers 400); `AdministrationContract` equals the constants; the
//       word functions have a `case` per state, role and level; the literals compared in the views are a subset of
//       the contract, and every container action has a button.
//   (c) Per binding a built-in sabotage on an in-memory copy; each yields a deviation.
//
// Counter-tests: in lib/api/administration.ts `cpuMax: bodyText.cpuMax` in the PUT body changed to
// `cpuMax: bodyText.cpuMax ?? undefined` turns (a) red ("body PUT …/resources"); in AdministrationModels.swift
// `encodeNil(forKey: .cpuMax)` replaced by `encodeIfPresent` turns (b) red ("cpuMax is optional, but without
// encodeNil"). A field removed from USER_FIELDS (administration.ts) additionally turns tsc red
// (`ADMINISTRATION_TYPES_BOUND`).
//
// Run:  node --test --test-reporter=tap web/test/administration-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/gateway/administration-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const ios = (...p) => path.join(repo, "mobile", "CbaseMobile", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

// Every export of the contract has EXACTLY one place: mirrored in the web (name there) or named "gateway only" (with reason).
const MIRROR = {
  CPU_PRIO: "CPU_PRIO", CPU_PRIO_WEIGHT: "CPU_PRIO_WEIGHT", RAM_MIN_GIB: "RAM_MIN_GIB", RAM_BUFFER_BYTES: "RAM_BUFFER_BYTES",
  ROLES: "ROLES", CONTAINER_STATES: "CONTAINER_STATES", RESOURCES_FIELDS: "RESOURCES_FIELDS", PATCH_FIELDS: "PATCH_FIELDS",
  CREATE_FIELDS: "CREATE_FIELDS", PASSWORD_FIELDS: "PASSWORD_FIELDS", CONTAINER_ACTIONS: "CONTAINER_ACTIONS",
  ADMINISTRATION_FIELDS: "ADMINISTRATION_FIELDS", SERVER_FIELDS: "SERVER_FIELDS", USER_FIELDS: "USER_FIELDS",
  CONTAINER_FIELDS: "CONTAINER_FIELDS", ACTUAL_FIELDS: "ACTUAL_FIELDS", CONSUMPTION_FIELDS: "CONSUMPTION_FIELDS",
  ENV_ADDITION_FIELDS: "ENV_ADDITION_FIELDS", ADMINISTRATION_JUMP: "ADMINISTRATION_JUMP", PAGE: "ADMINISTRATION_PAGE",
};
const ONLY_GATEWAY = {
  CPU_PRIO_SHARES: "the value for `docker update --cpu-shares`; the clients only see the weight (`actual.cpuWeight`)",
  HOST_RESERVE_GIB: "the clients read the reserve as `server.reserveBytes` from the response, never from a number of their own",
};

// ── (a) Web ─────────────────────────────────────────────────────────────────────────────────────

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules missing (tsc); the binding cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-administration-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "settings-jump.ts"), src("lib", "api", "administration.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = {
    ...(await import(pathToFileURL(path.join(tmp, "settings-jump.js")).href)),
    ...(await import(pathToFileURL(path.join(tmp, "api", "administration.js")).href)),
  };
  return web;
}

/** A version of lib/api/administration.ts with changed source, compiled next to the real one (same `./core.js` imports). */
async function loadWebSabotaged(change) {
  const real = await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const source = change(read(src("lib", "api", "administration.ts")));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, "api", `administration-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return { ...real, ...(await import(pathToFileURL(file).href)) };
}

/** Example values per field; none is the normalizer default (false, null, ""), otherwise a lost field would look right. */
const EXAMPLE = {
  container: { state: "stopped", since: "2026-10-15T07:30:00.000Z" },
  resources: { ramGiB: 12, cpuPrio: "up", cpuMax: 6 },
  actual: { ramBytes: 8 * 1024 ** 3, cpuMax: 2.5, cpuWeight: 50 },
  consumption: { ramBytes: 3 * 1024 ** 3, cpuThreads: 1.25 },
  server: { threads: 24, ramTotalBytes: 64 * 1024 ** 3, ramAllocatedBytes: 70 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3, overcommitted: true },
};
EXAMPLE.user = {
  id: "u-7", username: "mara", role: "admin", locked: true, createdAt: 1789000000000, itself: true,
  container: EXAMPLE.container, resources: EXAMPLE.resources, actual: EXAMPLE.actual, consumption: EXAMPLE.consumption, deviating: true,
};
const fromFields = (fields, example, location) => Object.fromEntries(fields.map((f) => {
  assert.ok(Object.hasOwn(example, f), `the contract names "${f}" (${location}), this test has no example value for it; add one`);
  return [f, example[f]];
}));

/** All deviations of the web side from the contract (empty = bound). */
async function webDeviations(m, contract = V) {
  const deviations = [];
  const equal = (actual, desired, what) => { try { assert.deepStrictEqual(actual, desired); } catch { deviations.push(`${what}: web ${JSON.stringify(actual)}, contract ${JSON.stringify(desired)}`); } };
  const raw = (x) => (Array.isArray(x) ? [...x] : x && typeof x === "object" ? { ...x } : x);

  // Every export has its place, and the mirrored ones carry the same value.
  for (const name of Object.keys(contract).sort()) {
    if (Object.hasOwn(ONLY_GATEWAY, name)) continue;
    if (!Object.hasOwn(MIRROR, name)) { deviations.push(`contract exports "${name}", neither mirrored in the web (MIRROR) nor named "gateway only"`); continue; }
    equal(raw(m[MIRROR[name]]), raw(contract[name]), `${name} (web ${MIRROR[name]})`);
  }
  for (const name of [...Object.keys(MIRROR), ...Object.keys(ONLY_GATEWAY)]) {
    if (!Object.hasOwn(contract, name)) deviations.push(`this test lists "${name}", which the contract no longer exports`);
  }

  // A user made of EXACTLY the contract fields (nested from their lists) comes back complete, in contract order.
  const nested = {
    container: fromFields(contract.CONTAINER_FIELDS, EXAMPLE.container, "CONTAINER_FIELDS"),
    resources: fromFields(contract.RESOURCES_FIELDS, EXAMPLE.resources, "RESOURCES_FIELDS"),
    actual: fromFields(contract.ACTUAL_FIELDS, EXAMPLE.actual, "ACTUAL_FIELDS"),
    consumption: fromFields(contract.CONSUMPTION_FIELDS, EXAMPLE.consumption, "CONSUMPTION_FIELDS"),
  };
  const userRaw = fromFields(contract.USER_FIELDS, { ...EXAMPLE.user, ...nested }, "USER_FIELDS");
  const n = m.normUser(userRaw);
  equal(n && Object.keys(n), [...contract.USER_FIELDS], "normUser: keys");
  equal(n, userRaw, "normUser: values");
  equal(n && Object.keys(n.container), [...contract.CONTAINER_FIELDS], "normUser.container: keys");
  equal(n?.resources && Object.keys(n.resources), [...contract.RESOURCES_FIELDS], "normUser.resources: keys");
  equal(n?.actual && Object.keys(n.actual), [...contract.ACTUAL_FIELDS], "normUser.actual: keys");
  equal(n?.consumption && Object.keys(n.consumption), [...contract.CONSUMPTION_FIELDS], "normUser.consumption: keys");
  for (const state of contract.CONTAINER_STATES) equal(m.normUser({ ...userRaw, container: { ...nested.container, state } })?.container.state, state, `state "${state}"`);
  for (const role of contract.ROLES) equal(m.normUser({ ...userRaw, role })?.role, role, `role "${role}"`);
  for (const cpuPrio of contract.CPU_PRIO) equal(m.normUser({ ...userRaw, resources: { ...nested.resources, cpuPrio } })?.resources?.cpuPrio, cpuPrio, `level "${cpuPrio}"`);
  // Empty is not unknown: what the contract does not know or what is missing becomes `null`, never an assertion.
  equal(m.normUser({ ...userRaw, container: { state: "paused", since: null } })?.container.state, null, "unknown state => null");
  equal(m.normUser({ ...userRaw, role: "guest" })?.role, null, "unknown role => null");
  const { cpuMax: _dropped, ...withoutMax } = nested.resources;
  equal(m.normUser({ ...userRaw, resources: withoutMax })?.resources, null, "resources without cpuMax => null (not \"no limit\")");
  equal(m.normUser({ ...userRaw, resources: { ...nested.resources, cpuMax: null } })?.resources?.cpuMax, null, "cpuMax: null stays null");

  const serverRaw = fromFields(contract.SERVER_FIELDS, EXAMPLE.server, "SERVER_FIELDS");
  const snapshot = m.normAdministration(fromFields(contract.ADMINISTRATION_FIELDS, { server: serverRaw, user: [userRaw] }, "ADMINISTRATION_FIELDS"));
  equal(Object.keys(snapshot), [...contract.ADMINISTRATION_FIELDS], "normAdministration: keys");
  equal(Object.keys(snapshot.server), [...contract.SERVER_FIELDS], "normAdministration.server: keys");
  equal(snapshot.server, serverRaw, "normAdministration.server: values");
  equal(snapshot.user, [userRaw], "normAdministration.user: values");

  const envRaw = fromFields(contract.ENV_ADDITION_FIELDS, nested, "ENV_ADDITION_FIELDS");
  const own = m.normOwnResources({ state: "running", startedAt: "x", ...envRaw });
  equal(Object.keys(own), [...contract.ENV_ADDITION_FIELDS], "normOwnResources: keys");
  equal(own, envRaw, "normOwnResources: values");

  // The bodies as they go out (fetch intercepted): exactly the required keys, also with `null`.
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify(userRaw), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await m.setResources("u 7", { ramGiB: 4, cpuPrio: contract.CPU_PRIO[0], cpuMax: null });
    await m.setRole("u-7", contract.ROLES[0]);
    await m.setLocked("u-7", false);
    await m.setUpUser({ username: "fresh", password: "pw", role: contract.ROLES[0] });
    await m.setPassword("u-7", "pw");
    for (const action of contract.CONTAINER_ACTIONS) await m.containerAction("u-7", action);
    await m.deleteUser("u-7", true);
  } catch (e) {
    deviations.push(`a path threw: ${e?.message || e}`);
  } finally { globalThis.fetch = old; }
  const [put, roleValue, lock, create, password] = sent;
  equal(Object.keys(put?.body ?? {}), [...contract.RESOURCES_FIELDS], "body PUT …/resources");
  equal(put?.body?.cpuMax, null, "body PUT …/resources: cpuMax as null");
  equal([put?.method, put?.url], ["PUT", "/gw/admin/users/u%207/resources"], "path PUT …/resources (id encoded)");
  for (const [z, what] of [[roleValue, "role"], [lock, "locked"]]) {
    equal(z?.method, "PATCH", `path PATCH (${what})`);
    equal(Object.keys(z?.body ?? {}).length, 1, `body PATCH (${what}): exactly ONE key`);
  }
  equal([...Object.keys(roleValue?.body ?? {}), ...Object.keys(lock?.body ?? {})].sort(), [...contract.PATCH_FIELDS].sort(), "bodies PATCH together");
  equal(Object.keys(create?.body ?? {}), [...contract.CREATE_FIELDS], "body POST /gw/admin/users");
  equal(Object.keys(password?.body ?? {}), [...contract.PASSWORD_FIELDS], "body POST …/password");
  equal(sent.slice(5, 5 + contract.CONTAINER_ACTIONS.length).map((z) => `${z.method} ${z.url}`), contract.CONTAINER_ACTIONS.map((a) => `POST /gw/admin/users/u-7/${a}`), "paths of the container actions");
  equal(sent.at(-1) && `${sent.at(-1).method} ${sent.at(-1).url}`, "DELETE /gw/admin/users/u-7?purge=1", "path DELETE (with data)");

  // The jump: the address from ADMINISTRATION_JUMP opens the PAGE and loses the parameter.
  const jump = m.settingsFromAddress(`https://cbase.example${contract.ADMINISTRATION_JUMP}`);
  equal(jump?.page, contract.PAGE, "jump: page");
  equal(jump && new URL(jump.without).search, "", "jump: address without parameter");
  return deviations;
}

test("web: lib/api/administration.ts mirrors every export of the contract, normalization loses no field, the bodies carry every key", async () => {
  const deviations = await webDeviations(await loadWeb());
  assert.deepEqual(deviations, [], `web ≠ administration-contract.js:\n${deviations.join("\n")}`);
});

test("web: SettingsModal leads to the PAGE in a group, the header opens it instead of /gw/admin", () => {
  const modal = read(src("components", "settings", "SettingsModal.tsx"));
  assert.match(modal, new RegExp(`\\{ key: "${V.PAGE}", label: "Admin"`), "SECTIONS lists the page");
  assert.match(modal, new RegExp(`\\{ title: "Admin", keys: \\["${V.PAGE}"\\] \\}`), "SETTINGS_GROUPS lists it in the group \"Administration\"");
  const header = read(src("components", "TopNav.tsx"));
  assert.match(header, /openSettings\(ADMINISTRATION_PAGE\)/, "the header opens the page");
  assert.doesNotMatch(header, /href="\/gw\/admin"/, "the old admin page is no longer a target");
  assert.match(header, /settingsFromAddress\(window\.location\.href\)/, "the header reads the jump from the address");
});

test("web, counter-test: a renamed field, a body without cpuMax and a contract with a new level and a new export are noticed", async () => {
  const field = "    deviating: r.deviating === true,";
  const a = await webDeviations(await loadWebSabotaged((q) => {
    assert.ok(q.includes(field), "the line for the sabotage is no longer in normUser; adjust");
    return q.replace(field, "    deviatingX: r.deviating === true,");
  }));
  assert.ok(a.some((z) => z.startsWith("normUser: keys")), `the renamed field went unnoticed:\n${a.join("\n")}`);

  const body = "cpuMax: bodyText.cpuMax };";
  const b = await webDeviations(await loadWebSabotaged((q) => {
    assert.ok(q.includes(body), "the PUT body no longer looks like this in setResources; adjust");
    return q.replace(body, "cpuMax: payload.cpuMax ?? undefined };");
  }));
  assert.ok(b.some((z) => z.startsWith("body PUT …/resources")), `the body without cpuMax went unnoticed:\n${b.join("\n")}`);

  const foreign = { ...V, CPU_PRIO: [...V.CPU_PRIO, "turbo"], NEW_FIELDS: ["x"] };
  const c = await webDeviations(await loadWeb(), foreign);
  assert.ok(c.some((z) => z.startsWith("CPU_PRIO (web")) && c.some((z) => z.startsWith("level \"turbo\"")), c.join("\n"));
  assert.ok(c.some((z) => z.includes("\"NEW_FIELDS\", neither mirrored in the web")), c.join("\n"));
});

// ── (b) iOS ─────────────────────────────────────────────────────────────────────────────────────

const MODELS = ios("Models", "AdministrationModels.swift");
const VIEWS = [
  ios("Settings", "AdministrationSettings.swift"), ios("Settings", "EnvironmentSettings.swift"), ios("Settings", "SettingsView.swift"),
  ios("Shell", "ProfilePage.swift"),
];

/** A top-level type: from the header to the first `}` in column 0 (model: preview-binding.test.mjs). */
function block(text, header) {
  const rows = text.split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  if (start < 0) return null;
  const end = rows.findIndex((z, i) => i > start && z === "}");
  return end > start ? rows.slice(start, end + 1).join("\n") : null;
}

/** The keys of an `enum CodingKeys`: one line or several, with raw values (`case a = "b"` gives "b"). */
function codingKeys(b) {
  const m = /enum CodingKeys: String, CodingKey \{([\s\S]*?)\n?\s*\}/.exec(b);
  if (!m) return null;
  const deviations = [];
  for (const row of m[1].split(/\n|(?=\bcase\b)/)) {
    const c = /\bcase\s+(.*)$/.exec(row.trim());
    if (!c) continue;
    for (const part of c[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const raw = /^(\w+)\s*=\s*"([^"]+)"$/.exec(t);
      deviations.push(raw ? raw[2] : t);
    }
  }
  return deviations;
}

const set = (xs) => [...new Set(xs)].sort();
/** The `case "…"` literals of a `switch` that switches over `<expression ending in name>`. */
const switchCases = (text, name) => [...text.matchAll(new RegExp(`switch [\\w.?]*\\b${name} \\{([\\s\\S]*?)\\n\\s*\\}`, "g"))]
  .flatMap((m) => [...m[1].matchAll(/case "([^"]+)"/g)].map((x) => x[1]));
/** A Swift literal of a `static let` in `enum AdministrationContract`. */
const constant = (b, name) => new RegExp(`static let ${name}(?:: [^=]+)? = ([^\\n]+)`).exec(b ?? "")?.[1]?.trim();
const swiftList = (raw) => (raw ? [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null);
const swiftCount = (raw) => (raw ? Number(raw.replace(/_/g, "")) : null);

/** All deviations of the iOS side from the contract; `texts` = { models, views: [...] } (for the sabotage on copies). */
function iosDeviations(texts, contract = V) {
  const deviations = [];
  const equal = (actual, desired, what) => { try { assert.deepStrictEqual(actual, desired); } catch { deviations.push(`${what}: iOS ${JSON.stringify(actual)}, contract ${JSON.stringify(desired)}`); } };

  // Bodies: keys, each encoded, each optional with encodeNil. PATCH: two bodies with ONE key each, together PATCH_FIELDS.
  const patch = [];
  for (const [header, fields, what] of [
    ["struct AdministrationResources:", contract.RESOURCES_FIELDS, "PUT …/resources"],
    ["struct AdministrationCreateBody:", contract.CREATE_FIELDS, "POST /gw/admin/users"],
    ["struct AdministrationPasswordBody:", contract.PASSWORD_FIELDS, "POST …/password"],
    ["struct AdministrationRoleBody:", null, "PATCH"],
    ["struct AdministrationLockBody:", null, "PATCH"],
  ]) {
    const b = block(texts.models, header);
    if (!b) { deviations.push(`${header} missing from AdministrationModels.swift`); continue; }
    const key = codingKeys(b) ?? [];
    if (fields) equal(set(key), set(fields), `${header} CodingKeys (${what})`);
    else { equal(key.length, 1, `${header} carries exactly ONE key (${what})`); patch.push(...key); }
    const encode = b.slice(Math.max(0, b.indexOf("func encode(to encoder")));
    if (!b.includes("func encode(to encoder")) deviations.push(`${header}: no own encode(to:); a synthesized one would drop nil keys`);
    for (const f of key) {
      if (!new RegExp(`forKey: \\.${f}\\)`).test(encode)) deviations.push(`${header}: "${f}" is not encoded`);
      const type = new RegExp(`\\b(?:let|var) ${f}: ([^\\n=]+)`).exec(b)?.[1]?.trim();
      if (!type) { deviations.push(`${header}: no property "${f}"`); continue; }
      if (type.endsWith("?") && !new RegExp(`encodeNil\\(forKey: \\.${f}\\)`).test(encode)) deviations.push(`${header}: "${f}" is optional, but without encodeNil; a nil value would be missing from the body (400)`);
    }
  }
  equal(set(patch), set(contract.PATCH_FIELDS), "PATCH bodies together");

  // Responses: decoder keys equal the contract, each read.
  for (const [header, fields] of [
    ["struct AdministrationResources:", contract.RESOURCES_FIELDS], ["struct AdministrationActual:", contract.ACTUAL_FIELDS],
    ["struct AdministrationConsumption:", contract.CONSUMPTION_FIELDS], ["struct AdministrationContainer:", contract.CONTAINER_FIELDS],
    ["struct AdministrationServer:", contract.SERVER_FIELDS], ["struct AdministrationUser:", contract.USER_FIELDS],
    ["struct AdministrationStatus:", contract.ADMINISTRATION_FIELDS], ["struct AdministrationOwn:", contract.ENV_ADDITION_FIELDS],
  ]) {
    const b = block(texts.models, header);
    if (!b) { deviations.push(`${header} missing from AdministrationModels.swift`); continue; }
    equal(set(codingKeys(b) ?? []), set(fields), `${header} CodingKeys`);
    const read = b.slice(Math.max(0, b.indexOf("init(from decoder")));
    if (!b.includes("init(from decoder")) deviations.push(`${header}: no own init(from:); a synthesized one would demand EVERY key`);
    for (const f of fields) if (!new RegExp(`(?:\\(|forKey: )\\.${f}\\b`).test(read)) deviations.push(`${header} does not read "${f}"`);
  }

  // The constants. What iOS does not need is named here (ADMINISTRATION_JUMP: a jump through the address exists only in the web).
  const k = block(texts.models, "enum AdministrationContract");
  if (!k) deviations.push("enum AdministrationContract missing from AdministrationModels.swift");
  equal(swiftList(constant(k, "cpuPrio")), [...contract.CPU_PRIO], "AdministrationContract.cpuPrio");
  equal(Object.fromEntries([...(constant(k, "cpuPrioWeight") ?? "").matchAll(/"([^"]+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])])), { ...contract.CPU_PRIO_WEIGHT }, "AdministrationContract.cpuPrioWeight");
  equal(swiftCount(constant(k, "ramMinGiB")), contract.RAM_MIN_GIB, "AdministrationContract.ramMinGiB");
  equal(swiftCount(constant(k, "ramBufferBytes")), contract.RAM_BUFFER_BYTES, "AdministrationContract.ramBufferBytes");
  equal(swiftList(constant(k, "roles")), [...contract.ROLES], "AdministrationContract.roles");
  equal(swiftList(constant(k, "containerStates")), [...contract.CONTAINER_STATES], "AdministrationContract.containerStates");
  equal(swiftList(constant(k, "containerActions")), [...contract.CONTAINER_ACTIONS], "AdministrationContract.containerActions");
  equal(swiftList(constant(k, "page"))?.[0], contract.PAGE, "AdministrationContract.page");

  // The words: per state, role and level of the contract a `case` in the word function.
  const word = (fn) => /func \w+\([^)]*\)[^{]*\{[\s\S]*?\n\}/.exec(texts.models.slice(texts.models.indexOf(`func ${fn}(`)))?.[0] ?? "";
  for (const [fn, list, what] of [["administrationStateWord", contract.CONTAINER_STATES, "state"], ["administrationRoleWord", contract.ROLES, "role"], ["administrationPrioWord", contract.CPU_PRIO, "level"]]) {
    const cases = [...word(fn).matchAll(/case "([^"]+)"/g)].map((m) => m[1]);
    if (!cases.length) { deviations.push(`${fn} is missing or has no cases; this test reads the literals there`); continue; }
    for (const x of list) if (!cases.includes(x)) deviations.push(`${fn} has no word for the ${what} "${x}"`);
    for (const x of cases) if (!list.includes(x)) deviations.push(`${fn} knows the ${what} "${x}", which the contract does not know`);
  }

  // Compared literals in the views are a subset of the contract; every container action has a button.
  const all = texts.views.join("\n");
  const states = [...all.matchAll(/state\s*(?:==|!=)\s*"([^"]+)"/g)].map((m) => m[1]).concat(switchCases(all, "state"));
  const roles = [...all.matchAll(/role\s*(?:==|!=)\s*"([^"]+)"/g)].map((m) => m[1]);
  const stages = [...all.matchAll(/cpuPrio\s*(?:==|!=)\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const z of set(states)) if (!contract.CONTAINER_STATES.includes(z)) deviations.push(`iOS compares the state "${z}", which the contract does not know`);
  for (const r of set(roles)) if (!contract.ROLES.includes(r)) deviations.push(`iOS compares the role "${r}", which the contract does not know`);
  for (const s of set(stages)) if (!contract.CPU_PRIO.includes(s)) deviations.push(`iOS compares the level "${s}", which the contract does not know`);
  if (states.length === 0 || roles.length === 0) deviations.push("no state or role literals found; does the test still read the right files?");
  const buttons = [...all.matchAll(/actionButton\(n, "([^"]+)"/g)].map((m) => m[1]);
  equal(set(buttons), set(contract.CONTAINER_ACTIONS), "buttons of the container actions");
  return deviations;
}

const iosTexts = () => ({ models: read(MODELS), views: VIEWS.map(read) });

test("iOS: bodies with every key (encodeNil), decoder keys, constants, words and literals as in administration-contract.js", () => {
  const deviations = iosDeviations(iosTexts());
  assert.deepEqual(deviations, [], `iOS ≠ administration-contract.js:\n${deviations.join("\n")}`);
});

test("iOS, counter-test: a removed encodeNil, a renamed decoder key, a foreign literal and a new state are noticed", () => {
  const t = iosTexts();
  const withNil = "if let cpuMax { try c.encode(cpuMax, forKey: .cpuMax) } else { try c.encodeNil(forKey: .cpuMax) }";
  assert.ok(t.models.includes(withNil), "the encodeNil row no longer looks like this in AdministrationModels.swift; adjust");
  const a = iosDeviations({ ...t, models: t.models.replace(withNil, "try c.encodeIfPresent(cpuMax, forKey: .cpuMax)") });
  assert.ok(a.some((z) => z.includes("\"cpuMax\" is optional, but without encodeNil")), a.join("\n"));

  const key = "case id, username, role, locked, createdAt,";
  assert.ok(t.models.includes(key), "the CodingKeys row of AdministrationUser no longer looks like this; adjust");
  const b = iosDeviations({ ...t, models: t.models.replace(key, "case id, username, role, blocked, createdOn,") });
  assert.ok(b.some((z) => z.startsWith("struct AdministrationUser: CodingKeys")), b.join("\\n"));

  const c = iosDeviations({ ...t, views: [...t.views, 'if n.container.state == "paused" {}'] });
  assert.ok(c.some((z) => z.includes("state \"paused\"")), c.join("\\n"));

  const d = iosDeviations(t, { ...V, CONTAINER_STATES: [...V.CONTAINER_STATES, "waiting"] });
  assert.ok(d.some((z) => z.includes("no word for the state \"waiting\"")) && d.some((z) => z.startsWith("AdministrationContract.containerStates")), d.join("\n"));

  const e = iosDeviations({ ...t, views: t.views.map((x) => x.replace('actionButton(n, "stop"', 'actionButton(n, "halt"')) });
  assert.ok(e.some((z) => z.startsWith("buttons of the container actions")), e.join("\n"));
});
