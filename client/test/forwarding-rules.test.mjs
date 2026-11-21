// Port forwarding per instance (client/forwarding-rules.js). Without Electron: the pure rules, plus (by path) the list of
// files the client ships.
//
// The promises and what breaks them:
//  · Two instances with port 3000 do not overwrite each other — the key is (instance, port). Counter-check: `forwardKey`
//    from the port alone ⇒ "key" and "remember" red.
//  · Old stored entries (without `instance`) are migrated ONCE to `instance: null`, `port` stays. Counter-check:
//    `transferRemembered` without the `"instance" in f` condition ⇒ "migration" red.
//  · Switchover binds EXACTLY the chosen instance on its ports and stops only what is in the way. Counter-check:
//    `switchoverPlan` stops every foreign forward ⇒ "switchover" red.
//  · Without an instance the tunnel carries NO `instance` (the server applies its old-client rule); with one, the identifier.
//  · Fallback: 404 "unknown instance" of a removed copy ⇒ `<project>/main`. Counter-check: no fallback ⇒ "fallback" red;
//    the `checkFallback(entry)` call removed from teardown in main.js ⇒ "fallback wired" red.
//  · Exclusive selection (exactly one instance or none forwards): `switchoverPlan` with `mode`, `startState` (one-time
//    migration, marker `forwardingsWithoutInstanceRemoved`), `sourceTo`, `selectOptions`, `activeFromSettings`,
//    `instanceForScope` with the choice. Each rule has a test that turns red when its line is removed.
//
// Run:  node --test client/test/forwarding-rules.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  forwardKey, rememberedToBind, instanceFromIpc, instanceForScope, instanceInScope, localPortsForScope, remember, without, tunnelSearch,
  tunnelTargetWithoutInstance, transferRemembered, switchoverPlan, forwardingNeedsMeasurement, fallbackInstance,
  MIGRATION_MARKER, activeFromSettings, sourceTo, startState, selectOptions,
} from "../forwarding-rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const A = "p-a/main";
const B = "p-b/main";

test("key: per (instance, port) — two instances with port 3000 are two forwards, without instance as before", () => {
  assert.notEqual(forwardKey(A, 3000), forwardKey(B, 3000));
  assert.notEqual(forwardKey(A, 3000), forwardKey(null, 3000));
  assert.equal(forwardKey(null, 3000), ":3000");
  assert.equal(forwardKey(undefined, 3000), ":3000", "a missing field is the same forward as null");
  assert.equal(forwardKey(A, 3000), "p-a/main:3000");
});

test("remember: the second instance on 3000 does not displace the first; the same key replaces; `without` hits only its own", () => {
  let list = [];
  list = remember(list, { instance: A, port: 3000, localPort: 3000 });
  list = remember(list, { instance: B, port: 3000, localPort: 3001 });
  assert.deepEqual(list, [
    { instance: A, port: 3000, localPort: 3000 },
    { instance: B, port: 3000, localPort: 3001 },
  ]);
  list = remember(list, { instance: A, port: 3000, localPort: 3005 });
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((f) => f.instance === A), { instance: A, port: 3000, localPort: 3005 });
  assert.deepEqual(without(list, { instance: B, port: 3000 }), [{ instance: A, port: 3000, localPort: 3005 }]);
  // An old entry without the field is the forward without an instance.
  assert.deepEqual(without([{ port: 8000, localPort: 8000 }, { instance: A, port: 8000, localPort: 8001 }], { instance: null, port: 8000 }),
    [{ instance: A, port: 8000, localPort: 8001 }]);
});

test("migration: old entries get `instance: null` once, `port` stays; migrated and foreign ones stay untouched", () => {
  const old = [{ port: 3000, localPort: 3000 }, { port: 5173 }];
  const r = transferRemembered(old);
  assert.equal(r.changed, true);
  assert.deepEqual(r.list, [{ instance: null, port: 3000, localPort: 3000 }, { instance: null, port: 5173 }]);
  // Second run: nothing left to do — the file is not rewritten on every start.
  const second = transferRemembered(r.list);
  assert.equal(second.changed, false);
  assert.deepEqual(second.list, r.list);
  // An identifier is never overwritten, not even with null.
  assert.deepEqual(transferRemembered([{ instance: A, port: 3000, localPort: 3000 }]), { list: [{ instance: A, port: 3000, localPort: 3000 }], changed: false });
  assert.deepEqual(transferRemembered(undefined), { list: [], changed: false });
  // Restore binds valid entries; an unreadable instance is skipped instead of silently falling to "none". Source is
  // "selection" only for an entry of the choice WITH an instance, everything else is manual.
  assert.deepEqual(rememberedToBind([
    { instance: null, port: 3000, localPort: 3000 }, { instance: A, port: 3000, localPort: 0 }, { instance: "broken", port: 4000 },
    { instance: null, port: 70000 }, { instance: B, port: 8000, localPort: 8000, source: "selection" },
    { instance: null, port: 9000, localPort: 9000, source: "selection" },
  ]), [
    { instance: null, port: 3000, localPort: 3000, source: "manual" }, { instance: A, port: 3000, localPort: undefined, source: "manual" },
    { instance: B, port: 8000, localPort: 8000, source: "selection" }, { instance: null, port: 9000, localPort: 9000, source: "manual" },
  ]);
});

test("IPC: a missing instance is none, an identifier is valid, anything else is an error", () => {
  for (const empty of [undefined, null, ""]) assert.deepEqual(instanceFromIpc(empty), { instance: null });
  assert.deepEqual(instanceFromIpc(A), { instance: A });
  for (const wrong of ["main", "/main", "p-a/", "p a/haupt", "p/a/b c", 3000, {}, ["p-a/main"], "x".repeat(199) + "/h"]) {
    assert.ok(instanceFromIpc(wrong).error, `${JSON.stringify(wrong)} passed as an instance`);
  }
});

test("tunnel: with instance `&instance=<identifier>`, without instance NO parameter (the server's old-client rule)", () => {
  assert.equal(tunnelSearch(3000, "t1", A), "?port=3000&ticket=t1&instance=p-a%2Fmain");
  assert.equal(new URLSearchParams(tunnelSearch(3000, "t1", A)).get("instance"), A);
  assert.equal(tunnelSearch(3000, "t1", null), "?port=3000&ticket=t1");
  assert.equal(new URLSearchParams(tunnelSearch(3000, "t1", undefined)).has("instance"), false);
});

test("switchover: the chosen instance gets all its ports; foreign ones end only where they are in the way", () => {
  // A holds 3000 and 8000 on its ports, B moved aside to 3001 for 3000; C (no conflict) forwards 9000.
  const forwards = [
    { instance: A, port: 3000, localPort: 3000 },
    { instance: A, port: 8000, localPort: 8000 },
    { instance: B, port: 3000, localPort: 3001 },
    { instance: "p-c/main", port: 9000, localPort: 9000 },
  ];
  // Switch to B with its services 3000 and 8000: A clears both, B rebinds 3000 (was on 3001) and 8000.
  const plan = switchoverPlan({ forwards, instance: B, ports: [8000, 3000] });
  assert.deepEqual(plan.stop, [{ instance: A, port: 3000 }, { instance: A, port: 8000 }, { instance: B, port: 3000 }]);
  assert.deepEqual(plan.bind, [3000, 8000]);
  // Only 3000 passed: A's 8000 stays (no conflict), C stays anyway.
  const only3000 = switchoverPlan({ forwards, instance: B, ports: [3000] });
  assert.deepEqual(only3000.stop, [{ instance: A, port: 3000 }, { instance: B, port: 3000 }]);
  assert.deepEqual(only3000.bind, [3000]);
  // Back to A: B sits on 3001 and is not in the way — stopped is only what sits on A's ports.
  const back = switchoverPlan({ forwards, instance: A, ports: [3000] });
  assert.deepEqual(back.stop, [], "A is already on its ports — nothing to stop");
  assert.deepEqual(back.bind, [], "and nothing to rebind");
  // Without passed ports the instance's own forwards count.
  assert.deepEqual(switchoverPlan({ forwards, instance: B }), { stop: [{ instance: A, port: 3000 }, { instance: B, port: 3000 }], bind: [3000] });
  // Switching to "no instance" works the same (a project in B against a relocated one).
  const onB = switchoverPlan({ forwards: [{ instance: A, port: 3000, localPort: 3000 }], instance: null, ports: [3000] });
  assert.deepEqual(onB, { stop: [{ instance: A, port: 3000 }], bind: [3000] });
});

// `null` is the namespace B, not a project group.
test("switchover to \"no instance\": null is the namespace B, not a project group — only the passed ports count", () => {
  const forwards = [
    { instance: null, port: 5173, localPort: 5174 }, // stored earlier or manual, moved aside
    { instance: A, port: 5173, localPort: 5173 },
    { instance: B, port: 8000, localPort: 8000 },
  ];
  assert.deepEqual(switchoverPlan({ forwards, instance: null, ports: [8000] }), { stop: [{ instance: B, port: 8000 }], bind: [8000] },
    "a foreign null forward dragged its port along and silently took 5173 from A");
  // An own null forward whose port is passed is fetched back to its port as before.
  assert.deepEqual(switchoverPlan({ forwards, instance: null, ports: [5173] }),
    { stop: [{ instance: null, port: 5173 }, { instance: A, port: 5173 }], bind: [5173] });
  // Without passed ports there is nothing to switch for null.
  assert.deepEqual(switchoverPlan({ forwards, instance: null }), { stop: [], bind: [] });
  // For a named instance the rule stays: its already forwarded ports come along.
  assert.deepEqual(switchoverPlan({ forwards: [{ instance: A, port: 3000, localPort: 3001 }], instance: A }), { stop: [{ instance: A, port: 3000 }], bind: [3000] });
});

test("native browser: a project's scope means ITS port; otherwise B; otherwise the one instance; several without a choice never", () => {
  const open = [{ port: 3000, instance: A }, { port: 3000, instance: B }];
  const core = (r) => ({ has: r.has, instance: r.instance });
  assert.deepEqual(core(instanceForScope(open, "proj:p-b", 3000)), { has: true, instance: B });
  assert.deepEqual(core(instanceForScope(open, "proj:p-a", 3000)), { has: true, instance: A });
  // Two instances, no own project: do not guess — but do not stay silent either: the candidates go to the card.
  assert.deepEqual(instanceForScope(open, "ws:w1", 3000), { has: "ambiguous", instance: null, nullTarget: undefined, candidates: [A, B] });
  assert.deepEqual(core(instanceForScope([...open, { port: 3000, instance: null }], "ws:w1", 3000)), { has: true, instance: null });
  assert.deepEqual(core(instanceForScope([{ port: 3000, instance: A }], "ws:w1", 3000)), { has: true, instance: A });
  // An old server sends no field — that is B.
  assert.deepEqual(core(instanceForScope([{ port: 3000 }], "proj:p-a", 3000)), { has: true, instance: null });
  assert.deepEqual(core(instanceForScope(open, "proj:p-a", 8000)), { has: false, instance: null });
  // A project whose id is a prefix of another does not match the other.
  assert.equal(instanceForScope([{ port: 3000, instance: "p-ab/main" }, { port: 3000, instance: B }], "proj:p-a", 3000).has, "ambiguous");
  assert.equal(instanceInScope(A, "proj:p-a"), true);
  assert.equal(instanceInScope("p-ab/main", "proj:p-a"), false);
  assert.equal(instanceInScope(A, "ws:p-a"), false);
  assert.equal(instanceInScope(null, "proj:p-a"), false);
});

// The rule of the tunnel WITHOUT an instance (server/backend/electron/server/tunnel.js tunnelTarget), mirrored: B if B holds
// the port, otherwise the ONE instance, otherwise nowhere.
test("tunnel without instance: B first, then the one instance; two or none ⇒ undefined", () => {
  assert.equal(tunnelTargetWithoutInstance([{ port: 3000, instance: A }, { port: 3000, instance: null }], 3000), null);
  assert.equal(tunnelTargetWithoutInstance([{ port: 3000 }], 3000), null, "without the field it is B");
  assert.equal(tunnelTargetWithoutInstance([{ port: 3000, instance: A }, { port: 8000, instance: B }], 3000), A);
  assert.equal(tunnelTargetWithoutInstance([{ port: 3000, instance: A }, { port: 3000, instance: B }], 3000), undefined);
  assert.equal(tunnelTargetWithoutInstance([], 3000), undefined);
  assert.equal(instanceForScope([{ port: 3000, instance: A }], "proj:p-b", 3000).nullTarget, A);
});

// Without this rule browser.js counted every forward as ours (a page of project B silently got the app of A).
test("native browser per scope: a local port leading to ANOTHER project is not \"ours\" if the own project holds it", () => {
  const ofA = { instance: A, port: 3000, localPort: 3000 };
  // Measurement in the scope of B: B holds 3000.
  const mB = { port: 3000, containerHas: true, instance: B, nullTarget: undefined };
  assert.equal(localPortsForScope([ofA], "proj:p-b", mB).has(3000), false, "A's forward counts as ours for a page of B");
  // In the scope of A, in the ws scope and without an own project on the port it stays ours.
  assert.equal(localPortsForScope([ofA], "proj:p-a", { port: 3000, containerHas: true, instance: A }).has(3000), true);
  assert.equal(localPortsForScope([ofA], "ws:w1", mB).has(3000), true);
  assert.equal(localPortsForScope([ofA], "proj:p-b", { port: 3000, containerHas: true, instance: A }).has(3000), true, "B does not hold the port");
  assert.equal(localPortsForScope([ofA], "proj:p-b", { port: 3000, containerHas: false, instance: null }).has(3000), true);
  assert.equal(localPortsForScope([ofA], "proj:p-b").has(3000), true, "without a measurement as before");
  // Other local ports stay untouched.
  assert.equal(localPortsForScope([ofA, { instance: A, port: 8000, localPort: 8000 }], "proj:p-b", mB).has(8000), true);
  // Without an instance: ours only if its tunnel (old-client rule) leads to the own project.
  const old = { instance: null, port: 3000, localPort: 3000 };
  assert.equal(localPortsForScope([old], "proj:p-b", { ...mB, nullTarget: B }).has(3000), true);
  assert.equal(localPortsForScope([old], "proj:p-b", { ...mB, nullTarget: undefined }).has(3000), false, "the tunnel ends in B, where nobody listens");
  assert.equal(localPortsForScope([old], "proj:p-b", { ...mB, nullTarget: null }).has(3000), false, "the tunnel goes to B, not to the own project");
  // When does the main frame need a measurement at all? Only in the scope of a project the forward does not belong to.
  assert.equal(forwardingNeedsMeasurement(ofA, "proj:p-a"), false);
  assert.equal(forwardingNeedsMeasurement(ofA, "proj:p-b"), true);
  assert.equal(forwardingNeedsMeasurement(old, "proj:p-b"), true);
  assert.equal(forwardingNeedsMeasurement(ofA, "ws:w1"), false);
});

// A removed copy leaves forwards whose tunnel the server rejects with 404 "unknown instance: <identifier>" (tunnel.js
// tunnelTarget, ports/running — the server's wording, which is why these fixtures are German). The client then lifts them
// to `<project>/main`, the one instance that always exists. The rule is pure; main.js only measures and wires.
test("fallback: 404 \"unknown instance\" of a copy ⇒ `<project>/main`; everything else stays as it is", () => {
  const k = "p-a/k1";
  assert.equal(fallbackInstance(k, 404, "unknown instance: p-a/k1"), "p-a/main");
  assert.equal(fallbackInstance(k, 404, JSON.stringify({ error: "unknown instance: p-a/k1" })), "p-a/main", "also as a JSON response");
  // The project is everything before the LAST slash.
  assert.equal(fallbackInstance("p/x/k2", 404, "unknown instance: p/x/k2"), "p/x/main");
  // The main instance itself does not fall back (that would loop), nor does a missing identifier.
  assert.equal(fallbackInstance(A, 404, "unknown instance: p-a/main"), null);
  assert.equal(fallbackInstance(null, 404, "unknown instance: x"), null);
  assert.equal(fallbackInstance(undefined, 404, "unknown instance: x"), null);
  // Only 404 WITH this reason: another 404 ("only in server mode"), 409, 500, 200 do not fall back.
  assert.equal(fallbackInstance(k, 404, "only in server mode"), null);
  assert.equal(fallbackInstance(k, 404, ""), null);
  assert.equal(fallbackInstance(k, 404, undefined), null);
  for (const status of [200, 400, 409, 500, 0, undefined]) assert.equal(fallbackInstance(k, status, "unknown instance: p-a/k1"), null, String(status));
  // No valid identifier ⇒ no fallback (never guess).
  assert.equal(fallbackInstance("main", 404, "unknown instance: main"), null);
});

test("fallback wired: a tunnel that never opened checks via the rule and lifts the entry to main", () => {
  const main = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
  assert.match(main, /if \(!openBeen\) checkFallback\(entry\);/, "teardown does not check the fallback");
  assert.match(main, /openBeen = true;/, "onopen does not remember the opening — every teardown would trigger a check");
  const block = main.slice(main.indexOf("async function checkFallback("), main.indexOf("async function liftForwarding("));
  assert.match(block, /fallbackInstance\(old, status, body\)/, "the check does not ask the rule");
  assert.match(block, /instance=\$\{encodeURIComponent\(old\)\}/, "the measurement does not ask with the instance");
  assert.match(main, /status: res\.statusCode, body: buf/, "sessionRequest does not pass on status and body of the error");
});

// ── Exclusive selection ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Exactly one instance or none forwards; the plan is `switchoverPlan` with `mode`.
const fw = (instance, port, localPort, source) => ({ instance, port, localPort, source });

test("selection exclusive: every forward of the choice of ANOTHER instance ends, even without conflict; the chosen numbers belong to the choice", () => {
  const forwards = [
    fw(A, 3000, 3000, "selection"),
    fw(A, 8000, 8000, "selection"),        // no conflict with B — ends anyway (exclusive)
    fw(null, 5173, 5173, "manual"),     // manual, sits on a number of B — the explicit choice takes it
    fw("p-c/main", 9000, 9000, "browser"), // browser, on no number of B — stays (own section)
    fw(null, 4000, 4000, "manual"),     // manual, on no number of B — stays
  ];
  assert.deepEqual(switchoverPlan({ forwards, instance: B, ports: [5173, 3000], mode: "exclusive" }), {
    stop: [{ instance: A, port: 3000 }, { instance: A, port: 8000 }, { instance: null, port: 5173 }],
    bind: [3000, 5173], takeOver: [], occupied: [],
  });
  // Own forwards: on its number the choice takes it over (browser/manual ⇒ selection), a moved-aside one is fetched back,
  // an own one outside the ports stays untouched.
  const own = [
    fw(B, 3000, 3000, "browser"),
    fw(B, 5173, 5174, "manual"),
    fw(B, 7000, 7000, "selection"),
    fw(A, 8000, 8000, "selection"),
  ];
  assert.deepEqual(switchoverPlan({ forwards: own, instance: B, ports: [3000, 5173, 8000], mode: "exclusive" }), {
    stop: [{ instance: B, port: 5173 }, { instance: A, port: 8000 }],
    bind: [5173, 8000], takeOver: [3000], occupied: [],
  });
  // None: all forwards of the choice end, manual and browser stay — passed ports do not count (null is NOT the namespace
  // B here).
  assert.deepEqual(switchoverPlan({ forwards, instance: null, ports: [5173], mode: "exclusive" }), {
    stop: [{ instance: A, port: 3000 }, { instance: A, port: 8000 }], bind: [], takeOver: [], occupied: [],
  });
  // The same choice again: nothing to do.
  const finished = [fw(B, 3000, 3000, "selection"), fw(B, 5173, 5173, "selection")];
  assert.deepEqual(switchoverPlan({ forwards: finished, instance: B, ports: [3000, 5173], mode: "exclusive" }),
    { stop: [], bind: [], takeOver: [], occupied: [] });
});

test("selection bring-along: binds the missing ports of the active instance — never takes a manual forward away and fetches no moved-aside one back", () => {
  const forwards = [
    fw(B, 3000, 3000, "selection"),
    fw(B, 5173, 5174, "selection"),          // moved aside (a local program listens) — stays, no back and forth
    fw(null, 8000, 8000, "manual"),       // manual on a needed number ⇒ occupied, NOT stopped, not bound elsewhere
    fw("p-c/main", 9000, 9000, "browser"),// browser on a needed number ⇒ ends, the choice has priority
    fw(A, 4000, 4000, "selection"),          // rest of another choice outside the ports — not bring-along's business
    fw(B, 6000, 6000, "browser"),          // own, from the browser, on a service port ⇒ taken over
  ];
  assert.deepEqual(switchoverPlan({ forwards, instance: B, ports: [3000, 5173, 6000, 8000, 9000], mode: "bringAlong" }), {
    stop: [{ instance: "p-c/main", port: 9000 }], bind: [9000], takeOver: [6000], occupied: [8000],
  });
  // Without an active instance there is nothing to bring along.
  assert.deepEqual(switchoverPlan({ forwards, instance: null, ports: [3000], mode: "bringAlong" }), { stop: [], bind: [], takeOver: [], occupied: [] });
  // Without a mode it stays the plain switchover: the shape without `takeOver`/`occupied`.
  assert.deepEqual(Object.keys(switchoverPlan({ forwards, instance: B, ports: [3000] })).sort(), ["bind", "stop"]);
});

test("source after a second request: the choice takes over any, a manual click only the browser's, the browser never", () => {
  const table = [
    ["browser", "selection", "selection"], ["manual", "selection", "selection"], ["selection", "selection", "selection"], [undefined, "selection", "selection"],
    ["browser", "manual", "manual"], ["manual", "manual", "manual"], ["selection", "manual", "selection"], [undefined, "manual", "manual"],
    ["browser", "browser", "browser"], ["manual", "browser", "manual"], ["selection", "browser", "selection"],
  ];
  for (const [old, fresh, desired] of table) assert.equal(sourceTo(old, fresh), desired, `${old} + ${fresh}`);
  // The source is stored only for the choice — a manual forward carries no field in the file.
  assert.deepEqual(remember([], { instance: A, port: 3000, localPort: 3000, source: "selection" }), [{ instance: A, port: 3000, localPort: 3000, source: "selection" }]);
  assert.deepEqual(remember([], { instance: A, port: 3000, localPort: 3000, source: "manual" }), [{ instance: A, port: 3000, localPort: 3000 }]);
  assert.deepEqual(remember([], { instance: A, port: 3000, localPort: 3000 }), [{ instance: A, port: 3000, localPort: 3000 }]);
});

test("start: ONCE the stored forwards without instance fall (marker), ones created later stay; the choice binds only its own", () => {
  // A real settings file: six without instance (one of them without the field), plus GEO 8000.
  const GEO = "e0ebc946/main";
  const maintainer = {
    serverUrl: "https://x", theme: "dark",
    forwards: [
      { instance: null, port: 3100, localPort: 3100 }, { instance: null, port: 3101, localPort: 3101 }, { instance: null, port: 3110, localPort: 3110 },
      { instance: null, port: 3001, localPort: 3001 }, { port: 2222, localPort: 2222 }, { instance: null, port: 3125, localPort: 3125 },
      { instance: GEO, port: 8000, localPort: 8000 },
    ],
  };
  const r = startState(maintainer);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed.map((f) => f.port), [3100, 3101, 3110, 3001, 2222, 3125]);
  // GEO:8000 is a project forward, not a manual one: it becomes the choice instead of forwarding as "manual" next to a
  // "none" in the radio.
  assert.deepEqual(r.settings, {
    serverUrl: "https://x", theme: "dark", [MIGRATION_MARKER]: true, activeInstance: GEO,
    forwards: [{ instance: GEO, port: 8000, localPort: 8000, source: "selection" }],
  }, "the migration touched more or other things than the old forwards");
  assert.deepEqual(r.bind, [{ instance: GEO, port: 8000, localPort: 8000, source: "selection" }]);
  assert.equal(r.active, GEO);
  // Second start: nothing left to do — the file is not rewritten on every start.
  const second = startState(r.settings);
  assert.equal(second.changed, false);
  assert.deepEqual(second.removed, []);
  // Created by hand afterwards (without instance) and an entry without the field (old client after rollback): both stay.
  const afterwards = startState({ [MIGRATION_MARKER]: true, forwards: [{ instance: null, port: 3000, localPort: 3000 }, { port: 4000, localPort: 4000 }] });
  assert.deepEqual(afterwards.bind.map((f) => [f.instance, f.port, f.source]), [[null, 3000, "manual"], [null, 4000, "manual"]],
    "a forward without instance created AFTER the migration fell — the marker has no effect");
  assert.equal(afterwards.changed, true, "the entry without the field is migrated");
  // The marker is set even if nothing fell (otherwise the next start would remove the first manual forward).
  const empty = startState({ forwards: [] });
  assert.equal(empty.changed, true);
  assert.equal(empty.settings[MIGRATION_MARKER], true);
  // The choice: only forwards of the stored instance are bound, those of another drop out of the file.
  const withChoice = startState({
    [MIGRATION_MARKER]: true, activeInstance: A,
    forwards: [fw(A, 3000, 3000, "selection"), fw(B, 3000, 3001, "selection"), { instance: null, port: 5173, localPort: 5173 }],
  });
  assert.equal(withChoice.active, A);
  assert.deepEqual(withChoice.bind.map((f) => [f.instance, f.port, f.source]), [[A, 3000, "selection"], [null, 5173, "manual"]]);
  assert.deepEqual(withChoice.settings.forwards.map((f) => f.instance), [A, null]);
  assert.equal(withChoice.changed, true);
  // An unreadable choice is none — then every forward of the choice falls too.
  const broken = startState({ [MIGRATION_MARKER]: true, activeInstance: "broken", forwards: [fw(A, 3000, 3000, "selection")] });
  assert.equal(broken.active, null);
  assert.deepEqual(broken.bind, []);
  assert.deepEqual(startState(undefined).bind, []);
});

// A stored forward WITH an instance but without `source` (the format before the selection existed) used to come back as
// "manual": the radio said "none", localhost:8000 still forwarded to GEO, and nothing ended it.
test("start: the old project forwards become the choice in the SAME migration — one instance ⇒ active, several ⇒ they fall", () => {
  const GEO = "e0ebc946/main";
  const run = (bind) => bind.map((f) => fw(f.instance, f.port, f.localPort, f.source));
  // After the first start, "none" and a project without 8000 both end GEO's forward.
  const r = startState({ forwards: [{ instance: null, port: 3100, localPort: 3100 }, { instance: GEO, port: 8000, localPort: 8000 }] });
  assert.equal(r.active, GEO);
  assert.deepEqual(switchoverPlan({ forwards: run(r.bind), instance: null, ports: [], mode: "exclusive" }).stop, [{ instance: GEO, port: 8000 }],
    "\"none\" does not end GEO's old forward — exactly one instance or none forwards");
  assert.deepEqual(switchoverPlan({ forwards: run(r.bind), instance: "reise/main", ports: [3000], mode: "exclusive" }).stop, [{ instance: GEO, port: 8000 }]);
  // The same instance on several ports: all become the choice (the file keeps their local numbers).
  const two = startState({ forwards: [{ instance: A, port: 3000, localPort: 3000 }, { instance: A, port: 8000, localPort: 8001 }] });
  assert.equal(two.active, A);
  assert.equal(two.settings.activeInstance, A);
  assert.deepEqual(two.settings.forwards, [fw(A, 3000, 3000, "selection"), fw(A, 8000, 8001, "selection")]);
  assert.deepEqual(two.removed, []);
  // Two instances: nobody knows which was meant — both fall like those without instance (a guessed choice would be worse).
  const both = startState({ forwards: [{ instance: A, port: 3000, localPort: 3000 }, { instance: B, port: 4000, localPort: 4000 }, { instance: null, port: 5173, localPort: 5173 }] });
  assert.equal(both.active, null);
  assert.deepEqual(both.removed.map((f) => [f.instance, f.port]), [[A, 3000], [B, 4000], [null, 5173]]);
  assert.deepEqual(both.settings.forwards, []);
  assert.deepEqual(both.bind, []);
  assert.equal(both.settings.activeInstance ?? null, null);
  // An entry with an unreadable instance stays as it was (restore skips it) — neither a candidate nor a reason to fall.
  const broken = startState({ forwards: [{ instance: "broken", port: 3000, localPort: 3000 }, { instance: A, port: 8000, localPort: 8000 }] });
  assert.equal(broken.active, A);
  assert.deepEqual(broken.settings.forwards, [{ instance: "broken", port: 3000, localPort: 3000 }, fw(A, 8000, 8000, "selection")]);
  // AFTER the migration (marker set) a forward with instance but without `source` stays manual: it was created afterwards.
  const afterwards = startState({ [MIGRATION_MARKER]: true, forwards: [{ instance: A, port: 3000, localPort: 3000 }] });
  assert.equal(afterwards.active, null);
  assert.deepEqual(afterwards.bind, [{ instance: A, port: 3000, localPort: 3000, source: "manual" }]);
  assert.equal(afterwards.changed, false);
});

// A forward of the choice that moved aside while binding (a local program briefly held localhost:3000) stored
// `localPort: 3001` — and every restart bound 3001 again, even with 3000 free. The choice always wants its own number.
test("start: a forward of the choice first tries its OWN number on restart; a manual one keeps the stored local port", () => {
  const r = startState({
    [MIGRATION_MARKER]: true, activeInstance: A,
    forwards: [fw(A, 3000, 3001, "selection"), { instance: null, port: 5173, localPort: 5174 }, fw(A, 8000, 8000, "selection")],
  });
  assert.deepEqual(r.bind.map((f) => [f.instance, f.port, f.localPort, f.source]), [[A, 3000, 3000, "selection"], [null, 5173, 5174, "manual"], [A, 8000, 8000, "selection"]],
    "a moved-aside forward of the choice would stay moved aside across every restart");
  assert.deepEqual(rememberedToBind([fw(A, 3000, 3001, "selection")]).map((f) => f.localPort), [3000]);
  assert.deepEqual(rememberedToBind([{ instance: A, port: 3000, localPort: 3001 }]).map((f) => f.localPort), [3001], "manually chosen local numbers stay");
});

test("the stored choice and the options of a `select`: identifier or none, mode only exclusive/bringAlong", () => {
  assert.equal(activeFromSettings({ activeInstance: A }), A);
  for (const empty of [{}, { activeInstance: null }, { activeInstance: "" }, { activeInstance: "broken" }, { activeInstance: 3 }, null, undefined]) {
    assert.equal(activeFromSettings(empty), null, JSON.stringify(empty));
  }
  assert.deepEqual(selectOptions(undefined), { mode: undefined });
  assert.deepEqual(selectOptions(null), { mode: undefined });
  assert.deepEqual(selectOptions({}), { mode: undefined });
  assert.deepEqual(selectOptions({ mode: "exclusive" }), { mode: "exclusive" });
  assert.deepEqual(selectOptions({ mode: "bringAlong" }), { mode: "bringAlong" });
  for (const wrong of [{ mode: "everything" }, "exclusive", [], 3]) assert.ok(selectOptions(wrong).error, JSON.stringify(wrong));
  // The `ifActive` condition — for which choice a fallback was computed (identifier or null = none); if absent, no
  // condition applies (no field, not `undefined`); anything else is an error, never silently "no condition".
  assert.deepEqual(selectOptions({ mode: "exclusive", ifActive: A }), { mode: "exclusive", ifActive: A });
  assert.deepEqual(selectOptions({ mode: "exclusive", ifActive: null }), { mode: "exclusive", ifActive: null });
  assert.deepEqual(selectOptions({ mode: "bringAlong", ifActive: B }), { mode: "bringAlong", ifActive: B });
  assert.deepEqual(selectOptions({ mode: "exclusive", ifActive: undefined }), { mode: "exclusive" });
  for (const wrong of [{ mode: "exclusive", ifActive: "broken" }, { mode: "exclusive", ifActive: 3 }, { ifActive: A }]) {
    assert.ok(selectOptions(wrong).error, JSON.stringify(wrong));
  }
});

test("native browser and the choice: if the active instance holds the port, it wins — before the scope's project; otherwise as before", () => {
  const open = [{ port: 3000, instance: A }, { port: 3000, instance: B }];
  const core = (r) => ({ has: r.has, instance: r.instance });
  assert.deepEqual(core(instanceForScope(open, "proj:p-b", 3000, A)), { has: true, instance: A }, "the browser silently displaces the choice with the scope's project");
  assert.deepEqual(core(instanceForScope(open, "ws:w1", 3000, A)), { has: true, instance: A }, "with an active instance the port is not ambiguous");
  // If the active instance does NOT hold the port, the scope's rule applies (the browser then forwards a port the choice does not have).
  assert.deepEqual(core(instanceForScope(open, "proj:p-b", 3000, "p-c/main")), { has: true, instance: B });
  assert.equal(instanceForScope(open, "ws:w1", 3000, "p-c/main").has, "ambiguous");
  assert.deepEqual(core(instanceForScope(open, "proj:p-b", 3000, null)), { has: true, instance: B });
  assert.deepEqual(core(instanceForScope([], "proj:p-b", 3000, A)), { has: false, instance: null });
});

test("shipping: every relative file of the shell is in build.files AND in client/shell-files.json", () => {
  const read = (...p) => fs.readFileSync(path.join(here, "..", "..", ...p), "utf8");
  const files = new Set(JSON.parse(read("client", "package.json")).build.files);
  const deploy = new Set(JSON.parse(read("client", "shell-files.json")).files);
  const imports = new Set();
  for (const file of ["main.js", "browser.js"]) {
    for (const i of read("client", file).matchAll(/from "\.\/([^"]+)"/g)) imports.add(i[1]);
  }
  assert.ok(imports.has("forwarding-rules.js"), "main.js does not import forwarding-rules.js — the anchor reads the wrong file");
  for (const d of imports) {
    assert.ok(files.has(d), `${d} is missing in client/package.json build.files — the bundle would not start without it`);
    assert.ok(deploy.has(d), `${d} is missing in client/shell-files.json — a change to it would silently not ship`);
  }
});
