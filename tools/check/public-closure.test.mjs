// tools/check stands on public ground: its import closure reaches nothing outside tools/check except product code.
//
// Why: the maintainer's repository has a private part (cleanliness.mjs PRIVATE_ROOT); the public repo keeps the gate, the deploy
// tool (tools/deploy, held by its own closure test tools/deploy/public-closure-deploy.test.mjs) and the product guards, and
// nothing in tools/check may need the private part to load. A file here that (transitively) imports the private part, another tool folder or any path
// outside the folder and the product trees could not be loaded in the public repo — a private import at the head of a mixed file
// makes the whole file unloadable. The walk covers EVERY `.mjs` of the folder (libraries, targets, tests), not a list: a new file is
// held from its first day.
//
// What is allowed outside the folder: the product trees (server/, web/, client/, mobile/) — the guards test the product, so they read
// and import it. Relative `.mjs`/`.js` imports are walked through `from "…"`, `import "…"` and `import("…")`; only `.mjs` files inside
// tools/check are followed further.
//
// COUNTER-PROOF (built in): a temporary file that imports a module of the private part — directly, one step removed through a clean-looking leaf,
// and dynamically — and one that imports another tool folder are reported with the path that reaches them; a clean file is not.
//
// Run:  node --test --test-reporter=tap tools/check/public-closure.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRIVATE_ROOT } from "./cleanliness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const PRODUCT_ROOTS = ["server", "web", "client", "mobile"];

const IMPORT = /(?:\bfrom|\bimport\s*\(|\bimport)\s*"(\.[^"]+)"/g;
const inside = (rel) => rel === "tools/check" || rel.startsWith("tools/check/");
const product = (rel) => PRODUCT_ROOTS.some((r) => rel.startsWith(`${r}/`));
// Strings that only LOOK like imports (a test's fixture text) lead nowhere: an outside path counts when the file exists, or when it
// stands under the private root (which a public clone does not have at all — there, existence cannot be asked).
const private_ = (rel) => rel === PRIVATE_ROOT || rel.startsWith(`${PRIVATE_ROOT}/`);

// Every relative import of `file` with the repo-relative path it resolves to, walked through the folder's own `.mjs` files.
export function closure(file) {
  const via = new Map([[path.resolve(file), null]]);
  const queue = [path.resolve(file)];
  while (queue.length) {
    const f = queue.shift();
    for (const m of fs.readFileSync(f, "utf8").matchAll(IMPORT)) {
      const p = path.resolve(path.dirname(f), m[1]);
      if (via.has(p)) continue;
      via.set(p, f);
      if (p.endsWith(".mjs") && inside(path.relative(REPO, p)) && fs.existsSync(p)) queue.push(p);
    }
  }
  return via;
}

// The imports of a file's closure that leave the folder for something that is not product code, each as "<path> (via a → b → c)".
export function reached(file) {
  const via = closure(file);
  const out = [];
  for (const p of via.keys()) {
    const rel = path.relative(REPO, p);
    if (inside(rel) || product(rel)) continue;
    if (!private_(rel) && !fs.existsSync(p)) continue;
    const chain = [];
    for (let x = p; x; x = via.get(x)) chain.unshift(path.relative(REPO, x));
    out.push(`${rel} (via ${chain.join(" → ")})`);
  }
  return out;
}

const own = () => fs.readdirSync(HERE, { recursive: true }).filter((n) => n.endsWith(".mjs") && !n.includes(".public-closure-probe-")).sort();

test("every .mjs of tools/check reaches nothing outside tools/check except product code", () => {
  const files = own();
  assert.ok(files.length > 60, `only ${files.length} files found — is the walk right?`);
  const bad = files.flatMap((f) => reached(path.join(HERE, f)).map((r) => `${f} → ${r}`));
  assert.deepEqual(bad, [], "a file of tools/check reaches the private part or another tool folder — move that part out, or into a leaf");
});

test("every test of tools/check is registered in the public register, and none carries an .ops suffix", () => {
  const latch = JSON.parse(fs.readFileSync(path.join(HERE, "latch.json"), "utf8"))["Gate tool"];
  const tests = fs.readdirSync(HERE).filter((n) => n.endsWith(".test.mjs"));
  assert.ok(tests.length > 30);
  for (const f of tests) {
    assert.ok(!f.endsWith(".ops.test.mjs"), `${f}: an .ops test belongs beside the deploy tool (tools/deploy) or to its private remainder`);
    assert.ok(latch.includes(f), `${f} is not registered in latch.json`);
  }
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
    const leaf = make("leaf", `import { config } from "../../${O}/deploy/config.mjs";\nexport const x = config;\n`);
    const direct = make("direct", `import "../../${O}/deploy/config.mjs";\n`);
    const indirect = make("indirect", `import { x } from "./${path.basename(leaf)}";\nexport const y = x;\n`);
    const dynamic = make("dynamic", `export const z = () => import("../../${O}/deploy/lib/ssh.mjs");\n`);
    const tool = make("tool", `import "../${B}/build-icons.mjs";\n`);
    const clean = make("clean", 'import { REPO } from "./config-repo.mjs";\nimport "../../server/backend/test/fake-docker.mjs";\nexport const r = REPO;\n');
    assert.match(reached(direct).join("\n"), new RegExp(`^${O}/deploy/config\\.mjs \\(via `), "a direct import of the private part went unnoticed");
    assert.match(reached(indirect).join("\n"), new RegExp(`${O}/deploy/config\\.mjs \\(via .*leaf\\.mjs → ${O}/deploy/config\\.mjs\\)`), "an indirect import of the private part went unnoticed");
    assert.match(reached(dynamic).join("\n"), new RegExp(`${O}/deploy/lib/ssh\\.mjs`), "a dynamic import of the private part went unnoticed");
    assert.match(reached(tool).join("\n"), /tools\/icon\/build-icons\.mjs/, "an import of another tool folder went unnoticed");
    assert.deepEqual(reached(clean), [], "a clean file is reported");
  } finally {
    for (const p of probes) fs.rmSync(p, { force: true });
  }
});
