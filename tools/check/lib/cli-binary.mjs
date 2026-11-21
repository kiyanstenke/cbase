// The Claude binary of one version for THIS machine, reproducibly from the npm platform package
// (`@anthropic-ai/claude-code-<platform>-<arch>@<v>`, sha256 of the binary returned). A leaf: it serves the baseline tool of the
// private part and the generator of the journal fixture (server/backend/test/fixtures/dynworkflows-journal/generate.mjs).
// The gate itself never calls it (the clone has neither the CLI nor network for it).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probe } from "./sh.mjs";

export const CACHE = path.join(os.homedir(), ".cache", "cbase-baseline");

export function platformPackage(version, platform = process.platform, arch = process.arch) {
  const p = { darwin: "darwin", linux: "linux", win32: "win32" }[platform];
  if (!p || !["x64", "arm64"].includes(arch)) throw new Error(`No Claude binary for ${platform}-${arch}`);
  return `@anthropic-ai/claude-code-${p}-${arch}@${version}`;
}

export async function binaryFor(version) {
  const pack = platformPackage(version);
  const target = path.join(CACHE, pack.replace(/[@/]/g, "_"));
  const bin = path.join(target, "package", process.platform === "win32" ? "claude.exe" : "claude");
  if (!fs.existsSync(bin)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    await probe("npm", ["pack", pack, "--pack-destination", target], { cwd: target, check: true });
    const tgz = fs.readdirSync(target).find((n) => n.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack ${pack} produced no archive`);
    await probe("tar", ["-xzf", path.join(target, tgz), "-C", target], { check: true });
    fs.rmSync(path.join(target, tgz));
  }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(bin)).digest("hex");
  const v = await probe(bin, ["--version"], { timeout: 60000 });
  const reported = (v.stdout.match(/\d+\.\d+\.\d+/) || [""])[0];
  if (reported !== version) throw new Error(`${pack}: the binary reports "${v.stdout.trim()}" instead of ${version}`);
  return { bin, pack, sha256 };
}
