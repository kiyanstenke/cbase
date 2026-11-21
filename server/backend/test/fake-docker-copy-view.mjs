// The copy view of the fake docker: overlays, preparation and transition of a copy container. A part of fake-docker.mjs, split out
// because that file sits at the line guard (2,000). Not a test, hence .mjs. Like fake-docker-stat.mjs without a back-import:
// `copyViewPart(h)` receives the helpers of the fake docker (readState, writeState, withState, daemonFolder, killGroup,
// startsAtResumption, rememberStart, map) and returns the functions that run, exec and program call there.
//
// A container that mounts its copy root under /cbase-copy and carries an overlays.tsv there (stacks/creation.js createCopy)
// gets a VIEW at `run -d` (`<dir>/copy-view/<name>/`): what the entrypoint (server/backend/projectbox-entry.sh) really mounts,
// as local folders:
//   - per row `target\tbottom\ttop\twork` a merged folder M: first `bottom` (resolved through the container's bind mounts to the
//     local path), then `top` over it; `.wh..wh..opq` in a folder of the upper layer hides everything below in it (the product's
//     `user.overlay.opaque`; the tests' opaque program writes this file), `.wh.<n>` is a whiteout. Rows in C-locale order like the
//     entrypoint; a row whose target lies under another one lies INSIDE that one's M (git finds `.git/objects` relatively), its
//     mount point does not belong to the outer layer.
//   - status file `phase=prepare`, `cgroup.subtree_control` with memory.
//   exec into the container: `-w` and every argument that starts with `/` is translated: a target to its M, /cbase-copy to the
//     root, /cbase-main<p> to <p> (both only until the transition; afterwards into the void, as if unmounted), the status file and
//     cgroup.subtree_control to those of the view; `programs` maps only paths, not bare names (`cat` is the real one).
//     After an exec (without -d) every change in M goes into its upper layer (new/changed: copied up, a whiteout drops; deleted:
//     removed from the upper layer, and if it was below, a whiteout), like the kernel on write.
//   - the TRANSITION: if `.prepared` lies in the root, the next exec makes the view `ready` (status file `phase=ready`) and starts
//     the inner daemon like a fresh dockerd on a cloned volume: every container stopped (a running one with 255), then `always`
//     started, and `unless-stopped` if it was running. Until then the inner daemon does not answer ("Cannot connect to the Docker
//     daemon"): a docker call before `.prepared` is a red test.
//   `rm` of the container takes the view with it.
// The literals belong to the product (projectbox/creation.js COPY_ROOT_INSIDE/MAIN_BOTTOM_INSIDE, stacks/location.js OVERLAYS_FILE/
// PREPARED_FILE, projectbox/instance.js STATUS_FILE/CGROUP_CONTROL); the fake does not import the product; bound in
// server/backend/test/stacks-creation.test.js.
import fs from "node:fs";
import path from "node:path";

export const COPY_VIEW = Object.freeze({
  root: "/cbase-copy", main: "/cbase-main", overlays: "overlays.tsv", prepared: ".prepared",
  status: "/run/cbase-projectbox.status", cgroup: "/sys/fs/cgroup/cgroup.subtree_control",
});

export function copyViewPart(h) {
  const { readState, writeState, withState, daemonFolder, killGroup, startsAtResumption, rememberStart, map } = h;
  const WH = ".wh.";
  const OPAQUE = ".wh..wh..opq";
  const viewFolder = (root, name) => path.join(root, "copy-view", encodeURIComponent(name));
  const viewExists = (root, name) => fs.existsSync(path.join(viewFolder(root, name), "state.json"));
  /** The view of a copy container (test side): { name, copy, ready, rows: [{ target, bottom, top, m }] } or null. */
  function copyView(root, name) {
    return viewExists(root, name) ? readState(viewFolder(root, name)) : null;
  }
  const ident = (st) => `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`;
  const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const underPath = (p, w) => p === w || p.startsWith(`${w}/`);

  function hostPath(mounts, p) {
    let best = null;
    for (const m of mounts || []) {
      if (m.Type === "bind" && underPath(p, m.Destination) && (!best || m.Destination.length > best.Destination.length)) best = m;
    }
    return best ? best.Source + p.slice(best.Destination.length) : p;
  }
  function copyFlat(q, z, st) {
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(q), z);
    else if (st.isFile()) { fs.copyFileSync(q, z); fs.chmodSync(z, st.mode & 0o7777); }
  }
  function copyBottom(q, z, rel, lower) {
    for (const n of fs.readdirSync(q)) {
      const r = rel ? `${rel}/${n}` : n;
      const qp = path.join(q, n);
      const zp = path.join(z, n);
      const st = fs.lstatSync(qp);
      lower.add(r);
      if (st.isDirectory()) { fs.mkdirSync(zp, { mode: st.mode & 0o7777 }); copyBottom(qp, zp, r, lower); } else copyFlat(qp, zp, st);
    }
  }
  const forgetUnder = (lower, rel) => { for (const x of [...lower]) if (!rel || underPath(x, rel)) lower.delete(x); };
  function applyTopOn(o, m, rel, lower) {
    const names = fs.readdirSync(o).sort();
    if (names.includes(OPAQUE)) {
      for (const n of fs.readdirSync(m)) fs.rmSync(path.join(m, n), { recursive: true, force: true });
      for (const x of [...lower]) if (!rel || x.startsWith(`${rel}/`)) lower.delete(x);
    }
    for (const n of names) {
      if (n === OPAQUE) continue;
      if (n.startsWith(WH)) {
        const w = n.slice(WH.length);
        fs.rmSync(path.join(m, w), { recursive: true, force: true });
        forgetUnder(lower, rel ? `${rel}/${w}` : w);
        continue;
      }
      const r = rel ? `${rel}/${n}` : n;
      const op = path.join(o, n);
      const mp = path.join(m, n);
      const st = fs.lstatSync(op);
      const mst = lstatOrNull(mp);
      if (st.isDirectory()) {
        if (mst && !mst.isDirectory()) { fs.rmSync(mp, { force: true }); forgetUnder(lower, r); }
        if (!mst || !mst.isDirectory()) fs.mkdirSync(mp, { mode: st.mode & 0o7777 });
        applyTopOn(op, mp, r, lower);
      } else {
        if (mst?.isDirectory()) forgetUnder(lower, r);
        fs.rmSync(mp, { recursive: true, force: true });
        copyFlat(op, mp, st);
      }
    }
  }
  function viewManifest(m, inner, lower) {
    const man = {};
    const run = (abs, rel) => {
      for (const n of fs.readdirSync(abs)) {
        const r = rel ? `${rel}/${n}` : n;
        if (inner.includes(r)) continue;
        const st = fs.lstatSync(path.join(abs, n));
        man[r] = { id: ident(st), l: lower && lower.has(r) ? 1 : 0 };
        if (st.isDirectory()) run(path.join(abs, n), r);
      }
    };
    run(m, "");
    return man;
  }
  function buildCopyView(dir, mounts, text) {
    const raw = text.split("\n").filter(Boolean).map((z) => {
      const f = z.split("\t");
      if (f.length !== 4 || f.some((x) => !x.startsWith("/"))) throw new Error(`overlays.tsv: row ${JSON.stringify(z)} does not have four absolute fields`);
      return { target: f[0], bottom: hostPath(mounts, f[1]), top: hostPath(mounts, f[2]) };
    }).sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
    const rows = [];
    const lowers = [];
    raw.forEach((z, i) => {
      if (!fs.existsSync(z.bottom)) throw new Error(`overlay ${z.target}: lowerdir ${z.bottom} missing`);
      if (!fs.existsSync(z.top)) throw new Error(`overlay ${z.target}: upperdir ${z.top} missing`);
      const parent = rows.filter((x) => z.target.startsWith(`${x.target}/`)).sort((a, b) => b.target.length - a.target.length)[0];
      const m = parent ? parent.m + z.target.slice(parent.target.length) : path.join(dir, `m${i}`);
      if (parent) parent.inner.push(z.target.slice(parent.target.length + 1));
      fs.rmSync(m, { recursive: true, force: true });
      fs.mkdirSync(m, { recursive: true });
      const lower = new Set();
      copyBottom(z.bottom, m, "", lower);
      applyTopOn(z.top, m, "", lower);
      rows.push({ ...z, m, inner: [] });
      lowers.push(lower);
    });
    rows.forEach((z, i) => { z.man = viewManifest(z.m, z.inner, lowers[i]); });
    return rows;
  }
  function copyViewAfterRun(ctx, id) {
    const c = readState(ctx.folder).container[id];
    const kw = (c?.mounts || []).find((m) => m.Type === "bind" && m.Destination === COPY_VIEW.root);
    if (!kw || !fs.existsSync(path.join(kw.Source, COPY_VIEW.overlays))) return;
    const dir = viewFolder(ctx.root, c.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cgroup"), "cpu io memory pids\n");
    let rows = [];
    let status = "phase=prepare\nnotice=overlays mounted, waiting for .prepared\n";
    try { rows = buildCopyView(dir, c.mounts, fs.readFileSync(path.join(kw.Source, COPY_VIEW.overlays), "utf8")); }
    catch (e) { status = `phase=error\nnotice=${String(e.message).split("\n")[0]}\n`; }
    fs.writeFileSync(path.join(dir, "status"), status);
    writeState(dir, { name: c.name, copy: kw.Source, ready: false, rows });
  }
  function copyViewTransition(ctx, name) {
    const dir = viewFolder(ctx.root, name);
    withState(dir, (s) => {
      if (s.ready || !fs.existsSync(path.join(s.copy, COPY_VIEW.prepared))) return;
      s.ready = true;
      fs.writeFileSync(path.join(dir, "status"), "phase=ready\nnotice=raw roots unmounted, dockerd running\n");
      withState(daemonFolder(ctx.root, name), (zi) => {
        for (const x of Object.values(zi.container || {})) {
          const ran = x.status === "running";
          for (const g of x.processes || []) killGroup(g);
          x.processes = [];
          delete x.paused;
          if (ran) { x.status = "exited"; x.exitCode = 255; }
          // The rules of the real restart (startsAtResumption): `always` and a previously running `unless-stopped` only; a
          // flaw in the policy guard for `on-failure` or a crashed `unless-stopped` must turn this red.
          if (startsAtResumption(x)) {
            x.status = "running";
            x.started = new Date().toISOString();
            rememberStart(zi, x);
          }
        }
      });
    });
  }
  function copyViewPath(s, dir, p) {
    if (typeof p !== "string" || !p.startsWith("/")) return p;
    if (p === COPY_VIEW.status) return path.join(dir, "status");
    if (p === COPY_VIEW.cgroup) return path.join(dir, "cgroup");
    const gone = path.join(dir, "unmounted");
    if (underPath(p, COPY_VIEW.root)) return (s.ready ? gone : s.copy) + p.slice(COPY_VIEW.root.length);
    if (underPath(p, COPY_VIEW.main)) return s.ready ? gone + p : p.slice(COPY_VIEW.main.length) || "/";
    let best = null;
    for (const z of s.rows) if (underPath(p, z.target) && (!best || z.target.length > best.target.length)) best = z;
    return best ? best.m + p.slice(best.target.length) : p;
  }
  function mapCopyView(cmd, c, ctx) {
    if (cmd[0] === "docker") return map(cmd, c, ctx);
    const dir = viewFolder(ctx.root, c.name);
    const s = readState(dir);
    const local = String(cmd[0]).startsWith("/") ? (ctx.config.programs || {})[cmd[0]] : null;
    return { argv: [local || copyViewPath(s, dir, cmd[0]), ...cmd.slice(1).map((a) => copyViewPath(s, dir, a))], env: {} };
  }
  function copyUp(z, r) {
    const mp = path.join(z.m, r);
    const op = path.join(z.top, r);
    const st = fs.lstatSync(mp);
    fs.mkdirSync(path.dirname(op), { recursive: true });
    fs.rmSync(path.join(path.dirname(op), WH + path.basename(op)), { force: true });
    const ost = lstatOrNull(op);
    if (st.isDirectory()) {
      if (ost && !ost.isDirectory()) fs.rmSync(op, { force: true });
      fs.mkdirSync(op, { recursive: true, mode: st.mode & 0o7777 });
      return;
    }
    if (ost) fs.rmSync(op, { recursive: true, force: true });
    copyFlat(mp, op, st);
  }
  function copyViewReconcile(ctx, name) {
    const dir = viewFolder(ctx.root, name);
    withState(dir, (s) => {
      for (const z of s.rows || []) {
        if (!fs.existsSync(z.m)) continue;
        const fresh = viewManifest(z.m, z.inner, null);
        for (const [r, e] of Object.entries(fresh)) {
          const old = z.man[r];
          e.l = old ? old.l : 0;
          if (!old || old.id !== e.id) copyUp(z, r);
        }
        const done = [];
        for (const r of Object.keys(z.man).filter((x) => !(x in fresh)).sort()) {
          if (done.some((x) => r.startsWith(`${x}/`))) continue;
          done.push(r);
          const op = path.join(z.top, r);
          fs.rmSync(op, { recursive: true, force: true });
          if (z.man[r].l) {
            fs.mkdirSync(path.dirname(op), { recursive: true });
            fs.writeFileSync(path.join(path.dirname(op), WH + path.basename(op)), "");
          }
        }
        z.man = fresh;
      }
    });
  }
  function copyViewWaiting(root, daemon) {
    if (!daemon || daemon === "host" || String(daemon).includes(">") || !viewExists(root, daemon)) return false;
    return !readState(viewFolder(root, daemon)).ready;
  }
  return { copyView, copyViewAfterRun, copyViewTransition, copyViewPath, mapCopyView, copyViewReconcile, copyViewWaiting, viewExists, viewFolder };
}
