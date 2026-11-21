// The approval marks of the built-in cbase tools per workspace (key `approval.cbase.<wid>`): which tool an agent may run only
// after the human approved. The mark belongs to the workspace, not to the choice per agent — it applies to everyone who chose
// the tool (an outer-loop run omits a marked tool, outerloop/set.js).
//
// What counts as a name is the caller's call (`allowed`): the coding route takes the tools of the coding catalog
// (toolchain/tool-catalog.js CODING_TOOLS), the outer loop its selectable ones (outerloop/catalog.js). Whoever sets replaces
// only the names of ITS set — marks outside stay. Route: GET/PUT /api/workspaces/:id/approval-marks (toolchain/routes.js).
// Deletion: store/workspaces.js (every setting ending in `.<wid>`).

import * as store from "../store.js";
import { T } from "../i18n.js";
import { CODING_TOOLS } from "./tool-catalog.js";

export const APPROVAL_KEY = (wid) => `approval.cbase.${wid}`;
/** The markable tools of the coding side, in catalog order. */
export const MARKABLE = Object.freeze(CODING_TOOLS.filter((t) => String(t).startsWith("cbase_")));
const MARKABLE_SET = new Set(MARKABLE);

/** All saved names (unreadable = none). */
function saved(wid) {
  try {
    const v = JSON.parse(store.getSetting(APPROVAL_KEY(wid), "[]") || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/** The marks of a workspace, restricted to `allowed` (a set of tool names; default the coding tools). */
export function approvalMarks(wid, allowed = MARKABLE_SET) {
  return saved(wid).filter((t) => allowed.has(t));
}

/**
 * Sets the marks within `allowed` to `tools`; marks outside stay. Throws 400 for a missing list or a name outside `allowed`.
 * → the marks within `allowed`, in input order.
 */
export function setApprovalMarks(wid, tools, allowed = MARKABLE_SET) {
  const error = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
  if (!Array.isArray(tools)) error(T("tools: list of tool names required"));
  const names = [...new Set(tools.map((x) => String(x).trim()).filter(Boolean))];
  const unknown = names.find((n) => !allowed.has(n));
  if (unknown) error(T`Unknown cbase tool: ${unknown}`);
  const outside = saved(wid).filter((t) => !allowed.has(t));
  store.setSetting(APPROVAL_KEY(wid), JSON.stringify([...outside, ...names]));
  return names;
}
