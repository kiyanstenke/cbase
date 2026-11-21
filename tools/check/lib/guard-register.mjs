// The guard register: which test benches EXIST, in black and white.
//
// The motive is measured and old: a bench section left out did not turn the run red, only smaller: 251 instead of 255
// checks, green tick. The same held for the test files themselves, only unnoticed: if `web/test/list-binding.test.mjs`
// disappears, the gate's glob finds one file less, reports a smaller number and a tick. A number that falls cannot be
// told from one that never rose.
//
// Hence the same shape as the route and schema registers: REGISTRATION == FILE, in both directions.
//
//  · a registered file that no longer exists  ⇒ red. If the deletion was intended, the line goes — and that is the
//    place where someone justifies why this guarantee no longer holds. A guard that can be deleted silently is none.
//  · a file in the glob that is not registered ⇒ red. This is the cost side and it is intended: one line per new
//    bench. It is the one moment in the flow where the question comes by itself — which guard catches the change I
//    am building right now?
//
// The file is `tools/check/latch.json`. It carries NO test counts: a count per file would be red with every new
// test and thus within a week a habit one clicks away. What is held here is existence.
import fs from "node:fs";
import path from "node:path";

// The globs are NOT a constant here any more: they belong to the gate PLAN (lib/gate-plans.mjs, `planGlobs`), and every
// function below takes them as an argument. A glob is `{ suite, dir, matches }`. Which globs a plan has is held against its
// suites by `guard-register.test.mjs` — if a suite is there and its glob is not, the register would check half.
//
// "Client": `client/test/*.test.mjs` run with bare node, without the real Electron. The browser tests import only the
// leaf `client/browser-rules.js`; the Electron side of the browser (`client/browser.js`) is checked by NO bench, it is
// inspected in the built client — which is why each of its decisions sits in the leaf next to it. In addition
// `shell-*.test.mjs` load the REAL main processes of both apps (`client/main.js` and the backend's `electron/main.js`)
// against a FAKED Electron (`client/test/shell-harness.mjs`, `module.registerHooks`, Node >= 22.15); windows, AppKit
// and notifications stay unchecked.

// The files the gate really runs — the same way as the shell globs, only in JS. A glob whose directory does not exist is an
// ERROR, not "nothing there": a vanished suite directory must never read as an empty register direction.
export function guardInTree(repo, globs) {
  if (!Array.isArray(globs) || !globs.length) throw new Error("guardInTree: no globs given — a gate plan without globs registers nothing");
  const out = [];
  for (const g of globs) {
    const dir = path.join(repo, g.dir);
    if (!fs.existsSync(dir)) throw new Error(`suite ${g.suite}: directory ${g.dir} is missing — the suite would silently run nothing`);
    for (const n of fs.readdirSync(dir).sort()) {
      if (g.matches(n)) out.push(`${g.dir}/${n}`);
    }
  }
  return out;
}

// Which suite does a file belong to? The same mapping as the globs, asked the other way round —
// the macOS-only exceptions name their file, the gate needs the suite.
export function suiteOf(rel, globs) {
  const g = globs.find((g) => rel.startsWith(`${g.dir}/`));
  return g ? g.suite : null;
}

// The register's entries for the suites of `globs`. `strict` (the gate with its full plan): EVERY entry of a suite counts,
// also one the glob would not match — it then shows up as "registered but not in the tree" instead of being dropped.
// Not strict (a partial plan next to a register that also carries the other plan's lines): only the entries the globs match.
export function readRegister(file, globs, { strict = true } = {}) {
  // One register file, or several (the public one and, in a tree that carries the private part, the ops one): the lists of the
  // same suite are joined, `onlyMacOS` and `hint` are the first file's that has them.
  const raw = {};
  for (const f of [].concat(file)) {
    const part = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [k, v] of Object.entries(part)) {
      if (Array.isArray(v)) raw[k] = [...(raw[k] || []), ...v];
      else if (!(k in raw)) raw[k] = v;
    }
  }
  const files = [];
  for (const g of globs) {
    for (const n of raw[g.suite] || []) if (strict || g.matches(n)) files.push(`${g.dir}/${n}`);
  }
  return { raw, files };
}

// The pure calculation — two lists, no file system. So it runs in the test without a repo.
export function guardRegister(inTree, registered) {
  const tree = new Set(inTree);
  const reg = new Set(registered);
  const disappeared = registered.filter((f) => !tree.has(f));
  const loggedOut = inTree.filter((f) => !reg.has(f));
  const duplicate = registered.filter((f, i) => registered.indexOf(f) !== i);
  const violations = [
    ...disappeared.map((f) => `registered but not in the tree: ${f} — if the deletion was intended, remove the line from latch.json and justify which guarantee no longer holds`),
    ...loggedOut.map((f) => `in the tree but not registered: ${f} — add a line to tools/check/latch.json`),
    ...[...new Set(duplicate)].map((f) => `registered twice: ${f}`),
  ];
  return {
    ok: violations.length === 0,
    count: inTree.length,
    disappeared,
    loggedOut,
    duplicate: [...new Set(duplicate)],
    violations,
  };
}

export function guardRegisterText(r) {
  if (r.ok) return `${r.count} benches registered and present`;
  return r.violations[0];
}
