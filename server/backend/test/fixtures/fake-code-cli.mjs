#!/usr/bin/env node
// Replica of the VS Code CLI for vscode-tunnel.test.js - exactly the outputs vscode-tunnel.js reads (measured on 1.137.0), and a
// file-system protocol with which the test plays the human (VSCODE_CLI_DATA_DIR is the directory):
//   account      signed in (written by `user login`, removed by `user logout`)
//   login-ok     the human entered the device code -> login ends with 0
//   login-fail   the code has expired -> login ends with 1
//   crash-once   the running tunnel ends with code 3 (the file is consumed)
//   registered   the machine is registered with the service (removed by `unregister`)
// As in the original the account is bound to the HOSTNAME (cli/src/auth.rs encrypts token.json with `gethostname()`):
// `account` carries the host name it was written under in line 2, and under another one it is unreadable ("not logged in") -
// unless VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT was set when writing, then "-" stands there and it reads everywhere.
// FAKE_CODE_HOSTNAME plays the container swap (new id = new host name).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = process.env.VSCODE_CLI_DATA_DIR;
if (!dir) { process.stderr.write("VSCODE_CLI_DATA_DIR missing\n"); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const f = (n) => path.join(dir, n);
const hostname = () => process.env.FAKE_CODE_HOSTNAME || os.hostname();
const accountWrite = (prov) => fs.writeFileSync(f("account"), `${prov}\n${process.env.VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT ? "-" : hostname()}\n`);
// Returns the provider, or "" if there is no account OR it lies under another host name.
const readAccount = () => {
  if (!fs.existsSync(f("account"))) return "";
  const [prov, host] = fs.readFileSync(f("account"), "utf8").split("\n");
  return host === "-" || host === hostname() ? prov : "";
};
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (files) => { for (;;) { for (const d of files) if (fs.existsSync(f(d))) return d; await sleep(40); } };
process.on("SIGTERM", () => process.exit(0));

if (args[0] === "--version") { process.stdout.write("code 1.137.0 (commit 645f29cc3176500b4b5762ba887cf2a7f0ffdf2c)\n"); process.exit(0); }
if (args[0] !== "tunnel") { process.stderr.write(`unbekannt: ${args.join(" ")}\n`); process.exit(2); }

const sub = args.slice(1);
if (sub[0] === "user" && sub[1] === "show") {
  const prov = readAccount();
  if (prov) { process.stdout.write(`logged in as tester (${prov})\n`); process.exit(0); }
  process.stdout.write("not logged in\n"); process.exit(1);
}
if (sub[0] === "user" && sub[1] === "logout") {
  if (!fs.existsSync(f("account"))) { process.stdout.write("[x] error error updating keyring: No matching entry found in secure storage\n"); process.exit(1); }
  fs.rmSync(f("account")); process.exit(0);
}
if (sub[0] === "user" && sub[1] === "login") {
  const prov = sub[sub.indexOf("--provider") + 1] || "github";
  process.stdout.write(`To grant access to the server, please log into https://${prov === "microsoft" ? "microsoft.com/devicelogin" : "github.com/login/device"} and use code AB12-CD34\n`);
  const what = await waitFor(["login-ok", "login-fail"]);
  if (what === "login-fail") { process.stdout.write("[x] error login failed: authorization expired\n"); process.exit(1); }
  accountWrite(prov); fs.rmSync(f("login-ok")); process.exit(0);
}
if (sub[0] === "unregister") { fs.rmSync(f("registered"), { force: true }); process.exit(0); }
if (sub[0] === "status") { process.stdout.write(JSON.stringify({ tunnel: fs.existsSync(f("registered")) ? { name: "x" } : null, service_installed: false }) + "\n"); process.exit(0); }

// `code tunnel --accept-server-license-terms --name <name>`: banner with \r\n like the original.
const name = sub[sub.indexOf("--name") + 1] || "";
if (!sub.includes("--accept-server-license-terms")) { process.stdout.write("Do you accept the terms? [y/N]\r\n"); await sleep(3_600_000); }
process.stdout.write("*\r\n* Visual Studio Code Server\r\n*\r\n");
if (!readAccount()) {
  process.stdout.write("[x] info Using GitHub for authentication, run `code tunnel user login --provider <provider>` option to change this.\n");
  process.stdout.write("To grant access to the server, please log into https://github.com/login/device and use code AB12-CD34\n");
  await waitFor(["login-ok"]);
  accountWrite("github"); fs.rmSync(f("login-ok"));
}
if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(name)) { process.stdout.write("[x] error Invalid machine name: " + name + "\n"); process.exit(1); }
await sleep(60);
fs.writeFileSync(f("registered"), name);
process.stdout.write(`Open this link in your browser https://vscode.dev/tunnel/${name}/home/tester\n`);
// A warn line with the word "error" in it, as the real CLI writes it at the first client -
// it is NOT an error and must not set the pill to "error".
process.stdout.write("[2026-09-11 21:06:21] warn [rpc.1] error handling call: NoAttachedServerError(NoAttachedServerError)\n");
// Runs until SIGTERM comes - or until the test orders the crash (crash-once is consumed).
await waitFor(["crash-once"]);
fs.rmSync(f("crash-once"));
process.stdout.write("[x] error tunnel connection lost\n");
process.exit(3);
