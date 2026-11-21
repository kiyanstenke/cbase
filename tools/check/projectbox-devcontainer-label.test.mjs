// The label `devcontainer.metadata` on the project-box image. The VS Code pill opens main and copies of a project as a
// Dev Containers window ("attach" behind the tunnel); on attaching, the extension reads this label of the IMAGE and takes user and
// settings from it. It REDUCES what the window carries from the Mac into the container (no .gitconfig copy, no git/docker
// credential helper, no git terminal/GitHub login) — it is no lock: while the window is open, processes in the container can
// ask for the Mac's access.
//
// Promises:
//   - exactly ONE label `devcontainer.metadata` in the whole Dockerfile, and it stands in the stage `projectbox` — NOT in `base`
//     (else `backend` would inherit it) and not in `backend`: the user container B must not carry it;
//   - its value is valid JSON, an array with exactly one object, `remoteUser` = agent, the five settings with the expected values;
//   - no LABEL row of the Dockerfile sets a key with `cbase.` (projectbox/own-labels.js: cbase sets its labels only on the
//     container; an inherited image label `cbase.*` would make containers invisible during a relocation), and no `cbase.` key
//     stands IN the JSON either.
// The check is a pure function over the Dockerfile text (parser from lib/projectbox.mjs, like the deploy); the sabotages run in every
// run (label in backend, in base, duplicate, broken JSON, wrong user, cbase. key).
// COUNTER-PROOF: the label in the real Dockerfile moved from `projectbox` to `backend` => the first test red; a Dockerfile without
// the label => red.
//
// Run:  node --test --test-reporter=tap tools/check/projectbox-devcontainer-label.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BACKEND_STAGE, PROJECTBOX_STAGE, dockerfileStages, stagesChain } from "./lib/projectbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = path.resolve(HERE, "..", "..", "server", "backend", "Dockerfile");
const KEY = "devcontainer.metadata";
const EXPECTED = {
  "dev.containers.copyGitConfig": false,
  "dev.containers.gitCredentialHelperConfigLocation": "none",
  "dev.containers.dockerCredentialHelper": false,
  "git.terminalAuthentication": false,
  "github.gitAuthentication": false,
};

// The keys of a LABEL instruction (`k=v k2="v 2" k3='v3'`); values in '…' or "…" as one piece.
function labelPairs(raw) {
  const out = [];
  const re = /([^\s=]+)=('([^']*)'|"((?:[^"\\]|\\.)*)"|(\S*))/g;
  let m;
  while ((m = re.exec(raw))) out.push([m[1], m[3] ?? (m[4] !== undefined ? m[4].replace(/\\(.)/g, "$1") : m[5])]);
  return out;
}

function hasCbaseKey(x) {
  if (Array.isArray(x)) return x.some(hasCbaseKey);
  if (x && typeof x === "object") return Object.entries(x).some(([k, v]) => k.startsWith("cbase.") || hasCbaseKey(v));
  return false;
}

/** The errors of the label in a Dockerfile text; [] = all good. */
export function devcontainerLabelError(text) {
  const error = [];
  const stages = dockerfileStages(text);
  const fund = [];
  for (const st of stages) {
    for (const a of st.instructions) {
      if (a.op !== "LABEL") continue;
      for (const [k, v] of labelPairs(a.raw.replace(/^LABEL\s+/i, ""))) {
        if (k.startsWith("cbase.")) error.push(`LABEL ${k} in stage ${st.name} (cbase sets its labels only on the container)`);
        if (k === KEY) fund.push({ stage: st.name, value: v, row: a.row });
      }
    }
  }
  if (fund.length !== 1) error.push(`${fund.length} labels ${KEY} instead of exactly one`);
  for (const f of fund) if (f.stage !== PROJECTBOX_STAGE) error.push(`${KEY} in stage ${f.stage} (row ${f.row}), not in ${PROJECTBOX_STAGE}`);
  // The backend's chain (base → backend) must not carry the label — not even via a stage it inherits from.
  for (const st of stagesChain(stages, BACKEND_STAGE)) if (fund.some((f) => f.stage === st.name)) error.push(`the stage ${BACKEND_STAGE} inherits ${KEY} from ${st.name}`);
  const f = fund.find((x) => x.stage === PROJECTBOX_STAGE);
  if (!f) return error;
  let value;
  try { value = JSON.parse(f.value); } catch (e) { error.push(`${KEY}: not valid JSON — ${e.message}`); return error; }
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") { error.push(`${KEY}: not an array with exactly one object`); return error; }
  if (value[0].remoteUser !== "agent") error.push(`${KEY}: remoteUser is "${value[0].remoteUser}", not agent`);
  const settings = value[0].customizations?.vscode?.settings ?? {};
  for (const [k, v] of Object.entries(EXPECTED)) if (settings[k] !== v) error.push(`${KEY}: ${k} is ${JSON.stringify(settings[k])}, not ${JSON.stringify(v)}`);
  if (hasCbaseKey(value)) error.push(`${KEY}: a key with cbase. in the JSON`);
  return error;
}

const TEXT = fs.readFileSync(DOCKERFILE, "utf8");

test("the Dockerfile: exactly one devcontainer.metadata in projectbox, valid JSON, remoteUser agent, five settings, no cbase.", () => {
  assert.deepEqual(devcontainerLabelError(TEXT), []);
});

test("sabotages: label in backend, in base, duplicate, without, broken JSON, wrong user, setting missing, cbase. key", () => {
  const rows = TEXT.split("\n");
  const i = rows.findIndex((z) => z.startsWith(`LABEL ${KEY}=`));
  assert.ok(i >= 0, "the label line stands in one line");
  const label = rows[i];
  const without = rows.filter((_, j) => j !== i).join("\n");
  const after = (target, z = label) => without.replace(new RegExp(`^(FROM \\S+ AS ${target})$`, "m"), `$1\n${z}`);
  const cases = {
    "in backend": after(BACKEND_STAGE),
    "in base": after("base"),
    "duplicate": after(PROJECTBOX_STAGE, `${label}\n${label}`),
    "without": without,
    "broken JSON": after(PROJECTBOX_STAGE, label.replace("[{", "[{,")),
    "wrong user": after(PROJECTBOX_STAGE, label.replace('"remoteUser":"agent"', '"remoteUser":"root"')),
    "setting missing": after(PROJECTBOX_STAGE, label.replace('"github.gitAuthentication":false', '"github.gitAuthentication":true')),
    "cbase. key in the JSON": after(PROJECTBOX_STAGE, label.replace('"remoteUser"', '"cbase.x":1,"remoteUser"')),
    "cbase. label": after(PROJECTBOX_STAGE, `${label}\nLABEL cbase.project=x`),
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.notEqual(text, TEXT, `sabotage "${name}" changed nothing`);
    assert.ok(devcontainerLabelError(text).length > 0, `sabotage "${name}" stays green`);
  }
});
