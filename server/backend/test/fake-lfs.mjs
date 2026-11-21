// A fake `git-lfs` for the project-setup tests. This Mac has no git-lfs; the project container ships it in its image. The
// fake docker runs `exec` LOCALLY, so a `git lfs …` there finds this program through PATH (git looks up `git-lfs` there).
// Harness, not a test: USED BY project-clone.test.js and projectbox-git-worktree.test.js.
//
//   fakeLfs(bin, log)   creates `<bin>/git-lfs`. It knows two subcommands:
//     ls-files [-n]         EVERY LFS file of the repo, fetched or not, like the real `git lfs ls-files`, which reads the tree, not the
//                           working tree (a pull without a new LFS file must still call `lfs pull`). Read from the index (real git,
//                           `ls-files -s -z`): the entries whose blob is an LFS pointer (`version https://git-lfs.github.com/spec/v1`,
//                           `cat-file -p`), one per line.
//     pull                  replaces every pointer IN THE WORKING TREE with `LFS-CONTENT <oid>` (as if the file came from the server;
//                           an already fetched one stays); if `<log>.fails` exists, it writes its content to stderr instead and
//                           exits with 2 (a server that does not hand out the objects).
//   Every call writes ONE JSON row to `log`: `{ command, cwd, ino, where, key, user, password, skip }` — `where` is the variable
//   IN_CONTAINER (projectbox-git-scenario.mjs sets it in the fake container), `ino` the inode of the cwd (a clone is put in
//   place with ONE rename: the same inode at the target), `key` the config keys from the environment (GIT_CONFIG_KEY_<i>, no
//   values), `user` the users of the credentials (test values), `password` only WHETHER one is present (never the value), `skip`
//   GIT_LFS_SKIP_SMUDGE.
//   lfsCalls(log) → the rows as a list.
//   pointer(oid) → the text of a pointer file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

export const pointer = (oid) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`;

export function fakeLfs(bin, log) {
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(log)) fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "git-lfs"), `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [command] = process.argv.slice(2);
const HEADER = "version https://git-lfs.github.com/spec/v1";
const GIT = ${JSON.stringify(REAL_GIT)};
const pointer = () => execFileSync(GIT, ["ls-files", "-z"], { encoding: "utf8" }).split("\\0").filter(Boolean)
  .filter((p) => { try { return fs.readFileSync(p, "utf8").startsWith(HEADER); } catch { return false; } });
// The LFS files at the index: "mode oid stage<TAB>path" per entry; gitlinks (160000) are not blobs.
const lfsFiles = () => execFileSync(GIT, ["ls-files", "-s", "-z"], { encoding: "utf8" }).split("\\0").filter(Boolean)
  .map((z) => { const tab = z.indexOf("\\t"); const [mode, oid] = z.slice(0, tab).split(" "); return { mode, oid, path: z.slice(tab + 1) }; })
  .filter((e) => { if (e.mode === "160000") return false; try { return execFileSync(GIT, ["cat-file", "-p", e.oid], { encoding: "utf8" }).startsWith(HEADER); } catch { return false; } })
  .map((e) => e.path);
const n = Number(process.env.GIT_CONFIG_COUNT || 0);
const key = [];
for (let i = 0; i < n; i++) key.push(process.env["GIT_CONFIG_KEY_" + i]);
const user = Object.keys(process.env).filter((k) => /^CBASE_GIT_USERNAME_\\d+$/.test(k)).sort().map((k) => process.env[k]);
const password = Object.keys(process.env).some((k) => /^CBASE_GIT_PASSWORD_\\d+$/.test(k) && process.env[k]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, cwd: process.cwd(), ino: fs.statSync(".").ino, where: process.env.IN_CONTAINER || null, key, user, password, skip: process.env.GIT_LFS_SKIP_SMUDGE ?? null }) + "\\n");
if (command === "ls-files") { for (const p of lfsFiles()) process.stdout.write(p + "\\n"); process.exit(0); }
if (command === "pull") {
  try { process.stderr.write(fs.readFileSync(${JSON.stringify(log)} + ".fails", "utf8")); process.exit(2); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const p of pointer()) {
    const oid = (fs.readFileSync(p, "utf8").match(/oid sha256:([0-9a-f]+)/) || [])[1] || "?";
    fs.writeFileSync(p, "LFS-CONTENT " + oid + "\\n");
  }
  process.exit(0);
}
process.stderr.write("fake git-lfs: unknown command “" + command + "”\\n");
process.exit(2);
`, { mode: 0o755 });
  return path.join(bin, "git-lfs");
}

/** From now on every `pull` fails with `text` on stderr (null: not any more). */
export function lfsFails(log, text) {
  if (text === null) fs.rmSync(`${log}.fails`, { force: true });
  else fs.writeFileSync(`${log}.fails`, text);
}
export const lfsCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
