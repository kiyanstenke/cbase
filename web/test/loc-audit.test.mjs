// The iOS app's translation audit in the gate. `mobile/tools/loc-audit.sh` checks that every `L("…")` key in the Swift
// sources has an English line in `Kit/LocDEBase.swift` or `Kit/LocDEMobile.swift` and that no dictionary carries a key
// twice. Both failures are silent: a missing key shows English text, a duplicate crashes the app at LAUNCH
// ("Dictionary literal contains duplicate keys"), and the compiler says nothing about either.
//
// Why a WEB test file: the gate runs `web/test/*.test.mjs` on every machine, including the Linux runner. The audit
// reads the Swift sources as text (python3 + bash, no simulator, no `xcrun`) and so does NOT belong under `onlyMacOS`.
//
// The counter-test is in the test itself (design `seams-fields`): a copy of the Swift sources missing a used key, and
// one with a duplicate key — both must be red, with the key in the message. An audit that is green against the real tree
// proves nothing alone: it is also green when it reads nothing (a glob that hits nothing after a move).
//
// Run:  node --test web/test/loc-audit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const mobile = path.join(repo, "mobile");
const script = path.join(mobile, "tools", "loc-audit.sh");

const run = (root, ...args) => {
  const r = spawnSync("bash", [path.join(root, "tools", "loc-audit.sh"), ...args], { encoding: "utf8" });
  return { code: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
};

// A copy of only the Swift sources plus the script — same folder shape (`tools/` next to `CbaseMobile/`) that the
// script jumps into via `cd "$(dirname "$0")/.."`.
function copy() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-loc-audit-"));
  fs.mkdirSync(path.join(target, "tools"));
  fs.copyFileSync(script, path.join(target, "tools", "loc-audit.sh"));
  const source = path.join(mobile, "CbaseMobile");
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) go(f);
      else if (e.name.endsWith(".swift")) {
        const z = path.join(target, "CbaseMobile", path.relative(source, f));
        fs.mkdirSync(path.dirname(z), { recursive: true });
        fs.copyFileSync(f, z);
      }
    }
  };
  go(source);
  return target;
}
const findFile = (root, name) => {
  const search = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { const t = search(f); if (t) return t; }
      else if (e.name === name) return f;
    }
    return null;
  };
  return search(path.join(root, "CbaseMobile"));
};
const cleanUp = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
};

test("loc-audit: every L(…) key of the iOS app has a German line, no dictionary carries one twice", () => {
  const r = run(mobile, "--all");
  const count = r.text.match(/(\d+) keys in the code, (\d+) in the dictionary/);
  console.log(`  [loc-audit] ${count ? `${count[1]} keys in the code, ${count[2]} in the dictionary` : "without count"} · exit ${r.code}`);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /All used keys are translated\./);
  assert.ok(count && Number(count[1]) > 500, `the audit really reads the sources (count: ${count?.[1] ?? "no"}) — an empty glob would report green`);
});

test("loc-audit, counter-test: a used key missing from the dictionary turns the audit red and names it", () => {
  const w = copy();
  try {
    const base = findFile(w, "LocDEBase.swift");
    assert.ok(base, "LocDEBase.swift in the copy");
    const text = fs.readFileSync(base, "utf8");
    // A key the code uses: the first dictionary entry that also occurs as L("…").
    const used = new Set();
    const go = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) go(f);
        else if (!e.name.startsWith("LocDE")) for (const m of fs.readFileSync(f, "utf8").matchAll(/\bL\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1]);
      }
    };
    go(path.join(w, "CbaseMobile"));
    const row = text.split("\n").find((z) => { const m = z.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"/); return m && used.has(m[1]); });
    assert.ok(row, "a used key is in LocDEBase");
    const key = row.match(/^\s*"((?:[^"\\]|\\.)*)"/)[1];
    // If it is ALSO in LocDEMobile, the second table covers it — then strike it from both.
    fs.writeFileSync(base, text.split("\n").filter((z) => z !== row).join("\n"));
    const mob = findFile(w, "LocDEMobile.swift");
    if (mob) fs.writeFileSync(mob, fs.readFileSync(mob, "utf8").split("\n").filter((z) => !z.match(new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`))).join("\n"));
    const r = run(w);
    assert.equal(r.code, 1, `the audit stays green without "${key}":\n${r.text}`);
    assert.ok(r.text.includes(key), "the message names the missing key");
  } finally { cleanUp(w); }
});

test("loc-audit, counter-test: a duplicate key in a dictionary is red (\"crash at launch\")", () => {
  const w = copy();
  try {
    const base = findFile(w, "LocDEBase.swift");
    const rows = fs.readFileSync(base, "utf8").split("\n");
    const i = rows.findIndex((z) => /^\s*"(?:[^"\\]|\\.)*"\s*:\s*"/.test(z));
    assert.ok(i >= 0, "an entry in LocDEBase");
    rows.splice(i + 1, 0, rows[i]);
    fs.writeFileSync(base, rows.join("\n"));
    const r = run(w);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /DUPLICATE keys/);
  } finally { cleanUp(w); }
});
