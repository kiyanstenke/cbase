#!/usr/bin/env node
// The cleanliness guard: nothing private in the public tree.
//
// Promise: outside the private part of the tree (PRIVATE_PATHS) there is no employer or customer name, no secret, no
// routable IP address, no foreign domain, and no device, account or container identifier.
//
// How it holds:
//   terms    private names are NOT written here. A terms file carries salted SHA-256 hashes; every run of letters and
//            digits in every file is hashed (whole, and every substring of a listed length) and compared. The FULL list
//            lives only in the private part (a published salt next to real hashes would let anyone test guesses);
//            the public cleanliness-terms.json holds the canary alone, so the counter-test runs in every tree.
//            `node tools/check/cleanliness.mjs --hash` rebuilds both from the private plain list.
//   ips      every IPv4 address must be loopback, private, link-local, documentation range, or listed in the allowlist.
//   hosts    every host in a URL and every mail domain must be reserved (example.*, *.test, *.invalid …) or allowlisted.
//   secrets  key shapes of the common providers must be visibly fake (contain "placeholder") or allowlisted.
//   ids      device identifiers (UDID shape) must be allowlisted fakes; a signing team must not be set; UUIDs and other
//            exact identifiers are compared against the hashed list as whole tokens.
//
//   node tools/check/cleanliness.mjs          scan the tree, print findings, exit 1 when there are any
//   node tools/check/cleanliness.mjs --hash   rebuild both terms files from the private list
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
/**
 * The root folder of the private part of the tree (the maintainer's deploy remainder, export and migration tools, private notes).
 * A public clone has no such folder; the public tools name it only through this constant, so it is spelled out in ONE place.
 */
export const PRIVATE_ROOT = "ops";
/** A path inside the private part (absolute). */
export const privatePart = (...parts) => path.join(REPO, PRIVATE_ROOT, ...parts);
/**
 * What never leaves the private repository. The list is a fact of the private part of the tree: it stands in the private part's
 * deploy folder (the export tool reads the same file). A tree without that file — the public clone — has no private part, so the
 * list is empty and every file counts as public.
 */
export const PRIVATE_PATHS_FILE = privatePart("deploy/private-paths.json");
export function loadPrivatePaths(file = PRIVATE_PATHS_FILE) {
  if (!fs.existsSync(file)) return [];
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(d) || d.some((x) => typeof x !== "string" || !x)) throw new Error(`${file}: a list of non-empty path strings expected`);
  return d;
}
export const PRIVATE_PATHS = loadPrivatePaths();
/** An entry ending in "/" is a directory prefix; any other entry names exactly one file, or a directory with everything below it. */
export function isPrivate(p, list = PRIVATE_PATHS) {
  return list.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x || p.startsWith(`${x}/`)));
}
export const TERMS_FILE = path.join(HERE, "cleanliness-terms.json");
/** The full hash list: private part only. Where it exists (the private tree) it is the one that counts. */
export const PRIVATE_TERMS_FILE = privatePart("umbau/cleanliness-terms.json");
/** The canary: the one term the public file carries (written in parts so this file does not carry it whole). */
export const CANARY_TERM = "cbase" + "canary" + "privateterm";
export const ALLOW_FILE = path.join(HERE, "cleanliness-allow.json");
export const PRIVATE_LIST = privatePart("umbau/private-terms.txt");
/** A term this short is only matched as a whole run — as a substring it would hit random text. */
const WHOLE_ONLY_BELOW = 5;
/** The repository owner is public with the repository itself: the address of this repository may carry the name, nothing else may. */
// The copyright line of LICENSE/NOTICE names the owner; the words are assembled so this file does not carry them whole.
const COPYRIGHT_LINE = "Copyright 2026 " + ["Ki", "yan"].join("") + " " + ["Sten", "ke"].join("");
const PUBLIC_CONTEXT = new RegExp(String.raw`github\.com[/:][\w-]+\/cbase(?![\w-])|^[ \t]*${COPYRIGHT_LINE}[ \t]*$`, "gim");

const sha = (salt, s) => crypto.createHash("sha256").update(salt + s).digest("hex").slice(0, 32);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function loadTerms(file = fs.existsSync(PRIVATE_TERMS_FILE) ? PRIVATE_TERMS_FILE : TERMS_FILE) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  return { salt: d.salt, substring: new Set(d.substring), whole: new Set(d.whole), lengths: d.lengths };
}
export function loadAllow(file = ALLOW_FILE) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  return { hosts: new Set(d.hosts), ips: new Set(d.ips), secrets: new Set(d.secrets), udids: new Set(d.udids) };
}

/** Builds the hash file from plain lines ("# comment" and empty lines ignored). `extra` are added terms (the canary). */
export function hashTerms(lines, { salt = crypto.randomBytes(16).toString("hex"), extra = [] } = {}) {
  const terms = [...new Set([...lines, ...extra].map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(norm).filter(Boolean))];
  const sub = terms.filter((t) => t.length >= WHOLE_ONLY_BELOW), whole = terms.filter((t) => t.length < WHOLE_ONLY_BELOW);
  return { hint: "Salted hashes of private terms. Built by tools/check/cleanliness.mjs --hash; never edit by hand.", salt,
    lengths: [...new Set(sub.map((t) => t.length))].sort((a, b) => a - b),
    substring: sub.map((t) => sha(salt, t)).sort(), whole: whole.map((t) => sha(salt, t)).sort() };
}

export function publicFiles(root = REPO, privatePaths = PRIVATE_PATHS) {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  let list;
  if (r.status === 0) list = r.stdout.split("\0").filter(Boolean);
  else { list = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = d ? `${d}/${e.name}` : e.name;
    if (e.isDirectory()) { if (![".git", "node_modules", ".next", "out", "dist", "build"].includes(e.name)) walk(p); } else if (e.isFile()) list.push(p); } }; walk(""); }
  return list.filter((p) => !isPrivate(p, privatePaths));
}

const RESERVED_TLD = new Set(["example", "invalid", "test", "local", "localhost", "internal"]);
const reservedHost = (h) => { const l = h.split("."); return RESERVED_TLD.has(l.at(-1)) || (l.length >= 2 && l.at(-2) === "example" && ["com", "org", "net", "de"].includes(l.at(-1))); };
function ipAllowed(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a === 255 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
}
const IP = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w]|\.\d)/g;
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"'`<>]*@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;
const MAIL = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![\w.]*\d)/gi;
const SECRET = /sk-ant-[A-Za-z0-9_-]{6,}|sk-(?:proj-)?[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g;
const UDID = /\b0000[0-9A-F]{4}-[0-9A-F]{16}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TEAM = /DEVELOPMENT_TEAM\s*=\s*"?([A-Z0-9]+)"?/g;
const RUN = /[a-z0-9]+/g;

/**
 * Scans the given files. Returns findings as { file, kind, what } — `what` never repeats a private term (only its position),
 * so the report itself can be shown.
 */
export function scan({ root = REPO, files = publicFiles(root), terms = loadTerms(), allow = loadAllow() } = {}) {
  const findings = []; const runs = new Map(); const binaryRuns = new Map(); const textRuns = new Set();   // run -> first file
  for (const p of files) {
    let buf; try { buf = fs.readFileSync(path.join(root, p)); } catch { continue; }
    const raw = buf.toString("latin1"); const text = raw.replace(PUBLIC_CONTEXT, " ");
    const binary = buf.includes(0) && !/\.(old|raw)$/.test(p);
    for (const m of (p + "\n" + text).toLowerCase().matchAll(RUN)) { if (binary) { if (!binaryRuns.has(m[0])) binaryRuns.set(m[0], p); } else { if (!runs.has(m[0])) runs.set(m[0], p); binaryRuns.delete(m[0]); textRuns.add(m[0]); } }
    if (binary) continue;   // binary: names only, and only the long ones — three letters turn up in any image by chance
    const add = (kind, what) => findings.push({ file: p, kind, what });
    const lock = /(^|\/)package-lock\.json$/.test(p);   // third-party metadata: registry and funding addresses, maintainers' mails
    if (!lock) for (const m of text.matchAll(IP)) if (!ipAllowed(m[0]) && !allow.ips.has(m[0])) add("ip", m[0]);
    if (!lock) for (const m of text.matchAll(URL_HOST)) { const h = m[1].toLowerCase(); if (!reservedHost(h) && !allow.hosts.has(h)) add("host", h); }
    if (!lock) for (const m of text.matchAll(MAIL)) { const h = m[1].toLowerCase(); if (!reservedHost(h) && !allow.hosts.has(h)) add("mail", `…@${h}`); }
    for (const m of text.matchAll(SECRET)) if (!/placeholder/i.test(m[0]) && !allow.secrets.has(m[0])) add("secret", `${m[0].slice(0, 12)}…`);
    for (const m of text.matchAll(UDID)) if (!allow.udids.has(m[0].toUpperCase())) add("device", `${m[0].slice(0, 9)}…`);
    for (const m of text.matchAll(UUID)) if (terms.whole.has(sha(terms.salt, norm(m[0]))) || terms.substring.has(sha(terms.salt, norm(m[0])))) add("id", `${m[0].slice(0, 8)}…`);
    for (const m of text.matchAll(TEAM)) add("account", "DEVELOPMENT_TEAM is set");
  }
  for (const [run, file] of binaryRuns) if (!runs.has(run)) runs.set(run, file);
  for (const [run, file] of runs) {
    if (textRuns.has(run) && terms.whole.has(sha(terms.salt, run))) { findings.push({ file, kind: "term", what: `a private term (${run.length} characters, whole word)` }); continue; }
    let hit = false;
    for (const n of terms.lengths) { if (n > run.length || hit) continue;
      for (let i = 0; i + n <= run.length; i++) if (terms.substring.has(sha(terms.salt, run.slice(i, i + n)))) { hit = true; findings.push({ file, kind: "term", what: `a private term (${n} characters) inside a word of ${run.length}` }); break; } }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--hash")) {
    const saltOf = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).salt : undefined);
    const d = hashTerms(fs.readFileSync(PRIVATE_LIST, "utf8").split("\n"), { salt: saltOf(PRIVATE_TERMS_FILE), extra: [CANARY_TERM] });
    fs.writeFileSync(PRIVATE_TERMS_FILE, JSON.stringify(d, null, 1) + "\n");
    // The public salt is never the private one: keep it only while the public file already holds the canary alone.
    const cur = fs.existsSync(TERMS_FILE) ? JSON.parse(fs.readFileSync(TERMS_FILE, "utf8")) : {};
    const pub = hashTerms([], { salt: (cur.substring?.length ?? 0) + (cur.whole?.length ?? 0) === 1 && cur.salt !== d.salt ? cur.salt : undefined, extra: [CANARY_TERM] });
    fs.writeFileSync(TERMS_FILE, JSON.stringify({ ...pub, hint: "The canary alone (the full list is private). Built by tools/check/cleanliness.mjs --hash; never edit by hand." }, null, 1) + "\n");
    console.log(`private terms: ${d.substring.length} substring, ${d.whole.length} whole-word; public file: the canary only`);
  } else {
    const f = scan(); const by = new Map(); for (const x of f) by.set(x.kind, (by.get(x.kind) || 0) + 1);
    for (const x of f) console.log(`${x.kind}\t${x.file}\t${x.what}`);
    console.log(`${f.length} findings${f.length ? ": " + [...by].map(([k, n]) => `${k} ${n}`).join(", ") : ""}`);
    process.exit(f.length ? 1 : 0);
  }
}
