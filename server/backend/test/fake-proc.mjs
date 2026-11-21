// A fake /proc for the guards of the relocation (projectbox/relocation/processes.js). Not a test, hence .mjs. macOS has no
// /proc, and on Linux a guard would otherwise depend on every process of the machine: the tests ALWAYS install a fake one
// (setProcessSeam), the same on both systems.
//
// fakeProc(dir, { itself, space, ancestors, selfCwd })  → { root, process(p), gone(pid) }
//     creates what the reader parses: `self` → `<itself>`, per process `<pid>/stat` (real form, name in parentheses, start
//     time in field 22), `comm`, `ns/mnt` (a link whose target is the name of the namespace, as in the real /proc) and `cwd`
//     (a link to the working directory). `itself` (default process.pid) and its `ancestors` (parents, grandparents …) are in
//     there with `selfCwd`.
//     process({ pid, cwd, space, comm, ppid, pgid, sid, start, tpgid, exe, maps, fd, cmdline, environ })  one process; `exe` (a
//     link like `/proc/<pid>/exe`), `maps` (list of paths, one line each in the real form `addr perms offset dev inode path`;
//     an entry without `/` appears as a pseudo name like `[heap]`) and `fd` ({ <nr>: target }, one link each, also
//     `socket:[123]`); `cmdline`/`environ` exist only so a guard can show that they are never read.
// emptyProc(dir?)  a /proc holding only B (for guards where no foreign process is at work) → the path.
// SPACE, FOREIGN_SPACE  the names of two mount namespaces.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SPACE = "mnt:[4026531840]";
export const FOREIGN_SPACE = "mnt:[4026532777]";

// `tpgid` (field 8: the foreground group of the terminal; projectbox/layout/proc-program.js), default -1 (no terminal).
const statText = ({ pid, comm, ppid, pgid, sid, start, tpgid = -1 }) =>
  `${pid} (${comm}) S ${ppid} ${pgid} ${sid} 0 ${tpgid} 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1150976 1 18446744073709551615\n`;

export function fakeProc(dir, { itself = process.pid, space = SPACE, ancestors = [], selfCwd = os.tmpdir() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const process = ({ pid, cwd = "/", space: r = space, comm = "node", ppid = 1, pgid = pid, sid = pid, start = 1000, tpgid = -1, exe = null, maps = null, fd = null, cmdline = null, environ = null }) => {
    const location = path.join(dir, String(pid));
    fs.rmSync(location, { recursive: true, force: true });
    fs.mkdirSync(path.join(location, "ns"), { recursive: true });
    fs.writeFileSync(path.join(location, "stat"), statText({ pid, comm, ppid, pgid, sid, start, tpgid }));
    fs.writeFileSync(path.join(location, "comm"), `${comm}\n`);
    fs.symlinkSync(r, path.join(location, "ns", "mnt"));
    if (cwd !== null) fs.symlinkSync(cwd, path.join(location, "cwd"));
    if (exe !== null) fs.symlinkSync(exe, path.join(location, "exe"));
    if (maps !== null) {
      fs.writeFileSync(path.join(location, "maps"), maps.map((m, i) => `${(0x1000 * (i + 1)).toString(16).padStart(12, "0")}-${(0x1000 * (i + 2)).toString(16).padStart(12, "0")} r--p 00000000 fd:01 ${1000 + i}                      ${m}\n`).join(""));
    }
    if (fd !== null) {
      fs.mkdirSync(path.join(location, "fd"));
      for (const [seq, target] of Object.entries(fd)) fs.symlinkSync(target, path.join(location, "fd", String(seq)));
    }
    if (cmdline !== null) fs.writeFileSync(path.join(location, "cmdline"), cmdline);
    if (environ !== null) fs.writeFileSync(path.join(location, "environ"), environ);
    return pid;
  };
  const chain = [itself, ...ancestors];
  chain.forEach((pid, i) => process({ pid, cwd: selfCwd, ppid: chain[i + 1] ?? 0, comm: i ? `ancestor${i}` : "node" }));
  fs.rmSync(path.join(dir, "self"), { force: true });
  fs.symlinkSync(String(itself), path.join(dir, "self"));
  return { root: dir, process, gone: (pid) => fs.rmSync(path.join(dir, String(pid)), { recursive: true, force: true }) };
}

export function emptyProc(dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fake-proc-"))) {
  fakeProc(dir);
  return dir;
}
