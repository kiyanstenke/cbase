// The ONE rule for a port override in a start command (relocation step 9). A leaf without imports — plan.js (which service has an
// override, which default a start script names) and data.js (what the return path takes out of the command) compute with the SAME
// rule. Before, there were two: plan.js read `-p 3100:3000` (docker) with `\b` as an override of 3100, data.js did not — and neither
// saw an override in quotation marks (`sh -c "next dev -p 3100"`, `bash -lc 'npm run dev -- --port=3100'`).
//
//   OVERRIDE                       the rule: `-p N`, `--port N`, `--port=N`, `[X_]PORT=N`. Before it the start, a space or a quotation
//                                  mark; after it a space, a quotation mark, the end or `;`, `&`, `|`, `)`. A `-p 3100:3000` (docker),
//                                  a `-p 3100/tcp` is none. A `ssh -p 2222` on the other hand is one — whoever means only the port of ONE
//                                  service filters on its registered port (plan.js, data.js).
//   overriddenPorts(command)     → the port numbers of the overrides, ascending.
//   withoutPortOverride(command, ports?)  → the command without the overrides (only THESE numbers if `ports` is a list); if it removes
//                                  nothing, the command comes back byte-equal (also its spaces). If it removes something, ONLY the
//                                  whitespace at that place shrinks to one space — every other, also in quotation marks, stays
//                                  byte-equal. A leftover `--` at the end (also before the closing quotation mark) falls with it.
//   portStillInCommand(command, port) → whether the number still stands as a whole number in the command (`-p 3100:3000` yes, `31000`
//                                  no) — the return path sets the field `port` back to the default only if none of the old ports remains.
// Guards: server/backend/test/relocation-data.test.js (8), (15), (16), (20); server/backend/test/relocation-plan.test.js "port return path".

const END = "(?=[\\s\"']|$|[;&|)])";
/** The rule (see header): group 1 = what stood before it, group 2 = the port number. */
export const OVERRIDE = Object.freeze([
  new RegExp(`(^|[\\s"'])(?:-p|--port)(?:\\s+|=)(\\d{2,5})${END}`, "g"),
  new RegExp(`(^|[\\s"'])(?:[A-Z][A-Z0-9_]*_)?PORT=(\\d{2,5})${END}`, "g"),
]);
const QUOTE = /["']/;
// A marker in the text: "the whitespace after it falls too" (a hit directly behind an opening quotation mark).
const MARKER = "\u0000";
// The marker of a gap — "an override stood here behind whitespace". ONLY the whitespace around such a gap shrinks to ONE space.
// Otherwise the return path would merge every double whitespace in the whole command, also in quotation marks (`--title "x  y"` ⇒
// `"x y"`) — and the result is stored permanently.
const GAP = "\u0001";

/** PURE: the port numbers of the overrides of a start command (see header), ascending. */
export function overriddenPorts(command) {
  const out = new Set();
  for (const re of OVERRIDE) {
    for (const m of String(command ?? "").matchAll(re)) { const n = Number(m[2]); if (n >= 1 && n <= 65535) out.add(n); }
  }
  return [...out].sort((a, b) => a - b);
}

/** PURE: a start command without a port override (see header). */
export function withoutPortOverride(command, ports = null) {
  const only = Array.isArray(ports) ? new Set(ports.filter(Number.isInteger)) : null;
  const one = String(command ?? "");
  const markerAllowed = !one.includes(MARKER) && !one.includes(GAP);
  let removed = false;
  let s = one;
  for (const re of OVERRIDE) {
    s = s.replace(re, (hits, before, n, off, whole) => {
      if (only && !only.has(Number(n))) return hits;
      removed = true;
      const to = whole[off + hits.length] ?? "";
      if (QUOTE.test(before)) return markerAllowed ? `${before}${MARKER}` : before; // `"-p 3100 next"` ⇒ `"next"`
      if (QUOTE.test(to)) return ""; // `next dev -p 3100"` ⇒ `next dev"`
      return markerAllowed ? `${before}${GAP}` : before;
    });
  }
  if (!removed) return one;
  // Without markers (the command carried one itself — never in operation) the whitespace stays as it is: a double space between two
  // words bothers no shell, swallowing one inside quotation marks does.
  return s.replace(new RegExp(`${MARKER}(?:[ \\t]|${GAP})*`, "g"), "")
    .replace(new RegExp(`[ \\t]*(?:${GAP}[ \\t]*)+`, "g"), " ").trim()
    .replace(/(^|\s)--$/, "").replace(/\s--(?=["'])/g, "")
    .trim();
}

/** PURE: does `port` still stand as a whole number in the command (see header)? */
export function portStillInCommand(command, port) {
  if (!Number.isInteger(port)) return false;
  return new RegExp(`(^|[^0-9])${port}(?![0-9])`).test(String(command ?? ""));
}
