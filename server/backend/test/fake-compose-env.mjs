// The fake `env` of the layout tests; shared by two tests (a `.test.js` never imports another one). Not a test, hence .mjs.
//
// It never calls a real docker: it only emulates `compose … config --format json --no-interpolate` and hands every other
// call through to /usr/bin/env.
// USED BY: layout-check.test.js, layout-procedure.test.js.

// The fake `env` (first in PATH): `env [-u NAME]… docker compose <global> config --format json --no-interpolate` emulates
// Compose's naming rule: -p > environment > `--env-file` or `<dir>/.env` > `name:` > directory. Every call is logged with
// its arguments and the environment value it saw in `log`. Everything else goes to /usr/bin/env.
export const FAKE_ENV = (log) => `#!${process.execPath}
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const env = { ...process.env };
let i = 0; const unset = [];
while (argv[i] === "-u") { unset.push(argv[i + 1]); delete env[argv[i + 1]]; i += 2; }
const rest = argv.slice(i);
if (rest[0] !== "docker" || rest[1] !== "compose") { const r = spawnSync("/usr/bin/env", argv, { stdio: "inherit" }); process.exit(r.status === null ? 1 : r.status); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, unset, environment: env.COMPOSE_PROJECT_NAME === undefined ? null : env.COMPOSE_PROJECT_NAME }) + "\\n");
let p = null, pd = null; const f = [], ef = [], otherwise = [];
for (let j = 2; j < rest.length; j++) { const a = rest[j]; if (a === "-p") p = rest[++j]; else if (a === "--project-directory") pd = rest[++j]; else if (a === "-f") f.push(rest[++j]); else if (a === "--env-file") ef.push(rest[++j]); else otherwise.push(a); }
if (otherwise.join(" ") !== "config --format json --no-interpolate" || !pd || !f.length) { process.stderr.write("fake env: only compose --project-directory … -f … config --format json --no-interpolate\\n"); process.exit(125); }
const fromFile = (d) => { try { for (const z of fs.readFileSync(d, "utf8").split("\\n")) { const m = /^COMPOSE_PROJECT_NAME=(.*)$/.exec(z.trim()); if (m) return m[1]; } } catch {} return null; };
const fromComposeFile = () => { for (const d of f) { try { for (const z of fs.readFileSync(d, "utf8").split("\\n")) { const m = /^name:[ \\t]*["']?([^"'\\s]+)["']?[ \\t]*$/.exec(z); if (m) return m[1]; } } catch {} } return null; };
const norm = (s) => s.toLowerCase().replace(/[^-_a-z0-9]+/g, "").replace(/^[_-]+/, "");
const fromEnvVar = ef.length ? ef.map(fromFile).find(Boolean) : fromFile(path.join(pd, ".env"));
const name = p || env.COMPOSE_PROJECT_NAME || fromEnvVar || fromComposeFile() || norm(path.basename(pd));
process.stdout.write(JSON.stringify({ name, services: {} }) + "\\n");
`;
