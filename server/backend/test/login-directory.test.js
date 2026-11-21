// Guard for the shared login, backend side.
//
// server/backend/entry.sh moves `.credentials.json` from ~/.claude/ into the login directory at user-container start;
// CLAUDE_SECURESTORAGE_CONFIG_DIR (image ENV) points every CLI start at it. Two promises of the backend, each with the
// sabotage that breaks it:
//   (1) account/usage.js finds the file in the login directory as the FIRST candidate, only when the variable is set.
//       Without the variable (Mac, old state) the list is unchanged. Counter-test: the same layout without the variable
//       finds nothing (fetchUsageLimits would report "no Claude Code token found" and the usage ring would be missing).
//   (2) cleanClaudeEnv() — the environment of EVERY Claude child — lets the variable through. If it stripped it, each
//       chat turn would write its own ~/.claude/.credentials.json again (split brain on the next refresh).
// Everything runs with a temp HOME and a wrong file; the keychain is NEVER asked (only credentialsFileCredential, never
// claudeUsageCredential/fetchUsageLimits — on the Mac those ask `security` first).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { credentialsFileCredential, credentialsCandidates } from "../electron/server/account/usage.js";
import { cleanClaudeEnv } from "../electron/server/providers/connectors/claude.js";

const VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
const WRONG = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "wrong", expiresAt: 4102444800000 } });

async function withHome(fn) {
  const saved = { HOME: process.env.HOME, [VAR]: process.env[VAR] };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-login-"));
  try {
    process.env.HOME = home;
    delete process.env[VAR];
    assert.equal(os.homedir(), home, "os.homedir() does not follow HOME — the test would read the real home");
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("candidate list: login directory first, only with the variable set", () => {
  const home = "/home/agent";
  assert.deepEqual(credentialsCandidates({ [VAR]: "/home/agent/.claude-login" }, home), [
    "/home/agent/.claude-login/.credentials.json",
    "/home/agent/.claude/.credentials.json",
    "/home/agent/.config/claude/.credentials.json",
  ]);
  const without = ["/home/agent/.claude/.credentials.json", "/home/agent/.config/claude/.credentials.json"];
  assert.deepEqual(credentialsCandidates({}, home), without, "without the variable (Mac) the list stays as it was");
  assert.deepEqual(credentialsCandidates({ [VAR]: "" }, home), without, "empty means ~/.claude for the CLI — it is in the list anyway");
});

test("usage.js finds the file in the login directory — counter-test: without the variable it finds nothing", async () => {
  await withHome(async (home) => {
    const login = path.join(home, ".claude-login");
    fs.mkdirSync(login, { mode: 0o700 });
    fs.writeFileSync(path.join(login, ".credentials.json"), WRONG("wrong-from-login"), { mode: 0o600 });

    assert.equal(credentialsFileCredential(), null, "without the variable the login directory must not be found");
    process.env[VAR] = login;
    assert.deepEqual(credentialsFileCredential(), { token: "wrong-from-login", expiresAt: 4102444800000 });
  });
});

test("with both locations present the login directory wins (the CLI writes there); the old location alone is still found", async () => {
  await withHome(async (home) => {
    const login = path.join(home, ".claude-login");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), WRONG("wrong-old"));
    process.env[VAR] = login;
    assert.equal(credentialsFileCredential()?.token, "wrong-old", "before the move (login directory empty) the old location stays readable");
    fs.mkdirSync(login);
    fs.writeFileSync(path.join(login, ".credentials.json"), WRONG("wrong-new"));
    assert.equal(credentialsFileCredential()?.token, "wrong-new");
  });
});

test("cleanClaudeEnv lets CLAUDE_SECURESTORAGE_CONFIG_DIR through", async () => {
  await withHome(async (home) => {
    process.env[VAR] = path.join(home, ".claude-login");
    const env = cleanClaudeEnv();
    assert.equal(env[VAR], path.join(home, ".claude-login"), "the environment of every Claude child loses the login location");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "and still strips what it should strip");
    delete process.env[VAR];
    assert.equal(VAR in cleanClaudeEnv(), false, "without the variable cleanClaudeEnv sets none");
  });
});
