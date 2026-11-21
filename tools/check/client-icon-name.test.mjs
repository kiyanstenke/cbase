// The desktop client's icon: macOS looks up CFBundleIconName (client/package.json, build.mac.extendInfo) in the compiled asset catalog
// client/build/Assets.car. When the two names differ, the built app shows no icon at all — no build step fails. Here both are held
// together: the catalog carries `<name>.iconstack` for exactly the name the Info.plist asks for.
//
// Counter-test: build the catalog under another name (tools/icon/build-icons.mjs with a different ICON_NAME), or set CFBundleIconName to
// anything else — the test is red. The second test proves the check on a planted catalog that names a different icon.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The icon names a compiled catalog carries (`<name>.iconstack` entries). Pure over the bytes. */
export function catalogIconNames(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  return [...new Set([...text.matchAll(/([A-Za-z0-9_-]+)\.iconstack/g)].map((m) => m[1]))];
}

test("client/build/Assets.car carries the icon that CFBundleIconName names", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "client/package.json"), "utf8"));
  const name = pkg.build?.mac?.extendInfo?.CFBundleIconName;
  assert.ok(name, "client/package.json has no build.mac.extendInfo.CFBundleIconName");
  const names = catalogIconNames(fs.readFileSync(path.join(REPO, "client/build/Assets.car")));
  assert.deepEqual(names, [name], `Assets.car names ${JSON.stringify(names)}, the Info.plist asks for "${name}" — rebuild with tools/icon/build-icons.mjs`);
});

test("counter-proof: a catalog that names a different icon is told apart", () => {
  const planted = Buffer.concat([Buffer.from("\0\0BOMStore\0"), Buffer.from("Other.iconstack\0Other/Group\0")]);
  assert.deepEqual(catalogIconNames(planted), ["Other"]);
  assert.notDeepEqual(catalogIconNames(planted), ["cbase"]);
});
