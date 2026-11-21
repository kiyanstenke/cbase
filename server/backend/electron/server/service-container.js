// The containers of a service from `docker ps` (split out of services.js so that it stays under the 2,000-line guard). A leaf
// without store and without docker: the template, reading the rows and the match service ↔ container. services.js re-exports
// everything (importers stay with `./services.js`); the call of docker stays there (projectbox-ops.test.js DOCKER_CALLS_ALLOWED).
import fs from "node:fs";
import path from "node:path";

// The template names its fields individually, never `{{json .}}`: the docker CLI requests the container sizes (`size=1`) for the
// template "everything", and the inner dockerd would walk through the rw layer of every container on each refresh (cache 4 s).
// The row stays a JSON object, `containerFromPs` reads both forms. Plus `ID` (shortened like the CLI without `--no-trunc`) —
// matchContainers skips the superseded containers of renamed stacks BY id (`project_superseded`: after `docker rename` a name
// says nothing any more).
export const PS_TEMPLATE = '{"ID":{{json .ID}},"Names":{{json .Names}},"State":{{json .State}},"Status":{{json .Status}},"Labels":{{json .Labels}}}';

// The compose labels by which a container is assigned to its project.
export const LABEL_SERVICE = "com.docker.compose.service";
export const LABEL_FOLDER = "com.docker.compose.project.working_dir";
// States in which `docker ps` WITHOUT -a shows a container — exactly that used to mean "running".
const RUNNING = new Set(["running", "restarting", "paused"]);

/**
 * The labels of a ps row: `docker ps --format` (`{{json .Labels}}` like `{{json .}}`) gives them as ONE string "k=v,k=v". A value may
 * itself carry commas (`com.docker.compose.depends_on=db:service_started:false,redis:…`, `config_files=a.yml,b.yml`):
 * a piece without "key=" at the start therefore belongs to the value before it.
 */
export function labelsFromPs(text) {
  const out = {};
  let last = null;
  for (const chunk of String(text || "").split(",")) {
    const m = chunk.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)=(.*)$/s);
    if (m) { last = m[1]; out[last] = m[2]; } else if (last !== null) out[last] += `,${chunk}`;
  }
  return out;
}

// `.native` (realpath(3)), not the JS version — on the case-INsensitive APFS only the native one aligns the spelling with the disk
// ("/Users/x/project" and "/users/X/Project" are the same folder, the JS version returns the spelling of the argument). Both
// sides of the match go through here: `working_dir` (containerFromPs) and the project folder (matchContainers). On a
// case-sensitive file system (Linux, the user container) nothing changes.
const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * The output of `docker ps -a --format PS_TEMPLATE` (or `{{json .}}`) → [{ id, name, state, running, labels, service, folder }]. `folder`
 * is `working_dir` after realpath (once per ps result, not per match). `id` as delivered (shortened or full, "" without the field).
 * Rows that are not JSON are dropped.
 */
export function containerFromPs(stdout) {
  const out = [];
  for (const row of String(stdout || "").split("\n")) {
    let z;
    try { z = JSON.parse(row); } catch { continue; }
    if (!z || typeof z !== "object") continue;
    const name = String(z.Names || "").split(",")[0].trim();
    if (!name) continue;
    const labels = typeof z.Labels === "string" ? labelsFromPs(z.Labels) : (z.Labels && typeof z.Labels === "object" ? z.Labels : {});
    const state = String(z.State || (String(z.Status || "").startsWith("Up") ? "running" : "")).toLowerCase();
    const wd = labels[LABEL_FOLDER];
    out.push({ id: String(z.ID || ""), name, state, running: RUNNING.has(state), labels, service: labels[LABEL_SERVICE] || "", folder: wd ? realPath(wd) : "" });
  }
  return out;
}

/**
 * The containers of a service: [{ name, running, … }] from `list` (containerFromPs).
 *   - Compose container (label `…project.working_dir`): the service name (`…service`) or the container name
 *     (`container_name`) is `container`, AND `working_dir` lies after realpath under the project folder (with separator:
 *     `/ws/orbit-2` is not under `/ws/orbit`). Without a known project folder none matches — unknown is not "everywhere".
 *   - Container without this label (`docker run --name …`): only the EXACT name. The compose pattern `<project>-<service>-<n>`
 *     has no hold here: without a label such a name does not say which project it belongs to — and exactly this pattern hit
 *     foreign projects.
 *   - `dir` (the column `project_services.dir`, relative to the project folder): a compose container matches only if `working_dir`
 *     and `<root>/<dir>` lie on ONE line — equal, ancestor or descendant, by realpath in whole path parts. NOT "under
 *     `<root>/<dir>`": in some projects the compose file lies one level ABOVE the service folder (`dir` =
 *     `core/services/<x>`, `working_dir` = `<root>/core`) — those are the right containers. A sibling (`…/services/y`,
 *     `…/services/xy`) no longer matches. A `dir` that is empty or absolute or carries `..` does not narrow down. A stack at the
 *     root lies on every line.
 *   - `exempt` (ids from `project_superseded`): such a container NEVER matches — the old containers of a renamed stack stand
 *     stopped next to the new ones, and status, stop and log would otherwise mean both. Compared by prefix (`ps` delivers
 *     the shortened id, the table the full one); a container without an id is not exempted.
 */
export function matchContainers(list, container, projectPath, { dir = "", exempt = null } = {}) {
  if (!Array.isArray(list) || !container) return [];
  const root = projectPath ? realPath(projectPath) : "";
  const below = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const underRoot = (folder) => !!root && below(folder, root);
  const d = serviceFolder(dir);
  const line = root && d ? realPath(path.join(root, d)) : "";
  const onLine = (folder) => !line || below(folder, line) || below(line, folder);
  const output = exempt ? [...exempt].map(String).filter(Boolean) : [];
  const superseded = (c) => !!c.id && output.some((a) => a.startsWith(c.id) || c.id.startsWith(a));
  return list.filter((c) => {
    if (superseded(c)) return false;
    if (c.labels?.[LABEL_FOLDER]) return underRoot(c.folder) && onLine(c.folder) && (c.service === container || c.name === container);
    return c.name === container;
  });
}

// The form of `project_services.dir` for the line (the same rule as normDir in the projectbox layout code — that knows the
// store, this leaf does not): relative, without `./`, without a trailing slash; empty, absolute or with `..` ⇒ "".
function serviceFolder(dir) {
  let d = String(dir ?? "").trim().replace(/\\/g, "/");
  if (!d || path.posix.isAbsolute(d)) return "";
  while (d.startsWith("./")) d = d.slice(2);
  d = d.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (d === "." || d.split("/").some((t) => t === "..")) return "";
  return d;
}
