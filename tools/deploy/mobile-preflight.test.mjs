// The Xcode account check of the mobile preflight — a check that could NOT fail.
//
// It used to read `accounts.stdout.trim().length > 0`. But `defaults read` returns a complete skeleton even for an EMPTY
// account list, i.e. 45 characters. The preflight therefore reported "Xcode account present" as long as Xcode had ever run —
// and `archive` runs through with the developer identity, only the upload breaks off.
//
// That is why the EMPTY output comes first here: it is the case the old version did not see, and the only one that justifies
// this test.
import assert from "node:assert/strict";
import test from "node:test";

import { hatAppleAccount, preflightVerdict } from "./targets/mobile.mjs";

// The verbatim output on a Mac with nobody logged in.
const EMPTY = '{\n    "IDE.Identifiers.Prod" =     (\n    );\n}\n';

test("an empty account list is NO account — even if `defaults read` prints 45 characters", () => {
  assert.equal(EMPTY.trim().length, 45, "the old check took exactly this length for \"present\"");
  assert.equal(hatAppleAccount(EMPTY), false);
});

test("an entered account counts", () => {
  const full = '{\n    "IDE.Identifiers.Prod" =     (\n        "maintainer@example.com"\n    );\n}\n';
  assert.equal(hatAppleAccount(full), true);
});

test("several lists: ONE filled one suffices", () => {
  const mixed = '{\n    "IDE.Identifiers.Prod" =     (\n    );\n    "IDE.Identifiers.Sandbox" =     (\n        "test@example.com"\n    );\n}\n';
  assert.equal(hatAppleAccount(mixed), true);
});

test("no output at all is no account", () => {
  // `defaults read` fails when the key is missing — the command ends in `|| true`, the output is then empty. "No account",
  // now for the right reason: there is nothing in the brackets because there are no brackets.
  assert.equal(hatAppleAccount(""), false);
  assert.equal(hatAppleAccount(undefined), false);
  assert.equal(hatAppleAccount("Domain … does not exist"), false);
});

// ── The verdict: who may go without an account? ──────────────────────────────────────────
//
// The repair of the account check (above) must not demand the account for EVERY mode: that would block the direct way to the
// iPhone — the only one in use here, which works without an account because identity and provisioning profile are local.
const OK = { hasIdentity: true, hasAccount: true, device: true };

test("without an account: the direct way to the iPhone stays open, the upload does not", () => {
  assert.equal(preflightVerdict({ ...OK, hasAccount: false, mode: "device" }), null);
  assert.equal(preflightVerdict({ ...OK, hasAccount: false, mode: "ipa" }), null);
  const hold = preflightVerdict({ ...OK, hasAccount: false, mode: "testflight" });
  assert.match(String(hold), /App Store Connect/, "the message must say WHAT is missing");
  assert.match(String(hold), /--device/, "and where the way leads anyway");
});

test("with an account every mode is free", () => {
  for (const mode of ["device", "ipa", "testflight"]) {
    assert.equal(preflightVerdict({ ...OK, mode }), null, mode);
  }
});

test("without a signing identity nothing works — in every mode", () => {
  for (const mode of ["device", "ipa", "testflight"]) {
    assert.match(String(preflightVerdict({ ...OK, hasIdentity: false, mode })), /signing identity/, mode);
  }
});

test("no phone stops ONLY the direct way", () => {
  assert.match(String(preflightVerdict({ ...OK, device: false, mode: "device" })), /No iPhone/);
  assert.equal(preflightVerdict({ ...OK, device: false, mode: "testflight" }), null);
  assert.equal(preflightVerdict({ ...OK, device: false, mode: "ipa" }), null);
});

test("credentials in the source tree stop it, --force lifts that — broken files NOT", () => {
  assert.match(String(preflightVerdict({ ...OK, mode: "device", leaks: ["mobile/x.swift:1"] })), /Credentials/);
  assert.equal(preflightVerdict({ ...OK, mode: "device", leaks: ["mobile/x.swift:1"], force: true }), null);
  // An invalid Info.plist is no discretion: the build would fail anyway.
  assert.match(String(preflightVerdict({ ...OK, mode: "device", bad: ["Info.plist: broken"], force: true })), /plutil/);
});
