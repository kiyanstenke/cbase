// PDF helpers of the providers — without dependencies (providers/engine.js, providers/tool-runtime.js): the page count of a
// PDF as a cap and the embedded JPEG images as a fallback for providers without a document block.
// The file name stays (the root files of the backend name it).

// The signature of a JPEG (FF D8 FF) — the cross-check in pdfImages whether a DCTDecode stream really carries one.
const isJpeg = (b) => Buffer.isBuffer(b) && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// ── PDF ──────────────────────────────────────────────────────────────────────
// Approach without the xref table (in incrementally saved files it exists several times and is partly encoded as a
// stream): collect ALL "N G obj … endobj". That is more robust than the formal way and exactly what is needed here.
function pdfObjects(buffer) {
  const objects = new Map(); // "num gen" → { dict, stream }
  const text = buffer.toString("latin1");
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(text))) {
    const start = re.lastIndex;
    const end = text.indexOf("endobj", start);
    if (end < 0) break;
    const bodyText = text.slice(start, end);
    const streamAt = bodyText.indexOf("stream");
    let dict = bodyText;
    let stream = null;
    if (streamAt >= 0) {
      dict = bodyText.slice(0, streamAt);
      // After "stream" comes CRLF or LF, then the raw data.
      let dataStart = start + streamAt + "stream".length;
      if (text[dataStart] === "\r") dataStart += 1;
      if (text[dataStart] === "\n") dataStart += 1;
      const dataEnd = text.indexOf("endstream", dataStart);
      if (dataEnd >= 0) stream = buffer.subarray(dataStart, dataEnd);
    }
    objects.set(`${match[1]} ${match[2]}`, { dict, stream });
  }
  return objects;
}

/**
 * Page count of a PDF, as well as it goes without a library — as a CAP, not as a statement.
 *
 * It is needed because a PDF costs the model text AND image per page (~1,500–3,000 tokens): sending a 200-page manual as a
 * document block blows the window, a two-page contract with a diagram is exactly the case it is built for.
 *
 * Two independent estimators, and the LARGER one counts. Neither carries alone: `/Type /Page` is missing when the objects
 * sit in an object stream (PDF 1.5+, the normal case today), and `/Count` is missing in broken or linearized page trees.
 * Whoever takes the smaller one takes a 200-page document for a single page — and exactly that mistake is the expensive one.
 *
 * `0` explicitly means **unknown**, not "no page": the caller then decides by file size, instead of checking a guessed
 * number against a cap.
 */
export function pdfPageCount(buffer) {
  const s = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : "";
  const types = (s.match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return Math.max(types, 0, ...counts);
}

/**
 * The RASTER IMAGES embedded in the PDF — the fallback for providers without a document block.
 *
 * Only an API with a `document` block can look at a PDF as a whole. Whoever cannot, but can look at images, gets at least
 * what lies as an image IN the PDF through this: scans, photos, exported charts. This is explicitly **no substitute** — a
 * diagram drawn from lines and text (vector) lies in no image object and stays invisible. The caller must be able to say
 * that in the prompt, which is why an empty result here is a statement and not an error.
 *
 * Only `DCTDecode`, and that is the trick: such a stream IS a JPEG file, byte for byte — it is cut out, not decoded. Other
 * filters would be real work: `FlateDecode` yields a raw bitmap that would first have to be encoded to a PNG with color
 * space, bit depth and palette, and no model can look at `JPXDecode` (JPEG 2000) and `CCITTFaxDecode` anyway. For the
 * purpose — making scans visible — DCTDecode carries practically everything.
 */
export function pdfImages(buffer, { max = 8, maxBytes = 3_500_000, minBytes = 3000 } = {}) {
  if (!Buffer.isBuffer(buffer)) return [];
  let objects;
  try { objects = pdfObjects(buffer); } catch { return []; }
  const out = [];
  // Order = order in the data stream, i.e. roughly page order. A real assignment would sit in the resources of the
  // respective page; for "show me what is inside" that is more machinery than benefit.
  for (const entry of objects.values()) {
    if (out.length >= max) break;
    if (!entry?.stream) continue;
    if (!/\/Subtype\s*\/Image\b/.test(entry.dict)) continue;
    if (!/\/DCTDecode\b/.test(entry.dict)) continue;
    // `/Length` is the only reliable boundary of the stream. `pdfObjects` cuts up to the word "endstream", and in between
    // there is, per the specification, a line break that does NOT belong to the data — a JPEG with one appended byte is
    // usually still readable, but "usually" is no measure for a contract that rejects blocks. If the value is missing
    // (indirect reference `/Length 12 0 R`), only the line break is cut off.
    const length = Number((entry.dict.match(/\/Length\s+(\d+)\s*(?:\/|>>|$)/) || [])[1]);
    let bytes = entry.stream;
    if (Number.isFinite(length) && length > 0 && length <= bytes.length) bytes = bytes.subarray(0, length);
    else while (bytes.length && (bytes[bytes.length - 1] === 0x0a || bytes[bytes.length - 1] === 0x0d)) bytes = bytes.subarray(0, bytes.length - 1);
    if (bytes.length < minBytes || bytes.length > maxBytes) continue;
    // Cross-check on the signature: an object can claim /DCTDecode and carry something else (encrypted file, broken stream).
    // A block with a wrong media_type is rejected by the API — for the whole call, not just for this image.
    if (!isJpeg(bytes)) continue;
    out.push({ name: `Image ${out.length + 1} from the PDF`, mime: "image/jpeg", buffer: bytes });
  }
  return out;
}
