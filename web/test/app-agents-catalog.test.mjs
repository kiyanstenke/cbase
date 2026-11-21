// The three catalogs of the app agents: one truth, three places.
//
// Which internal LLM tasks exist is written three times in the repo:
//   1. `AGENT_MODEL_KEYS`  — server/backend/electron/server/settings/agent-models.js (the truth: only a key from
//      here is read and written as `agent_model_<key>`)
//   2. `AGENTS`            — web/src/components/settings/AgentModelSettings.tsx (the picker on the web)
//   3. `Self.entries`      — mobile/…/Settings/AgentModelSettings.swift (the same picker on mobile)
//
// If a key is missing in 2 or 3, the task is NOT SETTABLE in that surface: the picker has no free text, there is no
// error message, and the user sees only a list that looks complete. That has happened twice: `workflow` was missing
// on the WEB (the model of all workflow verdicts was selectable nowhere), and later on the IPHONE, the same bug one
// client further. The header of agent-models.js carries the trap word for word ("AGENT_MODEL_KEYS and the catalog in
// AgentModelSettings.tsx are TWO lists") and names only TWO of the three lists. **A comment is not a guard.** This
// is one.
//
// What is bound and what is not:
//   · the SET of keys: all three identical. Binding.
//   · label and description between web and iOS: byte-equal for all shared keys today. Binding: an improved
//     explanation on the web that the iPhone does not get is the same duplication one level deeper.
//   · the ORDER: deliberately NOT binding. It differs in all three lists, each time with a reason (backend by
//     origin, web with the architecture roles at the end, iOS with the manager roles at the end). An order promise
//     here would not be a truth but a matter of taste with test coverage.
//   · `AGENT_MODEL_DEFAULTS`: the same key set. A key without default reads `undefined` as "Auto" and cannot be told
//     from a deliberately empty default ("").
//
// Reading goes BY PATH (model: web/test/effort.test.mjs, credit.test.mjs); whoever moves one of the two client files
// adjusts the line here. The backend list is IMPORTED.
//
// Run:  node --test web/test/app-agents-catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_MODEL_DEFAULTS,
  AGENT_MODEL_KEYS,
} from "../../server/backend/electron/server/settings/agent-models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_WEB = path.join(repo, "web", "src", "components", "settings", "AgentModelSettings.tsx");
const SOURCE_IOS = path.join(repo, "mobile", "CbaseMobile", "Settings", "AgentModelSettings.swift");

const read = (p) => fs.readFileSync(p, "utf8");

// The blocks are anchored AT THE NAME OF THE DECLARATION, and a missed anchor THROWS instead of returning an empty
// list. The classic here: someone renames `AGENTS` or writes the type annotation differently, the regex grabs
// nothing, the set is empty, and an empty set equals every other empty set. The test would be green and have
// measured nothing.
function webCatalog() {
  const source = read(SOURCE_WEB);
  const block = source.match(/const AGENTS: \{[^}]*\}\[\] = \[\n([\s\S]*?)\n\];/);
  assert.ok(
    block,
    `Declaration "const AGENTS: { … }[] = [" not found in ${path.relative(repo, SOURCE_WEB)} — ` +
      "renamed or reformatted? Adjust the anchor here, do NOT delete the test.",
  );
  return [...block[1].matchAll(/\{ key: "([^"]+)", label: "([^"]*)", desc: "([^"]*)" \}/g)].map((m) => ({
    key: m[1],
    label: m[2],
    desc: m[3],
  }));
}

function iosCatalog() {
  const source = read(SOURCE_IOS);
  const block = source.match(
    /private static let entries: \[\(key: String, label: String, desc: String\)\] = \[\n([\s\S]*?)\n {4}\]/,
  );
  assert.ok(
    block,
    `Declaration "private static let entries: [(key:…)] = [" not found in ${path.relative(repo, SOURCE_IOS)} — ` +
      "renamed or reformatted? Adjust the anchor here, do NOT delete the test.",
  );
  return [...block[1].matchAll(/\("([^"]+)", "([^"]*)", "([^"]*)"\)/g)].map((m) => ({
    key: m[1],
    label: m[2],
    desc: m[3],
  }));
}

// Lower bound instead of a fixed number: it does not age when a 14th app agent is added, but catches the case "regex
// matches but finds only two entries", the silent death of every source-text measurement. Today there are 9, and the
// bound stands EXACTLY on it: a lower bound with air below it lets the loss of an agent pass silently. Whoever
// removes an agent on purpose lowers the number in the same step; that is the point of the red test.
const AT_LEAST = 9;

test("app agents: the three catalogs carry the same keys", () => {
  const web = webCatalog();
  const ios = iosCatalog();

  assert.ok(AGENT_MODEL_KEYS.length >= AT_LEAST, `backend: only ${AGENT_MODEL_KEYS.length} keys`);
  assert.ok(web.length >= AT_LEAST, `web catalog: only ${web.length} entries; does the regex still match?`);
  assert.ok(ios.length >= AT_LEAST, `iOS catalog: only ${ios.length} entries; does the regex still match?`);

  console.log(
    `  [app agents] ${AGENT_MODEL_KEYS.length} keys in the backend, ${web.length} in the web picker, ${ios.length} in the iOS picker`,
  );

  const backend = [...AGENT_MODEL_KEYS].sort();
  const missingInWeb = backend.filter((k) => !web.some((e) => e.key === k));
  const missingOnIos = backend.filter((k) => !ios.some((e) => e.key === k));
  const onlyInWeb = web.map((e) => e.key).filter((k) => !AGENT_MODEL_KEYS.includes(k));
  const onlyOnIos = ios.map((e) => e.key).filter((k) => !AGENT_MODEL_KEYS.includes(k));

  assert.deepEqual(
    missingInWeb,
    [],
    "These app agents are not settable on the WEB (the picker has no free text, " +
      "the user never sees the gap): " + missingInWeb.join(", "),
  );
  assert.deepEqual(
    missingOnIos,
    [],
    "These app agents are not settable on the IPHONE (the picker has no free text, " +
      "the user never sees the gap): " + missingOnIos.join(", "),
  );
  assert.deepEqual(
    onlyInWeb,
    [],
    "The web picker offers keys that the backend does not know (the choice lands in " +
      "app_settings and is never read): " + onlyInWeb.join(", "),
  );
  assert.deepEqual(
    onlyOnIos,
    [],
    "The iOS picker offers keys that the backend does not know (the choice lands in " +
      "app_settings and is never read): " + onlyOnIos.join(", "),
  );

  // The order is DELIBERATELY free (see header); the set is checked.
  assert.deepEqual(web.map((e) => e.key).sort(), backend, "web set != backend set");
  assert.deepEqual(ios.map((e) => e.key).sort(), backend, "iOS set != backend set");
});

test("app agents: web and iOS explain every agent in the same words", () => {
  const web = new Map(webCatalog().map((e) => [e.key, e]));
  const ios = iosCatalog();
  assert.ok(ios.length >= AT_LEAST, "iOS catalog empty; see anchor");

  for (const e of ios) {
    const w = web.get(e.key);
    assert.ok(w, `"${e.key}" stands only in the iOS catalog`);
    assert.equal(e.label, w.label, `label of "${e.key}" diverges (web ≠ iOS)`);
    assert.equal(
      e.desc,
      w.desc,
      `explanation of "${e.key}" diverges: an improvement on the web that the iPhone does not get`,
    );
  }
});

test("app agents: every key has a default, a label and an explanation", () => {
  const defaults = Object.keys(AGENT_MODEL_DEFAULTS).sort();
  assert.deepEqual(
    defaults,
    [...AGENT_MODEL_KEYS].sort(),
    "AGENT_MODEL_DEFAULTS and AGENT_MODEL_KEYS are two lists: a key without an entry reads " +
      "undefined as \"Auto\" and cannot be told from a deliberately empty default (empty string)",
  );
  for (const e of [...webCatalog(), ...iosCatalog()]) {
    assert.ok(e.label.trim(), `"${e.key}" without label`);
    assert.ok(e.desc.trim(), `"${e.key}" without explanation`);
  }
});

// The app agent `channel_status` is the role "summary on request" for ANY reader of a chat, no longer the channel status
// of a manager agent. The key stays (stored choice `agent_model_channel_status`); label and explanation follow in both
// pickers and both translation tables. The old tool name `cbase_channel_status` is gone; an explanation that names it
// would point nowhere.
const RETRIEVAL = "Summary on request";
test("app agents: channel_status is called \"Summary on request\" in web, iOS and both translations", () => {
  for (const [location, catalog] of [["Web", webCatalog()], ["iOS", iosCatalog()]]) {
    const e = catalog.find((x) => x.key === "channel_status");
    assert.ok(e, `${location}: channel_status is missing`);
    assert.equal(e.label, RETRIEVAL, `${location}: label`);
    assert.doesNotMatch(e.desc, /cbase_channel_status|manager agent/i, `${location}: the explanation still names the old role`);
    assert.match(e.desc, /for any reader/, `${location}: the explanation does not say that it applies to any reader`);
  }
  const desc = webCatalog().find((x) => x.key === "channel_status").desc;
  const tables = [
    ["Web", path.join(repo, "web", "src", "lib", "i18n-de.ts")],
    ["iOS", path.join(repo, "mobile", "CbaseMobile", "Kit", "LocDEMobile.swift")],
  ];
  for (const [location, file] of tables) {
    const t = read(file);
    for (const k of [RETRIEVAL, desc]) assert.ok(t.includes(`${JSON.stringify(k)}:`), `${location} translation is missing for ${k.slice(0, 60)}`);
    assert.doesNotMatch(t, /: "Kanal: Status",/, `${location}: the old label is still in the translation`);
  }
});
