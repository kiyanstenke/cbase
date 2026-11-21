// The creation of a copy: overlays.tsv and the copy container. One step of the build (stacks/build.js), after freeze
// and clone: the copy is in `build`/`creation`, the instance row `copy-<name>` has been in `create` since `clone1`, the
// project occupancy "copy" is held by the queue.
//
// overlayRows({ location, projectPath, home, runtimeHome, repos })  PURE → [{ target, bottom, top, work, topB, workB, part, kind }]
//   The overlays of the copy, OUTER BEFORE INNER (a target comes after each of its ancestors; the entrypoint sorts by C
//   locale anyway, server/backend/projectbox-entry.sh — the file is still written in this order):
//     1. the project folder: target <orig>, bottom /cbase-main<orig>, top layer/p
//     2. if the project folder itself is a repo (part `p`, project repo or code repo): <orig>/.git/objects, bottom
//        objects/p, top layer/p.objects (the hard links are in a LOWER layer)
//     3. per code repo `r<i>` (ancestors first): <orig>/<rel>, bottom /cbase-main<orig>/<rel>, top layer/r<i> — and
//        DIRECTLY after it its <orig>/<rel>/.git/objects (bottom objects/r<i>, top layer/r<i>.objects)
//     4. ~/.local: <home>/.local, bottom <runtime>/home/.local (the project's), top layer/local
//   `top`/`work` are the paths as the copy sees them (below /cbase-copy — location.js `inside`), `topB`/`workB` the same
//   in the user container (location.js `root`); `work` = work/w<i> per row; `kind` is project | repo | objects | local.
//   A path the entrypoint could not mount (relative, with TAB, line break, `,` `\` `"` in a layer, `:` in `bottom`)
//   THROWS here — before anything is created.
// createCopy(copy, { location, projectPath, snapshot, home, system, root, addresses, data })  → the instance row
//   overlays.tsv with upper layers and work folders (stacks/objects.js createOverlays — only there does the user
//   container write below the layer folder), then projectbox/instance.js createInstance(pid, { instance, build: true,
//   occupancyHeld: true, chatId }) — with the mount rules of a copy, its own /24, its own token (projectbox/token.js per
//   identifier) and its DNS name. It waits only until `phase=prepare` and leaves the row in `create`; if it fails, it
//   clears container and network itself and throws — the rest is dismantled by stacks/dismantling.js.
//   Without the ops marker: 404 NO_OPS, without a docker call.
// Guard: server/backend/test/stacks-creation.test.js.
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { MAIN_BOTTOM_INSIDE, copyInstance } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { createInstance } from "../projectbox/instance.js";
import { createOverlays } from "./objects.js";
import { CopyError } from "./state.js";

const LOCAL = ".local";

// What the entrypoint refuses (projectbox-entry.sh, the overlays of a copy) — checked here so the reason shows up in the user container.
function checkRow(z) {
  for (const [field, p] of [["target", z.target], ["bottom", z.bottom], ["top", z.top], ["work", z.work]]) {
    if (typeof p !== "string" || !path.isAbsolute(p)) throw new CopyError(T`overlays.tsv: ${field} "${p}" is not an absolute path`, { code: "COPY_OVERLAY", status: 500 });
    if (/[\t\n\r\0]/.test(p)) throw new CopyError(T`overlays.tsv: ${field} ${JSON.stringify(p)} contains TAB, line break or NUL — not representable`, { code: "COPY_OVERLAY", status: 500 });
    if (field !== "target" && /[,\\"]/.test(p)) throw new CopyError(T`overlays.tsv: ${field} "${p}" contains , \\ or " — not representable as a mount option`, { code: "COPY_OVERLAY", status: 500 });
  }
  if (z.bottom.includes(":")) throw new CopyError(T`overlays.tsv: bottom "${z.bottom}" contains : (lowerdir separates layers there)`, { code: "COPY_OVERLAY", status: 500 });
}

// Ancestors first: compare path parts in order (a prefix comes before its children).
const afterShare = (a, b) => {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
};

export function overlayRows({ location, projectPath, home, runtimeHome, repos = [] }) {
  const orig = path.resolve(String(projectPath || ""));
  const main = (rel) => path.posix.join(MAIN_BOTTOM_INSIDE, rel === "." ? orig : path.posix.join(orig, rel));
  const raw = [];
  const repo = (part, rel) => {
    const target = rel === "." ? orig : path.posix.join(orig, rel);
    raw.push({ part, kind: "repo", target, bottom: main(rel), top: location.inside.layer(part), topB: location.root.layer(part) });
    raw.push({ part, kind: "objects", target: path.posix.join(target, ".git", "objects"), bottom: location.inside.objects(part), top: location.inside.layerObjects(part), topB: location.root.layerObjects(part) });
  };
  const p = repos.find((r) => r.part === "p");
  if (p && p.rel !== ".") throw new CopyError(T`Snapshot: part p is at "${p.rel}", not at the project folder`, { code: "COPY_OVERLAY", status: 500 });
  if (p) repo("p", ".");
  else raw.push({ part: "p", kind: "project", target: orig, bottom: main("."), top: location.inside.layer("p"), topB: location.root.layer("p") });
  const code = repos.filter((r) => r.part !== "p");
  for (const r of code) {
    const rel = String(r.rel || "");
    if (!rel || rel === "." || rel.startsWith("/") || rel.split("/").some((t) => t === ".." || t === "")) {
      throw new CopyError(T`Snapshot: repo path ${JSON.stringify(rel)} is not relative — no overlays`, { code: "COPY_OVERLAY", status: 500 });
    }
  }
  for (const r of [...code].sort((a, b) => afterShare(a.rel, b.rel))) repo(r.part, r.rel);
  raw.push({ part: "local", kind: "local", target: path.join(home, LOCAL), bottom: path.join(runtimeHome, LOCAL), top: location.inside.layer("local"), topB: location.root.layer("local") });
  const rows = raw.map((z, i) => ({ ...z, work: location.inside.work(i), workB: location.root.work(i) }));
  const targets = new Set();
  for (const z of rows) {
    checkRow(z);
    if (targets.has(z.target)) throw new CopyError(T`overlays.tsv: target ${z.target} would be listed twice`, { code: "COPY_OVERLAY", status: 500 });
    targets.add(z.target);
  }
  return rows;
}

export async function createCopy(copy, { location, projectPath, snapshot, home, system, root, addresses, data, runtimeHome }) {
  if (!projectboxOps()) throw new CopyError(T`copies exist only in server mode`, { code: "NO_OPS", status: 404 });
  const pid = copy.projectId;
  const instance = copyInstance(copy.name);
  const rows = overlayRows({ location, projectPath, home, runtimeHome, repos: snapshot.repos || [] });
  createOverlays({ location, rows });
  const row = await createInstance(pid, {
    instance, build: true, occupancyHeld: true, chatId: copy.chatId,
    ...(home ? { home } : {}), ...(system ? { system } : {}), ...(root !== undefined ? { root } : {}),
    ...(addresses ? { addresses } : {}), ...(data ? { data } : {}),
  });
  if (!row?.containerId) throw new CopyError(T`Creation ${pid}/${instance}: returned without a container id`, { code: "COPY_CREATION", status: 500 });
  return { row, rows, instance: store.projectInstance(pid, instance) };
}
