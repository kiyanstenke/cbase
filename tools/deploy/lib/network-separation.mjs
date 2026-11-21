// The "network separation" row of `./deploy status` per user container. Pure calculation over the output of ONE
// `docker exec -u 0` (command `networkSeparationCommand`), no ssh here.
//
// server/backend/entry.sh sets the chain CBASE-PROJ as root on every start of B (conntrack RELATED,ESTABLISHED → ACCEPT,
// tcp 7718 → ACCEPT, tcp → REJECT tcp-reset) and exactly ONE jump `-A INPUT -i cbp-+ -j CBASE-PROJ`, and then writes
// /run/cbase/network-separation.ok with the start time of PID 1. The row says whether both hold for THIS start. Before
// the first deploy with it both are missing — "warn", not "bad": without project containers the chain protects
// nothing yet, it only has to stand before the first one is created (project creation refuses without a valid marker).
//
// The start time is computed as in entry.sh (`pid1_start`) and projectbox/network-marker.js (`startTimeFromStat`) —
// three versions of the same rule, bound in tools/deploy/network-separation.ops.test.mjs.
//
// The bridge prefix comes from the ONE place (projectbox/creation.js BRIDGE_PREFIX, `cbp-`). A jump over the old bridge prefix
// is "bad": entry.sh of this release no longer sets it, so a B that shows it runs an older image.
import { BRIDGE_PREFIX } from "../../../server/backend/electron/server/projectbox/creation.js";

export const NETWORK_CHAIN = "CBASE-PROJ";
/** The interface match of the jump: `-i cbp-+`. */
export const BRIDGE_MATCH = `-i ${BRIDGE_PREFIX}+`;

const PARTS = ["CHAIN", "INPUT", "MARKER", "STAT"];

// No single quotes in the script: it sits in `sh -c '…'` behind ssh.
export function networkSeparationCommand(container) {
  const script = [
    `echo "--- CHAIN"; iptables -S ${NETWORK_CHAIN} 2>&1`,
    `echo "--- INPUT"; iptables -S INPUT 2>&1`,
    `echo "--- MARKER"; cat /run/cbase/network-separation.ok 2>&1`,
    `echo "--- STAT"; cat /proc/1/stat 2>&1`,
  ].join("; ");
  return `docker exec -u 0 ${container} sh -c '${script}' 2>&1 || true`;
}

export function startTimeFromStat(text) {
  const s = String(text ?? "");
  const i = s.lastIndexOf(")");
  if (i < 0) return null;
  const f = s.slice(i + 1).trim().split(/\s+/)[19];
  return f && /^\d+$/.test(f) ? f : null;
}

function parts(output) {
  const out = {};
  let now = null;
  for (const z of String(output ?? "").split("\n")) {
    const m = /^--- (CHAIN|INPUT|MARKER|STAT)$/.exec(z.trim());
    if (m) { now = m[1]; out[now] = []; continue; }
    if (now) out[now].push(z);
  }
  return out;
}

// [label, text, stage] like the other rows of status.mjs.
export function networkSeparationRow(output) {
  const label = "Network separation (CBASE-PROJ)";
  const t = parts(output);
  if (!PARTS.every((k) => Array.isArray(t[k]))) return [label, "unknown (docker exec -u 0 returned nothing readable)", "warn"];
  const rules = t.CHAIN.map((z) => z.trim()).filter((z) => z.startsWith(`-A ${NETWORK_CHAIN} `));
  const chain = t.CHAIN.some((z) => z.trim() === `-N ${NETWORK_CHAIN}`);
  const jumps = t.INPUT.map((z) => z.trim()).filter((z) => z.startsWith("-A INPUT ") && z.endsWith(`-j ${NETWORK_CHAIN}`));
  if (!chain) return [label, "missing (the user container predates the chain — the next deploy recreates it)", "warn"];
  const findings = [];
  const desired = [
    (z) => /--ctstate RELATED,ESTABLISHED/.test(z) && / -j ACCEPT$/.test(z),
    (z) => / -p tcp\b/.test(z) && /--dport 7718\b/.test(z) && / -j ACCEPT$/.test(z),
    (z) => / -p tcp\b/.test(z) && /-j REJECT --reject-with tcp-reset$/.test(z),
  ];
  if (rules.length !== 3 || !desired.every((f, i) => f(rules[i]))) findings.push(`rules deviate (${rules.length}: ${rules.join(" | ") || "none"})`);
  if (jumps.length !== 1) findings.push(`jump ${jumps.length}× instead of 1×`);
  else if (!` ${jumps[0]} `.includes(` ${BRIDGE_MATCH} `)) findings.push(`jump without ${BRIDGE_MATCH} (${jumps[0]})`);
  if ([...rules, ...jumps].some((z) => z.includes("br-"))) findings.push("a rule names br-* (would cut off the current stacks)");
  const marker = t.MARKER.join("\n").trim();
  const start = startTimeFromStat(t.STAT.join("\n"));
  let markerText;
  if (!/^\d+$/.test(marker)) { markerText = "marker missing"; findings.push("marker missing"); }
  else if (!start) { markerText = "marker present, /proc/1/stat unreadable"; findings.push(markerText); }
  else if (marker !== start) { markerText = `marker from another start (${marker} ≠ ${start})`; findings.push(markerText); }
  else markerText = "marker valid";
  if (findings.length) return [label, findings.join("; "), "bad"];
  return [label, `in place (3 rules, jump 1× via ${BRIDGE_PREFIX}+, ${markerText})`, "ok"];
}
