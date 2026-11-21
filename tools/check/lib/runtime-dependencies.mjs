// Binding the runtime dependencies: ONE manifest.
//
// A runtime dependency of the backend used to live in FOUR places — the manifest of the standalone app, that of the image
// (installed without a lockfile), the lockfile and the allowlist `build.files` of the packed bundle — and only this guard held
// them together. With the app its manifest and the allowlist went; the image has since installed with `npm ci` from the SAME
// lockfile the gate checks against on the Mac. Three places remain:
//   1. `server/backend/package.json` → `dependencies`
//   2. `server/backend/package-lock.json`  (including all transitive packages)
//   3. `server/backend/Dockerfile`         (the `rm -rf` behind `npm ci --omit=dev`: the dead wrapper, see `NEVER_LOADED`)
// A stale lockfile would let `npm ci` fail only at the image build on the server, a gap in the `rm` list silently ships 91 MB,
// an `rm` on a live package would let the backend die in the container — the guard catches all three in the gate.
//
// `checkRuntimeDependencies(locations)` is the ONE computation: it reads only manifest, lockfile and Dockerfile, never
// `node_modules`, and therefore runs on any machine. The guard is `tools/check/runtime-dependencies.test.mjs`. Whether the
// image LOADS afterwards is told by the load smoke test in targets/server.mjs (backendImageProbe).
import fs from "node:fs";
import path from "node:path";
import { dockerfileStages } from "./projectbox.mjs";

// The image runs on the server (linux/x64). Platform-bound optional packages for other targets are not installed by `npm ci`
// there and are skipped.
export const TARGET = { os: "linux", cpu: "x64" };

// Edges of the lockfile wrapper that are NEVER loaded at runtime — named, with a reason, and checked in BOTH directions: an
// exception whose edge the lockfile no longer carries is red (else it would silently cover the next package of the same name).
// The edge is cut, not the package. What is reachable ONLY via such an edge is the dead wrapper: the Dockerfile deletes it in
// the same instruction as `npm ci` (a layer of its own would keep the bytes in the image anyway).
export const NEVER_LOADED = [
  {
    from: "@huggingface/transformers",
    pack: "onnxruntime-web",
    reason:
      "the Node build (dist/transformers.node.mjs, which `exports.node` selects) replaces it with an empty module — " +
      "\"onnxruntime-web (ignored)\"; it is the browser runtime, 91 MB of wasm, with flatbuffers, guid-typescript, long, " +
      "platform, protobufjs and @protobufjs/* (embedding and import smoke test ran the same without them)",
  },
];

export const LOCATIONS = {
  manifest: "server/backend/package.json",
  lockfile: "server/backend/package-lock.json",
  dockerfile: "server/backend/Dockerfile",
};

// Runtime = what `npm ci --omit=dev` installs: dependencies + optionalDependencies.
export function runtimeOf(manifest) {
  return { ...(manifest?.dependencies || {}), ...(manifest?.optionalDependencies || {}) };
}

// --- Version ranges (without the semver package: the guard also runs without node_modules) ----------------

function parts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim());
  return m ? { a: +m[1], b: +m[2], c: +m[3], pre: m[4] || "" } : null;
}
function comparison(x, y) {
  for (const k of ["a", "b", "c"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// true/false, or null if the range has a form this guard cannot read — that is RED, not green
// ("not checkable" is not "fits").
export function fulfilled(version, area) {
  const v = parts(version);
  const r = String(area || "").trim();
  if (!v) return null;
  if (r === "*" || r === "") return true;
  const op = /^(\^|~|=)?/.exec(r)[0];
  const b = parts(r.slice(op.length));
  if (!b) return null;
  if (op === "" || op === "=") return comparison(v, b) === 0;
  if (comparison(v, b) < 0) return false;
  if (v.pre && !(v.a === b.a && v.b === b.b && v.c === b.c)) return false;
  if (op === "~") return v.a === b.a && v.b === b.b;
  // ^: the first non-zero position stays fixed
  if (b.a > 0) return v.a === b.a;
  if (b.b > 0) return v.a === 0 && v.b === b.b;
  return v.a === 0 && v.b === 0 && v.c === b.c;
}

// --- Lockfile: resolution like npm (nearest node_modules upwards) -------------------------------------

function matchesTarget(entry) {
  const matches = (list, value) => {
    if (!Array.isArray(list) || !list.length) return true;
    if (list.includes(`!${value}`)) return false;
    const positive = list.filter((x) => !x.startsWith("!"));
    return !positive.length || positive.includes(value);
  };
  return matches(entry.os, TARGET.os) && matches(entry.cpu, TARGET.cpu);
}

function resolve(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = (base ? `${base}/` : "") + `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i < 0 ? "" : base.slice(0, i);
  }
}

// The transitive wrapper of the runtime dependencies as lockfile keys (`node_modules/a`, `node_modules/a/node_modules/b`),
// plus what is missing from the lockfile — an optional dependency too (not an optional peer): npm writes it into the lockfile
// for EVERY platform, and if it is missing there, `npm ci` installs it nowhere (that is how the Linux binary of sharp once
// dropped out when the lockfile was created on the Mac).
export function wrapper(lock, roots, exceptions = []) {
  const packages = lock?.packages || {};
  const seen = new Set();
  const missing = [];
  const cut = new Set();
  const stack = [];
  for (const n of roots) {
    const k = resolve(packages, "", n);
    if (k) stack.push(k);
    else missing.push({ pack: n, from: "(root)" });
  }
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    const e = packages[k];
    const peerMeta = e.peerDependenciesMeta || {};
    const edgeList = [
      ...Object.keys(e.dependencies || {}).map((n) => [n, false, false]),
      ...Object.keys(e.optionalDependencies || {}).map((n) => [n, true, true]),
      ...Object.keys(e.peerDependencies || {}).map((n) => [n, !!peerMeta[n]?.optional, false]),
    ];
    for (const [n, optional, requiredInLock] of edgeList) {
      const exception = exceptions.find((a) => a.from === packageName(k) && a.pack === n);
      if (exception) {
        cut.add(exception);
        continue;
      }
      const z = resolve(packages, k, n);
      if (!z) {
        if (!optional || requiredInLock) missing.push({ pack: n, from: k, optional });
        continue;
      }
      if (optional && !matchesTarget(packages[z])) continue;
      if (!seen.has(z)) stack.push(z);
    }
  }
  return { key: [...seen].sort(), missing, cut: [...cut] };
}

// The package name of a lockfile key: `node_modules/tar/node_modules/yallist` → `yallist`.
export const packageName = (k) => k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);

// --- The Dockerfile ------------------------------------------------------------------------------------

/**
 * The install instruction of the stage `backend` → `{ instructions, deletes, copiedLockfile }`: all RUN instructions with
 * `npm ci`/`npm install` without `-g` (there should be exactly ONE, `npm ci --omit=dev`), the paths they then delete with
 * `rm -rf node_modules/…`, and whether a COPY takes the lockfile along.
 */
export function dockerfileInstall(text) {
  const backend = dockerfileStages(text).find((st) => st.name === "backend");
  if (!backend) return null;
  const instructions = backend.instructions.filter((a) => a.op === "RUN" && /\bnpm (ci|install)\b(?![^&;|]*\s-g\b)/.test(a.arg));
  const rm = instructions.length === 1 ? /&&\s*rm -rf ((?:node_modules\/[^\s&;|]+\s*)+)/.exec(instructions[0].arg) : null;
  const deletes = rm ? rm[1].trim().split(/\s+/) : [];
  const copiedLockfile = backend.instructions.some((a) => a.op === "COPY" && /(^|\s)package-lock\.json(\s|$)/.test(a.arg));
  return { instructions, deletes, copiedLockfile };
}

// Does `rm -rf <path>` hit the lockfile key `k`? `npm ci` lays out the tree exactly as the lockfile lists it — the PATH counts here.
const under = (k, filePath) => k === filePath || k.startsWith(`${filePath}/`);

// --- The verdict ----------------------------------------------------------------------------------------

// `{ manifest, lock, dockerfile }` as parsed objects resp. text (test seam); `readLocations` reads the three files under `repo`.
export function readLocations(repo) {
  const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
  return { manifest: JSON.parse(read(LOCATIONS.manifest)), lock: JSON.parse(read(LOCATIONS.lockfile)), dockerfile: read(LOCATIONS.dockerfile) };
}

export function checkRuntimeDependencies({ manifest, lock, dockerfile }, { exceptions = NEVER_LOADED } = {}) {
  const findings = [];
  const desired = runtimeOf(manifest);
  const lockPackages = lock?.packages || {};
  const lockRoot = runtimeOf(lockPackages[""]);
  const fresh = "npm install in server/backend/";

  // Per dependency of the manifest: is it in the lockfile, with the same range and a version in it?
  for (const [name, area] of Object.entries(desired)) {
    const lockEntry = lockPackages[`node_modules/${name}`];
    if (!(name in lockRoot) || !lockEntry) {
      findings.push(`${name}: listed in ${LOCATIONS.manifest}, missing from ${LOCATIONS.lockfile} (${fresh})`);
      continue;
    }
    if (lockRoot[name] !== area) {
      findings.push(`${name}: ${LOCATIONS.lockfile} is outdated — root has "${lockRoot[name]}", ${LOCATIONS.manifest} has "${area}" (${fresh})`);
    }
    const ok = fulfilled(lockEntry.version, area);
    if (ok === null) findings.push(`${name}: range "${area}" or version "${lockEntry.version}" is not readable for this guard`);
    else if (!ok) findings.push(`${name}: ${LOCATIONS.lockfile} has ${lockEntry.version}, outside of "${area}" (${fresh})`);
  }
  // What the lockfile lists as runtime but the manifest no longer does.
  for (const name of Object.keys(lockRoot)) {
    if (!(name in desired)) findings.push(`${name}: ${LOCATIONS.lockfile} is outdated — still lists it, ${LOCATIONS.manifest} no longer does (${fresh})`);
  }

  // The transitive wrapper: complete in the lockfile, none of it marked dev.
  const roots = Object.keys(desired).filter((n) => lockPackages[`node_modules/${n}`]);
  const { key, missing, cut } = wrapper(lock, roots, exceptions);
  for (const a of exceptions) {
    if (!cut.includes(a)) {
      findings.push(`${a.pack}: exception NEVER_LOADED (from ${a.from}) without an edge in ${LOCATIONS.lockfile} — remove it (tools/check/lib/runtime-dependencies.mjs)`);
    }
  }
  for (const f of missing) findings.push(`${f.pack}: ${f.optional ? "optional " : ""}needed by ${f.from}, missing from ${LOCATIONS.lockfile} (${fresh})`);
  for (const k of key) {
    if (lockPackages[k]?.dev) findings.push(`${k.replace(/^node_modules\//, "")}: runtime package, but marked dev in ${LOCATIONS.lockfile} — missing after npm ci --omit=dev (${fresh})`);
  }

  // The Dockerfile: ONE install instruction, `npm ci --omit=dev` with the lockfile, then exactly the dead wrapper deleted.
  const inst = dockerfileInstall(dockerfile);
  const tot = wrapper(lock, roots, []).key.filter((k) => !key.includes(k));
  if (!inst) findings.push(`${LOCATIONS.dockerfile}: no stage backend`);
  else {
    if (inst.instructions.length !== 1) findings.push(`${LOCATIONS.dockerfile}: ${inst.instructions.length} instructions install the runtime dependencies of the backend — exactly ONE belongs there`);
    else if (!/\bnpm ci\b/.test(inst.instructions[0].arg) || !/--omit=dev\b/.test(inst.instructions[0].arg)) {
      findings.push(`${LOCATIONS.dockerfile}: the install instruction is not \`npm ci --omit=dev\` — without the lockfile the image would resolve versions of its own`);
    }
    if (!inst.copiedLockfile) findings.push(`${LOCATIONS.dockerfile}: no COPY takes package-lock.json along — \`npm ci\` fails without a lockfile`);
    // onnxruntime-node fetches its CUDA build from GitHub at install time on linux/x64 unless told not to; that download
    // has gone away (404), and the server has no GPU anyway.
    if (key.some((k) => packageName(k) === "onnxruntime-node") && inst.instructions.length === 1
        && !/\bONNXRUNTIME_NODE_INSTALL_CUDA=skip\s+npm ci\b/.test(inst.instructions[0].arg)) {
      findings.push(`onnxruntime-node: the install instruction of ${LOCATIONS.dockerfile} does not set ONNXRUNTIME_NODE_INSTALL_CUDA=skip — its install script downloads the CUDA build from GitHub and fails the image build`);
    }
    // (a) No `rm` hits a live package.
    for (const p of inst.deletes) {
      for (const k of key.filter((x) => under(x, p))) {
        findings.push(`${packageName(k)}: runtime package (${k}), but ${LOCATIONS.dockerfile} deletes "${p}" — the backend would run in the container without it`);
      }
    }
    // (b) The dead wrapper is deleted — a dead package under a deleted folder is gone with it.
    for (const k of tot) {
      if (!inst.deletes.some((p) => under(k, p))) findings.push(`${packageName(k)}: dead wrapper (${k}, reachable only via NEVER_LOADED) ships in the image — "${k}" is missing from the rm list of ${LOCATIONS.dockerfile}`);
    }
    // (c) Every path of the rm list deletes something dead — otherwise it is stale (or a typo that silently deletes nothing).
    for (const p of inst.deletes) {
      if (!tot.some((k) => under(k, p))) findings.push(`${p}: ${LOCATIONS.dockerfile} deletes it, but it is not part of the dead wrapper — remove it`);
    }
  }

  return {
    ok: findings.length === 0,
    findings: [...new Set(findings)],
    counts: {
      runtime: Object.keys(desired).length,
      wrapper: key.length,
      exceptions: cut.length,
      tot: tot.length,
      deleted: inst?.deletes.length ?? 0,
    },
  };
}
