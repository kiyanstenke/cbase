// VERSIONING.md is the one source of the versioning policy, and its numbers are the code's numbers.
//
// PROMISES:
//   (1) every place that used to explain versions itself links VERSIONING.md: CONTRIBUTING.md, CHANGELOG.md and DEPLOY.md as a
//       Markdown link, tools/version.mjs in its header comment
//   (2) VERSIONING.md names the API level module by its path, the module exists and exports API_LEVEL = { level, oldest } as
//       integers with 1 <= oldest <= level, and the deprecation window the document states is DEPRECATION_WINDOW_DAYS of that module
//   (3) the build number base the document states is BUILD_OFFSET of tools/version.mjs
//   (4) the fields the document lists for `GET /api/version` are exactly the keys the backend answers (readVersionInfo of
//       version.js), and those for `GET /gw/info` exactly the version fields of the gateway (infoVersionFields of build-info.js)
//
// tools/version.mjs is read as text (tools/check imports no other tool folder, public-closure.test.mjs); the API level module,
// the backend's version.js and the gateway's build-info.js are product code and are imported. Every anchor throws when it finds
// nothing.
//
// COUNTER-PROOF (built in): each check is a pure function over texts; the test feeds it a document with the link, the path, the
// 90 or the 100 removed or changed, or a field list that names a field the code does not send (or misses one), and each must be
// named.
//
// Run:  node --test --test-reporter=tap tools/check/versioning-doc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const API_MODULE = "server/backend/electron/server/api-level.js";
const LINKERS = ["CONTRIBUTING.md", "CHANGELOG.md", "DEPLOY.md"];

function anchor(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`${what} not found (${re})`);
  return m;
}

/** Findings over the texts: [] when the document and the code agree. */
function findings({ doc, linkers, tool, apiModule, backendFields, gatewayFields }) {
  const out = [];
  for (const [file, text] of Object.entries(linkers)) if (!/\]\(VERSIONING\.md(#[^)]*)?\)/.test(text)) out.push(`${file} does not link VERSIONING.md`);
  const header = tool.split(/\nimport /)[0];
  if (!header.includes("VERSIONING.md")) out.push("tools/version.mjs: the header comment does not point to VERSIONING.md");
  if (!doc.includes(`\`${API_MODULE}\``)) out.push(`VERSIONING.md does not name the API level module ${API_MODULE}`);
  const offset = Number(anchor(tool, /^export const BUILD_OFFSET = (\d+);$/m, "BUILD_OFFSET in tools/version.mjs")[1]);
  if (!new RegExp(`\\*\\*${offset} \\+ the number of commits up to HEAD\\*\\*`).test(doc)) out.push(`VERSIONING.md does not state the build number base ${offset}`);
  const days = apiModule.DEPRECATION_WINDOW_DAYS;
  if (!new RegExp(`no earlier than \\*\\*${days} days\\*\\*`).test(doc)) out.push(`VERSIONING.md does not state the deprecation window of ${days} days`);
  for (const [route, keys] of [["/api/version", backendFields], ["/gw/info", gatewayFields]]) {
    const listed = [...anchor(doc, new RegExp(`\`GET ${route.replace(/\//g, "\\/")}\` \\(([^)]*)\\)`), `the field list of GET ${route} in VERSIONING.md`)[1]
      .matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (listed.join(",") !== keys.join(",")) out.push(`VERSIONING.md lists ${listed.join(", ")} for GET ${route}, the code sends ${keys.join(", ")}`);
  }
  return out;
}

async function real() {
  const apiModule = await import(pathToFileURL(path.join(REPO, API_MODULE)).href);
  const { readVersionInfo } = await import(pathToFileURL(path.join(REPO, "server/backend/electron/server/version.js")).href);
  const { infoVersionFields } = await import(pathToFileURL(path.join(REPO, "server/gateway/build-info.js")).href);
  return {
    doc: read("VERSIONING.md"),
    linkers: Object.fromEntries(LINKERS.map((f) => [f, read(f)])),
    tool: read("tools/version.mjs"),
    apiModule,
    backendFields: Object.keys(readVersionInfo()),
    gatewayFields: Object.keys(infoVersionFields(null, "0.0.0")),
  };
}

test("(1)-(4) VERSIONING.md is linked from every former explainer and agrees with the code's numbers", async (t) => {
  const texts = await real();
  assert.deepEqual(findings(texts), []);
  t.diagnostic(`BUILD_OFFSET ${texts.tool.match(/BUILD_OFFSET = (\d+)/)[1]}, deprecation window ${texts.apiModule.DEPRECATION_WINDOW_DAYS} days`);
});

test("(2) the API level module exports { level, oldest } as integers with 1 <= oldest <= level", async () => {
  const { apiModule } = await real();
  const { API_LEVEL } = apiModule;
  assert.ok(API_LEVEL && typeof API_LEVEL === "object", `${API_MODULE} does not export API_LEVEL`);
  assert.deepEqual(Object.keys(API_LEVEL).sort(), ["level", "oldest"]);
  assert.ok(Number.isInteger(API_LEVEL.level) && Number.isInteger(API_LEVEL.oldest), JSON.stringify(API_LEVEL));
  assert.ok(API_LEVEL.oldest >= 1 && API_LEVEL.oldest <= API_LEVEL.level, JSON.stringify(API_LEVEL));
  assert.ok(Number.isInteger(apiModule.DEPRECATION_WINDOW_DAYS) && apiModule.DEPRECATION_WINDOW_DAYS > 0);
});

test("counter-proof: a removed link, path or a changed number in the document or the code is named", async () => {
  const base = await real();
  const cases = [
    [{ linkers: { ...base.linkers, "DEPLOY.md": base.linkers["DEPLOY.md"].replaceAll("](VERSIONING.md)", "](OTHER.md)") } }, /DEPLOY\.md does not link/],
    [{ linkers: { ...base.linkers, "CHANGELOG.md": base.linkers["CHANGELOG.md"].replaceAll("](VERSIONING.md)", "") } }, /CHANGELOG\.md does not link/],
    [{ linkers: { ...base.linkers, "CONTRIBUTING.md": base.linkers["CONTRIBUTING.md"].replaceAll("](VERSIONING.md)", "") } }, /CONTRIBUTING\.md does not link/],
    [{ tool: base.tool.replace(/VERSIONING\.md/g, "the policy") }, /header comment/],
    [{ doc: base.doc.replaceAll(`\`${API_MODULE}\``, "the module") }, /does not name the API level module/],
    [{ tool: base.tool.replace(/^export const BUILD_OFFSET = \d+;$/m, "export const BUILD_OFFSET = 200;") }, /build number base 200/],
    [{ apiModule: { ...base.apiModule, DEPRECATION_WINDOW_DAYS: 60 } }, /deprecation window of 60 days/],
    [{ doc: base.doc.replace("`GET /api/version` (`version`, `api`)", "`GET /api/version` (`version`, `build`, `api`)") }, /lists version, build, api for GET \/api\/version/],
    [{ backendFields: [...base.backendFields, "schema"] }, /the code sends version, api, schema/],
    [{ doc: base.doc.replace("`release`, `api`, `gatewayVersion`)", "`release`, `api`)") }, /for GET \/gw\/info, the code sends/],
  ];
  for (const [patch, why] of cases) {
    const out = findings({ ...base, ...patch });
    assert.ok(out.some((f) => why.test(f)), `${why}: not named; findings: ${JSON.stringify(out)}`);
  }
  assert.throws(() => findings({ ...base, tool: base.tool.replace(/^export const BUILD_OFFSET.*$/m, "") }), /BUILD_OFFSET in tools\/version\.mjs not found/);
});
