// The citations of old paths. Decision: ONLY list — nothing here replaces, writes or stores anything. Read only from the database of
// cbase (no access to the project folder).
//
//   collectCitations({ projectId, workspaceId, paths, cap })
//     → { list: [{ kind, name, field, row?, text?, secret?, path }], total, unreadable: [kind] }
//
// WHAT IS SEARCHED: every affected old path (relative to the root) as a WHOLE path part — before it start, `/`, whitespace or a
// separator (quotation marks, `=`, `:`, `(`, `[`, `{`, `<`, `,`, `;`, `|`, `&`), after it end, `/`, whitespace or a separator (the same
// and `)`, `]`, `}`, `>`). An absolute path `<project>/<old>` ends on `/<old>` and is found with it. The other separators were added
// because `cd apps/x;` or `--dir=apps/x` would otherwise be missing — a list without replacing tolerates a false alarm better than a gap.
//
// WHERE IT IS SEARCHED: start commands of the services (`project_services.start_command` and the corrected one from
// `service_start_commands`), start instructions (`service_start_instructions`), MCP servers of the project (`command`, `args`, `url`,
// `env`), graph workflows, saved dynamic workflows (script, meta), agent definitions, skills, project credentials and project knowledge
// (`project_context`).
//
// FOREIGN TEXT IS DATA: `text` is the line of the citation, cut to WINDOW characters around the hit, control characters as "·". For
// secrets (values of credentials and of MCP `env`) ONLY the key stands (`field`, `secret: true`) — never the value, never a line. A
// source that was not readable stands in `unreadable` (empty is not unknown). Above `cap` citations the list stops, `total` says how
// many there were (the cap says that it is one).

import * as store from "../../store.js";

export const CITATIONS_CAP = 200;
export const WINDOW = 160;

const BEFORE = "\\s\"'`=:(\\[{<,;|&/";
const TO = "\\s\"'`=:()\\[\\]{}<>,;|&/";
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** PURE: the hits of an old path in a text → [{ row, text }] (rows from 1, cut). */
export function hits(text, prev) {
  if (typeof text !== "string" || !text || !prev) return [];
  const re = new RegExp(`(^|[${BEFORE}])${escRe(prev)}(?=$|[${TO}])`, "m");
  const out = [];
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const z = rows[i];
    const m = re.exec(z);
    if (!m) continue;
    const pos = m.index + m[1].length;
    const from = Math.max(0, pos - Math.floor((WINDOW - prev.length) / 2));
    // eslint-disable-next-line no-control-regex
    const chunk = z.slice(from, from + WINDOW).replace(/[\u0000-\u001f\u007f-\u009f]/g, "·");
    out.push({ row: i + 1, text: `${from > 0 ? "…" : ""}${chunk}${from + WINDOW < z.length ? "…" : ""}` });
  }
  return out;
}

const json = (x) => { try { return JSON.stringify(x, null, 2); } catch { return ""; } };

/** The sources: each `{ kind, name, fields: [{ field, text, secret? }] }` — an error per kind lands in `unreadable`. */
function sources(projectId, workspaceId, unreadable) {
  const out = [];
  const read = (kind, fn) => { try { out.push(...fn()); } catch (e) { unreadable.push(kind); console.error(`[layout] citations: ${kind} not readable: ${String(e?.message || e).slice(0, 200)}`); } };
  read("service", () => store.listProjectServices(projectId).map((s) => ({
    kind: "service", name: s.name, fields: [
      { field: "start_command", text: s.startCommand || "" },
      { field: "service_start_commands", text: store.savedStartCommand(projectId, s.name) || "" },
      { field: "service_start_instructions", text: s.agentInstructions || "" },
    ],
  })));
  if (!workspaceId) { unreadable.push("workspace"); return out; }
  read("mcp", () => store.effectiveMcpServers(workspaceId, projectId).map((s) => ({
    kind: "mcp", name: s.name, fields: [
      { field: "command", text: s.command || "" },
      { field: "args", text: (Array.isArray(s.args) ? s.args : []).map(String).join("\n") },
      { field: "url", text: s.url || "" },
      ...Object.entries(s.env && typeof s.env === "object" ? s.env : {}).map(([k, v]) => ({ field: k, text: String(v ?? ""), secret: true })),
    ],
  })));
  read("workflow", () => store.effectiveWorkflows(workspaceId, projectId).map((w) => ({
    kind: "workflow", name: w.name, fields: [{ field: "graph", text: json(w.graph) }, { field: "run", text: json(w.run) }],
  })));
  read("dyn-workflow", () => store.effectiveDynWorkflows(workspaceId, projectId).map((w) => ({
    kind: "dyn-workflow", name: w.name, fields: [{ field: "script", text: w.script || "" }, { field: "meta", text: json(w.meta) }],
  })));
  read("agent", () => store.effectiveAgents(workspaceId, projectId).map((a) => ({
    kind: "agent", name: a.name, fields: [{ field: "body", text: a.body || "" }, { field: "description", text: a.description || "" }],
  })));
  read("skill", () => {
    const seen = new Map();
    // Only the Coding skills.
    for (const s of store.effectiveSkills(workspaceId, projectId)) if (!seen.has(s.id ?? s.name)) seen.set(s.id ?? s.name, s);
    return [...seen.values()].map((s) => ({ kind: "skill", name: s.name, fields: [{ field: "body", text: s.body || "" }, { field: "description", text: s.description || "" }] }));
  });
  read("credential", () => store.effectiveProjectVars(projectId, workspaceId).map((v) => ({
    kind: "credential", name: v.key, fields: [{ field: v.key, text: String(v.value ?? ""), secret: true }, { field: "description", text: v.description || "" }],
  })));
  read("knowledge", () => store.listProjectContext(projectId).map((c) => ({
    kind: "knowledge", name: c.title || c.slug || String(c.id), fields: [
      { field: "title", text: c.title || "" }, { field: "summary", text: c.summary || "" }, { field: "body", text: c.body || "" },
      { field: "code_paths", text: (Array.isArray(c.codePaths) ? c.codePaths : []).map(String).join("\n") },
    ],
  })));
  return out;
}

/** The citations (see header). `paths`: the affected old paths (relative to the root). */
export function collectCitations({ projectId, workspaceId, paths, cap = CITATIONS_CAP }) {
  const unreadable = [];
  const list = [];
  let total = 0;
  const old = [...new Set((paths || []).filter((p) => typeof p === "string" && p))];
  if (!old.length) return { list, total, unreadable };
  for (const q of sources(projectId, workspaceId, unreadable)) {
    for (const f of q.fields) {
      for (const prev of old) {
        const t = hits(f.text, prev);
        if (!t.length) continue;
        if (f.secret) {
          total += 1;
          if (list.length < cap) list.push({ kind: q.kind, name: q.name, field: f.field, secret: true, path: prev });
          continue;
        }
        for (const x of t) {
          total += 1;
          if (list.length < cap) list.push({ kind: q.kind, name: q.name, field: f.field, row: x.row, text: x.text, path: prev });
        }
      }
    }
  }
  return { list, total, unreadable };
}
