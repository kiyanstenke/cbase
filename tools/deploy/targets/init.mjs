// `./deploy init` — the first installation on the host. The deploy tool otherwise assumes that the installation exists: the root with
// its folders, the systemd user unit (deployGateway needs a unit or a running process), the folder of the gateway code.
//
// What it does, in ONE ssh script (so a dry run shows every command):
//   · creates <root>/{releases,data,secrets,backups,gateway,web-out}; `secrets` mode 700
//   · writes the unit ~/.config/systemd/user/cbase-gateway.service from tools/deploy/templates/cbase-gateway.service
//     (@ROOT@ @PORT@ @IMAGE@ from the configuration) and runs `systemctl --user daemon-reload`
// What it does NOT do: start or enable the unit, touch Docker, roll out any code, create users.
//
// Refuses when the root or the unit already exists — unless `--force` (then the folders are only completed with `mkdir -p`, an
// existing unit is moved aside as `<unit>.bak-<release>` first; nothing is ever deleted). Refuses a configuration that carries the
// identity of a foreign installation the private part knows (config.mjs assertOwnInstallation) and values that do not fit the script (path, port, image).
// Guard: tools/deploy/init.test.mjs (fake ssh).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertOwnInstallation } from "../config.mjs";
import { isDryRun } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "../lib/ssh.mjs";
import * as log from "../../check/lib/log.mjs";

export const UNIT_NAME = "cbase-gateway.service";
export const UNIT_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../templates", UNIT_NAME);
export const ROOT_DIRS = ["releases", "data", "secrets", "backups", "gateway", "web-out"];
const UNIT_FILE = `$HOME/.config/systemd/user/${UNIT_NAME}`;
const SYSTEMCTL = `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user`;

/** Pure: the values must fit the script (they stand in a heredoc and in paths) — throws with the reason. */
export function assertInitValues({ root, port, image, node = "/usr/bin/node" }) {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(node) || node.includes("..")) throw new Error(`init: remote.node must be an absolute path of plain characters, not "${node}"`);
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(root) || root.includes("..") || root === "/") throw new Error(`init: remote.root must be an absolute path of plain characters, not "${root}"`);
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error(`init: remote.gatewayPort must be an integer from 1024 to 65535, not "${port}"`);
  if (!/^[a-z0-9][a-z0-9._\/-]*$/.test(image)) throw new Error(`init: remote.image must be a plain image name, not "${image}"`);
}

/** Pure: the unit text from the template. Every placeholder must be gone afterwards. */
export function renderUnit(template, { root, port, image, node = "/usr/bin/node" }) {
  const text = template.replaceAll("@ROOT@", root).replaceAll("@PORT@", String(port)).replaceAll("@IMAGE@", image).replaceAll("@NODE@", node);
  const left = text.match(/@[A-Z]+@/);
  if (left) throw new Error(`init: placeholder ${left[0]} of the unit template is not filled`);
  return text;
}

/** Pure: the script of the real step. `moveAside` is the suffix for an existing unit (--force), null when there is none. */
export function initScript({ root, unitText, moveAside = null }) {
  const dirs = ROOT_DIRS.map((d) => `${root}/${d}`).join(" ");
  const lines = [
    `mkdir -p ${dirs}`,
    `chmod 700 ${root}/secrets`,
    `mkdir -p "$HOME/.config/systemd/user"`,
  ];
  if (moveAside) lines.push(`[ ! -e "${UNIT_FILE}" ] || mv "${UNIT_FILE}" "${UNIT_FILE}.bak-${moveAside}"`);
  lines.push(`cat > "${UNIT_FILE}" <<'CBASE_UNIT_EOF'\n${unitText.replace(/\n$/, "")}\nCBASE_UNIT_EOF`);
  lines.push(`${SYSTEMCTL} daemon-reload`);
  return lines.join("\n");
}

export async function init({ force = false, release = "init" } = {}) {
  const { root, gatewayPort: port, image, node } = config.remote;
  await assertOwnInstallation(config.remote);
  assertInitValues({ root, port, image, node });
  const unitText = renderUnit(fs.readFileSync(UNIT_TEMPLATE, "utf8"), { root, port, image, node });

  log.step("First installation: look at the host");
  const seen = (await sshProbe(`test -e ${root} && echo root; test -e "${UNIT_FILE}" && echo unit; true`)).stdout.split("\n").map((s) => s.trim());
  const hasRoot = seen.includes("root");
  const hasUnit = seen.includes("unit");
  if ((hasRoot || hasUnit) && !force) {
    throw new Error(`init refused: ${[hasRoot && `${root} exists`, hasUnit && `the unit ${UNIT_NAME} exists`].filter(Boolean).join(" and ")} — the installation is there already. --force only completes the folders and moves an existing unit aside.`);
  }
  if (hasRoot || hasUnit) log.warn(`--force: ${hasRoot ? "root exists (folders are completed)" : ""}${hasRoot && hasUnit ? ", " : ""}${hasUnit ? "unit exists (moved aside)" : ""}`);

  log.step("First installation: root, folders, unit");
  await sshAct(initScript({ root, unitText, moveAside: hasUnit ? release : null }));
  if (isDryRun()) return;
  log.ok(`Installation prepared under ${root} (gateway port ${port}); the unit ${UNIT_NAME} is written, not started`);
  log.detail("next: ./deploy server --gateway (code), then start the unit by hand once");
}
