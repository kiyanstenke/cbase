// The second, independent secret scanner: gitleaks over the public tree.
//
// Why a foreign tool next to cleanliness.mjs: the own guard knows a handful of key shapes and an entropy rule; gitleaks knows
// some hundred provider formats and is maintained by others. Two guards written by different people miss different things.
//
// What it scans: exactly the files cleanliness.mjs calls public (`publicFiles`: tracked and untracked-not-ignored, private paths
// left out). They are copied into a throwaway folder first, so node_modules, build output and the private half never reach the
// scanner, and `gitleaks dir` sees the tree the export would publish. Rules: gitleaks' defaults plus the value allowlist of
// `.gitleaks.toml` at the repo root (made-up test secrets, each by its exact value).
//
// A missing gitleaks is RED, not skipped: an unchecked tree cannot be told from a clean one. Install: `brew install gitleaks`
// (macOS) or a release binary from github.com/gitleaks/gitleaks (Linux); CONTRIBUTING names it.
//
// Guard: tools/check/secrets.test.mjs (a key planted at run time must be found, also inside a test file; an allowlisted
// placeholder must not; a missing binary is reported as missing).
//
// Run:  node tools/check/secrets.mjs      -> one line per finding, then "N findings"; exit 0 clean, 1 findings, 2 gitleaks missing
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicFiles, REPO } from "./cleanliness.mjs";

/** The installed gitleaks version ("8.30.1"), or null when it cannot be run. `env` is for the test (an empty PATH). */
export function gitleaksVersion(env = process.env) {
  const r = spawnSync("gitleaks", ["version"], { encoding: "utf8", env });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || "").trim().replace(/^v/, "") || null;
}

/**
 * gitleaks over `files` (relative to `root`) with `root/.gitleaks.toml`.
 * Returns { missing: true } or { missing: false, version, scanned, findings: [{ rule, file, line }] }. Secrets are never returned
 * (the run is redacted). Throws when gitleaks ran but wrote no report — a scanner that did not scan is not a clean result.
 */
export function scanSecrets({ root = REPO, files = publicFiles(root), env = process.env } = {}) {
  const version = gitleaksVersion(env);
  if (!version) return { missing: true };
  const config = path.join(root, ".gitleaks.toml");
  if (!fs.existsSync(config)) throw new Error(`${path.relative(process.cwd(), config) || config} is missing: gitleaks would run without the allowlist`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-secrets-"));
  try {
    const tree = path.join(work, "tree");
    let scanned = 0;
    for (const f of files) {
      const src = path.join(root, f);
      let st;
      try { st = fs.lstatSync(src); } catch { continue; }   // tracked but deleted in the working tree
      if (!st.isFile()) continue;                            // symlinks are not followed (gitleaks does not either)
      const dst = path.join(tree, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      scanned++;
    }
    fs.mkdirSync(tree, { recursive: true });
    const report = path.join(work, "report.json");
    const r = spawnSync("gitleaks", ["dir", tree, "--config", config, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "0", "--log-level", "error"],
      { encoding: "utf8", env, maxBuffer: 1 << 26 });
    if (r.status !== 0 || !fs.existsSync(report)) throw new Error(`gitleaks did not finish (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    const findings = JSON.parse(fs.readFileSync(report, "utf8") || "[]").map((x) => ({ rule: x.RuleID, file: path.relative(tree, x.File), line: x.StartLine }));
    return { missing: false, version, scanned, findings };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = scanSecrets();
  if (r.missing) { console.log("gitleaks is not installed — not checked (brew install gitleaks)"); process.exit(2); }
  for (const f of r.findings) console.log(`${f.rule}\t${f.file}:${f.line}`);
  console.log(`${r.findings.length} findings (gitleaks ${r.version}, ${r.scanned} files)`);
  process.exit(r.findings.length ? 1 : 0);
}
