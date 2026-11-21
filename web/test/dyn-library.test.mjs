// The library of dynamic workflows on the web: src/lib/dyn-library.ts, compiled with tsc (leaf module without
// imports) — the list path per scope.
//
// Run:  node --test web/test/dyn-library.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dyn-library-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  path.join(webDir, "node_modules", "typescript", "bin", "tsc"), path.join(webDir, "src", "lib", "dyn-library.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const bib = await import(pathToFileURL(path.join(out, "dyn-library.js")).href);

test("list paths", () => {
  assert.equal(bib.listPath("w1", null), "/api/workspaces/w1/dyn-workflows");
  assert.equal(bib.listPath("w1", "p1"), "/api/projects/p1/workspace-dyn-workflows");
});
