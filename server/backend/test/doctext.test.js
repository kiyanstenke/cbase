// doctext.js as a unit: pdfImages, pdfPageCount, without a server.
import assert from "node:assert/strict";
import test from "node:test";
import * as doctext from "../electron/server/doctext.js";
import { pdfImages, pdfPageCount } from "../electron/server/doctext.js";

// The file carries only what the providers call. COUNTER-TEST: re-adding another export (extractDocText, sniffMime,
// ooxmlImages, …) to doctext.js turns this red.
test("doctext.js exports only pdfImages and pdfPageCount", () => {
  assert.deepEqual(Object.keys(doctext).sort(), ["pdfImages", "pdfPageCount"]);
});

/**
 * `pdfImages` is the fallback for providers that do not accept a PDF as a document.
 *
 * A `DCTDecode` stream IS a JPEG file, byte for byte: it is cut out, not decoded. The test proves exactly the cutting
 * and filtering, so the body is deliberately no decodable image but a JPEG SIGNATURE plus filler.
 */
test("pdfImages extracts embedded raster images: DCTDecode yes, the rest no", () => {
  // Deterministic filler: it must not contain "endstream" by chance, or the parser would cut inside the image.
  // A fixed LCG makes that verifiable instead of probable.
  let seed = 4711;
  const fill = (n) => Buffer.from(Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 16) & 0xff;
  }));
  const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fill(n)]);
  const obj = (seq, dict, data) => Buffer.concat([
    Buffer.from(`${seq} 0 obj << ${dict} /Length ${data.length} >> stream\n`, "latin1"),
    data, Buffer.from("\nendstream endobj\n", "latin1"),
  ]);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.5\n", "latin1"),
    obj(1, "/Subtype /Image /Filter /DCTDecode /Width 800 /Height 600", jpeg(20000)),
    // A logo below the decoration threshold: same file, says nothing, costs tokens.
    obj(2, "/Subtype /Image /Filter /DCTDecode /Width 16 /Height 16", jpeg(500)),
    // FlateDecode would be a RAW bitmap: without colour space, bit depth and palette no image a model could look at.
    // Left out on purpose.
    obj(3, "/Subtype /Image /Filter /FlateDecode /Width 800 /Height 600", fill(20000)),
    // Claims DCTDecode but carries no JPEG: the signature decides. A block with a wrong media_type is rejected by the
    // API, and the whole call with it.
    obj(4, "/Subtype /Image /Filter /DCTDecode", fill(20000)),
    // A content stream is no image.
    obj(5, "/Type /XObject /Subtype /Form", fill(20000)),
    Buffer.from("%%EOF\n", "latin1"),
  ]);
  const images = pdfImages(pdf);
  assert.equal(images.length, 1, `only the real image: ${JSON.stringify(images.map((b) => b.buffer.length))}`);
  assert.equal(images[0].mime, "image/jpeg");
  assert.equal(images[0].buffer.length, 20004, "the bytes are cut out unchanged");
  assert.equal(images[0].buffer.subarray(0, 3).toString("hex"), "ffd8ff");
  // No PDF, no throw: the caller decides what to do with an empty result.
  assert.deepEqual(pdfImages(Buffer.from("not a pdf")), []);
  assert.deepEqual(pdfImages(null), []);
});

test("pdfPageCount: the LARGER estimator wins, 0 means unknown", () => {
  // (a) Classic layout: the page objects are in plain text.
  const two = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >> endobj\n"
    + "2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF");
  assert.equal(pdfPageCount(two), 2);
  // (b) Object streams (PDF 1.5+, the normal case today) hide the page objects, so /Count alone carries. Taking the
  // smaller estimator would count 120 pages as none and send a manual to the model as a document block.
  const many = Buffer.from("%PDF-1.6\n7 0 obj << /Type /ObjStm /N 42 >> stream\n…\nendstream endobj\n"
    + "9 0 obj << /Count 120 >> endobj\n%%EOF");
  assert.equal(pdfPageCount(many), 120, "/Count carries when /Type /Page sits in the object stream");
  // (c) No PDF: 0 means UNKNOWN. The caller then decides by file size instead of checking a guessed number against a cap.
  assert.equal(pdfPageCount(Buffer.from("hello")), 0);
  assert.equal(pdfPageCount(null), 0);
});
