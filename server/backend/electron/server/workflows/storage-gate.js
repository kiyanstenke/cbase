// The save gate of graph workflows in the background. A leaf: it reads only the file system (plus the language switch
// from i18n.js, itself a leaf without imports). There is no numeric cap on parallel background runs — instead a NEW run
// waits while memory is scarce and starts by itself (workflows/graph-start.js redeem, `waiting_storage`; the tick
// and the wakeup ask again).
//
// storageSituation({ read })  the situation NOW, read at runtime (never stored):
//   Container  `<root>/sys/fs/cgroup/memory.max` and `…/memory.current` (cgroup v2, readable inside the user container).
//              `max` (no limit), a missing or unreadable file, a number ≤ 0 ⇒ this part is OFF.
//              Measured is OCCUPIED = `memory.current − inactive_file` (from `…/memory.stat`, the "working set" of
//              cAdvisor/kubelet): `memory.current` includes the page cache, which the kernel only releases under
//              pressure — a single large copy would otherwise keep the gate shut at 10 % real demand, and nothing can
//              be released from inside the container. If `memory.stat` or its `inactive_file` line is missing,
//              `memory.current` counts as is (never "off"); more cache than current ⇒ 0.
//   Host       `<root>/proc/meminfo` (`MemTotal`, `MemAvailable`, kB — under Sysbox it shows the HOST). If the file or
//              one of the two values is missing ⇒ this part is OFF.
//   If both are off (a plain Mac), the gate is free. `<root>` is `CBASE_STORAGE_ROOT` (default empty = `/`) — the
//   variable makes the gate testable. `read(path)` replaces the reading (unit test); if it throws, the file is missing.
//   Returns `{ free, reason, container: {current, inactiveFile, occupied, max, share} | null, host: {available, total,
//   share} | null }` — bytes, `inactiveFile` `null` without memory.stat, `share` = occupied / max as a fraction; the
//   reason names OCCUPIED, never current (otherwise 99 % would stand next to an open gate). Not free: container ABOVE
//   80 % of its limit (`CONTAINER_SHARE_MAX`) or host BELOW 20 % free (`HOST_FREE_MIN`); exactly on the limit is free.
//   If both apply, `reason` names the container.

import fs from "node:fs";
import { T } from "../i18n.js";

const CONTAINER_SHARE_MAX = 0.8;
const HOST_FREE_MIN = 0.2;
const GIB = 1024 ** 3;

const read = (p) => fs.readFileSync(p, "utf8");

// A file as text — `null` when it is missing or the reader throws.
function text(read2, path) {
  try {
    const t = read2(path);
    return typeof t === "string" ? t : null;
  } catch { return null; }
}

// A positive integer from a cgroup file; "max", empty, broken or ≤ 0 ⇒ null.
function bytes(t) {
  const s = String(t ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A field from memory.stat ("inactive_file 1234", bytes) — missing or broken ⇒ null. The line must match ENTIRELY:
// `total_inactive_file` (cgroup v1) is a different field.
function statField(t, name) {
  const m = new RegExp(`^${name} (\\d+)$`, "m").exec(String(t ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// A field from /proc/meminfo ("MemAvailable:  1234 kB") in bytes; missing ⇒ null.
function meminfoField(t, name) {
  const m = new RegExp(`^${name}:\\s*(\\d+)\\s*kB\\s*$`, "m").exec(String(t ?? ""));
  if (!m) return null;
  const n = Number(m[1]) * 1024;
  return Number.isFinite(n) ? n : null;
}

// Rounded, but never onto the limit: "above 80 %" shows at least 81, "below 20 %" at most 19.
const percent = (share) => Math.round(share * 100);
const gib = (n) => (n / GIB).toFixed(1).replace(".", T(".##decimal"));

function storageSituation({ read: read2 = read } = {}) {
  const root = String(process.env.CBASE_STORAGE_ROOT || "").replace(/\/+$/, "");
  const max = bytes(text(read2, `${root}/sys/fs/cgroup/memory.max`));
  const current = max === null ? null : bytes(text(read2, `${root}/sys/fs/cgroup/memory.current`));
  const inactiveFile = current === null ? null : statField(text(read2, `${root}/sys/fs/cgroup/memory.stat`), "inactive_file");
  const occupied = current === null ? null : inactiveFile === null ? current : Math.max(0, current - inactiveFile);
  const container = max !== null && current !== null ? { current, inactiveFile, occupied, max, share: occupied / max } : null;
  const meminfo = text(read2, `${root}/proc/meminfo`);
  const total = meminfo === null ? null : meminfoField(meminfo, "MemTotal");
  const available = meminfo === null ? null : meminfoField(meminfo, "MemAvailable");
  const host = total && available !== null ? { available, total, share: available / total } : null;

  let reason = "";
  if (container && container.share > CONTAINER_SHARE_MAX) {
    const p = Math.max(percent(container.share), percent(CONTAINER_SHARE_MAX) + 1);
    reason = T`waiting for memory: container at ${p} % of its limit (${gib(occupied)} of ${gib(max)} GiB)`;
  } else if (host && host.share < HOST_FREE_MIN) {
    const p = Math.min(percent(host.share), percent(HOST_FREE_MIN) - 1);
    reason = T`waiting for memory: host has only ${p} % free`;
  }
  return { free: !reason, reason, container, host };
}

export { CONTAINER_SHARE_MAX, HOST_FREE_MIN, storageSituation };
