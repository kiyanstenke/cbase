// The space check.
//
//   checkSlot(inst, root, bytes) → { ok: true, free, needed } | throws SlotError (code SLOT, status 409, free, needed)
//
// `df -B1 --output=avail <root>` IN the project container (B never measures in the mounted folder); rejected if `free − bytes <
// reserve` (./rules.js reserveBytes: default 5 GB, knob CBASE_SPACE_RESERVE_BYTES — the same number in the rules route and in every
// message). The check applies per operation and is NO reservation: `df` is the free space of the whole server, several sources,
// projects and users each check alone against the same disk. The backstop is ENOSPC. A `df` that does not answer or returns no number
// is an error (empty is not unknown) — never "then enough".
import { T } from "../../i18n.js";
import { commandRun } from "../../runtime/git-run.js";
import { reserveBytes } from "./rules.js";

export class SlotError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "SlotError";
    this.code = "SLOT";
    this.status = 409;
    Object.assign(this, fields);
  }
}

const gb = (n) => `${(n / 1e9).toFixed(1).replace(".", ",")} GB`;

/** Free space (bytes) at the place `root` in the container. */
export async function freeSlot(inst, root) {
  const r = await commandRun(inst, root, "df", ["-B1", "--output=avail", root]);
  const rows = String(r.stdout || "").trim().split("\n");
  const free = Number(String(rows[rows.length - 1] || "").trim());
  if (r.code !== 0 || !Number.isSafeInteger(free) || free < 0) {
    throw new SlotError(T`Free space could not be measured (df: ${String(r.stderr || "").trim().slice(0, 200) || T`exit ${r.code}`}).`, { free: null, needed: null });
  }
  return free;
}

export async function checkSlot(inst, root, bytes = 0) {
  const b = Number.isSafeInteger(Number(bytes)) && Number(bytes) > 0 ? Number(bytes) : 0;
  const reserve = reserveBytes();
  const free = await freeSlot(inst, root);
  const needed = b + reserve;
  if (free < needed) {
    throw new SlotError(T`Not enough space on the server's disk: ${gb(free)} free, ${gb(needed)} needed (${gb(b)} plus ${gb(reserve)} reserve).`, { free, needed });
  }
  return { ok: true, free, needed };
}
