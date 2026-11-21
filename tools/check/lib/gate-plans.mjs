// The gate plans: WHAT the gate runs, as data instead of a hard-coded block in targets/check.mjs.
//
// Why: the maintainer's repository has a private part (the deploy tool's private remainder, the split, migration and export tools); the
// public repo keeps the gate, the deploy tool and the product guards. `check({ plan })` therefore takes a plan, and the plan carries
// everything that differs between the two worlds:
//
//   markerScope   the marker scope ("public" | "ops", lib/gate-marker.mjs): which marker file, and which requests a marker serves
//   suites        [{ name, glob?, build(ctx) }] in OUTPUT order. `glob` = { dir, ext, matches } is what the register holds against
//                 the tree; a suite without a glob (macOS) takes its files from the register's onlyMacOS section
//   registerFile  the guard register (repo-relative; one path or a list), `locAllowFile` the line-count exceptions
//   manifest      the split manifest (repo-relative) for the back-imports exception and step 1d (manifest diff), or null
//
// PUBLIC_PLAN is complete in itself (Backend, Gateway, Web, Client, the gate's own tests in tools/check, the deploy tool's tests in
// tools/deploy, macOS) and is the default plan of the public gate (`check`, tools/check/run.mjs). The private part builds its own plans:
// OPS_PLAN is a DELTA over this one (the private deploy tests, the Split, Migration and Export tool
// suites, the manifest-diff step, the ops marker scope), and `mergePlans(PUBLIC_PLAN, OPS_PLAN)` is what `./deploy check` runs.
//
// A suite builder `build(ctx, self)` (self = the suite as the plan holds it) returns the shell command (or a function that returns it, when it must be built at the moment it starts — the
// backend measures the load only then). A suite whose directory is missing or holds no test file THROWS: that is a red row, never
// the old `echo 'none'` that reported green because nothing ran. The only deliberate "none" left is macOS on a foreign platform.
import fs from "node:fs";
import path from "node:path";
import { shortParallelism } from "./gate-plan.mjs";
import { suiteOf } from "./guard-register.mjs";

export const SCOPES = Object.freeze(["public", "ops"]);

// The files of a glob directory, as the shell glob `<dir>/*<ext>` would take them.
function dirFiles(repo, g) {
  const dir = path.join(repo, g.dir);
  if (!fs.existsSync(dir)) throw new Error(`${g.dir} is missing — the suite would silently run nothing`);
  return fs.readdirSync(dir).filter((n) => n.endsWith(g.ext)).sort();
}

// The test files of a glob suite: the files `matches` accepts. The command takes the shell glob when that is exactly the same
// set (the form the gate has always used), an explicit list when the plan runs only a part of the directory.
function suiteFiles(ctx, s) {
  const all = dirFiles(ctx.repo, s.glob);
  const mine = all.filter(s.glob.matches);
  if (!mine.length) throw new Error(`${s.glob.dir} holds no test file the ${s.name} suite takes — it would silently run nothing`);
  return { all, mine, glob: mine.length === all.length };
}

export function globSuite(name, dir, ext, { matches = (n) => n.endsWith(ext), long = false } = {}) {
  const s = { name, glob: { dir, ext, matches } };
  // `self` is the suite as the PLAN holds it (a merge widens the matcher on a copy), never the object this closure was born with.
  s.build = (ctx, self = s) => {
    const f = suiteFiles(ctx, self);
    const target = f.glob ? `${dir}/*${ext}` : f.mine.map((n) => `${dir}/${n}`).join(" ");
    if (long) return () => `${ctx.fastDeadlines} ${ctx.NODE_TEST} --test-concurrency=${ctx.backend().count} ${target}`;
    return `${ctx.NODE_TEST} ${ctx.width(ctx.count(name))} ${target}`;
  };
  return s;
}

const WEB = {
  name: "Web",
  glob: { dir: "web/test", ext: ".mjs", matches: (n) => n.endsWith(".mjs") },
  // Explicit list instead of a shell glob: only so can the macOS-bound files be taken out without moving them. The list comes from
  // the guard register, which was already held against the tree one row earlier. An EMPTY list is an error (the register missing
  // or emptied), not "none".
  build(ctx) {
    if (!ctx.webFiles.length) throw new Error("no web test files from the register — the suite would silently run nothing");
    return `${ctx.NODE_TEST} ${ctx.width(ctx.webFiles.length)} ${ctx.webFiles.join(" ")}`;
  },
};

// The platform-bound benches (register `onlyMacOS`): on macOS a suite of their own, elsewhere not started — and the row says so.
const MACOS = {
  name: "macOS",
  build(ctx) {
    return ctx.onMac && ctx.onlyMac.files.length ? `${ctx.NODE_TEST} ${ctx.width(ctx.onlyMac.files.length)} ${ctx.onlyMac.files.join(" ")}` : "echo 'none'";
  },
};

export const PUBLIC_PLAN = Object.freeze({
  markerScope: "public",
  registerFile: "tools/check/latch.json",
  locAllowFile: "tools/check/loc-allow.json",
  manifest: null,
  suites: [
    globSuite("Backend", "server/backend/test", ".test.js", { long: true }),
    globSuite("Gateway", "server/gateway", ".test.js"),
    WEB,
    globSuite("Client", "client/test", ".test.mjs"),
    // The gate tests itself, and the product guards that live next to it.
    globSuite("Gate tool", "tools/check", ".test.mjs"),
    // The deploy tool; its private remainder adds "Deploy tool (private)" in the merged plan.
    globSuite("Deploy tool", "tools/deploy", ".test.mjs"),
    MACOS,
  ],
});

// Layer `extra` over `base`: a suite of the same name gets its matcher widened (its builder stays the base's), a new one is
// inserted after `extra.after` (else at the end). The marker scope, files and manifest of `extra` win where it names one.
export function mergePlans(base, extra) {
  const suites = base.suites.map((s) => ({ ...s, glob: s.glob ? { ...s.glob } : s.glob }));
  for (const e of extra.suites) {
    const at = suites.findIndex((s) => s.name === e.name);
    if (at >= 0) {
      const b = suites[at];
      if (!b.glob || !e.glob) throw new Error(`mergePlans: suite ${e.name} cannot be widened — it has no glob on one side`);
      if (b.glob.dir !== e.glob.dir || b.glob.ext !== e.glob.ext) throw new Error(`mergePlans: suite ${e.name} points at a different directory`);
      const [m1, m2] = [b.glob.matches, e.glob.matches];
      suites[at] = { ...b, glob: { ...b.glob, matches: (n) => m1(n) || m2(n) } };
      continue;
    }
    const { after, ...suite } = e;
    const pos = after ? suites.findIndex((s) => s.name === after) : -1;
    if (after && pos < 0) throw new Error(`mergePlans: ${e.name} wants to follow ${after}, which the base plan does not have`);
    suites.splice(pos < 0 ? suites.length : pos + 1, 0, suite);
  }
  return Object.freeze({
    markerScope: extra.markerScope || base.markerScope,
    registerFile: extra.registerFile || base.registerFile,
    locAllowFile: extra.locAllowFile || base.locAllowFile,
    manifest: extra.manifest ?? base.manifest,
    suites,
  });
}

export const DEFAULT_PLAN = PUBLIC_PLAN;

export const planSuiteNames = (plan) => plan.suites.map((s) => s.name);
export const planGlobs = (plan) => plan.suites.filter((s) => s.glob).map((s) => ({ suite: s.name, ...s.glob }));

// The context the builders see. Everything that is measured at gate time (register, platform, load) comes in through here, so a
// builder is a pure function of it — the tests drive them with staged values.
//   repo, NODE_TEST, fastDeadlines   the root and the two command fragments check.mjs owns
//   cores                            for the short suites' width
//   registerRaw, registerFiles       what the register file holds (null while it could not be read)
//   getBackend                       () → { count } — the backend width, known only when the long suite starts
//   onMac                            process.platform === "darwin"
export function suiteContext({ plan, repo, NODE_TEST, fastDeadlines, cores, registerRaw, registerFiles, getBackend, onMac }) {
  const globs = planGlobs(plan);
  const onlyMac = registerRaw?.onlyMacOS || { files: [], tests: [] };
  return {
    repo,
    NODE_TEST,
    fastDeadlines,
    onMac,
    onlyMac,
    globs,
    backend: getBackend,
    width: (files) => `--test-concurrency=${shortParallelism({ cores, files })}`,
    count: (suite) => (registerFiles || []).filter((f) => suiteOf(f, globs) === suite).length,
    webFiles: (registerFiles || []).filter((f) => f.startsWith("web/test/") && !onlyMac.files.includes(f)),
    skipsFor: (name) => (onMac ? [] : onlyMac.tests.filter((t) => suiteOf(t.file, globs) === name).map((t) => t.title)),
  };
}

// Build every suite of the plan. A builder that throws does not end the gate: its suite is reported (`errors`) and the gate turns
// red on it — in the table, with the reason — while the others still run.
export function buildSuites(plan, ctx) {
  const suites = [];
  const errors = [];
  for (const s of plan.suites) {
    if (typeof s.build !== "function") { errors.push({ name: s.name, message: "the plan has no builder for this suite" }); continue; }
    try { suites.push([s.name, s.build(ctx, s)]); } catch (e) { errors.push({ name: s.name, message: e.message }); }
  }
  return { suites, errors };
}
