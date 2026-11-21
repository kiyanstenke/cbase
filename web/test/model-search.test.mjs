// The ONE model choice with search.
//
// Since OpenRouter is a fixed provider it carries the WHOLE catalogue with tools — several hundred models. A `<select>` with optgroups is
// unusable for that, and the two composers each had their own search (the same idea built twice, with slightly different rules). Now
// every model choice goes through ONE component (`components/ModelChoice.tsx`: `ModelSearchList` in the composers' dropdown,
// `ModelChoice` instead of a `<select>` everywhere else), and the component asks ONE calculation (`lib/model-search.ts`).
//
// What is bound here:
//   (a) the calculation, EXECUTED (the sheet without imports, compiled with tsc): words instead of a string, every word must hit (in
//       label, value OR group name, case-insensitive), a group without hits drops out, an empty query leaves everything (as a copy —
//       the caller may filter without changing the source), the first hit, and a value no group carries has NO label (`null`) — the
//       button then shows the value itself, never "nothing chosen".
//   (b) the places, as TEXT: no file under web/src builds `<option>`/`<optgroup>` or buttons from a provider's model list itself, no
//       second search field "Search model…" outside the component, and every place that offers models today pulls the component. Plus
//       the form of the component: list via portal on the body with `cb-kit`, closed via document `mousedown` plus
//       `closest("[data-model-choice-pop]")` (a click catcher never as `fixed inset-0`), Enter in the search field ALWAYS intercepted
//       (in the composer it would otherwise send the message).
//   (c) One built-in sabotage per binding on an in-memory copy.
//
// Counter-probes: in lib/model-search.ts `words.every` replaced by `words.some` (a search "sonnet 5.5" would then hit every Claude model)
// => (a) red ("every word must hit"); settings/AgentModelSettings.tsx replaced by the OLD state (the `<select>` with optgroups) => (b)
// red ("builds rows from the model list itself", "does not pull the shared component"); in `popSituation` the height fixed to
// `POP.height` (the old state: 340 px regardless of the space) => (a) red ("popSituation: upward, height = free space" — the top edge
// would lie at -44 px, the search field outside the window).
//
// Run:  node --test --test-reporter=tap web/test/model-search.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let computation = null;
async function loadComputation() {
  if (computation) return computation;
  assert.ok(fs.existsSync(tsc), "web/node_modules missing (tsc) — the calculation cannot be checked without a compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-model-search-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "model-search.ts"), "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  computation = await import(pathToFileURL(path.join(tmp, "model-search.js")).href);
  return computation;
}

// A catalogue in the shape the callers build: one group per provider, the value `provider::model`.
const CATALOG = [
  { key: "claude", label: "Claude", options: [
    { value: "claude::claude-opus-5-5", label: "Opus 5.5" },
    { value: "claude::claude-sonnet-5-5", label: "Sonnet 5.5" },
    { value: "claude::claude-sonnet-5", label: "Sonnet 5" },
  ] },
  { key: "codex", label: "Codex", options: [{ value: "codex::gpt-5.6-sol", label: "GPT-5.6 Sol" }] },
  { key: "openrouter", label: "OpenRouter", options: [
    { value: "openrouter::z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
    { value: "openrouter::deepseek/deepseek-v4", label: "DeepSeek V4" },
    { value: "openrouter::anthropic/claude-sonnet-5.5", label: "Anthropic: Claude Sonnet 5.5" },
  ] },
];
const values = (groups) => groups.flatMap((g) => g.options.map((o) => o.value));

/** All deviations of the calculation from its promise (empty = kept). */
function computationDeviations(m) {
  const deviations = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { deviations.push(`${what}: ${JSON.stringify(holds)} instead of ${JSON.stringify(desired)}`); } };

  equal(m.searchWords("  Sonnet   5 "), ["sonnet", "5"], "searchWords: lower case, without empty ones");
  equal(m.searchWords("   "), [], "searchWords: whitespace only => no words");

  // Every word must hit — "sonnet 5" is not "sonnet OR 5".
  equal(values(m.modelHits(CATALOG, "sonnet 5.5")), ["claude::claude-sonnet-5-5", "openrouter::anthropic/claude-sonnet-5.5"], "every word must hit");
  // … in the value (the id behind the label) …
  equal(values(m.modelHits(CATALOG, "deepseek/")), ["openrouter::deepseek/deepseek-v4"], "hit in the value");
  // … or in the group name, case-insensitive; a group without hits drops out.
  const glm = m.modelHits(CATALOG, "OPENROUTER glm");
  equal(glm.map((g) => g.key), ["openrouter"], "groups without hits drop out");
  equal(values(glm), ["openrouter::z-ai/glm-5.3-flash"], "hit via the group name");
  equal(m.modelHits(CATALOG, "nonexistent"), [], "no hit => no group");

  // An empty query leaves everything — as a copy.
  const all = m.modelHits(CATALOG, "  ");
  equal(values(all), values(CATALOG), "empty query => everything");
  if (all[0] === CATALOG[0] || all[0]?.options === CATALOG[0].options) deviations.push("empty query: the groups are no copy — a caller that filters would change the source");

  // The first hit (Enter in the search field) and the group of a value.
  equal(m.firstHit(m.modelHits(CATALOG, "flash"))?.option?.value, "openrouter::z-ai/glm-5.3-flash", "firstHit");
  equal(m.firstHit([]), null, "firstHit without a group => null");
  equal(m.firstHit([{ key: "x", label: "X", options: [] }]), null, "firstHit over empty groups => null");
  equal(m.groupOf(CATALOG, "codex::gpt-5.6-sol")?.key, "codex", "groupOf");
  equal(m.groupOf(CATALOG, "codex::gpt-4"), null, "groupOf for a foreign value => null");

  // A value no group carries has NO label — never the first row, never "nothing".
  equal(m.labelOf(CATALOG, "claude::claude-opus-5-5"), "Opus 5.5", "labelOf");
  equal(m.labelOf(CATALOG, "claude::claude-opus-4"), null, "labelOf for a foreign value => null");
  equal(m.labelOf(CATALOG, ""), null, "labelOf for the empty value => null (the empty entry belongs in `oben`)");

  // The position of the list: never beyond the window edge — the height is at most the free space.
  // The case: window 560 high, button 300–330 => upward (288 free there), 288 high, top edge at 8 (not -44).
  const button = (top, bottom, left = 40, width = 200) => ({ top, bottom, left, width });
  const window = { width: 1000, height: 560 };
  const small = m.popSituation(button(300, 330), window);
  equal(small, { left: 40, width: 260, height: 288, bottom: 264 }, "popSituation: upward, height = free space");
  equal(window.height - small.bottom - small.height, 8, "popSituation: the top edge stays in the window (margin 8)");
  // Downward with less than the full height: the last rows stay reachable.
  equal(m.popSituation(button(200, 230), window), { left: 40, width: 260, height: 318, top: 234 }, "popSituation: downward, height = free space");
  // Enough space below: the full height, downward.
  equal(m.popSituation(button(20, 50), { width: 1000, height: 900 }), { left: 40, width: 260, height: 340, top: 54 }, "popSituation: full height if it fits");
  // Indented at the right edge, wide buttons capped.
  equal(m.popSituation(button(20, 50, 900, 600), { width: 1000, height: 900 }).left, 1000 - 380 - 8, "popSituation: indented on the right, width at most 380");
  return deviations;
}

test("calculation (lib/model-search.ts): every word hits, empty groups drop, an empty query leaves everything, foreign values have no label", async () => {
  const deviations = computationDeviations(await loadComputation());
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

// ── (b) The places ─────────────────────────────────────────────────────────────────────────────

const COMPONENT = path.join("src", "components", "ModelChoice.tsx");
// Every place that offers a provider's models for choice today. If a place is added, it belongs here — the guard below catches it
// anyway as soon as it builds rows itself.
const PLACES = [
  "src/components/AgentDialog.tsx", "src/components/ProviderModel.tsx", "src/components/chat/ChatComposer.tsx",
  "src/components/outerloop/OuterLoopEditor.tsx", "src/components/settings/AgentModelSettings.tsx",
  "src/components/settings/ProviderSettings.tsx", "src/components/workflow/WorkflowSettings.tsx",
];

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources() {
  const deviations = {};
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.tsx?$/.test(e.name)) deviations[path.relative(webDir, p)] = withoutComments(read(p));
    }
  };
  run(src());
  return deviations;
}

/** Does a file build rows (`<option>`, `<optgroup>`, buttons) from a provider's model list itself? */
const BUILDS_SELF = /\bmodels\b(?:\.filter\([^()]*(?:\([^()]*\)[^()]*)*\))?\.map\(\s*\(?\s*\w+\s*\)?\s*=>\s*\(?\s*<(option|optgroup|button)\b/;

function placesDeviations(q) {
  const deviations = [];
  for (const [file, text] of Object.entries(q)) {
    if (file === COMPONENT) continue;
    if (BUILDS_SELF.test(text)) deviations.push(`${file} builds rows from the model list itself — the choice goes through components/ModelChoice.tsx`);
    if (/<optgroup\b[^>]*\b(?:p|pv|provider|provider)\.label\b/.test(text)) deviations.push(`${file} groups models in an <optgroup> — the choice goes through components/ModelChoice.tsx`);
    if (text.includes('t("Search model…")')) deviations.push(`${file} has its own search field "Search model…" — the component has one`);
  }
  for (const file of PLACES) {
    if (!Object.hasOwn(q, file)) { deviations.push(`${file} no longer exists — update PLACES`); continue; }
    if (!/from "@\/components\/ModelChoice"/.test(q[file])) deviations.push(`${file} does not pull the shared component (components/ModelChoice.tsx)`);
  }
  const b = q[COMPONENT] ?? "";
  if (!/createPortal\(/.test(b) || !/document\.body/.test(b)) deviations.push("ModelChoice: the list does not hang on the body via a portal");
  if (!/className="cb-kit fixed /.test(b)) deviations.push("ModelChoice: the overlay node does not carry cb-kit");
  if (!/document\.addEventListener\("mousedown", beside\)/.test(b) || !b.includes('closest?.("[data-model-choice-pop]")')) deviations.push("ModelChoice: it is not closed via document mousedown + closest");
  if (/fixed inset-0/.test(b)) deviations.push("ModelChoice: a click catcher as fixed inset-0");
  if (!/if \(e\.key === "Enter"\) \{ e\.preventDefault\(\);/.test(b)) deviations.push("ModelChoice: Enter in the search field is not always intercepted");
  if (!/import \{[^}]*modelHits[^}]*\} from "@\/lib\/model-search"/.test(b)) deviations.push("ModelChoice: the component does not calculate with lib/model-search.ts");
  if (!/setSituation\(popSituation\(el\.getBoundingClientRect\(\), \{ width: window\.innerWidth, height: window\.innerHeight \}\)\);/.test(b)
    || !/style=\{\{ maxHeight: situation\.height \}\}/.test(b) || !/scrollStyle=\{\{ maxHeight: Math\.max\(0, situation\.height - SEARCH_HEADER\) \}\}/.test(b)) {
    deviations.push("ModelChoice: position and height of the list do not come from popSituation (it would stick out beyond the window edge)");
  }
  return deviations;
}

test("places: nobody builds model rows themselves, no second search field, every model choice pulls the component — and the component has its form", () => {
  const deviations = placesDeviations(sources());
  assert.deepEqual(deviations, [], deviations.join("\n"));
});

// ── (c) Counter-probes ─────────────────────────────────────────────────────────────────────────────

test("counter-probe: \"any word\", a label for foreign values, an old <select> and a second search field are noticed", async () => {
  const real = await loadComputation();
  const or = computationDeviations({
    ...real,
    modelHits: (groups, question) => {
      const w = real.searchWords(question);
      if (!w.length) return groups.map((g) => ({ ...g, options: [...g.options] }));
      return groups.map((g) => ({ ...g, options: g.options.filter((o) => w.some((x) => `${o.label} ${o.value} ${g.label}`.toLowerCase().includes(x))) })).filter((g) => g.options.length);
    },
  });
  assert.ok(or.some((z) => z.startsWith("every word must hit")), or.join("\n"));
  const first = computationDeviations({ ...real, labelOf: (g, w) => real.labelOf(g, w) ?? g[0]?.options[0]?.label ?? null });
  assert.ok(first.some((z) => z.startsWith("labelOf for a foreign value")), first.join("\n"));
  // The old position: fixed 340 px regardless of the space.
  const fixed = computationDeviations({ ...real, popSituation: (r, f) => ({ ...real.popSituation(r, f), height: 340 }) });
  assert.ok(fixed.some((z) => z.startsWith("popSituation: upward, height = free space")), fixed.join("\n"));
  const fixedPlace = placesDeviations({ ...sources(), [COMPONENT]: sources()[COMPONENT].replace("style={{ maxHeight: situation.height }}", "style={{ maxHeight: 340 }}") });
  assert.ok(fixedPlace.some((z) => z.startsWith("ModelChoice: position and height of the list do not come from popSituation")), fixedPlace.join("\n"));

  const q = sources();
  const place = "src/components/settings/AgentModelSettings.tsx";
  const oldSelect = '<select>{providers.map((p) => (<optgroup key={p.id} label={p.label}>{p.models.filter((m) => m.id).map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}</optgroup>))}</select>';
  const a = placesDeviations({ ...q, [place]: q[place].replace(/<ModelChoice\b/, `${oldSelect}<ModelChoice`) });
  assert.ok(a.some((z) => z.startsWith(`${place} builds rows from the model list itself`)), a.join("\n"));
  assert.ok(a.some((z) => z.startsWith(`${place} groups models in an <optgroup>`)), a.join("\n"));

  const b = placesDeviations({ ...q, "src/components/Foreign.tsx": '<input placeholder={t("Search model…")} />' });
  assert.ok(b.some((z) => z.startsWith("src/components/Foreign.tsx has its own search field")), b.join("\n"));

  const without = placesDeviations({ ...q, "src/components/AgentDialog.tsx": q["src/components/AgentDialog.tsx"].replace('from "@/components/ModelChoice"', 'from "@/components/OtherChoice"') });
  assert.ok(without.some((z) => z.startsWith("src/components/AgentDialog.tsx does not pull the shared component")), without.join("\n"));
});
