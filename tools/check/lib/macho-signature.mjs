// Is EVERY Mach-O file of a built bundle validly signed?
//
// Measured: of 281 s of app build under Electron 44, 276 s were the signing loop. `@electron/osx-sign` 1.3.3 calls
// `codesign --timestamp` for every file it takes for binary, one by one (≈ 0.37 s per call, almost all waiting for
// Apple's timestamp server), walks through the symlinks `Versions/Current` and `<Framework>/Resources` via `fs.stat`
// (every framework file three times), and Electron 44 ships 220 instead of 55 `locale.pak` — 736 calls, 660 of them pure
// language data. Therefore `build.mac` of the package.json carries two lines:
//
//   · H1 `signIgnore`: symlink paths (`\.framework/(?!Versions/A/)`) and pure data
//     (`\.(pak|dat|bin|nib|asar|icns|car|onnx)$`) are not signed individually — the surrounding bundle signature seals
//     the data, as with every other Mac app. 736 → 38 calls.
//   · H2 `timestamp: "none"`: no timestamp server (≈ 55 instead of 368 ms per call, and the build no longer depends on the
//     network). There is no notarization anyway.
//
// Together 281 → 7.0 s (app) and 272 → 4.2 s (client).
//
// The price of H1: the extension list is a HEURISTIC. A future Mach-O file with the extension `.bin`/`.dat`/… would stay
// unsigned — and `codesign --verify --deep --strict` on the whole bundle would NOT see that: a Mach-O under
// `Contents/Resources` is no nested code unit for `--deep`, but a resource the seal covers only by hash (shown on a real
// bundle in the test: seal valid, file "not signed at all"). Under Hardened Runtime such a file dies only on loading.
// Hence this guard checks every Mach-O INDIVIDUALLY (`codesign -v --strict <file>`) — and the bundle seal in addition,
// because the omitted data are covered only by it.
//
// A Mach-O is recognized by its first four bytes (`MACHO_MAGIC`), not by the extension (exactly the heuristic the guard
// stands against) and not via `file` (one process per file, and a foreign tool with its own opinion). Symlinks are NOT
// followed (`lstat`): every real file counts once — `Versions/Current/…` and the top framework link are the same bytes as
// `Versions/A/…`, and exactly this triple counting was one of the three reasons for the 736 calls.
//
// Empty is not unknown: if the bundle is missing, `codesign` is missing (Linux runner), NO Mach-O is found or a call ends
// without a verdict — the result is UNKNOWN and never "valid". "0 of 0 invalid" would otherwise be exactly the line that
// reports green while nobody checked anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// The first four bytes, read as big-endian uint32. Thin Mach-O files lie little-endian on disk on arm64/x86_64
// (`cf fa ed fe` → 0xcffaedfe = MH_CIGAM_64), universal binaries big-endian (`ca fe ba be` = FAT_MAGIC). The
// counterparts are included for completeness.
const THIN = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);
const FAT_BE = new Set([0xcafebabe, 0xcafebabf]); // FAT_MAGIC, FAT_MAGIC_64
const FAT_LE = new Set([0xbebafeca, 0xbfbafeca]); // FAT_CIGAM, FAT_CIGAM_64
export const MACHO_MAGIC = new Set([...THIN, ...FAT_BE, ...FAT_LE]);

// `cafebabe` is ALSO the identifier of a Java class file. There the minor/major version follows (major ≥ 45),
// in a universal binary the number of architectures — the same threshold as libmagic (`file`):
// below 20 is Mach-O. /usr/bin/true carries 3.
const FAT_AT_MOST = 19;

export function isMachO(header) {
  if (!header || header.length < 4) return false;
  const magic = header.readUInt32BE(0);
  if (THIN.has(magic)) return true;
  if (!FAT_BE.has(magic) && !FAT_LE.has(magic)) return false;
  if (header.length < 8) return false;
  const n = FAT_BE.has(magic) ? header.readUInt32BE(4) : header.readUInt32LE(4);
  return n >= 1 && n <= FAT_AT_MOST;
}

function headerOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Every Mach-O file under `app`, relative and sorted bytewise. Only real files — a symlink
// (to a file OR a folder) is neither counted nor entered.
export function machoFiles(app) {
  const found = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) run(full);
      else if (e.isFile() && isMachO(headerOf(full))) found.push(path.relative(app, full));
    }
  };
  run(app);
  return found.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

// One `codesign` call on `target`. `null` in the field `rc` means: no verdict (tool missing, deadline,
// signal). codesign prefixes every message with "<path>: " — the path is already in the line.
function codesign(bin, args, target, deadline) {
  return new Promise((resolve) => {
    let err = "";
    let finished = false;
    const end = (r) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(bin, [...args, target], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      end({ rc: null, reason: e.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      end({ rc: null, reason: `deadline ${deadline} ms expired` });
    }, deadline);
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => end({ rc: null, reason: e.code === "ENOENT" ? `${bin} missing` : e.message }));
    child.on("close", (code, signal) =>
      end(code === null ? { rc: null, reason: `${bin} terminated by ${signal}` } : { rc: code, reason: err.split(`${target}: `).join("").trim().split("\n").filter(Boolean).slice(0, 2).join(" · ") }),
    );
  });
}

// The check. `bin` only for the test (a missing tool is "unknown", not "valid").
// Parallel, because the ≈ 1 s would otherwise become the sum of all single calls; `codesign -v` only reads.
export async function signatureCheck(app, { bin = "codesign", parallel = Math.min(8, os.availableParallelism?.() || 4), deadline = 60000 } = {}) {
  const t0 = Date.now();
  const result = { bundle: { valid: null, reason: "" }, found: 0, checked: 0, invalid: [], unknown: [], ms: 0 };
  const finished = () => ((result.ms = Date.now() - t0), result);
  if (!app || !fs.existsSync(app)) {
    result.bundle.reason = "bundle missing";
    return finished();
  }
  const files = machoFiles(app);
  result.found = files.length;

  // The seal of the whole bundle: since H1 it covers the data not signed individually. It runs ALONGSIDE the
  // single checks (measured: seal 0.62 s, 23 single checks at parallelism 8 ≈ 0.6 s; in sequence 1.24 s).
  const seal = codesign(bin, ["--verify", "--deep", "--strict"], app, deadline).then((b) => {
    result.bundle = b.rc === null ? { valid: null, reason: b.reason } : { valid: b.rc === 0, reason: b.rc === 0 ? "" : b.reason || `Exit ${b.rc}` };
  });

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const rel = files[next++];
      const r = await codesign(bin, ["-v", "--strict"], path.join(app, rel), deadline);
      if (r.rc === null) result.unknown.push({ file: rel, reason: r.reason });
      else {
        result.checked++;
        if (r.rc !== 0) result.invalid.push({ file: rel, reason: r.reason || `Exit ${r.rc}` });
      }
    }
  };
  await Promise.all([seal, ...Array.from({ length: Math.max(1, Math.min(parallel, files.length)) }, worker)]);
  result.invalid.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  result.unknown.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  return finished();
}

const sec = (ms) => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;

// The verdict and the cell for the client's table. `ok` ONLY if the seal was read and is valid, at least one Mach-O
// was found and every single one was read and is valid.
export function signatureVerdict(r) {
  const all = r.found;
  if (r.bundle.valid === null && !all && r.bundle.reason === "bundle missing") return { ok: false, text: "unknown (bundle missing)" };
  if (!all) return { ok: false, text: `unknown (no Mach-O found in the bundle — nothing checked; ${sec(r.ms)})` };
  if (r.bundle.valid === null) return { ok: false, text: `unknown (bundle seal unreadable: ${r.bundle.reason}; ${sec(r.ms)})` };
  if (r.unknown.length) {
    const u = r.unknown[0];
    return { ok: false, text: `unknown (${r.unknown.length} of ${all} without verdict, e.g. ${u.file}: ${u.reason}; ${sec(r.ms)})` };
  }
  const parts = [];
  if (!r.bundle.valid) parts.push(`bundle seal INVALID (${r.bundle.reason})`);
  if (r.invalid.length) {
    const list = r.invalid.slice(0, 3).map((u) => `${u.file} (${u.reason})`).join(", ");
    parts.push(`INVALID: ${r.invalid.length} of ${all} — ${list}${r.invalid.length > 3 ? ", …" : ""}`);
  }
  if (parts.length) return { ok: false, text: `${parts.join(" · ")} · ${sec(r.ms)}` };
  return { ok: true, text: `${r.checked} of ${all} individually valid, seal --deep --strict valid · ${sec(r.ms)}` };
}

// The one call the targets need.
export async function machoSignatureVerdict(app, opts = {}) {
  const r = await signatureCheck(app, opts);
  return { ...signatureVerdict(r), result: r };
}
