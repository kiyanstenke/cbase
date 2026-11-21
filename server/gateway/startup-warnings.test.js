// The start-up warnings (startup-warnings.js) — as a pure function and in the REAL gateway's log (gateway-harness.mjs).
//   (1) GW_RUNTIME empty ⇒ the Sysbox warning; sysbox-runc ⇒ none
//   (2) GW_HOST not loopback and GW_SECURE != "1" ⇒ the Secure-cookie warning; loopback or GW_SECURE=1 ⇒ none
//   (3) the real gateway prints both warnings for a weak configuration and neither for the production one
// COUNTER-TEST: drop the `startupWarnings` loop in index.js's listen callback ⇒ (3) red; drop the GW_SECURE check ⇒ (2) red.
import test from "node:test";
import assert from "node:assert/strict";
import { prepareSetup } from "./gateway-harness.mjs";
import { isLoopbackHost, startupWarnings } from "./startup-warnings.js";

const SYSBOX = /GW_RUNTIME is empty .*without Sysbox/;
const COOKIE = /without the Secure flag\. Set GW_SECURE=1 behind TLS/;
const has = (lines, re) => lines.some((l) => re.test(l));

test("(1) an empty GW_RUNTIME warns about plain Docker containers without Sysbox", () => {
  assert.ok(has(startupWarnings({ GW_RUNTIME: "" }), SYSBOX));
  assert.ok(has(startupWarnings({}), SYSBOX));
  assert.ok(has(startupWarnings({ GW_RUNTIME: "  " }), SYSBOX));
  assert.equal(has(startupWarnings({ GW_RUNTIME: "sysbox-runc" }), SYSBOX), false);
});

test("(2) a non-loopback GW_HOST without GW_SECURE=1 warns about cookies without the Secure flag", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.org"]) {
    assert.ok(has(startupWarnings({ GW_RUNTIME: "sysbox-runc", GW_HOST: host }), COOKIE), host);
    assert.ok(has(startupWarnings({ GW_RUNTIME: "sysbox-runc", GW_HOST: host, GW_SECURE: "0" }), COOKIE), host);
    assert.deepEqual(startupWarnings({ GW_RUNTIME: "sysbox-runc", GW_HOST: host, GW_SECURE: "1" }), [], host);
  }
  for (const host of [undefined, "", "127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.deepEqual(startupWarnings({ GW_RUNTIME: "sysbox-runc", GW_HOST: host }), [], String(host));
  }
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("127.0.0.1.example.org"), false);
});

test("(3) the real gateway logs both warnings for a weak configuration and none for the production one", async () => {
  const weak = await prepareSetup({ env: { GW_RUNTIME: "", GW_HOST: "0.0.0.0", GW_SECURE: "" } });
  try {
    await weak.start();
    assert.match(weak.log(), SYSBOX);
    assert.match(weak.log(), COOKIE);
  } finally { await weak.end(); }
  const prod = await prepareSetup({ env: { GW_RUNTIME: "sysbox-runc", GW_HOST: "127.0.0.1", GW_SECURE: "1" } });
  try {
    await prod.start();
    assert.doesNotMatch(prod.log(), SYSBOX);
    assert.doesNotMatch(prod.log(), COOKIE);
    assert.match(prod.log(), /cbase gateway v\S+ on /, "the log was read at all");
  } finally { await prod.end(); }
});
