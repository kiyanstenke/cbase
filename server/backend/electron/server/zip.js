// Streamed ZIP for folder downloads: no dependency, only Node zlib.
//
// Format decisions (and why):
//  - Data descriptors (flag bit 3): CRC and sizes are only known AFTER deflating, so no file
//    has to be buffered; even a 5 GB folder runs through with constant memory.
//  - Bit 11 (UTF-8 names): umlauts in file names arrive correctly.
//  - ZIP64 as soon as a field no longer fits in 32 bits. Needed because a `node_modules` easily
//    blows the 65535-entry limit; without ZIP64 the archive would be BROKEN.
//  - Symlinks are NOT followed when they lead out of the folder (no data leak), directory
//    symlinks never (cycles). Skipped items end up as a notice file INSIDE the archive; silently
//    omitting them would lie about the contents.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { traverseWithoutReferences, openFileWithoutReference } from "./runtime/real-path.js";

const LOCAL_SIG = 0x04034b50;
const DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const Z64_EOCD_SIG = 0x06064b50;
const Z64_LOCATOR_SIG = 0x07064b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
// Safety margin to the 4 GiB limit: deflate can inflate incompressible data slightly, so
// ZIP64 decides the field width just below it.
const Z64_THRESHOLD = 0xfff00000;

// Already compressed formats do not go through deflate again (costs CPU, gains nothing).
const STORED_EXT = new Set([
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".jar", ".whl",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".ico",
  ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac",
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi",
  ".woff", ".woff2", ".pdf",
]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// MS-DOS timestamp (seconds rounded to 2, years from 1980).
function dosTime(mtime) {
  const d = mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? mtime : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Writes honouring backpressure; if the receiver aborts, the run ends.
function makeWriter(out) {
  let closed = false;
  const mark = () => { closed = true; };
  out.on("close", mark);
  out.on("error", mark);
  return {
    get closed() { return closed; },
    async write(buf) {
      if (closed) throw new Error("Download aborted");
      if (out.write(buf)) return;
      await new Promise((resolve) => {
        const done = () => { out.off("drain", done); out.off("close", done); out.off("error", done); resolve(); };
        out.once("drain", done);
        out.once("close", done);
        out.once("error", done);
      });
    },
  };
}

// A folder -> flat entry list. `.git` stays out (the tree does not show it either). Directory
// symlinks are skipped (cycles), file symlinks only followed if their target lies INSIDE the folder.
export function collectEntries(rootAbs, topName) {
  const realRoot = fs.realpathSync(rootAbs);
  const entries = [];
  const skipped = [];
  const insideRoot = (abs) => {
    try {
      const real = fs.realpathSync(abs);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch { return false; }
  };

  const walk = (absDir, zipDir) => {
    let names;
    try { names = fs.readdirSync(absDir).sort((a, b) => a.localeCompare(b)); }
    catch (e) { skipped.push(`${zipDir} — ${e.code || e.message}`); return; }
    for (const name of names) {
      if (name === ".git") continue;
      const abs = path.join(absDir, name);
      const zipPath = `${zipDir}${name}`;
      let st;
      try { st = fs.lstatSync(abs); } catch (e) { skipped.push(`${zipPath} — ${e.code || e.message}`); continue; }
      if (st.isSymbolicLink()) {
        let target;
        try { target = fs.statSync(abs); } catch { skipped.push(`${zipPath} — dead symlink`); continue; }
        if (target.isDirectory()) { skipped.push(`${zipPath}/ — directory symlink`); continue; }
        if (!insideRoot(abs)) { skipped.push(`${zipPath} — symlink leaves folder`); continue; }
        entries.push({ abs, zipPath, size: target.size, mtime: target.mtime, mode: 0o644, dir: false });
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ abs, zipPath: `${zipPath}/`, size: 0, mtime: st.mtime, mode: st.mode, dir: true });
        walk(abs, `${zipPath}/`);
      } else if (st.isFile()) {
        entries.push({ abs, zipPath, size: st.size, mtime: st.mtime, mode: st.mode, dir: false });
      } else {
        skipped.push(`${zipPath} — special file`);
      }
    }
  };

  walk(realRoot, `${topName}/`);
  return { entries, skipped };
}

// The same INSIDE THE AREA of a relocated project (runtime/http.js serveDownload with a boundary): collected via
// runtime/real-path.js traverseWithoutReferences (every folder O_NOFOLLOW from the pinned parent folder; the walk never leaves
// the start folder), each file is only opened at packing time with openFileWithoutReference (parent folder in the area, file
// O_NOFOLLOW|O_NONBLOCK, regular files only). A link, a special file or a file that became one before packing goes into
// `_CBASE-SKIPPED.txt`; a link is never followed, not even one that would stay in the folder (the path cannot hold that between
// collecting and opening). A file's size, time and mode come from fstat of the opened descriptor.
export function collectEntriesInArea(rootAbs, topName, area) {
  const entries = [];
  const skipped = [];
  const zipName = (abs) => `${topName}/${path.relative(rootAbs, abs).split(path.sep).join("/")}`;
  traverseWithoutReferences(rootAbs, area, (abs, e) => {
    if (e.name === ".git") return false;
    if (e.isDirectory()) {
      let st = null;
      try { st = fs.lstatSync(abs); } catch { /* only time and mode */ }
      entries.push({ abs, zipPath: `${zipName(abs)}/`, size: 0, mtime: st?.mtime || new Date(0), mode: st?.mode ?? 0o40755, dir: true });
      return true;
    }
    if (e.isFile()) { entries.push({ abs, zipPath: zipName(abs), size: 0, mtime: new Date(0), mode: 0o644, dir: false, inArea: true }); return false; }
    skipped.push(`${zipName(abs)} — ${e.isSymbolicLink() ? "symlink (not followed)" : "special file"}`);
    return false;
  });
  entries.sort((a, b) => a.zipPath.localeCompare(b.zipPath));
  return { entries, skipped };
}

function localHeader(entry, nameBuf, zip64) {
  const extra = zip64 ? 20 : 0;
  const buf = Buffer.alloc(30 + nameBuf.length + extra);
  const { time, date } = dosTime(entry.mtime);
  buf.writeUInt32LE(LOCAL_SIG, 0);
  buf.writeUInt16LE(zip64 ? 45 : 20, 4);            // version needed
  buf.writeUInt16LE(entry.flags, 6);
  buf.writeUInt16LE(entry.method, 8);
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(date, 12);
  buf.writeUInt32LE(0, 14);                         // CRC follows in the data descriptor
  buf.writeUInt32LE(0, 18);                         // compressed size follows
  buf.writeUInt32LE(0, 22);                         // original size follows
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(extra, 28);
  nameBuf.copy(buf, 30);
  if (zip64) {
    // Placeholder with 8-byte fields: fixes the data descriptor's field width.
    buf.writeUInt16LE(0x0001, 30 + nameBuf.length);
    buf.writeUInt16LE(16, 32 + nameBuf.length);
    buf.writeBigUInt64LE(0n, 34 + nameBuf.length);
    buf.writeBigUInt64LE(0n, 42 + nameBuf.length);
  }
  return buf;
}

function dataDescriptor(crc, csize, usize, zip64) {
  const buf = Buffer.alloc(zip64 ? 24 : 16);
  buf.writeUInt32LE(DESC_SIG, 0);
  buf.writeUInt32LE(crc, 4);
  if (zip64) {
    buf.writeBigUInt64LE(BigInt(csize), 8);
    buf.writeBigUInt64LE(BigInt(usize), 16);
  } else {
    buf.writeUInt32LE(csize, 8);
    buf.writeUInt32LE(usize, 12);
  }
  return buf;
}

function centralHeader(e) {
  const z64 = [];
  if (e.usize >= U32_MAX || e.csize >= U32_MAX) { z64.push(BigInt(e.usize), BigInt(e.csize)); }
  if (e.offset >= U32_MAX) { if (!z64.length) z64.push(BigInt(e.usize), BigInt(e.csize)); z64.push(BigInt(e.offset)); }
  const extra = z64.length ? 4 + z64.length * 8 : 0;
  const buf = Buffer.alloc(46 + e.nameBuf.length + extra);
  const { time, date } = dosTime(e.mtime);
  buf.writeUInt32LE(CENTRAL_SIG, 0);
  buf.writeUInt16LE(0x031e, 4);                     // made on Unix, spec 3.0
  buf.writeUInt16LE(extra > 0 || e.localZip64 ? 45 : 20, 6);
  buf.writeUInt16LE(e.flags, 8);
  buf.writeUInt16LE(e.method, 10);
  buf.writeUInt16LE(time, 12);
  buf.writeUInt16LE(date, 14);
  buf.writeUInt32LE(e.crc, 16);
  buf.writeUInt32LE(e.csize >= U32_MAX ? U32_MAX : e.csize, 20);
  buf.writeUInt32LE(e.usize >= U32_MAX ? U32_MAX : e.usize, 24);
  buf.writeUInt16LE(e.nameBuf.length, 28);
  buf.writeUInt16LE(extra, 30);
  buf.writeUInt16LE(0, 32);                         // comment length
  buf.writeUInt16LE(0, 34);                         // disk number
  buf.writeUInt16LE(0, 36);                         // internal attributes
  // `<<` yields a SIGNED 32-bit result; without `>>> 0` the Unix mode goes negative.
  buf.writeUInt32LE(((((e.mode & 0xffff) << 16) | (e.dir ? 0x10 : 0)) >>> 0), 38);
  buf.writeUInt32LE(e.offset >= U32_MAX ? U32_MAX : e.offset, 42);
  e.nameBuf.copy(buf, 46);
  if (extra) {
    let at = 46 + e.nameBuf.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(z64.length * 8, at + 2);
    at += 4;
    for (const v of z64) { buf.writeBigUInt64LE(v, at); at += 8; }
  }
  return buf;
}

function endRecords(count, cdSize, cdOffset, force64 = false) {
  const needs64 = force64 || count > U16_MAX || cdSize >= U32_MAX || cdOffset >= U32_MAX;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Math.min(count, U16_MAX), 8);
  eocd.writeUInt16LE(Math.min(count, U16_MAX), 10);
  eocd.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
  eocd.writeUInt32LE(Math.min(cdOffset, U32_MAX), 16);
  eocd.writeUInt16LE(0, 20);
  if (!needs64) return eocd;

  const rec = Buffer.alloc(56);
  rec.writeUInt32LE(Z64_EOCD_SIG, 0);
  rec.writeBigUInt64LE(44n, 4);                     // remaining length of this record
  rec.writeUInt16LE(45, 12);
  rec.writeUInt16LE(45, 14);
  rec.writeUInt32LE(0, 16);
  rec.writeUInt32LE(0, 20);
  rec.writeBigUInt64LE(BigInt(count), 24);
  rec.writeBigUInt64LE(BigInt(count), 32);
  rec.writeBigUInt64LE(BigInt(cdSize), 40);
  rec.writeBigUInt64LE(BigInt(cdOffset), 48);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(Z64_LOCATOR_SIG, 0);
  loc.writeUInt32LE(0, 4);
  loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
  loc.writeUInt32LE(1, 16);
  return Buffer.concat([rec, loc, eocd]);
}

/**
 * Stream a folder as ZIP into any Writable (response, file, buffer).
 * `topName` is the folder INSIDE the archive, so extracting does not spill everything into the working directory.
 * `forceZip64`/`forceEocd64` force the 64-bit fields or the ZIP64 end (tests only; in
 * operation size and entry count decide that themselves).
 * Returns: counters for logs/tests.
 */
export async function zipDirectory(rootAbs, topName, out, { forceZip64 = false, forceEocd64 = false, note = null, area = null } = {}) {
  // `area`: collected and opened inside the area of a relocated project (collectEntriesInArea); the notice file then
  // comes at the END because only opening decides what is skipped. Without `area` byte-identical to before.
  const { entries, skipped } = area ? collectEntriesInArea(rootAbs, topName, area) : collectEntries(rootAbs, topName);
  const hint = () => ({ zipPath: `${topName}/_CBASE-SKIPPED.txt`, buffer: Buffer.from([
    note?.header || "Skipped while packing:",
    "",
    ...skipped.map((s) => `- ${s}`),
  ].join("\n") + "\n", "utf8"), mtime: new Date(0), mode: 0o644, dir: false, size: 0 });
  if (skipped.length && !area) entries.push(hint());
  let hintDue = !area;
  if (area) entries.push({ hintSlot: true });

  const writer = makeWriter(out);
  const central = [];
  let offset = 0;
  let files = 0, bytes = 0;

  for (let entry of entries) {
    if (entry.hintSlot) {
      if (hintDue || !skipped.length) continue;
      hintDue = true;
      entry = hint();
    }
    const nameBuf = Buffer.from(entry.zipPath, "utf8");
    const isDir = entry.dir === true;
    const inline = entry.buffer || null;
    let fd = null;
    if (!isDir && !inline && entry.inArea) {
      // Without link, regular file only, in the area; size, time and mode from the opened descriptor.
      try {
        fd = openFileWithoutReference(entry.abs, area);
        const st = fs.fstatSync(fd);
        entry = { ...entry, size: st.size, mtime: st.mtime, mode: st.mode };
      } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        skipped.push(`${entry.zipPath} — ${e?.code === "EOUTSIDE" ? "symlink (not followed)" : e?.code === "ENOFILE" ? "special file" : (e?.code || e?.message)}`);
        continue;
      }
    } else if (!isDir && !inline) {
      // Open first, THEN write the local header: an unreadable file must not
      // leave a half-written archive behind.
      try { fd = fs.openSync(entry.abs, "r"); }
      catch { continue; }
    }

    const zip64 = forceZip64 || entry.size >= Z64_THRESHOLD;
    const stored = isDir || inline || STORED_EXT.has(path.extname(entry.zipPath).toLowerCase()) || entry.size === 0;
    const flags = isDir ? 0x0800 : 0x0808;          // Bit 11 UTF-8, Bit 3 Data Descriptor
    const method = stored ? 0 : 8;
    const header = localHeader({ ...entry, dir: isDir, flags, method }, nameBuf, !isDir && zip64);
    await writer.write(header);
    const localOffset = offset;
    offset += header.length;

    let crc = 0, csize = 0, usize = 0;
    if (isDir) {
      // Directories have no data and no data descriptor (flag bit 3 is not set).
    } else if (inline) {
      crc = crc32(inline);
      usize = inline.length;
      csize = inline.length;
      await writer.write(inline);
      offset += inline.length;
      const desc = dataDescriptor(crc, csize, usize, zip64);
      await writer.write(desc);
      offset += desc.length;
    } else {
      const counter = new Transform({
        transform(chunk, _enc, cb) { crc = crc32(chunk, crc); usize += chunk.length; cb(null, chunk); },
      });
      const source = fs.createReadStream(entry.abs, { fd, autoClose: true });
      const stream = stored ? source.pipe(counter) : source.pipe(counter).pipe(zlib.createDeflateRaw({ level: 6 }));
      try {
        for await (const chunk of stream) {
          csize += chunk.length;
          await writer.write(chunk);
          offset += chunk.length;
        }
      } catch (e) {
        // Mid-entry: the archive is irrecoverably incomplete; let the receiver tear down
        // (aborted download) rather than deliver a silent wreck of an archive.
        try { source.destroy(); } catch {}
        throw e;
      }
      const desc = dataDescriptor(crc, csize, usize, zip64);
      await writer.write(desc);
      offset += desc.length;
      files += 1;
      bytes += usize;
    }

    central.push({
      nameBuf, flags, method, crc, csize, usize, offset: localOffset,
      mtime: entry.mtime, mode: entry.mode, dir: isDir, localZip64: !isDir && zip64,
    });
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const e of central) {
    const buf = centralHeader(e);
    await writer.write(buf);
    cdSize += buf.length;
  }
  await writer.write(endRecords(central.length, cdSize, cdOffset, forceEocd64));
  return { entries: central.length, files, bytes, skipped };
}
