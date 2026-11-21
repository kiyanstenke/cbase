// Width and height of an image attachment from its file header. An image in the user bubble reserves no space until it has
// loaded and then grows by its full height — the history then sits exactly that far above the end. With `w`/`h` in the
// attachment meta the client sets the aspect ratio BEFORE loading (web ChatBubbleRow, iOS via the same fields); without them
// the old behaviour applies.
//
// ONLY the header is read (PNG IHDR, GIF logical screen, WebP VP8/VP8L/VP8X, JPEG SOFn including the EXIF rotation) — no new
// dependency, no decoding. A JPEG capture from a phone almost always carries EXIF rotation 6 or 8: the browser shows it rotated
// (`image-orientation: from-image`), so width and height are swapped in the meta — otherwise the client would reserve a
// landscape box for a portrait image. Anything not clearly readable yields `null` (empty is not unknown: no guessed size).
// A leaf with `node:fs`.
import fs from "node:fs";

const MASS_MAX = 100_000; // anything larger is not an image but a broken header
// How far a file is read: a JPEG's SOF comes after the APP segments (EXIF up to 64 KiB, plus ICC profiles) — 512 KiB catch
// everything a phone or a screenshot writes; whatever starts beyond that gets no dimensions.
const HEADER_MAX = 512 * 1024;
const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp)$/i;

const gut = (w, h) => (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= MASS_MAX && h <= MASS_MAX ? { w, h } : null);

function png(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return gut(b.readUInt32BE(16), b.readUInt32BE(20));
}

function gif(b) {
  if (b.length < 10 || !/^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return null;
  return gut(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webp(b) {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8 ") {
    // Frame header: 3-byte frame tag, start code 9d 01 2a, then 14 bits each of width and height (the top 2 bits are the scale).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return gut(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return gut((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (kind === "VP8X") return gut(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return null;
}

// The EXIF rotation (tag 0x0112) from an APP1 segment: 1–8, or 0 if none is readable.
function exifRotation(b, start, end) {
  if (end - start < 14 || b.toString("latin1", start, start + 6) !== "Exif\0\0") return 0;
  const t = start + 6; // TIFF header
  const ii = b.toString("latin1", t, t + 2);
  if (ii !== "II" && ii !== "MM") return 0;
  const u16 = (o) => (ii === "II" ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (ii === "II" ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 0;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}

function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  let rotation = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xff) { o += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; } // no length
    const length = b.readUInt16BE(o + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && !rotation) rotation = exifRotation(b, o + 4, Math.min(b.length, o + 2 + length));
    // SOF0…SOF15 except DHT (c4), JPG (c8), DAC (cc): height and width are there.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 9 > b.length) return null;
      const h = b.readUInt16BE(o + 5);
      const w = b.readUInt16BE(o + 7);
      return rotation >= 5 ? gut(h, w) : gut(w, h); // 5–8: displayed rotated by 90°
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data or end before any SOF
    o += 2 + length;
  }
  return null;
}

/** A file name whose header `imageDimensions` reads (png, jpg/jpeg, gif, webp). */
export const isImageName = (name) => IMAGE_SUFFIX.test(String(name || ""));

/** Width and height from an image's header (PNG, JPEG, GIF, WebP) → `{ w, h }` or `null`. Never throws. */
export function imageDimensions(buf) {
  try {
    if (!Buffer.isBuffer(buf)) return null;
    return png(buf) || jpeg(buf) || gif(buf) || webp(buf) || null;
  } catch { return null; }
}

/** The same for a stored file (a message's attachment is re-described from the attachment folder, runs/routes.js): image
 *  suffixes only, a REGULAR file only (O_NOFOLLOW|O_NONBLOCK — a symlink or a FIFO in the attachment's place neither stalls the
 *  server nor leads outside), at most `HEADER_MAX` bytes. → `{ w, h }` or `null`. Never throws. */
export function imageDimensionsFromFile(path) {
  if (!IMAGE_SUFFIX.test(String(path))) return null;
  let fd;
  try {
    fd = fs.openSync(String(path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(HEADER_MAX);
    const n = fs.readSync(fd, buf, 0, HEADER_MAX, 0);
    return imageDimensions(buf.subarray(0, n));
  } catch { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** The attachment meta extended by `w`/`h` if they can be read — otherwise unchanged (no field, no placeholder). */
export const withImageDimensions = (meta, dimensions) => (dimensions ? { ...meta, w: dimensions.w, h: dimensions.h } : meta);
