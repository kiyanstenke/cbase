// Read a ZIP's central directory without unpacking the archive. The project-creation preview must stand BEFORE creating, but the
// archive is only uploaded afterwards — so the browser reads the directory at the end of the file (`File.slice`): end of central
// directory, ZIP64 locator, per entry name, size, flags. No library. Only the content of a `.git` FILE (at most 4 KB, for the
// project layout rule) is unpacked.
//
// Twin: `mobile/CbaseMobile/Code/ZipDirectory.swift` (same name rule, same pre-check).
//
// NAMES as Python's `zipfile` in the `PROVISIONER`: flag bit 11 ⇒ UTF-8 (strict — an invalid name makes `zipfile` unable to read the
// archive), otherwise cp437; the "Unicode Path" field (0x7075) is not read by `zipfile`, so not by this reader either; cut at the first
// NUL (as `ZipInfo`); `\` → `/`; compared in NFC; a leading BOM stays (Python's utf-8 codec keeps it). An Explorer ZIP carries umlauts
// without bit 11 — a UTF-8 reader would find no `from` of the mapping in the archive (`PLAN_MATCHES_NOT`). After that "." path parts
// are dropped (bsdtar writes every name with "./"); a name consisting only of "." parts ("./") is no entry.
//
// The reader is NO trust anchor: the server lists the archive itself after the upload and stops on a deviation; zip-slip, links and
// bombs are checked only by the `PROVISIONER`. The pre-check here (`denied`) only says early what the server will surely reject —
// so nobody uploads gigabytes to learn it afterwards.

export interface ZipEntry {
  /** Decoded and normalized (see above), without a trailing "/". */
  name: string;
  folder: boolean;
  /** Uncompressed, as declared. */
  size: number;
  compressed: number;
  method: number;
  encrypted: boolean;
  /** Unix mode `0o120000` in the upper word of `external_attr`. */
  reference: boolean;
  /** Offset of the local header (only for `readSmallEntry`). */
  header: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Exactly one common first path part (without `__MACOSX/` and `.DS_Store`), and it is a folder — otherwise null. */
  parentFolder: string | null;
  /** What the `PROVISIONER`'s pre-check surely rejects (at most 5 names): an absolute name, a drive letter, a `..` or empty path
   *  part (zip-slip), an encrypted entry, a name with bit 11 that is not UTF-8. */
  denied: { reason: "unsafe" | "encrypted" | "encoding"; names: string[] } | null;
}

export type ZipErrorCode = "NO_ZIP" | "MULTIPART" | "BROKEN";
export class ZipError extends Error {
  code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) { super(message); this.name = "ZipError"; this.code = code; }
}

/** Reads the bytes `[from, until)`. */
export type Reader = (from: number, until: number) => Promise<Uint8Array>;

export const fileReader = (f: Blob): Reader => async (from, until) => new Uint8Array(await f.slice(from, until).arrayBuffer());

// cp437, 0x80–0xFF, generated from Python's codec (`bytes(range(128, 256)).decode("cp437")`); 0x00–0x7F are ASCII.
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûù" +
  "ÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟" +
  "╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈" +
  "°∙·√ⁿ²■ ";

/** PURE: a name from the directory → text (bit 11 ⇒ strict UTF-8, otherwise cp437). `null` = no valid UTF-8 despite bit 11. */
export function decodeZipName(bytes: Uint8Array, utf8: boolean): string | null {
  let s: string;
  if (utf8) {
    try { s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  } else {
    s = "";
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  }
  const nul = s.indexOf("\u0000");
  return nul >= 0 ? s.slice(0, nul) : s;
}

/** PURE: the name as preview and mapping carry it — `\` → `/`, NFC, without "." path parts (as the `PROVISIONER`). A folder's
 *  trailing "/" stays here. `null`: EVERY path part was "." ("./") — no entry. A leading "/" and empty parts stay (the pre-check
 *  rejects them). */
export function zipNormal(name: string): string | null {
  const s = name.replace(/\\/g, "/").normalize("NFC");
  const end = s.endsWith("/");
  const parts = (end ? s.slice(0, -1) : s).split("/");
  const without = parts.filter((t) => t !== ".");
  if (!without.length) return null;
  return without.join("/") + (end ? "/" : "");
}

/** PURE: would the `PROVISIONER`'s pre-check reject this (normalized) name? (zip-slip) */
export function zipNameUnsafe(name: string): boolean {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  const withoutEnd = name.endsWith("/") ? name.slice(0, -1) : name;
  return withoutEnd.split("/").some((t) => t === "" || t === "..");
}

const OUTSIDE = (name: string) => name.split("/")[0] === "__MACOSX" || name.split("/").pop() === ".DS_Store";

/** PURE: the common first path part if there is exactly one and it is a folder (`__MACOSX/` and `.DS_Store` do not
 *  count). */
export function zipParentFolder(entries: { name: string; folder: boolean }[]): string | null {
  let first: string | null = null;
  let isFolder = false;
  for (const e of entries) {
    if (!e.name || OUTSIDE(e.name)) continue;
    const i = e.name.indexOf("/");
    const t = i < 0 ? e.name : e.name.slice(0, i);
    if (first === null) first = t;
    else if (first !== t) return null;
    if (i >= 0 || e.folder) isFolder = true;
  }
  return first !== null && isFolder ? first : null;
}

/** PURE: the folder name for a ZIP without a parent folder — the file name without `.zip`, with the character rule of `managedPath`
 *  (`workspaces/git-auth.js` `slugify`). */
export function zipTargetName(fileName: string): string {
  const without = fileName.replace(/\.zip$/i, "");
  return without.trim().toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" }[c] as string))
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "unnamed";
}

const SIG_EOCD = 0x06054b50;
const SIG_LOC64 = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const COMMENT_MAX = 0xffff;

const count64 = (v: DataView, o: number) => {
  const n = v.getBigUint64(o, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("BROKEN", "Archive too large");
  return Number(n);
};

/** The central directory of an archive of size `size`. Throws `ZipError`. */
export async function readZipDirectory(size: number, read: Reader): Promise<ZipDirectory> {
  if (size < EOCD_MIN) throw new ZipError("NO_ZIP", "This is not a ZIP file.");
  const tailFrom = Math.max(0, size - (EOCD_MIN + COMMENT_MAX));
  const tail = await read(tailFrom, size);
  const sv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let ep = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (sv.getUint32(i, true) === SIG_EOCD) { ep = i; break; }
  }
  if (ep < 0) throw new ZipError("NO_ZIP", "This is not a ZIP file (no directory at the end).");
  const eocdLocation = tailFrom + ep;
  let disk = sv.getUint16(ep + 4, true);
  let cdDisk = sv.getUint16(ep + 6, true);
  let cdSize = sv.getUint32(ep + 12, true);
  let cdDeclared = sv.getUint32(ep + 16, true);
  let endLocation = eocdLocation; // Where the directory ends: at the ZIP64 end set if there is one, otherwise at the EOCD.

  // ZIP64: the locator stands directly before the EOCD. Like `zipfile` it always reads it if it is there.
  if (eocdLocation >= 20) {
    const loc = eocdLocation - 20 >= tailFrom ? tail.subarray(ep - 20, ep) : await read(eocdLocation - 20, eocdLocation);
    const lv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
    if (lv.getUint32(0, true) === SIG_LOC64) {
      if (lv.getUint32(16, true) > 1) throw new ZipError("MULTIPART", "Multi-part archives are not supported.");
      const location64 = eocdLocation - 20 - 56;
      if (location64 < 0) throw new ZipError("BROKEN", "ZIP64 directory missing");
      const e64 = await read(location64, location64 + 56);
      const v = new DataView(e64.buffer, e64.byteOffset, e64.byteLength);
      if (v.getUint32(0, true) !== SIG_EOCD64) throw new ZipError("BROKEN", "ZIP64 directory missing");
      disk = v.getUint32(16, true);
      cdDisk = v.getUint32(20, true);
      cdSize = count64(v, 40);
      cdDeclared = count64(v, 48);
      endLocation = location64;
    }
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError("MULTIPART", "Multi-part archives are not supported.");
  // Like `zipfile`: the directory lies directly before its end record — so it also fits with prepended data.
  const cdLocation = endLocation - cdSize;
  if (cdLocation < 0) throw new ZipError("BROKEN", "Invalid directory");
  const cd = await read(cdLocation, endLocation);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  // Prepended data (self-extracting archives) shifts every header by the same amount — like `zipfile` `concat`.
  const shift = cdLocation - cdDeclared;

  const entries: ZipEntry[] = [];
  const unsafe: string[] = [];
  const encrypted: string[] = [];
  const encoding: string[] = [];
  let o = 0;
  while (o < cd.length) {
    if (o + 46 > cd.length || cv.getUint32(o, true) !== SIG_CD) throw new ZipError("BROKEN", "Invalid directory");
    const flags = cv.getUint16(o + 8, true);
    const method = cv.getUint16(o + 10, true);
    let compressed = cv.getUint32(o + 20, true);
    let sizeU = cv.getUint32(o + 24, true);
    const nameLen = cv.getUint16(o + 28, true);
    const extraLen = cv.getUint16(o + 30, true);
    const commentLen = cv.getUint16(o + 32, true);
    const extern = cv.getUint32(o + 38, true);
    let header = cv.getUint32(o + 42, true);
    const nameRaw = cd.subarray(o + 46, o + 46 + nameLen);
    // ZIP64 addition (0x0001): only the fields that are 0xFFFFFFFF in the header, in fixed order.
    let x = o + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd && x + 4 <= cd.length) {
      const id = cv.getUint16(x, true);
      const len = cv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        const fEnd = Math.min(x + 4 + len, cd.length);
        if (sizeU === 0xffffffff && f + 8 <= fEnd) { sizeU = count64(cv, f); f += 8; }
        if (compressed === 0xffffffff && f + 8 <= fEnd) { compressed = count64(cv, f); f += 8; }
        if (header === 0xffffffff && f + 8 <= fEnd) { header = count64(cv, f); f += 8; }
      }
      x += 4 + len;
    }
    o += 46 + nameLen + extraLen + commentLen;
    const raw = decodeZipName(nameRaw, (flags & 0x800) !== 0);
    if (raw === null) { if (encoding.length < 5) encoding.push(new TextDecoder().decode(nameRaw)); continue; }
    const full = zipNormal(raw);
    if (full === null) continue;
    if (zipNameUnsafe(full)) { if (unsafe.length < 5) unsafe.push(full); continue; }
    const folder = full.endsWith("/");
    const name = folder ? full.slice(0, -1) : full;
    if (flags & 1) { if (encrypted.length < 5) encrypted.push(name); }
    entries.push({
      name, folder, size: sizeU, compressed, method, encrypted: (flags & 1) !== 0,
      reference: ((extern >>> 16) & 0o170000) === 0o120000, header: header + shift,
    });
  }
  const denied = unsafe.length ? { reason: "unsafe" as const, names: unsafe }
    : encoding.length ? { reason: "encoding" as const, names: encoding }
    : encrypted.length ? { reason: "encrypted" as const, names: encrypted }
    : null;
  return { entries, parentFolder: zipParentFolder(entries), denied };
}

/** The content of a small entry (stored or deflate, at most `max` bytes) as text — for `.git` files. `null` = not
 *  readable (too large, encrypted, other method, broken). */
export async function readSmallEntry(e: ZipEntry, read: Reader, max = 4096): Promise<string | null> {
  // A negative header (the directory names a larger offset than it has): `slice` would read from the end — not readable.
  if (e.encrypted || e.folder || e.header < 0 || e.size > max || e.compressed > max * 2 + 64) return null;
  try {
    const k = await read(e.header, e.header + 30);
    const kv = new DataView(k.buffer, k.byteOffset, k.byteLength);
    if (k.length < 30 || kv.getUint32(0, true) !== SIG_LOCAL) return null;
    const from = e.header + 30 + kv.getUint16(26, true) + kv.getUint16(28, true);
    const data = await read(from, from + e.compressed);
    let raw: Uint8Array;
    if (e.method === 0) raw = data;
    else if (e.method === 8 && typeof DecompressionStream === "function") {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
      raw = new Uint8Array(await new Response(stream).arrayBuffer());
    } else return null;
    return new TextDecoder().decode(raw.subarray(0, max));
  } catch {
    return null;
  }
}
