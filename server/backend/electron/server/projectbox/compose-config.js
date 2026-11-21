// The Compose call of a container, from its LABELS (relocation steps 3, 8 and 10). A leaf: only `node:path`.
//
// WHY FROM THE LABELS. Compose writes to every container what it was created with: project name, project folder, the Compose files
// and (since v2.2x, only with `--env-file`) the environment files. With exactly that the relocation recreates the containers in the
// project container and compares `config --hash` against the label `config-hash` (only for services without `env_file`, see
// "ENV_FILE" below). What carries NO label — profiles, variables from the shell — this call cannot restore either: the plan names it,
// the hash comparison stops. The call covers profiles anyway: `config` with `--profile *` (all profiles active) and `up` with the
// services explicitly (a named service activates its profile) — see configHashArgs.
//
// FOREIGN DATA. Labels are written by whoever calls `docker compose` in B — foreign data for the backend. So every piece is checked
// before it goes into an argument array (never a shell string): project name by the Compose rule, every path absolute and normalized
// (no `..`, nothing that starts with `-`, no control characters), the file list not empty. A violation throws `ComposeConfigError`
// with a sentence — the plan turns it into a hold reason, the procedure calls nothing.
//
// WHAT IS HERE
//   LABEL                         the names of the Compose labels, ONCE
//   labelsOf(inst)               the labels of a `docker inspect` (`Config.Labels`) or of a ps row (`labels`)
//   composeConfig(inst)           → { project, folder, files, envFiles, args } — `args` are the global arguments
//                                 `-p … --project-directory … -f … [--env-file …]`, BEFORE the subcommand
//   configKey(k)           a text per call equality (groups of the containers ONE `up` creates)
//   configHashArgs(k)             `… --profile * config --hash *` (the dry run of step 3 — no longer in step 10; Compose v5.3.1 in the
//                                 project container). `--profile *` is here and in the model call (configModelArgs), never at `up`:
//                                 without an active profile `config --hash *` LEAVES OUT the profile services, and a named profile
//                                 service ends with "no such service: <d>: disabled" (measured with Compose v2.40.3) — the hash of a
//                                 container created with `--profile x` would be missing, every relocation of a project with a profile
//                                 service would stop in the dry run. `up` does not get it: there the named service activates its profile,
//                                 another flag on the creating call would be unmeasured.
//   upWithoutStartArgs(k, services)   `… up --no-start --no-build --pull never <services>` (steps 8 and 10)
//   upDryrunArgs(k, services, { allNew })  `compose --progress json --dry-run … up --no-start --no-build --pull never
//                                 [--force-recreate] <services>` (step 10): Compose's OWN verdict on which container has to be
//                                 created anew — changes nothing (measured with 5.3.1: id and state equal)
//   dryrunVerdict(text, names)  THE parser of the JSON rows of a dry run (stdout and stderr together) → { fresh, missing, foreign,
//                                 unclear, seen }; a line that is not a JSON object of the known shapes THROWS
//   configModelArgs(k)           `… --profile * config --format json --no-interpolate --no-env-resolution` (step 3)
//   servicesWithEnvFile(text)       the services that carry `env_file`, from this output (names only)
//   configResolvedArgs(k)       `… --profile * config --format json` — Compose's model WITH interpolation and resolved env_file
//                                 (`build` per service, `environment` for the real targets, names and aliases for the classification).
//                                 The output carries VALUES: it never leaves the caller, and if the call fails neither stdout nor
//                                 stderr goes on — stacks/result.js
//
// ENV_FILE (measured on the server, Compose v5.3.1 in B and in the projectbox image): for a service WITH `env_file`, `config --hash <d>`
// is NEVER equal to the label `config-hash` that `up` sets (no config option changes that), and `config --hash` ignores the CONTENT of
// the env_file, which `up` takes into its hash. So `config --hash` is an oracle only for services WITHOUT env_file (measured equal
// there): the dry run compares only them, which services step 12b must recreate is said by Compose itself in the dry run. Which services
// carry env_file is read by `configModelArgs` from Compose's own model (anchors, `extends`, `include` and several `-f` are resolved in
// it — a text search in the Compose files could not do that); measured with v2.40.3 locally (without daemon): ONLY with
// `--no-interpolate` does `env_file` stay in the model (as a list `{path, required}`) and no value from an env_file or `.env` is in the
// output; without it (also with `--no-env-resolution` alone) `config` resolves the env_file into `environment` — with values — and
// `env_file` is missing. Both switches are on the call. The label `depends_on` is NOT read by this file but by restore.js:dependsOnFrom
// (tolerant, both forms) — one reading for restoration, plan and start in step 14.
import path from "node:path";

export const LABEL = Object.freeze({
  project: "com.docker.compose.project",
  folder: "com.docker.compose.project.working_dir",
  files: "com.docker.compose.project.config_files",
  envFiles: "com.docker.compose.project.environment_file",
  service: "com.docker.compose.service",
  hash: "com.docker.compose.config-hash",
  dependsOn: "com.docker.compose.depends_on",
  image: "com.docker.compose.image",
  oneoff: "com.docker.compose.oneoff",
  number: "com.docker.compose.container-number",
  network: "com.docker.compose.network",
  volume: "com.docker.compose.volume",
});

export class ComposeConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ComposeConfigError";
    this.code = code;
  }
}

export function labelsOf(inst) {
  const l = inst?.Config?.Labels ?? inst?.labels ?? inst?.Labels ?? null;
  return l && typeof l === "object" ? l : {};
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkPath(p, what) {
  const s = String(p ?? "");
  if (!s) throw new ComposeConfigError(`Compose label ${what}: empty`, "LABEL_EMPTY");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ComposeConfigError(`Compose label ${what}: control character in the path`, "LABEL_INVALID");
  const t = s.replace(/(.)\/+$/, "$1");
  if (!path.isAbsolute(t) || path.normalize(t) !== t) {
    throw new ComposeConfigError(`Compose label ${what}: not an absolute, normalized path`, "LABEL_INVALID");
  }
  return t;
}

const list = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** The global Compose arguments of a container from its labels (see header); throws ComposeConfigError. */
export function composeConfig(inst) {
  const l = labelsOf(inst);
  const project = String(l[LABEL.project] ?? "");
  if (!project) throw new ComposeConfigError("not a Compose container (label com.docker.compose.project missing)", "NO_COMPOSE");
  if (!PROJECT_NAME.test(project)) throw new ComposeConfigError("Compose label project: not a valid project name", "LABEL_INVALID");
  const folder = checkPath(l[LABEL.folder], "project.working_dir");
  const files = list(l[LABEL.files]).map((d) => checkPath(d, "project.config_files"));
  if (!files.length) throw new ComposeConfigError("Compose label project.config_files: empty — without the files the call cannot be reproduced", "LABEL_EMPTY");
  const envFiles = list(l[LABEL.envFiles]).map((d) => checkPath(d, "project.environment_file"));
  const args = ["-p", project, "--project-directory", folder];
  for (const d of files) args.push("-f", d);
  for (const d of envFiles) args.push("--env-file", d);
  return { project, folder, files, envFiles, args };
}

export const configKey = (k) => JSON.stringify([k.project, k.folder, k.files, k.envFiles]);

export const configHashArgs = (k) => ["compose", ...k.args, "--profile", "*", "config", "--hash", "*"];

function servicesChecked(services) {
  const d = [...new Set(services || [])];
  if (!d.length) throw new ComposeConfigError("up --no-start without services: Compose would otherwise not create a profile service", "NO_SERVICES");
  for (const n of d) if (!SERVICE_NAME.test(String(n))) throw new ComposeConfigError("service name invalid", "LABEL_INVALID");
  return d;
}

// `fresh` (layout/docker-rebuild.js composeNew): with `--force-recreate` — a moved stack whose services carry no path in the hash
// (only an image, no bind) would otherwise keep its containers with `working_dir` at the OLD place.
export function upWithoutStartArgs(k, services, { fresh = false } = {}) {
  return ["compose", ...k.args, "up", "--no-start", "--no-build", "--pull", "never", ...(fresh ? ["--force-recreate"] : []), ...servicesChecked(services)];
}

// ── Compose's own verdict instead of `config --hash` ───────────────────────────────────────────────────────────────────

/** The dry run (header): the same files, the same project name and the same services as `up --no-start`, plus the global switches
 *  `--progress json --dry-run`; with `allNew` additionally `--force-recreate` (the control: EVERY container must then report
 *  "Recreate" — otherwise the output is not readable, and an empty output would silently mean "nothing new"). */
export function upDryrunArgs(k, services, { allNew = false } = {}) {
  return ["compose", "--progress", "json", "--dry-run", ...k.args, "up", "--no-start", "--no-build", "--pull", "never",
    ...(allNew ? ["--force-recreate"] : []), ...servicesChecked(services)];
}

export const configModelArgs = (k) => ["compose", ...k.args, "--profile", "*", "config", "--format", "json", "--no-interpolate", "--no-env-resolution"];

/** The resolved model — values in `environment`, only for stacks/result.js. */
export const configResolvedArgs = (k) => ["compose", ...k.args, "--profile", "*", "config", "--format", "json"];

/** Under `--no-interpolate` an interpolated volume `name:` stays literal (`${VOL:-x}`, measured v2.40.3) — only the default name
 *  `<project>_<key>` comes resolved. So for the volume names the dry run asks the model a second time WITH interpolation (without
 *  env_file resolution) when one carries a `$`, and reads ONLY `volumes` from it (modelVolumes) — the output carries interpolated
 *  values, never leaves the caller and is never logged. */
export const configVolumesArgs = (k) => ["compose", ...k.args, "--profile", "*", "config", "--format", "json", "--no-env-resolution"];

/** The services with `env_file` from `configModelArgs` (header). Only names leave this function; no JSON or no `services` object
 *  throws (never "nobody has env_file" from an unreadable output). */
export function servicesWithEnvFile(text) {
  let d;
  try { d = JSON.parse(String(text ?? "")); } catch { throw new ComposeConfigError("config --format json: the output is not JSON", "MODEL_UNREADABLE"); }
  const s = d && typeof d === "object" ? d.services : null;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new ComposeConfigError("config --format json: no `services` object", "MODEL_UNREADABLE");
  const including = new Set();
  for (const [name, service] of Object.entries(s)) {
    const ef = service && typeof service === "object" ? service.env_file : null;
    if (Array.isArray(ef) ? ef.length > 0 : typeof ef === "string" ? ef.trim() !== "" : ef != null) including.add(name);
  }
  return including;
}

/** The named volumes from `configModelArgs` (header): Map resolved name → { key, external }. Measured with 5.3.1: the model carries at
 *  the top `volumes: { <key>: { name: "<project>_<key>" | <name:>, external?: true } }`, the name already resolved. Without `volumes`
 *  the map is empty; no JSON, a `volumes` that is no object, or an entry without a name throws (never "none" from an unreadable
 *  output). Only names leave this function. */
export function modelVolumes(text) {
  let d;
  try { d = JSON.parse(String(text ?? "")); } catch { throw new ComposeConfigError("config --format json: the output is not JSON", "MODEL_UNREADABLE"); }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new ComposeConfigError("config --format json: no object", "MODEL_UNREADABLE");
  const out = new Map();
  if (d.volumes === undefined || d.volumes === null) return out;
  if (typeof d.volumes !== "object" || Array.isArray(d.volumes)) throw new ComposeConfigError("config --format json: `volumes` is no object", "MODEL_UNREADABLE");
  for (const [key, v] of Object.entries(d.volumes)) {
    const name = v && typeof v === "object" && typeof v.name === "string" ? v.name : "";
    if (!name) throw new ComposeConfigError(`config --format json: volume “${key}” without a name`, "MODEL_UNREADABLE");
    out.set(name, { key, external: Boolean(v.external) });
  }
  return out;
}

// The words Compose reports for a container (measured with 5.3.1): "Recreate"/"Recreated" = it deviates and would be created
// anew, "Creating"/"Created" = it is missing, "Running" = current and running; a current container that is not running (created,
// exited) gets NO line. After a Recreate lines with "Container <short-id>_<name>" appear (the old container under its transitional
// name).
const PROBE_NEW = new Set(["Recreate", "Recreated"]);
const PROBE_CREATE = new Set(["Creating", "Created"]);
const PROBE_CURRENT = new Set(["Running"]);
const PROBE_KINDS = /^(Container|Network|Volume|Image) (.+)$/;
const SHORT_ID = /^[0-9a-f]{12,64}_(.+)$/;
const PROBE_ERROR_LEVEL = /^(error|fatal|panic)$/i;
const probeError = (text) => new ComposeConfigError(`dry run: ${text}`, "DRYRUN_UNREADABLE");

/** Compose's verdict from the output of a dry run (stdout and stderr, JSON lines) against the plan containers `names`:
 *  { fresh: [name] (Recreate), missing: [name] (Creating/Created), foreign: [name] (not in the plan, but not "current"),
 *    unclear: [{ name, words }] (another word), seen: [name] }.
 *  Only lines `{ id: "Container <name>", status, text }` are read; lines about networks, volumes, images, warnings
 *  (`{ level, msg }`) and closing texts (`{ tail: true }`) do not count. It THROWS (`DRYRUN_UNREADABLE`, with the line number, never
 *  the content — a line may carry a value): a line that is no JSON object; an object without `id` and without `level`/`msg`; an
 *  unknown kind before the name; a container line without text or with status "Error"; a message of level error/fatal. An empty
 *  output is "all current" — hence the control with `allNew` (upDryrunArgs). */
export function dryrunVerdict(text, names) {
  const plan = new Set(names || []);
  const words = new Map();
  String(text ?? "").split("\n").forEach((raw, i) => {
    const z = raw.trim();
    if (!z) return;
    let o;
    try { o = JSON.parse(z); } catch { throw probeError(`line ${i + 1} is not JSON`); }
    if (!o || typeof o !== "object" || Array.isArray(o)) throw probeError(`line ${i + 1} is not a JSON object`);
    if (typeof o.id !== "string") {
      if (o.tail === true) return;
      if (typeof o.level === "string" && typeof o.msg === "string") {
        if (PROBE_ERROR_LEVEL.test(o.level)) throw probeError(`line ${i + 1} reports an error (level ${o.level.slice(0, 10)})`);
        return;
      }
      throw probeError(`line ${i + 1} carries neither \`id\` nor \`level\``);
    }
    const m = o.id.match(PROBE_KINDS);
    if (!m) throw probeError(`line ${i + 1}: unknown kind before the name`);
    if (m[1] !== "Container") return;
    if (typeof o.text !== "string" || !o.text) throw probeError(`line ${i + 1}: container line without text`);
    if (o.status === "Error") throw probeError(`line ${i + 1}: status “Error”`);
    let name = m[2];
    const k = plan.has(name) ? null : name.match(SHORT_ID);
    if (k) name = k[1];
    if (!words.has(name)) words.set(name, new Set());
    words.get(name).add(o.text);
  });
  const verdict = { fresh: [], missing: [], foreign: [], unclear: [], seen: [...words.keys()].sort() };
  for (const [name, w] of [...words].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const list = [...w];
    const kind = list.some((x) => PROBE_NEW.has(x)) ? "fresh" : list.some((x) => PROBE_CREATE.has(x)) ? "missing"
      : list.every((x) => PROBE_CURRENT.has(x)) ? "current" : "unclear";
    if (!plan.has(name)) { if (kind !== "current") verdict.foreign.push(name); continue; }
    if (kind === "fresh") verdict.fresh.push(name);
    else if (kind === "missing") verdict.missing.push(name);
    else if (kind === "unclear") verdict.unclear.push({ name, words: list.map((x) => (/^[A-Za-z][A-Za-z ]{0,29}$/.test(x) ? x : "?")).sort() });
  }
  return verdict;
}
