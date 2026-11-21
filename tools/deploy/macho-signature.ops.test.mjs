// Private half of the Mach-O signature guard: the client target EVALUATES the verdict before the bundle swap (reads targets/client.mjs).
//
// Run:  node --test --test-reporter=tap tools/deploy/macho-signature.ops.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the verdict is EVALUATED, not only printed — the client checks the built bundle before the swap", () => {
  // A row that stands in the log but enters no decision is decoration.
  const read = (rel) => fs.readFileSync(path.join(REPO, "tools/deploy/targets", rel), "utf8");
  for (const [name, src] of [["client.mjs", read("client.mjs")]]) {
    assert.match(src, /import \{ machoSignatureVerdict \} from "\.\.\/\.\.\/check\/lib\/macho-signature\.mjs";/, `${name}: does not import the guard`);
    assert.match(src, /const sig = await machoSignatureVerdict\(BUILT\);/, `${name}: does not check the BUILT bundle`);
    assert.match(src, /\["Mach-O in built bundle signed", sig\.text, sig\.ok \? "ok" : "bad"\]/, `${name}: does not print the row`);
    assert.match(src, /if \(!sig\.ok\) throw new Error\(/, `${name}: an invalidly signed bundle would be swapped`);
    // BEFORE the swap: the check stands before the first `ditto` into the target.
    const check = src.indexOf("if (!sig.ok) throw");
    const swap = src.indexOf('act("ditto"');
    assert.ok(check > 0 && swap > 0 && check < swap, `${name}: the signature check does not stand before the bundle swap`);
  }
});
