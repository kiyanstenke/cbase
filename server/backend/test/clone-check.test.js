// Guard: the check of the clone address at the SERVER (projectbox/setup/clone.js checkCloneDetail, the border - 400
// before any project setup) follows the fixture set server/backend/test/fixtures/clone-check/cases.json, expectation
// `server`. Web (`web/src/lib/project-clone.ts`) and iOS (`Code/ProjectClone.swift`) run the same set with their
// expectation `client` - ONE rule in three places. A new case belongs in the set, not here (README there). This test
// never changes the fixture.
//
// The promises:
//   (1) Every case: `{ host }` => `ok` and `host` (lowercase, no port - the key of the access) as expected; `{ code }`
//       => not ok, the same code, a text. No case stays without an expectation, every code is in CLONE_CODES (the
//       server never answers with another).
//   (2) Built-in sabotage: the comparison itself is not empty - a swapped expectation (host instead of code, code
//       instead of host, another code, another host) is reported, and a rule that lets everything through or rejects
//       everything fails on the set.
//
// Counter-test: a check that drops the host normalization or mixes up the codes (uppercase scheme `HTTPS://` as
// HOST_UNCLEAR, `https:gitlab.com/...` as HOST_UNCLEAR instead of ONLY_HTTPS, an octet 256 or a port over 65535
// as ONLY_HTTPS instead of HOST_UNCLEAR, `https://gitlab.com/g/.git` and encoded separators passing) turns (1) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLONE_CODES, checkCloneDetail } from "../electron/server/projectbox/setup/clone.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "clone-check", "cases.json"), "utf8"));

// The verdict on ONE case: null (fits) or the reason why not.
function deviation(fall, r) {
  const e = fall.server;
  if (e && typeof e.host === "string") {
    if (!r?.ok) return `expected host ${e.host}, got ${r?.code}: ${r?.error}`;
    if (r.host !== e.host) return `expected host ${e.host}, got host ${r.host}`;
    return null;
  }
  if (e && typeof e.code === "string") {
    if (r?.ok) return `expected ${e.code}, passed (host ${r.host})`;
    if (r?.code !== e.code) return `expected ${e.code}, got ${r?.code}: ${r?.error}`;
    if (typeof r.error !== "string" || !r.error) return `${e.code} without a text`;
    return null;
  }
  return `without an expectation: ${JSON.stringify(e)}`;
}
const check = (fall) => checkCloneDetail({ url: fall.url, branch: fall.branch });

test("(1) checkCloneDetail follows the clone-check fixture set (expectation server): host or code per case, every code from CLONE_CODES", () => {
  assert.ok(Array.isArray(cases) && cases.length > 0, "the set is empty");
  const wrong = [];
  for (const fall of cases) {
    assert.ok(fall.server && (typeof fall.server.host === "string") !== (typeof fall.server.code === "string"), `a case without an unambiguous expectation: ${JSON.stringify(fall)}`);
    if (fall.server.code) assert.ok(CLONE_CODES.includes(fall.server.code), `the set expects a code outside CLONE_CODES: ${fall.server.code}`);
    const r = check(fall);
    if (!r.ok) assert.ok(CLONE_CODES.includes(r.code), `the server answered with ${r.code} - not in CLONE_CODES`);
    const reason = deviation(fall, r);
    if (reason) wrong.push(`${JSON.stringify(fall.url)} (branch ${JSON.stringify(fall.branch)}): ${reason}`);
  }
  assert.deepEqual(wrong, [], `${wrong.length} of ${cases.length} cases deviate:\n${wrong.join("\n")}`);
  // Both kinds occur - otherwise the set would check only one side.
  assert.ok(cases.some((f) => f.server.host) && cases.some((f) => f.server.code), "the set carries only one kind of expectation");
});

test("(2) built-in sabotage: the comparison reports swapped expectations, and a rule that lets everything through or rejects everything fails on the set", () => {
  const withHost = cases.find((f) => f.server.host);
  const withCode = cases.find((f) => f.server.code);
  const rHost = check(withHost);
  const rCode = check(withCode);
  assert.equal(deviation(withHost, rHost), null);
  assert.equal(deviation(withCode, rCode), null);
  // Swapped: code instead of host, host instead of code, another code, another host, no expectation at all.
  assert.ok(deviation({ ...withHost, server: { code: "ONLY_HTTPS" } }, rHost));
  assert.ok(deviation({ ...withCode, server: { host: "gitlab.com" } }, rCode));
  assert.ok(deviation({ ...withCode, server: { code: CLONE_CODES.find((c) => c !== withCode.server.code) } }, rCode));
  assert.ok(deviation({ ...withHost, server: { host: `x${withHost.server.host}` } }, rHost));
  assert.ok(deviation({ ...withHost, server: {} }, rHost));
  assert.ok(deviation(withCode, { ok: false, code: withCode.server.code, error: "" }), "a code without a text passed");
  // Two rules that distinguish nothing: the set catches both.
  const everythingPasses = cases.filter((f) => !deviation(f, { ok: true, host: f.server.host ?? "gitlab.com" }));
  const everythingNo = cases.filter((f) => !deviation(f, { ok: false, code: f.server.code ?? "ONLY_HTTPS", error: "x" }));
  assert.ok(everythingPasses.length < cases.length, "a rule that lets everything through passed the set");
  assert.ok(everythingNo.length < cases.length, "a rule that rejects everything passed the set");
});
