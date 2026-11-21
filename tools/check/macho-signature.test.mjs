// Every Mach-O of a built bundle is validly signed on its own — and the signing levers (`signIgnore`, `timestamp none`) are
// set. Only in the client.
//
// Why dedicated tests: with `build.mac.signIgnore` electron-builder signs only what an EXTENSION LIST does not hit — 736 -> 38
// codesign calls, build 281 -> 7 s with the timestamp lever. A future Mach-O with a data extension would stay unsigned, and the
// builder's `codesign --verify --deep --strict` is blind to it (the real-bundle test shows it). Checked here:
//   · detection by magic bytes (not by extension, symlinks not twice, Java class not),
//   · "empty is not unknown": no bundle, no Mach-O, no codesign => never valid,
//   · on macOS the real situation: seal valid, a hidden Mach-O invalid => red,
//   · that client/package.json carries the list and `timestamp: "none"` and the list hits no known Mach-O.
//
// The binding "the client evaluates the verdict" lives in macho-signature.ops.test.mjs.
//
// Run:  node --test --test-reporter=tap tools/check/macho-signature.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MACHO_MAGIC, isMachO, machoFiles, machoSignatureVerdict, signatureCheck, signatureVerdict } from "./lib/macho-signature.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAC = process.platform === "darwin";

const bytes = (...xs) => Buffer.from(xs);
// The head of a real thin arm64 Mach-O (little-endian on disk) plus padding.
const THIN_ARM64 = Buffer.concat([bytes(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01), Buffer.alloc(56)]);
// Universal binary with three architectures — the shape of /usr/bin/true.
const FAT_3 = Buffer.concat([bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x03), Buffer.alloc(56)]);
// A Java class file (major 65 = Java 21): the same four bytes as FAT_MAGIC, but no Mach-O.
const JAVA_CLASS = Buffer.concat([bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41), Buffer.alloc(56)]);

function disposable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-macho-"));
  return { dir, cleanUp: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function write(root, rel, content) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

test("magic bytes: thin and universal yes, Java class, text and stub no", () => {
  assert.equal(isMachO(THIN_ARM64), true, "arm64 (cf fa ed fe)");
  assert.equal(isMachO(FAT_3), true, "universal (ca fe ba be, 3 architectures)");
  assert.equal(isMachO(bytes(0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0)), true, "MH_MAGIC_64 big-endian");
  assert.equal(isMachO(bytes(0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 2)), true, "FAT_MAGIC_64");
  assert.equal(isMachO(bytes(0xbe, 0xba, 0xfe, 0xca, 2, 0, 0, 0)), true, "FAT_CIGAM, count little-endian");
  assert.equal(isMachO(JAVA_CLASS), false, "a Java class file is no Mach-O (major 65 >= 20)");
  assert.equal(isMachO(bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0)), false, "universal with 0 architectures");
  assert.equal(isMachO(Buffer.from("no mach-o, just text")), false);
  assert.equal(isMachO(bytes(0xcf, 0xfa, 0xed)), false, "three bytes are no head");
  assert.equal(isMachO(null), false);
  assert.equal(MACHO_MAGIC.size, 8);
});

test("detection in the tree: by bytes, not by extension — symlinks neither counted nor entered", () => {
  const w = disposable();
  try {
    const app = path.join(w.dir, "Probe.app");
    write(app, "Contents/MacOS/Probe", THIN_ARM64);
    // Exactly the case the guard stands against: a Mach-O with a data extension (the extension list leaves it out).
    write(app, "Contents/Resources/hidden.bin", FAT_3);
    // The opposite direction: an extension that looks like code, without code in it.
    write(app, "Contents/Resources/data.dylib", "no mach-o");
    write(app, "Contents/Resources/class.class", JAVA_CLASS);
    write(app, "Contents/Resources/empty.node", "");
    // Framework shape as in Electron: real file under Versions/A, Current and the top name are symlinks. osx-sign 1.3.3 ran
    // through exactly here three times (fs.stat) — we count once.
    const fw = path.join(app, "Contents/Frameworks/Probe.framework");
    write(fw, "Versions/A/Probe", THIN_ARM64);
    fs.symlinkSync("A", path.join(fw, "Versions/Current"));
    fs.symlinkSync("Versions/Current/Probe", path.join(fw, "Probe"));

    const found = machoFiles(app);
    console.log(`  [found] ${found.join(" · ")}`);
    assert.deepEqual(found, [
      "Contents/Frameworks/Probe.framework/Versions/A/Probe",
      "Contents/MacOS/Probe",
      "Contents/Resources/hidden.bin",
    ]);
  } finally {
    w.cleanUp();
  }
});

test("empty is not unknown: no bundle, no Mach-O, no codesign — never valid", async () => {
  const w = disposable();
  try {
    const missing = signatureVerdict(await signatureCheck(path.join(w.dir, "exists-not.app")));
    console.log(`  [bundle missing] ${missing.text}`);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /unknown \(bundle missing\)/);

    // A bundle without a single Mach-O: "0 of 0 invalid" would be the green row without a measurement.
    const empty = path.join(w.dir, "Empty.app");
    write(empty, "Contents/Resources/only-data.pak", "x");
    const l = signatureVerdict(await signatureCheck(empty, { bin: "codesign-exists-not-cbase" }));
    console.log(`  [no Mach-O] ${l.text}`);
    assert.equal(l.ok, false);
    assert.match(l.text, /no Mach-O/);

    // The tool is missing (what every Linux runner looks like): unknown, with a reason — never valid.
    const app = path.join(w.dir, "Probe.app");
    write(app, "Contents/MacOS/Probe", THIN_ARM64);
    const r = await signatureCheck(app, { bin: "codesign-exists-not-cbase" });
    const u = signatureVerdict(r);
    console.log(`  [codesign missing] ${u.text}`);
    assert.equal(r.found, 1);
    assert.equal(r.checked, 0, "without the tool nothing may count as checked");
    assert.equal(r.bundle.valid, null);
    assert.equal(u.ok, false);
    assert.match(u.text, /unknown/);
    assert.match(u.text, /codesign-exists-not-cbase missing/);
  } finally {
    w.cleanUp();
  }
});

test("real situation: seal --deep --strict valid, a hidden Mach-O unsigned — the guard is red", async () => {
  const w = disposable();
  try {
    const app = path.join(w.dir, "Probe.app");
    write(app, "Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>dev.cbase.macho-probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`);
    write(app, "Contents/Resources/data.pak", "pure data");

    if (!MAC) {
      // On the Linux runner there is neither codesign nor a real Mach-O to copy. Then the verdict is UNKNOWN — never "valid";
      // that is the promise that holds there. No skip: a skip counts as passed, and here something is measured.
      write(app, "Contents/MacOS/probe", THIN_ARM64);
      const u = await machoSignatureVerdict(app);
      console.log(`  [${process.platform}] ${u.text}`);
      assert.equal(u.ok, false);
      assert.match(u.text, /unknown/);
      return;
    }

    // A real Mach-O: /usr/bin/true (universal binary). The main program is signed ad hoc (no identity needed), the hidden copy
    // carries the extension .bin and NO signature — exactly what the extension list would do with a future Mach-O of this extension.
    fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
    fs.copyFileSync("/usr/bin/true", path.join(app, "Contents/MacOS/probe"));
    fs.copyFileSync("/usr/bin/true", path.join(app, "Contents/Resources/hidden.bin"));
    const cs = (...a) => {
      const r = spawnSync("codesign", a, { encoding: "utf8" });
      assert.equal(r.status, 0, `codesign ${a.join(" ")}: ${r.stderr}`);
    };
    cs("--remove-signature", path.join(app, "Contents/Resources/hidden.bin"));
    cs("--sign", "-", "--force", path.join(app, "Contents/MacOS/probe"));
    cs("--sign", "-", "--force", app);

    // The blindness the guard stands against: the whole bundle is VALID for --deep --strict.
    const deep = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    assert.equal(deep.status, 0, `--deep --strict should be green here (else the test does not measure the gap): ${deep.stderr}`);

    const red = await signatureCheck(app);
    const u = signatureVerdict(red);
    console.log(`  [hidden.bin unsigned] ${u.text}`);
    assert.equal(red.bundle.valid, true);
    assert.equal(red.found, 2);
    assert.equal(red.checked, 2);
    assert.deepEqual(red.invalid.map((x) => x.file), ["Contents/Resources/hidden.bin"]);
    assert.match(red.invalid[0].reason, /not signed/);
    assert.equal(u.ok, false, "an unsigned Mach-O under Resources slipped through");
    assert.match(u.text, /INVALID: 1 of 2 — Contents\/Resources\/hidden\.bin/);

    // The same file signed, bundle sealed anew: green.
    cs("--sign", "-", "--force", path.join(app, "Contents/Resources/hidden.bin"));
    cs("--sign", "-", "--force", app);
    const green = signatureVerdict(await signatureCheck(app));
    console.log(`  [signed] ${green.text}`);
    assert.equal(green.ok, true, green.text);
    assert.match(green.text, /2 of 2 individually valid/);

    // And the seal itself: a data file changed AFTER signing (covered only by the seal) is red. Measured: `codesign -v` on the MAIN
    // PROGRAM of a bundle checks the seal too ("a sealed resource is missing or invalid") — the other Mach-O stay valid.
    fs.writeFileSync(path.join(app, "Contents/Resources/data.pak"), "changed afterwards");
    const seal = await signatureCheck(app);
    const s = signatureVerdict(seal);
    console.log(`  [data changed after signing] ${s.text}`);
    assert.deepEqual(seal.invalid.map((x) => x.file), ["Contents/MacOS/probe"]);
    assert.match(seal.invalid[0].reason, /sealed resource/);
    assert.equal(seal.bundle.valid, false);
    assert.equal(s.ok, false);
    assert.match(s.text, /bundle seal INVALID/);
  } finally {
    w.cleanUp();
  }
});

test("real bundles on this Mac: every Mach-O valid on its own — the measurement row", async () => {
  // Measures what lies in built bundles. If none lies there (fresh clone, Linux runner), that is PRINTED, not thrown. And ONLY
  // the measurement row, no assert: dist/ is a build artifact, not code, and is not in the gate marker's hash. A half-built
  // bundle or one rejected by the swap check in dist/ would otherwise turn the gate red — and a full deploy runs the gate BEFORE
  // the build, so it would block exactly the run that rebuilds it. Only the check before the swap (targets/client.mjs), which
  // always sees the fresh bundle, may block.
  const candidates = [
    path.join(REPO, "client/dist/mac-arm64/cbase Client.app"),
  ].filter((p) => fs.existsSync(p));
  if (!MAC || !candidates.length) {
    console.log(`  [real bundles] none measured (${MAC ? "no built bundle in the tree" : process.platform})`);
    return;
  }
  for (const app of candidates) {
    const u = await machoSignatureVerdict(app);
    console.log(`  [${path.basename(app)}] ${u.text}`);
  }
});

// ── the levers ─────────────────────────────────────────────────────────────────────

const mac = (target) => JSON.parse(fs.readFileSync(path.join(REPO, target, "package.json"), "utf8")).build.mac;

test("signing levers: client/package.json carries the signIgnore list and timestamp none", () => {
  const c = mac("client");
  console.log(`  [signIgnore] ${JSON.stringify(c.signIgnore)} · timestamp ${c.timestamp}`);
  assert.ok(Array.isArray(c.signIgnore) && c.signIgnore.length, "client: signIgnore missing — every build signs every file individually again");
  assert.equal(c.timestamp, "none", "client: without timestamp none every codesign call asks Apple's timestamp server");
});

test("signIgnore hits symlink paths and data — and NO Mach-O (the way electron-builder checks)", () => {
  // electron-builder (app-builder-lib MacTargetHelper.buildSignOptions) makes `new RegExp(it)` of each entry and tests it against
  // the ABSOLUTE path osx-sign sees while walking — so also the ways via `Versions/Current` and the top framework links.
  const pattern = mac("client").signIgnore.map((m) => new RegExp(m));
  const ignored = (p) => pattern.some((re) => re.test(p));
  const APP = "/Users/x/cbase/client/dist/mac-arm64/cbase Client.app/";
  const FW = `${APP}Contents/Frameworks/Electron Framework.framework/`;

  // The Mach-O of a bundle under Electron 44 (the client carries a subset; the native modules under app.asar.unpacked stand as an
  // example for every future one).
  const macho = [
    `${FW}Versions/A/Electron Framework`,
    `${FW}Versions/A/Helpers/chrome_crashpad_handler`,
    `${FW}Versions/A/Libraries/libffmpeg.dylib`,
    `${FW}Versions/A/Libraries/libvk_swiftshader.dylib`,
    `${APP}Contents/Frameworks/cbase Client Helper (Renderer).app/Contents/MacOS/cbase Client Helper (Renderer)`,
    `${APP}Contents/Frameworks/Mantle.framework/Versions/A/Mantle`,
    `${APP}Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`,
    `${APP}Contents/MacOS/cbase Client`,
    `${APP}Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node`,
    `${APP}Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`,
    `${APP}Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib`,
    `${APP}Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node`,
    // osx-sign signs the bundles themselves too.
    `${APP}Contents/Frameworks/Squirrel.framework`,
    `${APP}Contents/Frameworks/cbase Client Helper.app`,
  ];
  for (const p of macho) assert.equal(ignored(p), false, `signIgnore hits a Mach-O — it would stay unsigned: ${p}`);

  const omit = [
    `${FW}Versions/Current/Electron Framework`,
    `${FW}Electron Framework`,
    `${FW}Libraries/libffmpeg.dylib`,
    `${APP}Contents/Frameworks/Squirrel.framework/Resources/ShipIt`,
    `${FW}Versions/A/Resources/de.lproj/locale.pak`,
    `${FW}Versions/A/Resources/icudtl.dat`,
    `${FW}Versions/A/Resources/v8_context_snapshot.arm64.bin`,
    `${APP}Contents/Resources/app.asar`,
    `${APP}Contents/Resources/icon.icns`,
    `${APP}Contents/Resources/Assets.car`,
  ];
  for (const p of omit) assert.equal(ignored(p), true, `signIgnore omits what the measurement omitted — not here: ${p}`);

  // And against REALITY where a built bundle lies: no found Mach-O may match the list. Else the test would only check the
  // examples above against themselves.
  for (const app of [path.join(REPO, "client/dist/mac-arm64/cbase Client.app")]) {
    if (!fs.existsSync(app)) continue;
    const hit = machoFiles(app).filter((rel) => ignored(path.join(app, rel)));
    console.log(`  [${path.basename(app)}] ${machoFiles(app).length} Mach-O, hit by signIgnore: ${hit.length}`);
    assert.deepEqual(hit, [], `${app}: signIgnore hits real Mach-O`);
  }
});
