// File symbols as in VS Code (Seti): the ONE table lib/file-symbols.ts, EXECUTED: whole name before extension (package.json is npm,
// not JSON), longest extension first (x.test.ts orange, x.d.ts blue), name beginnings (.env.local, Dockerfile.dev), the last path
// segment counts, case-insensitive, otherwise the default symbol. Each sabotage is a copy of the source with ONE changed spot;
// the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/file-symbols.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "file-symbols.ts"), "utf8");

const SABOTAGES = {
  "shortest extension first": { old: ".sort((a, b) => b.length - a.length)", fresh: ".sort((a, b) => a.length - b.length)", catches: "suffix" },
  "name after the extension": { old: "if (NAMES[small]) return NAMES[small];\n", fresh: "", catches: "name" },
  "whole path instead of last segment": { old: `const name = String(pathOrName ?? "").split("/").pop() ?? "";`, fresh: `const name = String(pathOrName ?? "");`, catches: "name" },
  "case matters": { old: "const small = name.toLowerCase();", fresh: "const small = name;", catches: "name" },
  "no beginnings": { old: "for (const [a, kind] of BEGINNINGS) if (small.startsWith(a)) return kind;", fresh: "", catches: "beginning" },
  "name equals extension": { old: "small.length > e.length + 1", fresh: "true", catches: "beginning" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-file-symbols-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "file-symbols.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `file-symbols-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const CHECKS = {
  suffix: (m) => {
    assert.equal(m.fileSymbolKind("a.test.ts").color, m.SETI.orange, "x.test.ts is a test (orange)");
    assert.equal(m.fileSymbolKind("ChatBox.tsx").form, "react");
    assert.equal(m.fileSymbolKind("ChatBox.test.tsx").color, m.SETI.orange);
    assert.deepEqual(m.fileSymbolKind("index.ts"), { form: "text", color: m.SETI.blue, text: "TS" });
  },
  name: (m) => {
    assert.equal(m.fileSymbolKind("package.json").form, "npm", "package.json before .json");
    assert.equal(m.fileSymbolKind("frontend/package.json").form, "npm", "the last path segment counts");
    assert.equal(m.fileSymbolKind("README.md").form, "info");
    assert.equal(m.fileSymbolKind("docs/api.json").form, "brackets");
    assert.equal(m.fileSymbolKind("Image.PNG").form, "image", "case-insensitive");
  },
  beginning: (m) => {
    assert.equal(m.fileSymbolKind(".env").form, "gear");
    assert.equal(m.fileSymbolKind(".env.local").form, "gear");
    assert.equal(m.fileSymbolKind("Dockerfile.dev").form, "docker");
    assert.equal(m.fileSymbolKind(".ts").form, "file", "a file named just \".ts\" has no extension");
    assert.deepEqual(m.fileSymbolKind("NOTES"), m.STANDARD_SYMBOL);
  },
};

test("file symbols: the table keeps its promise", async () => {
  const m = await load("file-symbols.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("file symbols: each sabotage fails its check", async () => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
});
