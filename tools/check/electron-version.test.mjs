// The Electron version of a bundle against node_modules.
//
// Why dedicated tests: no check of the tool read the Electron version. The client decided "rebuild or only restart" from shell
// files and icon alone — a pure version jump (37.10.3 → 44.4.4) would have left the old bundle standing silently. Checked here
// is the verdict in all four situations (equal / different / bundle missing / plist unreadable) plus the one that "empty is
// not unknown" hangs on: two UNKNOWN versions are not equal.
//
// The bindings to targets/client.mjs and targets/status.mjs live in electron-version.test.mjs.
//
// Run:  node --test --test-reporter=tap tools/check/electron-version.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, reads } from "./lib/electron-version-fixture.mjs";
import { ELECTRON_PLIST, electronBundleAgainstModule, electronInBundle, electronDesired, electronComparison, plutilValue } from "./lib/electron-version.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The real form of the framework plist (shortened, Electron 37.10.3).
const PLIST = (v) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Electron Framework</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.Electron.framework</string>
	<key>CFBundleVersion</key>
	<string>${v}</string>
</dict>
</plist>
`;

test("equal: bundle and node_modules carry the same version", () => {
  const b = build();
  try {
    const v = electronBundleAgainstModule(b.app, b.target, { read: reads("44.4.4") });
    console.log(`  [equal] ${v.text}`);
    assert.equal(v.equal, true);
    assert.equal(v.actual, "44.4.4");
    assert.equal(v.desired, "44.4.4");
    assert.match(v.text, /== node_modules \(44\.4\.4\)/, "the line names the version, not just \"equal\"");
  } finally {
    b.cleanUp();
  }
});

test("different: the pure version jump is a deviation — and the line names both sides", () => {
  const b = build();
  try {
    const v = electronBundleAgainstModule(b.app, b.target, { read: reads("37.10.3") });
    console.log(`  [different] ${v.text} · ${v.short}`);
    assert.equal(v.equal, false);
    assert.match(v.text, /37\.10\.3/);
    assert.match(v.text, /44\.4\.4/);
    assert.equal(v.short, "Electron 37.10.3 → 44.4.4");
    // A patch jump too — the next move after this one (44.4.5) would look just as silent.
    assert.equal(electronBundleAgainstModule(b.app, b.target, { read: reads("44.4.5") }).equal, false);
  } finally {
    b.cleanUp();
  }
});

test("bundle missing — or carries no framework plist: unknown, never equal", () => {
  const b = build();
  try {
    const way = electronInBundle(path.join(b.dir, "exists-not.app"), { read: reads("44.4.4") });
    assert.deepEqual(way, { version: null, reason: "bundle missing" });
    assert.equal(electronComparison(way, electronDesired(b.target)).equal, false);

    // A bundle without Electron Framework (e.g. a half-copied one): the reader is not asked at all.
    fs.rmSync(path.join(b.app, ELECTRON_PLIST));
    let asked = false;
    const without = electronInBundle(b.app, { read: () => ((asked = true), { value: "44.4.4", reason: "" }) });
    assert.equal(without.version, null);
    assert.equal(asked, false, "without a plist no version may be conjured up");
    assert.match(without.reason, /Info\.plist/);
  } finally {
    b.cleanUp();
  }
});

test("plist unreadable: failing reader, throwing reader, nonsense — never equal", () => {
  const b = build();
  try {
    for (const [name, read] of [
      ["plutil fails", reads(null)],
      ["reader throws", () => { throw new Error("simulated: broken"); }],
      ["nonsense instead of version", reads("Electron Framework")],
      ["empty value", () => ({ value: "", reason: "" })],
    ]) {
      const actual = electronInBundle(b.app, { read });
      const v = electronComparison(actual, electronDesired(b.target));
      console.log(`  [unreadable: ${name}] ${v.text}`);
      assert.equal(actual.version, null, `${name}: a version was claimed`);
      assert.ok(actual.reason, `${name}: without a reason \"unknown\" cannot be told from \"empty\"`);
      assert.equal(v.equal, false, `${name}: counts as equal`);
      assert.match(v.text, /unknown/);
    }
  } finally {
    b.cleanUp();
  }
});

test("two unknowns are NOT equal — bundle unreadable and node_modules missing", () => {
  const b = build({ desired: null });
  try {
    const desired = electronDesired(b.target);
    assert.deepEqual(desired, { version: null, reason: "node_modules/electron missing" });
    // The core: null === null. A version that compares only the values would report "equal" here.
    const v = electronComparison(electronInBundle(b.app, { read: reads(null) }), desired);
    console.log(`  [both unknown] ${v.text}`);
    assert.equal(v.equal, false, "two unread versions were reported as equal");
    // And only the desired side unknown: a read bundle is not equal to "don't know".
    assert.equal(electronComparison({ version: "44.4.4", reason: "" }, desired).equal, false);
    // A package.json with a non-version is unknown too.
    fs.mkdirSync(path.join(b.target, "node_modules", "electron"), { recursive: true });
    fs.writeFileSync(path.join(b.target, "node_modules", "electron", "package.json"), JSON.stringify({ version: "" }));
    assert.equal(electronDesired(b.target).version, null);
  } finally {
    b.cleanUp();
  }
});

test("plutil: a missing tool is unknown — and on macOS it reads the real plist", () => {
  const b = build({ plist: PLIST("44.4.4") });
  try {
    const missing = plutilValue(path.join(b.app, ELECTRON_PLIST), "CFBundleVersion", { bin: "plutil-exists-not-cbase" });
    assert.deepEqual(missing, { value: null, reason: "plutil-exists-not-cbase missing" });

    if (process.platform !== "darwin") {
      // The Linux runner has no plutil (the desktop targets run on macOS only). Then the version is UNKNOWN —
      // never "equal"; that is the promise that holds there. No skip: a skip counts as passed, and something is measured here.
      const r = electronInBundle(b.app);
      console.log(`  [plutil, ${process.platform}] ${r.version || `unknown (${r.reason})`}`);
      if (r.version === null) assert.match(r.reason, /unreadable/);
      else assert.equal(r.version, "44.4.4");
      return;
    }

    // The real thing: plutil reads CFBundleVersion from an XML plist in exactly the form of the framework.
    const real = electronInBundle(b.app);
    assert.deepEqual(real, { version: "44.4.4", reason: "" });
    // A broken plist: plutil fails, the version is unknown, the reason comes from plutil.
    fs.writeFileSync(path.join(b.app, ELECTRON_PLIST), "{ no plist");
    const broken = electronInBundle(b.app);
    console.log(`  [plutil, broken plist] ${broken.reason}`);
    assert.equal(broken.version, null);
    assert.match(broken.reason, /plutil/);

    // And the ELECTRON_PLIST path against REALITY: otherwise the tests above only check that the constant matches
    // itself. Taken is whatever Electron bundles lie on this Mac.
    const candidates = [
      path.join(REPO, "client/dist/mac-arm64/cbase Client.app"),
      path.join(REPO, "client/node_modules/electron/dist/Electron.app"),
    ].filter((p) => fs.existsSync(p));
    const read = candidates.map((p) => ({ p, v: electronInBundle(p) }));
    console.log(`  [real bundles] ${read.map((g) => `${path.basename(g.p)} ${g.v.version || g.v.reason}`).join(" · ") || "none"}`);
    assert.ok(read.length > 0, "no single Electron bundle on this Mac — the path is measured against nothing");
    for (const g of read) assert.match(g.v.version || "", /^\d+\.\d+\.\d+/, `${g.p}: ${g.v.reason}`);
  } finally {
    b.cleanUp();
  }
});
