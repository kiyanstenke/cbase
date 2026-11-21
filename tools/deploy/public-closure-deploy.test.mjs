// tools/deploy stands on public ground: its static import closure reaches nothing private.
//
// Why: the deploy tool is public; only its private remainder stays in the private part (lib/private-part.mjs
// PRIVATE_DEPLOY_REL: the baseline target, the pin-sync guard, the verbatim guard, the merged gate plan, the tests that read private data). Every file of tools/deploy
// must load in a tree without the private part. A static import of it — direct, one step removed through a clean-looking leaf, or as a
// string-literal `import("…")` — would make the whole file unloadable there. The private part is reached ONLY through
// lib/private-part.mjs (`importPrivate`: an existence check, then a dynamic import of a computed URL), which this walk does not
// follow on purpose. The walk covers EVERY `.mjs` of the folder (libraries, targets, tests), not a list: a new file is held from its
// first day. Same shape as tools/check/public-closure.test.mjs, which holds tools/check alone.
//
// What is allowed outside the folder: tools/check (the gate's libraries, held by its own closure test) and the product trees
// (server/, web/, client/, mobile/). Relative `.mjs`/`.js` imports are walked through `from "…"`, `import "…"` and `import("…")`;
// `.mjs` files inside tools/deploy and tools/check are followed further.
//
// Second promise: every `importPrivate("<rel>")` names a file that exists in the private remainder where the tree carries it — a renamed
// private module would otherwise read as "no private part" and silently switch the private tree to the public behaviour.
//
// COUNTER-PROOF (built in): temporary files that import the private part directly, indirectly and dynamically, and one that imports another
// tool folder, are reported with the path that reaches them; a clean file is not; an `importPrivate` of a missing name is reported.
//
// Run:  node --test --test-reporter=tap tools/deploy/public-closure-deploy.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isPrivate, PRIVATE_ROOT } from "../check/cleanliness.mjs";
import { PRIVATE_DEPLOY_DIR } from "./lib/private-part.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PRODUCT_ROOTS = ["server", "web", "client", "mobile"];
const PRIVATE_DEPLOY = PRIVATE_DEPLOY_DIR;

const IMPORT = /(?:\bfrom|\bimport\s*\(|\bimport)\s*"(\.[^"]+)"/g;
const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
const walked = (rel) => under(rel, "tools/deploy") || under(rel, "tools/check");
const product = (rel) => PRODUCT_ROOTS.some((r) => rel.startsWith(`${r}/`));
// The private root counts even where it does not exist (a public clone has none — there, existence cannot be asked); the other private paths
// count by the private list where the tree carries it.
const private_ = (rel) => under(rel, PRIVATE_ROOT) || isPrivate(rel);

function closure(file) {
  const via = new Map([[path.resolve(file), null]]);
  const queue = [path.resolve(file)];
  while (queue.length) {
    const f = queue.shift();
    for (const m of fs.readFileSync(f, "utf8").matchAll(IMPORT)) {
      const p = path.resolve(path.dirname(f), m[1]);
      if (via.has(p)) continue;
      via.set(p, f);
      if (p.endsWith(".mjs") && walked(path.relative(REPO, p)) && fs.existsSync(p)) queue.push(p);
    }
  }
  return via;
}

// The imports of a file's closure that reach something private or another tool folder, each as "<path> (via a → b → c)".
function reached(file) {
  const via = closure(file);
  const out = [];
  for (const p of via.keys()) {
    const rel = path.relative(REPO, p);
    if (private_(rel)) { /* reported below */ } else if (walked(rel) || product(rel)) continue;
    else if (!fs.existsSync(p)) continue; // fixture text that only looks like an import
    const chain = [];
    for (let x = p; x; x = via.get(x)) chain.unshift(path.relative(REPO, x));
    out.push(`${rel} (via ${chain.join(" → ")})`);
  }
  return out;
}

// Every `importPrivate("<rel>")` of a text whose target is missing under `root`.
const PRIVATE_CALL = /\bimportPrivate\(\s*"([^"]+)"\s*\)/g;
const missingPrivate = (text, root) => [...text.matchAll(PRIVATE_CALL)].map((m) => m[1]).filter((rel) => !fs.existsSync(path.join(root, rel)));

const own = () => fs.readdirSync(HERE, { recursive: true }).filter((n) => n.endsWith(".mjs") && !n.includes(".public-closure-probe-")).sort();

test("every .mjs of tools/deploy reaches nothing private by a static import — only tools/check and product code outside the folder", () => {
  const files = own();
  assert.ok(files.length > 40, `only ${files.length} files found — is the walk right?`);
  const bad = files.flatMap((f) => reached(path.join(HERE, f)).map((r) => `${f} → ${r}`));
  assert.deepEqual(bad, [], "a file of tools/deploy reaches the private part or another tool folder statically — go through lib/private-part.mjs");
});

test("every importPrivate target exists in the private remainder where the tree carries it", (t) => {
  if (!fs.existsSync(PRIVATE_DEPLOY)) { t.diagnostic("no private remainder in this tree — the public tool runs without its private remainder"); return; }
  const code = own().filter((f) => !f.endsWith(".test.mjs")); // the tests name it in text and probes, never as a call of the tool
  const calls = code.flatMap((f) => [...fs.readFileSync(path.join(HERE, f), "utf8").matchAll(PRIVATE_CALL)].map((m) => `${f}: ${m[1]}`));
  t.diagnostic(`importPrivate: ${calls.join(" · ")}`);
  assert.ok(calls.length >= 4, `only ${calls.length} importPrivate calls found — is the anchor right?`);
  const bad = code.flatMap((f) => missingPrivate(fs.readFileSync(path.join(HERE, f), "utf8"), PRIVATE_DEPLOY).map((r) => `${f}: ${r}`));
  assert.deepEqual(bad, [], "an importPrivate names a private module that does not exist — the private tree would silently behave like the public one");
});

test("counter-proof: a file that imports the private part — directly, one step removed, dynamically — or another tool folder is reported; a clean file is not", () => {
  const probes = [];
  // The probe texts are built so that THIS file's own walk does not read them as imports (`${O}` stands where the folder name would).
  const O = PRIVATE_ROOT;
  const B = "icon";
  const make = (name, text) => {
    const p = path.join(HERE, `.public-closure-probe-${process.pid}-${name}.mjs`);
    fs.writeFileSync(p, text);
    probes.push(p);
    return p;
  };
  try {
    const leaf = make("leaf", `import { OPS_PLAN } from "../../${O}/deploy/lib/ops-gate.mjs";\nexport const x = OPS_PLAN;\n`);
    const direct = make("direct", `import "../../${O}/deploy/lib/pinSync.mjs";\n`);
    const indirect = make("indirect", `import { x } from "./${path.basename(leaf)}";\nexport const y = x;\n`);
    const dynamic = make("dynamic", `export const z = () => import("../../${O}/deploy/targets/baseline.mjs");\n`);
    const tool = make("tool", `import "../${B}/build-icons.mjs";\n`);
    const clean = make("clean", 'import { REPO } from "./config.mjs";\nimport { log } from "../check/lib/log.mjs";\nimport "../../server/gateway/containers.js";\nexport const r = [REPO, log];\n');
    assert.match(reached(direct).join("\n"), new RegExp(`^${O}/deploy/lib/pinSync\\.mjs \\(via `), "a direct import of the private part went unnoticed");
    assert.match(reached(indirect).join("\n"), new RegExp(`${O}/deploy/lib/ops-gate\\.mjs \\(via .*leaf\\.mjs → ${O}/deploy/lib/ops-gate\\.mjs\\)`), "an indirect import of the private part went unnoticed");
    assert.match(reached(dynamic).join("\n"), new RegExp(`${O}/deploy/targets/baseline\\.mjs`), "a dynamic import of the private part went unnoticed");
    assert.match(reached(tool).join("\n"), /tools\/icon\/build-icons\.mjs/, "an import of another tool folder went unnoticed");
    assert.deepEqual(reached(clean), [], "a clean file is reported");
  } finally {
    for (const p of probes) fs.rmSync(p, { force: true });
  }
  // The second promise against a staged private root: a present name passes, a renamed one is reported.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-private-part-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "here.mjs"), "");
    const text = 'await importPrivate("lib/here.mjs");\nawait importPrivate("lib/renamed.mjs");\n';
    assert.deepEqual(missingPrivate(text, root), ["lib/renamed.mjs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
