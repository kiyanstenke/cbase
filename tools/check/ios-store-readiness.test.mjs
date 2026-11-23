// Guard for App Store review of the iOS app: the privacy manifest and the Info.plist keys review asks for.
//
// Three promises, each silent when broken (the build stays green, the rejection comes days later from App Review):
//  1. `mobile/CbaseMobile/PrivacyInfo.xcprivacy` exists, is a well-formed plist, declares no tracking, and names a reason for
//     EVERY required-reason API category the Swift sources use. A new `UserDefaults` or `systemUptime` in a file that never
//     had one is enough to need a manifest line; the mapping table below says which spelling belongs to which category.
//  2. `Info.plist` says `ITSAppUsesNonExemptEncryption` false and carries non-empty `NSLocalNetworkUsageDescription` and
//     `NSPhotoLibraryAddUsageDescription`; without the latter, "Save Image" from a share sheet crashes the app.
//  3. If the sources use `ShareLink` or `UIActivityViewController` (both offer "Save to Photos"), the photo key must exist.
//  4. The manifest is a member of the app target: no `membershipExceptions` entry in project.pbxproj names it.
//  5. Every declared reason code is one Apple lists for its category (`ALLOWED_REASONS`); a typo is rejected at upload. Where
//     the sources fix WHICH reason applies (`PINNED_REASONS`, e.g. timestamps of files the user picked -> 3B52.1), it is there.
//  6. The app is iPhone-only: TARGETED_DEVICE_FAMILY = 1 in every build configuration of the app target and no
//     `UISupportedInterfaceOrientations~ipad` — an iPad build would be reviewed on an iPad, which the app is not laid out for.
//  7. `NSAllowsArbitraryLoads` is absent: next to `NSAllowsLocalNetworking` iOS ignores it, and review asks to justify it.
//
// The plist is parsed here in JavaScript (a minimal XML plist reader), not with `plutil`, so the guard runs on Linux too.
// The counter-proof is in the test itself: a manifest missing one reason, an Info.plist missing one key — both must be red.
//
// Run:  node --test tools/check/ios-store-readiness.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP = path.join(REPO, "mobile/CbaseMobile");
const MANIFEST = path.join(APP, "PrivacyInfo.xcprivacy");
const INFO = path.join(APP, "Info.plist");
const PBXPROJ = path.join(REPO, "mobile/CbaseMobile.xcodeproj/project.pbxproj");

// Required-reason API categories and the spellings in Swift that use them. A spelling here that the sources use makes the
// category mandatory in the manifest.
export const REQUIRED_REASON = [
  { category: "NSPrivacyAccessedAPICategoryUserDefaults", pattern: /\bUserDefaults\b|@AppStorage\b/ },
  { category: "NSPrivacyAccessedAPICategorySystemBootTime", pattern: /\bsystemUptime\b|\bCACurrentMediaTime\b|\bmach_absolute_time\b/ },
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    pattern:
      /\bcontentModificationDateKey\b|\bcreationDateKey\b|\bmodificationDate\b|\.creationDate\b|\battributesOfItem\b|\bfileModificationDate\b|\b(?:l|f)?stat\s*\(|\bgetattrlist\b/,
  },
  {
    category: "NSPrivacyAccessedAPICategoryDiskSpace",
    pattern: /\bvolumeAvailableCapacity\w*|\bvolumeTotalCapacityKey\b|\bsystemFreeSize\b|\bsystemSize\b|\bf?statfs\b|\bstatvfs\b/,
  },
  { category: "NSPrivacyAccessedAPICategoryActiveKeyboards", pattern: /\bactiveInputModes\b/ },
];

// The reason codes Apple lists per category (developer.apple.com, "Describing use of required reason API"). Anything else is
// rejected when the build is uploaded.
export const ALLOWED_REASONS = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1", "8FFB.1", "3D61.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ["3EC4.1", "54BD.1"],
};

// Where the sources decide which reason applies: when every pattern matches some source, the reason must be declared.
// Timestamps read from files the user picked in a document picker are 3B52.1 ("files or directories the user granted access to").
export const PINNED_REASONS = [
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    reason: "3B52.1",
    when: [/\bfileImporter\b|\bUIDocumentPickerViewController\b/, /\bcontentModificationDateKey\b|\bcreationDateKey\b/],
  },
];

const SHARE_PATTERN = /\bShareLink\b|\bUIActivityViewController\b/;

// ── A minimal XML plist reader (dict, array, string, true, false, integer, real, date, data) ──

export function parsePlist(xml) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!DOCTYPE[\s\S]*?>/, "");
  const tokens = [...text.matchAll(/<(\/?)([A-Za-z]+)(?:\s+[^>]*?)?(\s*\/)?>|([^<]+)/g)].filter((m) => m[4] === undefined || m[4].trim());
  let i = 0;
  const expectClose = (name) => {
    const t = tokens[i++];
    if (!t || t[1] !== "/" || t[2] !== name) throw new Error(`expected </${name}>`);
  };
  const value = () => {
    const t = tokens[i++];
    if (!t || t[4] !== undefined || t[1] === "/") throw new Error(`expected a value, got ${t ? t[0].trim() : "end"}`);
    const [, , name, selfClosing] = t;
    if (selfClosing) {
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "array") return [];
      if (name === "dict") return {};
      if (name === "string") return "";
      throw new Error(`unexpected <${name}/>`);
    }
    if (name === "dict") {
      const out = {};
      while (tokens[i] && !(tokens[i][1] === "/" && tokens[i][2] === "dict")) {
        const k = tokens[i++];
        if (!k || k[2] !== "key") throw new Error("expected <key> in <dict>");
        const raw = tokens[i] && tokens[i][4] !== undefined ? tokens[i++][4] : "";
        expectClose("key");
        out[raw.trim()] = value();
      }
      expectClose("dict");
      return out;
    }
    if (name === "array") {
      const out = [];
      while (tokens[i] && !(tokens[i][1] === "/" && tokens[i][2] === "array")) out.push(value());
      expectClose("array");
      return out;
    }
    if (["string", "integer", "real", "date", "data"].includes(name)) {
      const raw = tokens[i] && tokens[i][4] !== undefined ? tokens[i++][4] : "";
      expectClose(name);
      return name === "integer" || name === "real" ? Number(raw) : raw;
    }
    throw new Error(`unknown element <${name}>`);
  };
  const open = tokens[i++];
  if (!open || open[2] !== "plist") throw new Error("no <plist> root");
  const root = value();
  expectClose("plist");
  if (i !== tokens.length) throw new Error("content after </plist>");
  return root;
}

// Comments dropped: an explanatory comment naming `UserDefaults` is no use of it. A "..." literal is kept whole, so the `//`
// of "https://x" does not cut off the rest of its line (one-line literals only; escaped quotes inside are honoured).
export const stripComments = (code) =>
  code.replace(/("(?:[^"\\\n]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, literal) => literal ?? "");

function swiftSources(root) {
  const out = [];
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) go(p);
      else if (e.name.endsWith(".swift")) {
        out.push({ file: path.relative(root, p), code: stripComments(fs.readFileSync(p, "utf8")) });
      }
    }
  };
  go(root);
  return out;
}

/** The verdict over a manifest, an Info.plist and the sources: a list of findings, empty when ready. */
export function findings({ manifestXml, infoXml, sources, pbxproj }) {
  const out = [];
  let manifest;
  try {
    manifest = parsePlist(manifestXml);
  } catch (e) {
    return [`PrivacyInfo.xcprivacy does not parse: ${e.message}`];
  }
  if (manifest.NSPrivacyTracking !== false) out.push("PrivacyInfo.xcprivacy: NSPrivacyTracking must be false");
  if (!Array.isArray(manifest.NSPrivacyTrackingDomains)) out.push("PrivacyInfo.xcprivacy: NSPrivacyTrackingDomains missing");
  if (!Array.isArray(manifest.NSPrivacyCollectedDataTypes)) out.push("PrivacyInfo.xcprivacy: NSPrivacyCollectedDataTypes missing");
  const declared = new Map();
  for (const entry of Array.isArray(manifest.NSPrivacyAccessedAPITypes) ? manifest.NSPrivacyAccessedAPITypes : []) {
    const reasons = Array.isArray(entry?.NSPrivacyAccessedAPITypeReasons) ? entry.NSPrivacyAccessedAPITypeReasons : [];
    declared.set(entry?.NSPrivacyAccessedAPIType, reasons.filter((r) => typeof r === "string" && r.trim()));
  }
  for (const { category, pattern } of REQUIRED_REASON) {
    const users = sources.filter((s) => pattern.test(s.code)).map((s) => s.file);
    if (!users.length) continue;
    if (!declared.get(category)?.length) {
      out.push(`PrivacyInfo.xcprivacy: ${category} has no reason, but the sources use it (${users.slice(0, 3).join(", ")})`);
    }
  }

  let info;
  try {
    info = parsePlist(infoXml);
  } catch (e) {
    return [...out, `Info.plist does not parse: ${e.message}`];
  }
  if (info.ITSAppUsesNonExemptEncryption !== false) out.push("Info.plist: ITSAppUsesNonExemptEncryption must be false");
  for (const key of ["NSLocalNetworkUsageDescription", "NSPhotoLibraryAddUsageDescription"]) {
    if (typeof info[key] !== "string" || !info[key].trim()) out.push(`Info.plist: ${key} missing or empty`);
  }
  const sharing = sources.filter((s) => SHARE_PATTERN.test(s.code)).map((s) => s.file);
  if (sharing.length && !(typeof info.NSPhotoLibraryAddUsageDescription === "string" && info.NSPhotoLibraryAddUsageDescription.trim())) {
    out.push(`Info.plist: the sources share content (${sharing[0]}), so NSPhotoLibraryAddUsageDescription is required`);
  }

  if ("NSAllowsArbitraryLoads" in (info.NSAppTransportSecurity ?? {})) {
    out.push("Info.plist: NSAllowsArbitraryLoads must be absent (plain http is for local addresses only, NSAllowsLocalNetworking)");
  }
  if ("UISupportedInterfaceOrientations~ipad" in info) out.push("Info.plist: UISupportedInterfaceOrientations~ipad — the app is iPhone-only");

  out.push(...declaredReasonFindings(declared, sources));
  out.push(...deviceFamilyFindings(pbxproj));

  for (const block of pbxproj.match(/membershipExceptions = \(([\s\S]*?)\);/g) || []) {
    if (/PrivacyInfo\.xcprivacy/.test(block)) out.push("project.pbxproj: PrivacyInfo.xcprivacy is excluded from a target");
  }
  return out;
}

function declaredReasonFindings(declared, sources) {
  const out = [];
  for (const [category, reasons] of declared) {
    const allowed = ALLOWED_REASONS[category];
    if (!allowed) {
      out.push(`PrivacyInfo.xcprivacy: unknown category ${category}`);
      continue;
    }
    for (const r of reasons) if (!allowed.includes(r)) out.push(`PrivacyInfo.xcprivacy: ${category} reason ${r} is not one Apple lists`);
  }
  for (const { category, reason, when } of PINNED_REASONS) {
    if (!when.every((p) => sources.some((s) => p.test(s.code)))) continue;
    if (!declared.get(category)?.includes(reason)) out.push(`PrivacyInfo.xcprivacy: ${category} needs reason ${reason} (the sources determine it)`);
  }
  return out;
}

/** TARGETED_DEVICE_FAMILY must be exactly 1 in every build configuration of the app target "CbaseMobile". */
function deviceFamilyFindings(pbxproj) {
  const list = pbxproj.match(/buildConfigurationList = (\w+) \/\* Build configuration list for PBXNativeTarget "CbaseMobile" \*\//);
  if (!list) return ['project.pbxproj: no configuration list for the app target "CbaseMobile"'];
  const ids = pbxproj.match(new RegExp(`${list[1]} /\\*[^*]*\\*/ = \\{\\s*isa = XCConfigurationList;\\s*buildConfigurations = \\(([^)]*)\\)`));
  const configs = ids ? [...ids[1].matchAll(/(\w+) \/\*/g)].map((m) => m[1]) : [];
  if (!configs.length) return ["project.pbxproj: the app target has no build configurations"];
  const out = [];
  for (const id of configs) {
    const block = pbxproj.match(new RegExp(`\\t${id} /\\*[^*]*\\*/ = \\{\\s*isa = XCBuildConfiguration;[\\s\\S]*?\\n\\t\\t\\};`));
    const family = block?.[0].match(/TARGETED_DEVICE_FAMILY = "?([^";]*)"?;/)?.[1];
    if (family !== "1") out.push(`project.pbxproj: app configuration ${id} has TARGETED_DEVICE_FAMILY ${family ?? "unset"}, expected 1 (iPhone-only)`);
  }
  return out;
}

const real = () => ({
  manifestXml: fs.readFileSync(MANIFEST, "utf8"),
  infoXml: fs.readFileSync(INFO, "utf8"),
  sources: swiftSources(APP),
  pbxproj: fs.readFileSync(PBXPROJ, "utf8"),
});

test("the iOS app is ready for review: privacy manifest, Info.plist keys, target membership", () => {
  assert.ok(fs.existsSync(MANIFEST), "mobile/CbaseMobile/PrivacyInfo.xcprivacy is missing");
  const input = real();
  // The guard must actually read something: an empty glob after a move would make every category optional.
  assert.ok(input.sources.length > 50, `only ${input.sources.length} Swift files found under ${APP}`);
  assert.ok(
    REQUIRED_REASON.some(({ pattern }) => input.sources.some((s) => pattern.test(s.code))),
    "no required-reason API found in the sources at all — the mapping table reads nothing",
  );
  assert.deepEqual(findings(input), []);
});

test("counter-proof: a dropped reason, a dropped key, an exclusion are each red", () => {
  const input = real();
  // A category the sources use, with its whole entry removed from the manifest.
  const used = REQUIRED_REASON.find(({ pattern }) => input.sources.some((s) => pattern.test(s.code)));
  const entry = new RegExp(`<dict>\\s*<key>NSPrivacyAccessedAPIType</key>\\s*<string>${used.category}</string>[\\s\\S]*?</dict>`);
  assert.match(input.manifestXml, entry);
  const noReason = findings({ ...input, manifestXml: input.manifestXml.replace(entry, "") });
  assert.ok(noReason.some((f) => f.includes(used.category)), JSON.stringify(noReason));

  // An empty reason list is no reason.
  const emptyReasons = input.manifestXml.replace(
    new RegExp(`(<string>${used.category}</string>\\s*<key>NSPrivacyAccessedAPITypeReasons</key>\\s*)<array>[\\s\\S]*?</array>`),
    "$1<array/>",
  );
  assert.notEqual(emptyReasons, input.manifestXml);
  assert.ok(findings({ ...input, manifestXml: emptyReasons }).some((f) => f.includes(used.category)));

  // A category the sources do NOT use becomes mandatory as soon as a source uses it.
  const extra = { file: "Probe.swift", code: "let free = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])" };
  assert.ok(findings({ ...input, sources: [...input.sources, extra] }).some((f) => f.includes("DiskSpace")));
  // ...but not when it is only named in a comment (comments are dropped before the scan).
  const comment = { file: "Probe.swift", code: stripComments("/// volumeAvailableCapacity is not read here\nlet x = 1") };
  assert.deepEqual(findings({ ...input, sources: [...input.sources, comment] }), []);

  for (const key of ["ITSAppUsesNonExemptEncryption", "NSLocalNetworkUsageDescription", "NSPhotoLibraryAddUsageDescription"]) {
    const dropped = input.infoXml.replace(new RegExp(`\\s*<key>${key}</key>\\s*<(?:string>[^<]*</string|false/|true/)>`), "");
    assert.notEqual(dropped, input.infoXml, `${key} not found to drop`);
    const f = findings({ ...input, infoXml: dropped });
    assert.ok(f.some((x) => x.includes(key)), `${key} dropped but not red: ${JSON.stringify(f)}`);
  }
  // Encryption set to true is red as well.
  const yes = input.infoXml.replace(/(<key>ITSAppUsesNonExemptEncryption<\/key>\s*)<false\/>/, "$1<true/>");
  assert.ok(findings({ ...input, infoXml: yes }).some((x) => x.includes("ITSAppUsesNonExemptEncryption")));

  // Tracking switched on is red.
  const tracking = input.manifestXml.replace(/(<key>NSPrivacyTracking<\/key>\s*)<false\/>/, "$1<true/>");
  assert.ok(findings({ ...input, manifestXml: tracking }).some((x) => x.includes("NSPrivacyTracking")));

  // A broken manifest is red, not skipped.
  assert.ok(findings({ ...input, manifestXml: "<plist><dict><key>x</key></dict></plist>" })[0].includes("does not parse"));

  // Excluding the manifest from the target is red.
  const excluded = input.pbxproj.replace(/membershipExceptions = \(/, "membershipExceptions = (\n\t\t\t\tPrivacyInfo.xcprivacy,");
  assert.ok(findings({ ...input, pbxproj: excluded }).some((x) => x.includes("excluded")));
});

test("counter-proof: reason codes, iPhone-only, no arbitrary loads", () => {
  const input = real();
  // A reason code Apple does not list (here: a DiskSpace code under UserDefaults) is red.
  const wrong = input.manifestXml.replace("<string>CA92.1</string>", "<string>E174.1</string>");
  assert.notEqual(wrong, input.manifestXml);
  assert.ok(findings({ ...input, manifestXml: wrong }).some((x) => x.includes("E174.1")), "foreign reason code not red");
  const typo = input.manifestXml.replace("<string>35F9.1</string>", "<string>35F9.2</string>");
  assert.ok(findings({ ...input, manifestXml: typo }).some((x) => x.includes("35F9.2")));
  // The pinned reason: the app reads timestamps of user-picked files, so 3B52.1 must stay even if another valid code replaces it.
  assert.ok(input.sources.some((s) => /\bfileImporter\b/.test(s.code)), "the pin's premise (fileImporter) is gone from the sources");
  const swapped = input.manifestXml.replace("<string>3B52.1</string>", "<string>C617.1</string>");
  assert.notEqual(swapped, input.manifestXml);
  assert.ok(findings({ ...input, manifestXml: swapped }).some((x) => x.includes("needs reason 3B52.1")));

  // iPhone-only: an iPad family in either app configuration is red; the UI-test target's "1,2" is not the app's business.
  const appBlocks = [...input.pbxproj.matchAll(/TARGETED_DEVICE_FAMILY = 1;/g)];
  assert.equal(appBlocks.length, 2, "expected TARGETED_DEVICE_FAMILY = 1 in exactly the two app configurations");
  for (const n of [0, 1]) {
    let k = -1;
    const ipad = input.pbxproj.replace(/TARGETED_DEVICE_FAMILY = 1;/g, (m) => (++k === n ? 'TARGETED_DEVICE_FAMILY = "1,2";' : m));
    assert.ok(findings({ ...input, pbxproj: ipad }).some((x) => x.includes("iPhone-only")), `configuration ${n} on iPad not red`);
  }
  const unset = input.pbxproj.replace(/\s*TARGETED_DEVICE_FAMILY = 1;/, "");
  assert.ok(findings({ ...input, pbxproj: unset }).some((x) => x.includes("unset")));
  const ipadKey = input.infoXml.replace(
    "<key>UISupportedInterfaceOrientations</key>",
    "<key>UISupportedInterfaceOrientations~ipad</key><array/><key>UISupportedInterfaceOrientations</key>",
  );
  assert.ok(findings({ ...input, infoXml: ipadKey }).some((x) => x.includes("~ipad")));

  // NSAllowsArbitraryLoads back in the ATS dict is red.
  const arbitrary = input.infoXml.replace("<key>NSAllowsLocalNetworking</key>", "<key>NSAllowsArbitraryLoads</key><true/><key>NSAllowsLocalNetworking</key>");
  assert.notEqual(arbitrary, input.infoXml);
  assert.ok(findings({ ...input, infoXml: arbitrary }).some((x) => x.includes("NSAllowsArbitraryLoads")));
});

test("the mapping table catches the spellings it names, and a // inside a string is no comment", () => {
  const category = (code) => REQUIRED_REASON.filter(({ pattern }) => pattern.test(stripComments(code))).map((r) => r.category.replace("NSPrivacyAccessedAPICategory", ""));
  assert.deepEqual(category("let d = attrs[.creationDate] as? Date"), ["FileTimestamp"]);
  assert.deepEqual(category("var st = stat(); lstat(path, &st); fstat(fd, &st)"), ["FileTimestamp"]);
  assert.deepEqual(category("getattrlist(path, &list, &buf, size, 0)"), ["FileTimestamp"]);
  assert.deepEqual(category("let v = try url.resourceValues(forKeys: [.volumeTotalCapacityKey])"), ["DiskSpace"]);
  assert.deepEqual(category("fstatfs(fd, &fs)"), ["DiskSpace"]);
  // Word boundary: names that merely contain "stat" are no call of stat().
  assert.deepEqual(category("let s = status(); restat(x); updateStat(1)"), []);
  // The rest of a line after "https://" is code, not comment; a real comment after the literal still goes.
  assert.equal(stripComments('let u = "https://x"; UserDefaults.standard // UserDefaults'), 'let u = "https://x"; UserDefaults.standard ');
  assert.deepEqual(category('let u = URL(string: "https://x")!; let v = UserDefaults.standard'), ["UserDefaults"]);
  assert.equal(stripComments('let q = "a \\"//\\" b" // c'), 'let q = "a \\"//\\" b" ');
  assert.equal(stripComments("/* UserDefaults */ let x = 1 // systemUptime"), " let x = 1 ");
});

test("the plist reader reads what plutil writes", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>a</key><true/><key>b</key><array><string>x</string><integer>3</integer></array>
<!-- a comment --><key>c</key><dict/><key>d</key><string></string></dict></plist>`;
  assert.deepEqual(parsePlist(xml), { a: true, b: ["x", 3], c: {}, d: "" });
  assert.throws(() => parsePlist("<plist><dict><key>a</key><true/>"));
  // Where plutil exists (macOS), the reader must agree with it on both real files — otherwise the guard could judge a
  // file Xcode reads differently. Only a missing binary skips (Linux); plutil refusing a real file is a failure.
  for (const file of [MANIFEST, INFO]) {
    const r = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    if (r.error?.code === "ENOENT") continue;
    assert.ifError(r.error);
    assert.equal(r.status, 0, `plutil rejects ${path.basename(file)}: ${r.stderr}`);
    assert.deepEqual(parsePlist(fs.readFileSync(file, "utf8")), JSON.parse(r.stdout), path.basename(file));
  }
});
