// What a bind mount IS inside the container, and its network for lsof: a part of the fake docker (fake-docker.mjs), split out
// because that file sits at the line guard (2,000). Not a test, hence .mjs.
//
//   bindInodes(mounts, swap)     at `run` on the host daemon: dockerd resolves every bind source (links followed) and mounts THAT
//                                place: dev:ino per target, remembered on the container (`mountInodes`, not in `inspect`).
//                                Option `runReference: { source, target }` of fakeDocker(): for the moment of mounting, `source` is
//                                a link to `target` (a folder of B), i.e. the swap of a project container between check and
//                                `mount`; afterwards the folder is back in place.
//   statInContainer(c, cmd, ctx) `exec <c> stat -c %d:%i -- p…`: GNU stat for exactly this format (macOS has no `-c`): dev:ino
//                                per path, for the target of a bind mount the source resolved at `run`, else the local path; a
//                                missing one is exit 1 with the real stat's message. true = answered.
//   inNetworkOfTheContainer(c, cmd, argv, ctx)  `exec <c> lsof -i [proto]:PORT` sees only the addresses of the container's
//                                networks, otherwise a stop at a port would hit processes of the machine (block below).
//   rename(args, ctx, h)         `rename <container> <new-name>`: the layout renames the old containers of a renamed stack that
//                                have a fixed `container_name`. As the real one: an unknown container is exit 1 "No such
//                                container", a taken name exit 1 "Conflict … is already in use", the same name as the old one
//                                an error as well ("Renaming a container with the same name …"). `h` hands in the helpers of the
//                                fake docker (withState, find, error), since fake-docker.mjs sits at the line guard.
//   withSize(view, c)            `inspect --size` of a container: `SizeRw`/`SizeRootFs` from the state's `size` field (missing:
//                                0, like a container without a writable layer).
//   networkFree(ctx, z, n, error)  `network rm` with the option `checkUsed` of fakeDocker(): a RUNNING container in the network
//                                is exit 1 "has active endpoints" as for real (a stopped one does not hold it, which is why the
//                                superseded-removal code checks itself before the network). Without the option: always free.
//   volumeFree(ctx, z, w, error) `volume rm` with `checkUsed`: if ANY container (even stopped) mounts the volume, exit 1 "volume
//                                is in use - [<ids>]" as for real. Without the option as before.
//   dfImages(z, human)           the `Images` of `system df -v`: one entry per image with a `size` field in the state (long id,
//                                `Size` as human-readable size); `image inspect` of the fake docker carries no `Size`, so the size
//                                comes through this route, as with the real CLI 20.10 (docker-read.js dockerInventory).
//   cidr(s), intersect(a, b), ipFrom(n)  the address arithmetic of the fake docker (`network create --subnet`, `run --ip`).
import fs from "node:fs";
import path from "node:path";

const devIno = (p) => { const st = fs.statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; };

export function bindInodes(mounts, swap) {
  const out = {};
  for (const m of mounts) {
    if (m.Type !== "bind") continue;
    if (swap?.source && path.resolve(m.Source) === path.resolve(swap.source)) {
      const aside = `${m.Source}.fake-aside`;
      fs.renameSync(m.Source, aside);
      try {
        fs.symlinkSync(swap.destination, m.Source);
        out[m.Destination] = devIno(m.Source);
        fs.unlinkSync(m.Source);
      } finally { fs.renameSync(aside, m.Source); }
    } else out[m.Destination] = devIno(m.Source);
  }
  return out;
}

export function statInContainer(c, cmd, ctx) {
  if (cmd[0] !== "stat" || cmd[1] !== "-c" || cmd[2] !== "%d:%i" || cmd[3] !== "--") return false;
  const rows = [];
  let code = 0;
  for (const p of cmd.slice(4)) {
    if (c.mountInodes?.[p]) { rows.push(c.mountInodes[p]); continue; }
    try { rows.push(devIno(p)); } catch { ctx.failed(`stat: cannot statx '${p}': No such file or directory\n`); code = 1; }
  }
  ctx.stdout(rows.map((z) => `${z}\n`).join(""));
  ctx.exitCode = code;
  return true;
}

// The network namespace of a container: the processes of an exec run LOCALLY, so a real `lsof -ti tcp:PORT` would see every
// listener OF THE MACHINE on that port, and a stop at a port inside a project container would kill a foreign process of the
// Mac that happens to hold the same port number on another address. Inside the container, `lsof -i [46][proto]:PORT` therefore
// sees only the addresses of ITS networks (the instance IP); without an address there is no listener (exit 1 like the real
// lsof without a hit). An lsof emulated through `programs` stays untouched.
export function inNetworkOfTheContainer(c, cmd, argv, ctx) {
  if (path.basename(String(cmd[0])) !== "lsof" || (ctx.config.programs || {})[cmd[0]]) return argv;
  const ips = (c.networks || []).map((n) => n.ip).filter(Boolean);
  const rest = [];
  let portSpec = false;
  for (const a of argv.slice(1)) {
    const m = /^([46]?(?:tcp|udp|TCP|UDP)?):(\d+)$/.exec(a);
    if (!m) { rest.push(a); continue; }
    portSpec = true;
    ips.forEach((ip, i) => { if (i) rest.push("-i"); rest.push(`${m[1]}@${ip.includes(":") ? `[${ip}]` : ip}:${m[2]}`); });
  }
  if (!portSpec) return argv;
  if (!ips.length) return [process.execPath, "-e", "process.exitCode = 1"];
  return [argv[0], ...rest];
}

export function rename(args, ctx, { withState, find, error }) {
  if (args.length !== 2) error(1, "\"docker rename\" requires exactly 2 arguments.");
  const [who, fresh] = args;
  withState(ctx.folder, (z) => {
    const c = find(z, who);
    if (!c) error(1, `Error response from daemon: No such container: ${who}`);
    if (c.name === fresh) error(1, "Error response from daemon: Renaming a container with the same name as its current name");
    const occupied = Object.values(z.container).find((x) => x.name === fresh && x.id !== c.id);
    if (occupied) error(1, `Error response from daemon: Conflict. The container name "/${fresh}" is already in use by container "${occupied.id}". You have to remove (or rename) that container to be able to reuse that name.`);
    c.name = fresh;
  });
}

// ── Removal of superseded containers (head) ───────────────────────────────────────────────────────────────────────────

export function withSize(view, c) {
  const g = Number.isFinite(Number(c?.size)) ? Number(c.size) : 0;
  return { ...view, SizeRw: g, SizeRootFs: g };
}

export function networkFree(ctx, z, n, error) {
  if (!ctx.config.checkUsed) return;
  const inside = Object.values(z.container).some((c) => c.status === "running" && (c.networks || []).some((x) => x.name === n.name));
  if (inside) error(1, `Error response from daemon: error while removing network: network ${n.name} id ${n.id} has active endpoints`);
}

export function volumeFree(ctx, z, w, error) {
  if (!ctx.config.checkUsed) return;
  const who = Object.values(z.container).filter((c) => (c.mounts || []).some((m) => m?.Type === "volume" && m.Name === w)).map((c) => c.id);
  if (who.length) error(1, `Error response from daemon: remove ${w}: volume is in use - [${who.join(", ")}]`);
}

export function dfImages(z, human) {
  const out = new Map();
  for (const [ref, b] of Object.entries(z.images || {})) {
    if (!Number.isFinite(b?.size) || out.has(b.id)) continue;
    const i = ref.lastIndexOf(":");
    const without = ref.startsWith("sha256:") || i < 0;
    const size = human(b.size);
    out.set(b.id, { Containers: "0", CreatedAt: "", CreatedSince: "", Digest: "<none>", ID: `sha256:${b.id}`, Repository: without ? "<none>" : ref.slice(0, i), SharedSize: "0B", Size: size, Tag: without ? "<none>" : ref.slice(i + 1), UniqueSize: size, VirtualSize: size });
  }
  return [...out.values()];
}

// Address arithmetic: a CIDR as a range { start, end }, intersection of two CIDRs, number → IPv4.
export const cidr = (s) => {
  const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return null;
  const base = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
  const size = 2 ** (32 - +m[5]);
  const start = base - (base % size);
  return { start, end: start + size - 1 };
};
export const intersect = (a, b) => {
  const x = cidr(a); const y = cidr(b);
  return !!x && !!y && x.start <= y.end && y.start <= x.end;
};
export const ipFrom = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
