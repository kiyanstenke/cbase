// SSH and rsync to the deployment host — the installation-specific half of the shell helpers (config.mjs: SSH host, key).
// The generic half (probe, act, exec, dry run) lives in sh.mjs and needs no configuration.
import { config, requireSsh } from "../config.mjs";
import * as log from "../../check/lib/log.mjs";
import { act, probe, exec, isDryRun, CommandError } from "../../check/lib/sh.mjs";

export function sshArgs() {
  const s = requireSsh();
  return [
    "-i",
    s.key,
    "-o",
    `UserKnownHostsFile=${s.knownHosts}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    s.host,
  ];
}

// Script via stdin to `bash -s` — no quoting circus needed, and multi-line scripts work unchanged.
export async function sshRun(runner, script, opts = {}) {
  const args = [...sshArgs(), "bash", "-s"];
  if (runner === act && isDryRun()) {
    log.cmdLine(`[dry run] ssh ${config.ssh.host} <<'EOF'\n${script.trim()}\nEOF`);
    return { code: 0, stdout: "", stderr: "", skipped: true };
  }
  log.trace(`ssh << ${script.trim()}`);
  return runner === act
    ? exec("ssh", args, { input: `set -euo pipefail\n${script}`, ...opts }).then((r) => {
        if (opts.check !== false && r.code !== 0) throw new CommandError("ssh", r.code, r.stderr);
        return r;
      })
    : probe("ssh", args, { input: `set -euo pipefail\n${script}`, ...opts });
}

export const sshProbe = (script, opts) => sshRun(probe, script, opts);
export const sshAct = (script, opts) => sshRun(act, script, opts);

export function sshTransport() {
  const s = requireSsh();
  return `ssh -i ${s.key} -o UserKnownHostsFile=${s.knownHosts} -o BatchMode=yes -o ConnectTimeout=10`;
}

// rsync to the server. `del:true` only where deleting is wanted — NOT for web-out (open sessions would
// otherwise fetch _next chunks that no longer exist).
export async function rsyncUp(localDir, remoteDir, { del = false, dryRunOnly = false, extraExcludes = [] } = {}) {
  const args = ["-r", "--checksum", "--times", "--exclude", "node_modules", "--exclude", ".DS_Store"];
  for (const ex of extraExcludes) args.push("--exclude", ex);
  if (del) args.push("--delete");
  if (dryRunOnly) args.push("-n", "-i");
  args.push("-e", sshTransport(), localDir, `${config.ssh.host}:${remoteDir}`);
  return dryRunOnly ? probe("rsync", args) : act("rsync", args);
}
