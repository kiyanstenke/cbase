// The live measurement of the streamed browser. The client (BrowserPane with the measure switch: localStorage
// `cbase.browserMeasure` = "1" or `?measure=1` in the app's address) computes a summary from the frames' measurement points every
// ≈ 10 s and sends it to `POST /api/browsers/measurement`; B appends it as one row to `<data>/browser-measurement.jsonl`. The file is read
// by hand (ssh).
//
// Two caps, both here: a row at most ROW_MAX bytes (the numbers and short texts below — a client does not write anything
// arbitrary into it), the file at most FILE_MAX: above that the younger half stays, cut at a line boundary.
import fs from "node:fs";

export const ROW_MAX = 4096;
export const FILE_MAX = 1024 * 1024;

// The fields a summary may carry: numbers (finite, otherwise they are dropped) and a few short texts.
const COUNTS = [
  "duration_ms", "images", "fps", "kb_med", "kb_p90", "age_rel_med", "age_rel_p90", "b_intern_med", "chrome_b_med",
  "gap_med", "gap_p90", "bundle", "clicks", "click_med", "click_p90", "width_px", "height_px", "dpr", "rtt_med",
  "images_sharp", "images_smooth",
];
const TEXTS = { transport: 24, encoding: 32, browser: 40, client: 64 };

/** Sanitize a summary: only the known fields, numbers finite and rounded, texts shortened. */
export function sanitizeMeasurement(raw, now = Date.now()) {
  const o = raw && typeof raw === "object" ? raw : {};
  const e = { time: new Date(now).toISOString() };
  for (const k of COUNTS) { const n = Number(o[k]); if (o[k] !== undefined && o[k] !== null && Number.isFinite(n)) e[k] = Math.round(n * 10) / 10; }
  for (const [k, max] of Object.entries(TEXTS)) if (typeof o[k] === "string") e[k] = o[k].slice(0, max);
  return e;
}

/** Append a row (both caps). Returns the written row without the line ending. */
export function appendMeasurement(file, raw, { now = Date.now(), fileMax = FILE_MAX } = {}) {
  let row = JSON.stringify(sanitizeMeasurement(raw, now));
  if (Buffer.byteLength(row) > ROW_MAX) row = JSON.stringify({ time: new Date(now).toISOString(), tooBig: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new */ }
  if (size + row.length + 1 > fileMax) {
    // Keep the younger half, cut at the first line boundary behind it.
    let old = "";
    try { old = fs.readFileSync(file, "utf8"); } catch { /* gone */ }
    const rest = old.slice(Math.max(0, old.length - Math.floor(fileMax / 2)));
    const nl = rest.indexOf("\n");
    fs.writeFileSync(file, nl >= 0 ? rest.slice(nl + 1) : "");
  }
  fs.appendFileSync(file, `${row}\n`);
  return row;
}
