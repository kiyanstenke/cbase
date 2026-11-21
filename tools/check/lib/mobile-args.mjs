// The command-line words of the iOS UI test run (`mobile --tests`), as a leaf: the parser of deploy.mjs takes them from here, and the public guards
// (uitests.test.mjs) drive the same code without loading deploy.mjs (which pulls in the whole installation: config, ssh, targets).
// Pure — no file system, no process. The equivalence with `parseArgs` of deploy.mjs is bound in uitests.ops.test.mjs.

// Fresh values of the options this leaf owns; deploy.mjs spreads them into its option object.
export const mobileDefaults = () => ({ wait: 0, mobileTests: false, only: [], runs: 1 });

// One word of the command line. Returns true when the word (and, for `--only`/`--runs`/`--wait`, its follower in `args`) was taken.
export function applyMobileArg(o, a, args) {
  switch (a) {
    case "--tests": o.mobileTests = true; return true;
    case "--only": o.only.push(args.shift() || ""); return true;
    case "--runs": o.runs = +(args.shift() || 1); return true;
    // Without a number: the default of the TARGET — 300 s for the deploy gates, 600 s for the load gate of
    // `mobile --tests`.
    case "--wait": o.wait = /^\d+$/.test(args[0] || "") ? +args.shift() : null; return true;
    default:
  }
  if (a.startsWith("--wait=")) { o.wait = +a.split("=")[1] || null; return true; }
  if (a.startsWith("--only=")) { o.only.push(a.slice("--only=".length)); return true; }
  if (a.startsWith("--runs=")) { o.runs = +a.slice("--runs=".length); return true; }
  return false;
}

// After the last word: the default of `--wait` and the rules that bind the options to `mobile` alone.
export function finishMobileArgs(o) {
  if (o.wait === null) o.wait = o.mobileTests ? 600 : 300;
  if ((o.mobileTests || o.only.length || o.runs !== 1) && !(o.targets.length === 1 && o.targets[0] === "mobile")) {
    throw new Error("--tests, --only and --runs belong to `mobile` alone (`mobile --tests ...`).");
  }
  if (o.mobileTests && (!Number.isInteger(o.runs) || o.runs < 1)) throw new Error("--runs needs a whole number ≥ 1.");
  if (o.only.some((k) => !k.trim())) throw new Error("--only needs an identifier CbaseMobileUITests/<Class>/<test> (or CbaseMobileUITests/<Class>).");
}

// The last rule of the group (deploy.mjs checks it after `--diff`, so the order of the messages stays as it was).
export function mobileOnlyNeedsTests(o) {
  if ((o.only.length || o.runs !== 1) && !o.mobileTests) throw new Error("--only/--runs only together with --tests.");
}

// The mobile subset of the command line on its own: target words, `--force`, and the options above. For the guards.
export function parseMobileArgs(argv, targets = ["web", "server", "client", "mobile"]) {
  const o = { ...mobileDefaults(), targets: [], force: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === "--force") o.force = true;
    else if (targets.includes(a)) o.targets.push(a);
    else if (!applyMobileArg(o, a, args)) throw new Error(`Unknown argument: ${a}`);
  }
  finishMobileArgs(o);
  mobileOnlyNeedsTests(o);
  return o;
}
