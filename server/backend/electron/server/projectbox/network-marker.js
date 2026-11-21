// The marker of the network separation, backend side. A leaf, only `node:fs` and `node:path`.
//
// At EVERY start of the user container server/backend/entry.sh sets as root the INPUT allow list for the bridges `cbp-*` (chain
// CBASE-PROJ) and, if that succeeded, writes /run/cbase/network-separation.ok with the start time of PID 1 OF THIS container start
// (field 22 of /proc/1/stat). The container file system survives `docker start`/`restart` — a marker from the previous start is cleared
// by entry.sh, but one that another path laid down or that an earlier state left standing must not be read as "the separation
// stands". So the marker counts ONLY if its content matches the running PID 1; any other (missing, empty, foreign start time, /proc
// unreadable) counts as missing.
//
// Who asks: the creation and the start of an instance — without a valid marker no project container, the backend keeps running. This
// leaf decides nothing about operations (projectbox/ops.js), it only reads. `root` is the test seam (the same role as
// CBASE_ENTRY_ROOT in entry.sh); empty in the product.
import fs from "node:fs";
import path from "node:path";

export const NETWORK_MARKER = "/run/cbase/network-separation.ok";
const PID1_STAT = "/proc/1/stat";

// Field 22 (starttime), counted after the LAST `)`: the command name in field 2 may carry parentheses and spaces. Field 3 begins after
// the `)`, so field 22 is the twentieth there. The same computation as `pid1_start` in entry.sh.
export function startTimeFromStat(text) {
  const s = String(text ?? "");
  const i = s.lastIndexOf(")");
  if (i < 0) return null;
  const fields = s.slice(i + 1).trim().split(/\s+/);
  const f = fields[19];
  return f && /^\d+$/.test(f) ? f : null;
}

// { valid, reason, marker, start } — `reason` ∈ "ok" | "missing" | "empty" | "stat-unreadable" | "foreign-start".
export function networkSeparation({ root = "" } = {}) {
  const markerPath = path.join(root || "/", NETWORK_MARKER);
  let marker;
  try {
    marker = fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    return { valid: false, reason: "missing", marker: null, start: null };
  }
  if (!marker) return { valid: false, reason: "empty", marker, start: null };
  let start = null;
  try {
    start = startTimeFromStat(fs.readFileSync(path.join(root || "/", PID1_STAT), "utf8"));
  } catch {}
  if (!start) return { valid: false, reason: "stat-unreadable", marker, start: null };
  if (marker !== start) return { valid: false, reason: "foreign-start", marker, start };
  return { valid: true, reason: "ok", marker, start };
}
