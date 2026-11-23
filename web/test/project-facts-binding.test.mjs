// cbase's own licence and the address of its source stand in TWO places, because the two clients have no common build: in
// `PROJECT` (web/src/lib/thirdParty.ts), which feeds the web settings page and THIRD_PARTY_NOTICES.txt, and as constants of
// `SettingsView` (mobile/CbaseMobile/Settings/SettingsView.swift), which feed the About section of the iOS app.
//
// Why a guard: the AGPL (section 13) asks that whoever uses cbase over a network can reach its source. If one side moves — a
// fork renames the repository, the licence changes — and the other stays, the app keeps sending its users to an address that
// is no longer the source of the program they run, and nothing says so. A doubled truth needs a path that turns red.
//
// What it does NOT do: the web side may be overridden at build time (`NEXT_PUBLIC_SOURCE_URL`), the iOS side cannot. Only the
// DEFAULT of the web side is compared, which is what the repository ships.
//
// Each test anchors before it compares: a renamed constant or a rewritten `PROJECT` makes the guard red instead of letting it
// pass on an empty match.
//
// Run:  node --test --test-reporter=tap web/test/project-facts-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

const WEB = "web/src/lib/thirdParty.ts";
const IOS = "mobile/CbaseMobile/Settings/SettingsView.swift";

/** The `PROJECT` literal of the web side. Throws when its shape is gone, instead of returning nothing. */
function webProject() {
  const text = read(WEB);
  const block = text.match(/export const PROJECT[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, `${WEB}: the \`export const PROJECT = { … };\` literal was not found — rename it here too`);
  const field = (name, re) => {
    const m = block[1].match(re);
    assert.ok(m, `${WEB}: the field \`${name}\` of PROJECT was not found in the expected shape`);
    return m[1];
  };
  return {
    license: field("license", /\blicense:\s*"([^"]+)"/),
    licenseUrl: field("licenseUrl", /\blicenseUrl:\s*"([^"]+)"/),
    // The default behind the build-time override; `source: "…"` without an override is accepted as well.
    source: field("source", /\bsource:\s*(?:process\.env\.\w+\s*\|\|\s*)?"([^"]+)"/),
  };
}

/** The three written-out constants of the iOS About section. Throws when one is gone. */
function iosFacts() {
  const text = read(IOS);
  const one = (name) => {
    const m = text.match(new RegExp(String.raw`static let ${name}\s*=\s*"([^"]+)"`));
    assert.ok(m, `${IOS}: \`static let ${name}\` was not found — the About section lost or renamed it`);
    return m[1];
  };
  return { licenseName: one("licenseName"), licenseURL: one("licenseURL"), sourceURL: one("sourceURL") };
}

test("(1) the iOS About section names the same licence as the web side", () => {
  const web = webProject();
  const ios = iosFacts();
  assert.equal(ios.licenseName, web.license, `${IOS} and ${WEB} name different licences`);
  assert.equal(ios.licenseURL, web.licenseUrl, `${IOS} and ${WEB} point at different licence texts`);
});

test("(2) the iOS About section points at the same source as the web side", () => {
  const web = webProject();
  const ios = iosFacts();
  assert.equal(ios.sourceURL, web.source, `${IOS} and the default of ${WEB} point at different repositories`);
  assert.match(web.source, /^https:\/\/[^/]+\/[^/]+\/[^/]+$/, `${WEB}: the source is not of the form https://<host>/<owner>/<name>`);
  // The row's label is the shortened address and must stay DERIVED from it: written out a second time it could drift, and the
  // bare "owner/name" outside a repository URL is what the cleanliness guard counts as private.
  const ios_ = read(IOS);
  assert.match(ios_, /static var sourceLabel: String \{ sourceURL\.split\(separator: "\/"\)\.suffix\(2\)\.joined\(separator: "\/"\) \}/,
    `${IOS}: \`sourceLabel\` is no longer derived from \`sourceURL\``);
  const owner = web.source.split("/").slice(-2).join("/");
  assert.equal(ios_.split(`"${owner}"`).length - 1, 0, `${IOS}: "${owner}" is written out as a literal although the label is derived`);
});

test("(3) both sides are actually shown, not merely declared", () => {
  const ios = read(IOS);
  // Without these the constants would be dead and the guard would watch nothing.
  for (const name of ["licenseName", "licenseURL", "sourceLabel", "sourceURL"]) {
    const uses = ios.split(`Self.${name}`).length - 1;
    assert.ok(uses >= 1, `${IOS}: \`${name}\` is declared but never used in the About section`);
  }
  const web = read(WEB);
  assert.match(web, /PROJECT\b/, `${WEB}: PROJECT is not referenced`);
});
