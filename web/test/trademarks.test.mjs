// Third-party marks (TRADEMARKS.md). Three promises, each of which would fail silently:
//  (1) The provider logos cbase may not pass on stay out: the Anthropic "A" and the OpenAI blossom were replaced by neutral glyphs
//      (web/src/components/ProviderMarks.tsx, iOS ProviderClaude/ProviderCodex). A copy pasted back into any file under web/src,
//      mobile/CbaseMobile or client — or a provider key in the Simple Icons table — is red. Recognised by a fingerprint of the path
//      data, so a recolour or a resize is caught too.
//  (2) The list is complete and points at real files: every integration asset of the iOS app and every file of the Simple Icons
//      attributions in web/src/lib/thirdParty.ts is named in TRADEMARKS.md; every path the list names exists.
//  (3) Web and iOS draw the same neutral marks (ProviderMarks.tsx says so): the path data of the iOS SVGs is in ProviderMarks.tsx.
//  (4) The six hand-redrawn MCP logos (Playwright, GitLab, Google Maps, Slack, Canva, monday.com) stay out of the same tree: a
//      redrawn mark is a modified mark. GitLab and Google Maps come from Simple Icons unchanged (web/src/components/brandLogos.ts),
//      the other four are neutral initials in McpIcon.tsx. Recognised by geometry of the old drawings and, for the multicolour
//      ones, by their brand-colour set, so a moved or resized copy is caught too.
//
// Run:  node --test --test-reporter=tap web/test/trademarks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// The start of each withdrawn path (Simple Icons openai.svg up to 15.22.0, anthropic.svg in all versions; both coordinate variants).
const WITHDRAWN = [
  ["OpenAI blossom", /M22\.2819\s*9\.8211/],
  ["Anthropic A", /M17\.3041\s*3\.541h-3\.6718/],
];
const WITHDRAWN_KEYS = ["openai", "anthropic", "claude", "chatgpt", "openrouter"];
const SCANNED = ["web/src", "mobile/CbaseMobile", "client"];
const TEXT = /\.(tsx?|jsx?|mjs|cjs|swift|svg|json|html|css)$/;

// The hand-drawn MCP logos McpIcon.tsx carried until 2026-11: each is [name, predicate over a file's text]. Geometry first; the
// colour sets catch a redraw with new coordinates (hex in any case, all colours of the set in one file).
const colours = (...hex) => (text) => hex.every((h) => new RegExp(`#${h}\\b`, "i").test(text));
const REDRAWN = [
  ["redrawn Playwright mask", (t) => /M4\.5 4h15v6\.5c0 5\.2/.test(t)],
  ["redrawn GitLab tanuki", (t) => /M12 21\.5 3 11\.2/.test(t)],
  ["redrawn Google Maps pin", (t) => /M12 2\.5c-3\.9 0-7 3-7 6\.8/.test(t)],
  ["redrawn Slack cross", (t) => /x="7\.6" y="4\.6" width="2\.9" height="14\.8"/.test(t) || colours("36C5F0", "2EB67D", "E01E5A", "ECB22E")(t)],
  ["redrawn Canva circle", (t) => /M15\.7 8\.6a5 5 0 1 0 0 6\.8/.test(t) || colours("00C4CC", "7D2AE8")(t)],
  ["redrawn monday.com bars", (t) => /x="5\.6" y="7" width="3\.4" height="10"/.test(t) || colours("F62B54", "00CA72", "FDAB3D")(t)],
];

/** Every hit of a withdrawn mark under `root` (relative paths with the mark's name). */
function withdrawnHits(root, dirs, marks = WITHDRAWN.map(([name, re]) => [name, (t) => re.test(t)])) {
  const hits = [];
  const walk = (rel) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (TEXT.test(e.name)) {
        const text = fs.readFileSync(path.join(root, r), "utf8");
        for (const [name, has] of marks) if (has(text)) hits.push(`${r}: ${name}`);
      }
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

test("(1) the withdrawn provider logos are nowhere in the shipped tree (with counter-probe)", () => {
  for (const d of SCANNED) assert.ok(fs.existsSync(path.join(repo, d)), `anchor: ${d} is missing — the scan would find nothing`);
  assert.deepEqual(withdrawnHits(repo, SCANNED), []);
  const keys = Object.keys(JSON.parse(`{${read("web/src/components/brandLogos.ts").split("BRAND_LOGOS: Record<string, BrandLogo> = {")[1].split("\n};")[0]}}`));
  assert.ok(keys.length > 10, `anchor: only ${keys.length} keys read from brandLogos.ts`);
  assert.deepEqual(keys.filter((k) => WITHDRAWN_KEYS.includes(k)), [], "a provider logo is back in the Simple Icons table");

  // Counter-probe: the old Anthropic asset, recoloured, in a temporary tree is found.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-marks-"));
  try {
    fs.mkdirSync(path.join(tmp, "mobile/CbaseMobile/A.imageset"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "mobile/CbaseMobile/A.imageset/a.svg"), '<svg><path fill="#123456" d="M17.3041 3.541h-3.6718l6.696 16.918H24Z"/></svg>');
    assert.deepEqual(withdrawnHits(tmp, SCANNED), ["mobile/CbaseMobile/A.imageset/a.svg: Anthropic A"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("(2) TRADEMARKS.md names every integration asset and every Simple Icons file, and every path it names exists", () => {
  const list = read("TRADEMARKS.md");
  const assets = path.join(repo, "mobile/CbaseMobile/Assets.xcassets");
  const integration = fs.readdirSync(assets).filter((n) => n.startsWith("Integration"))
    .flatMap((set) => fs.readdirSync(path.join(assets, set)).filter((f) => f.endsWith(".svg")).map((f) => `mobile/CbaseMobile/Assets.xcassets/${set}/${f}`));
  assert.ok(integration.length >= 2, `anchor: only ${integration.length} integration assets found`);
  const simpleIcons = [...read("web/src/lib/thirdParty.ts").matchAll(/name: "Simple Icons[^"]*"[\s\S]*?files: \[([\s\S]*?)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.ok(simpleIcons.length >= 2, `anchor: only ${simpleIcons.length} Simple Icons files read from thirdParty.ts`);
  for (const f of [...integration, ...simpleIcons]) assert.ok(list.includes(`\`${f}\``), `TRADEMARKS.md does not name ${f}`);
  const named = [...list.matchAll(/`((?:web|mobile|client|server)\/[^`\s]+)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 5, `anchor: only ${named.length} paths read from TRADEMARKS.md`);
  for (const f of named) assert.ok(fs.existsSync(path.join(repo, f)), `TRADEMARKS.md names ${f}, which does not exist`);
});

test("(3) web and iOS draw the same neutral provider marks", () => {
  const web = read("web/src/components/ProviderMarks.tsx");
  for (const set of ["ProviderClaude.imageset/claude.svg", "ProviderCodex.imageset/codex.svg"]) {
    const svg = read(`mobile/CbaseMobile/Assets.xcassets/${set}`);
    const d = svg.match(/ d="([^"]+)"/)?.[1];
    assert.ok(d, `anchor: no path in ${set}`);
    assert.ok(web.includes(`d="${d}"`), `${set}: its path is not in ProviderMarks.tsx`);
  }
});

test("(4) the hand-redrawn MCP logos are nowhere in the shipped tree, GitLab and Google Maps come from Simple Icons (with counter-probe)", () => {
  for (const d of SCANNED) assert.ok(fs.existsSync(path.join(repo, d)), `anchor: ${d} is missing — the scan would find nothing`);
  assert.deepEqual(withdrawnHits(repo, SCANNED, REDRAWN), []);

  // GitLab and Google Maps are in the Simple Icons table; the GitLab path is the same drawing the iOS asset carries (both Simple Icons
  // 16.38.0, unchanged), so a hand edit of either copy is red.
  const table = JSON.parse(`{${read("web/src/components/brandLogos.ts").split("BRAND_LOGOS: Record<string, BrandLogo> = {")[1].split("\n};")[0]}}`);
  for (const k of ["gitlab", "gmaps"]) assert.ok(table[k]?.path, `brandLogos.ts has no Simple Icons entry for ${k}`);
  const ios = read("mobile/CbaseMobile/Assets.xcassets/IntegrationGitLab.imageset/gitlab.svg").match(/ d="([^"]+)"/)?.[1];
  assert.ok(ios, "anchor: no path in the iOS GitLab asset");
  assert.equal(table.gitlab.path, ios, "the GitLab path in brandLogos.ts is not the Simple Icons drawing of the iOS asset");
  // The four without a Simple Icons logo are neutral initials, reached through McpIcon's switch (no call site passes a drawing).
  const icon = read("web/src/components/McpIcon.tsx");
  for (const [k, letter] of [["playwright", "P"], ["slack", "S"], ["canva", "C"], ["monday", "M"]]) {
    assert.match(icon, new RegExp(`case "${k}":\\s*return <Initial size=\\{size\\} letter="${letter}" />;`), `${k} is not the neutral initial ${letter}`);
  }

  // Counter-probe: each old drawing, moved into a temporary tree (Slack resized, so only its colours give it away), is found.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcp-marks-"));
  try {
    const dir = path.join(tmp, "web/src/components");
    fs.mkdirSync(dir, { recursive: true });
    const old = {
      "playwright.tsx": '<path d="M4.5 4h15v6.5c0 5.2-3.6 9-7.5 9s-7.5-3.8-7.5-9V4z" fill="#2EAD33" />',
      "gitlab.tsx": '<path d="M12 21.5 3 11.2l1.4-4.4 2.5 6.9h10.2l2.5-6.9L21 11.2z" fill="#E24329" />',
      "gmaps.tsx": '<path d="M12 2.5c-3.9 0-7 3-7 6.8 0 4.9 7 12.2 7 12.2s7-7.3 7-12.2c0-3.8-3.1-6.8-7-6.8z" fill="#EA4335" />',
      "slack.tsx": '<rect x="8" y="5" fill="#36c5f0" /><rect fill="#2EB67D" /><rect fill="#E01E5A" /><rect fill="#ECB22E" />',
      "canva.tsx": '<stop stopColor="#00C4CC" /><stop stopColor="#7D2AE8" />',
      "monday.tsx": '<rect x="5.6" y="7" width="3.4" height="10" rx="1.7" fill="#F62B54" />',
    };
    for (const [f, text] of Object.entries(old)) fs.writeFileSync(path.join(dir, f), text);
    assert.deepEqual(withdrawnHits(tmp, SCANNED, REDRAWN).sort(), [
      "web/src/components/canva.tsx: redrawn Canva circle",
      "web/src/components/gitlab.tsx: redrawn GitLab tanuki",
      "web/src/components/gmaps.tsx: redrawn Google Maps pin",
      "web/src/components/monday.tsx: redrawn monday.com bars",
      "web/src/components/playwright.tsx: redrawn Playwright mask",
      "web/src/components/slack.tsx: redrawn Slack cross",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
