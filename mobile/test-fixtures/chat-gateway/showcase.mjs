// The showcase data set of the fixture gateway: English, neutral demo content for App Store screenshots
// (`ScreenshotUITests`). Opt-in ONLY — start the gateway with `CBASE_FIXTURE_SHOWCASE=1`; without it nothing here runs and the
// UI tests see the default data they match against (workspace "Mobile Fixture", chat "Queue-Test" …).
//
// Two halves: `applyShowcase()` rewrites the seed objects in place once at startup (names, titles, history, files — `reset-run`
// does not touch any of them), and `routesShowcase` answers the few routes whose default answer is computed from fixed values
// (account, usage rings, the project's git and its graph). It stands FIRST in `ROUTERS` and returns `NEXT` when the mode is off.
// No real names, no company names, no private hosts.
import { S, NEXT, json, body, workspace, projectId, extraChats, fixtureFiles } from "./state.mjs";

export const SHOWCASE = process.env.CBASE_FIXTURE_SHOWCASE === "1";

const MIN = 60_000;
const HOUR = 60 * MIN;

const row = (role, text, ago) => ({ role, text, ts: Date.now() - ago, attachments: [] });
const tool = (id, name, input, ago) => row("tool", JSON.stringify({ id, name, input }), ago);
const result = (id, text, ago) => row("tool_result", JSON.stringify({ id, result: text, isError: false }), ago);

const TOTAL_BEFORE = [
  "import { roundCents } from \"../money\";",
  "import type { CartLine, Money } from \"./types\";",
  "",
  "export function cartTotal(lines: CartLine[], discountPct = 0): Money {",
  "  let total = 0;",
  "  for (const line of lines) {",
  "    const price = (line.priceCents / 100) * (1 - discountPct / 100);",
  "    total += roundCents(price) * line.qty;",
  "  }",
  "  return { cents: Math.round(total * 100), currency: \"USD\" };",
  "}",
].join("\n");

const TOTAL_AFTER_FN = [
  "export function cartTotal(lines: CartLine[], discountPct = 0): Money {",
  "  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);",
  "  const cents = roundHalfEven((subtotal * (100 - discountPct)) / 100);",
  "  return { cents, currency: \"USD\" };",
  "}",
].join("\n");

function mainHistory() {
  return [
    row("user", "The cart total is sometimes off by a cent: 3 × $12.50 with the 15% discount shows $31.89 instead of $31.88. Can you find out why and fix it?", 26 * MIN),
    row("assistant", "Let me look at how the cart computes its total.", 25.5 * MIN),
    tool("sc-grep", "Grep", { pattern: "cartTotal", path: "src" }, 25 * MIN),
    result("sc-grep", "src/cart/total.ts:4:export function cartTotal(\nsrc/checkout/summary.tsx:18:  const total = cartTotal(lines, discount);", 24.9 * MIN),
    tool("sc-read", "Read", { file_path: "src/cart/total.ts" }, 24.5 * MIN),
    result("sc-read", TOTAL_BEFORE, 24.4 * MIN),
    row("assistant", [
      "Found it. `cartTotal()` applies the discount to **every line** and rounds each one, then adds the rounded lines up. With three items the rounding errors add up to a full cent.",
      "",
      "**Plan**",
      "",
      "1. Compute the total in integer cents",
      "2. Apply the discount once, on the subtotal",
      "3. Round only at the end (half-even, like the payment provider)",
      "4. Add a regression test for the 3 × $12.50 case",
    ].join("\n"), 24 * MIN),
    tool("sc-edit", "Edit", { file_path: "src/cart/total.ts", old_string: TOTAL_BEFORE.split("\n").slice(3).join("\n"), new_string: TOTAL_AFTER_FN }, 22 * MIN),
    result("sc-edit", "The file src/cart/total.ts has been updated.", 21.9 * MIN),
    tool("sc-test", "Edit", { file_path: "src/cart/total.test.ts", old_string: "", new_string: "it(\"rounds a discounted cart once\", () => {\n  expect(cartTotal([line(1250, 3)], 15).cents).toBe(3188);\n});" }, 21 * MIN),
    result("sc-test", "The file src/cart/total.test.ts has been updated.", 20.9 * MIN),
    tool("sc-run", "Bash", { command: "npm test -- src/cart" }, 20 * MIN),
    result("sc-run", "PASS src/cart/total.test.ts\n  cartTotal\n    ✓ sums lines in cents (2 ms)\n    ✓ rounds a discounted cart once (1 ms)\n    ✓ returns zero for an empty cart\n\nTest Suites: 3 passed, 3 total\nTests:       14 passed, 14 total", 19.8 * MIN),
    row("assistant", [
      "Fixed. The total is now computed in cents and rounded exactly once:",
      "",
      "```ts",
      TOTAL_AFTER_FN,
      "```",
      "",
      "| Cart | Before | After |",
      "| --- | ---: | ---: |",
      "| 3 × $12.50, −15 % | $31.89 | $31.88 |",
      "| 2 × $8.99, −10 % | $16.18 | $16.18 |",
      "| Empty cart | $0.00 | $0.00 |",
      "",
      "All 14 cart tests pass, including the new regression test. I can deploy a preview so you can try the checkout yourself.",
    ].join("\n"), 19 * MIN),
    row("approval", JSON.stringify({
      requestId: "showcase-approval-0001", toolName: "mcp__preview__deploy_preview", server: "Preview", key: "preview",
      tool: "deploy_preview", description: "Deploy a branch to a temporary preview URL.", writing: true,
      input: { branch: "fix/checkout-rounding", environment: "preview" }, at: Date.now() - 18 * MIN,
    }), 18 * MIN),
  ];
}

const SHOWCASE_FILES = [
  { path: "README.md", name: "README.md", type: "file", content: "# storefront\n\nA small web shop: product pages, cart and checkout.\n\n```sh\nnpm install\nnpm run dev\n```\n" },
  { path: "package.json", name: "package.json", type: "file", content: "{\n  \"name\": \"storefront\",\n  \"private\": true,\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"test\": \"vitest run\"\n  }\n}\n" },
  { path: "src", name: "src", type: "dir" },
  { path: "src/cart", name: "cart", type: "dir" },
  { path: "src/cart/total.ts", name: "total.ts", type: "file", content: `import { roundHalfEven } from "../money";\nimport type { CartLine, Money } from "./types";\n\n${TOTAL_AFTER_FN}\n` },
  { path: "src/cart/total.test.ts", name: "total.test.ts", type: "file", content: "import { cartTotal } from \"./total\";\n" },
  { path: "src/checkout", name: "checkout", type: "dir" },
  { path: "src/checkout/summary.tsx", name: "summary.tsx", type: "file", content: "export function Summary() {\n  return null;\n}\n" },
  { path: "src/money.ts", name: "money.ts", type: "file", content: "export const roundHalfEven = (x: number) => Math.round(x);\n" },
];

/** Rewrites the seed objects in place. Idempotent; runs once at startup when the mode is on. */
export function applyShowcase() {
  if (!SHOWCASE) return;
  workspace.name = "Demo";
  workspace.path = "/home/agent/demo";
  const project = workspace.projects.find((p) => p.id === projectId);
  if (project) {
    project.name = "storefront";
    project.path = "/home/agent/demo/storefront";
  }
  Object.assign(S.chat, {
    title: "Fix the checkout total rounding", provider: "claude", model: "claude-opus-5-5", contextTokens: 41_800,
    updatedAt: Date.now() - 18 * MIN,
  });
  const titles = [
    ["Add dark mode to the settings page", 2 * HOUR],
    ["Explain the project structure", 5 * HOUR],
  ];
  titles.forEach(([title, ago], i) => {
    if (!extraChats[i]) return;
    Object.assign(extraChats[i], { title, provider: "claude", model: "claude-sonnet-5", updatedAt: Date.now() - ago, createdAt: Date.now() - ago - HOUR });
  });
  const more = [
    ["20000000-0000-4000-8000-000000000004", "Speed up the product image loading", "codex", "gpt-5.6-sol", 26 * HOUR],
    ["20000000-0000-4000-8000-000000000005", "Write release notes for v1.4.0", "claude", "claude-sonnet-5", 50 * HOUR],
    ["20000000-0000-4000-8000-000000000006", "Review the payment webhook handler", "claude", "claude-opus-5-5", 74 * HOUR],
  ];
  for (const [id, title, provider, model, ago] of more) {
    if (extraChats.some((c) => c.id === id)) continue;
    extraChats.push({ ...extraChats[0], id, title, provider, model, updatedAt: Date.now() - ago, createdAt: Date.now() - ago - HOUR });
  }
  S.seededRawEntries = mainHistory();
  fixtureFiles.splice(0, fixtureFiles.length, ...SHOWCASE_FILES);
}

// ── Git of the project "storefront" ────────────────────────────────────────────────────────────────
const commit = (hash, subject, author, hours, parents, refs = [], files = []) => ({ hash, subject, author, hours, parents, refs, files });
const H = {
  fix: "4e7a1c90b2d35f6a8c1e0d9b7a6f5e4d3c2b1a09",
  test: "b31f8a2c7d9e4f60a5b3c2d1e0f9a8b7c6d5e4f3",
  merge: "7d2c9e4f1a8b3c5d7e9f0a2b4c6d8e0f1a3b5c7d",
  dark: "c58e1f3a9b2d4c6e8f0a1b3c5d7e9f2a4b6c8d0e",
  delivery: "2a9f6b4c8e1d3f5a7b9c0d2e4f6a8b0c1d3e5f7a",
  money: "e1c7b3d9f5a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0",
  deps: "93b0d6e2a8c4f0b6d1e3a5c7f9b1d3e5a7c9f2b4",
  init: "58d4f0a6c2e8b4d0f6a1c3e5b7d9f1a3c5e7b9d2",
};
const GRAPH = [
  commit(H.fix, "Round the cart total once, in cents", "cbase agent", 0.3, [H.test],
    [{ name: "fix/checkout-rounding", kind: "head" }],
    [{ status: "M", path: "src/cart/total.ts" }, { status: "M", path: "src/money.ts" }]),
  commit(H.test, "Add a regression test for discounted totals", "cbase agent", 0.4, [H.merge],
    [{ name: "origin/fix/checkout-rounding", kind: "remote" }], [{ status: "A", path: "src/cart/total.test.ts" }]),
  commit(H.merge, "Merge branch 'main' into fix/checkout-rounding", "Alex", 3, [H.money, H.delivery], [], [{ status: "M", path: "src/product/page.tsx" }]),
  commit(H.dark, "Add dark theme tokens to the settings page", "Sam", 5, [H.deps],
    [{ name: "feature/dark-mode", kind: "local" }], [{ status: "M", path: "src/settings/theme.css" }]),
  commit(H.delivery, "Show the delivery estimate on the product page", "Sam", 8, [H.deps],
    [{ name: "main", kind: "local" }, { name: "origin/main", kind: "remote" }, { name: "v1.4.0", kind: "tag" }],
    [{ status: "M", path: "src/product/page.tsx" }, { status: "A", path: "src/product/delivery.ts" }]),
  commit(H.money, "Extract price formatting into money.ts", "Alex", 26, [H.deps], [], [{ status: "A", path: "src/money.ts" }]),
  commit(H.deps, "Update dependencies", "Alex", 50, [H.init], [], [{ status: "M", path: "package.json" }, { status: "M", path: "package-lock.json" }]),
  commit(H.init, "Initial storefront", "Alex", 120, [], [{ name: "v1.0.0", kind: "tag" }],
    [{ status: "A", path: "README.md" }, { status: "A", path: "src/main.tsx" }]),
];

const DIFFS = {
  "src/cart/total.ts": [
    "@@ -1,11 +1,8 @@",
    "-import { roundCents } from \"../money\";",
    "+import { roundHalfEven } from \"../money\";",
    " import type { CartLine, Money } from \"./types\";",
    " ",
    " export function cartTotal(lines: CartLine[], discountPct = 0): Money {",
    "-  let total = 0;",
    "-  for (const line of lines) {",
    "-    const price = (line.priceCents / 100) * (1 - discountPct / 100);",
    "-    total += roundCents(price) * line.qty;",
    "-  }",
    "-  return { cents: Math.round(total * 100), currency: \"USD\" };",
    "+  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);",
    "+  const cents = roundHalfEven((subtotal * (100 - discountPct)) / 100);",
    "+  return { cents, currency: \"USD\" };",
    " }",
  ].join("\n"),
  "src/money.ts": [
    "@@ -1,4 +1,10 @@",
    "-export const roundCents = (x: number) => Math.round(x * 100) / 100;",
    "+/** Rounds to whole cents; a tie goes to the even neighbour. */",
    "+export function roundHalfEven(cents: number): number {",
    "+  const floor = Math.floor(cents);",
    "+  const diff = cents - floor;",
    "+  if (diff > 0.5) return floor + 1;",
    "+  if (diff < 0.5) return floor;",
    "+  return floor % 2 === 0 ? floor : floor + 1;",
    "+}",
    " ",
    " export const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;",
  ].join("\n"),
};
const fileDiff = (path, old) => {
  const head = `diff --git a/${old ?? path} b/${path}\n--- a/${old ?? path}\n+++ b/${path}\n`;
  return head + (DIFFS[path] || "@@ -1,3 +1,3 @@\n context\n-previous line\n+updated line\n context");
};

const relative = (hours) => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`;
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
};

function gitTree() {
  const changes = [
    { x: "M", y: " ", path: "src/checkout/summary.tsx", code: "M", label: "modified", kind: "modified" },
    { x: " ", y: "M", path: "src/cart/types.ts", code: "M", label: "modified", kind: "modified" },
  ];
  return {
    repos: [{
      name: "storefront", relPath: "", branch: "fix/checkout-rounding", detached: false, upstream: "origin/fix/checkout-rounding",
      ahead: 1, behind: 0, changes,
      counts: { staged: 1, unstaged: 1, untracked: 0, total: changes.length }, clean: false,
      lastCommit: { subject: GRAPH[0].subject, author: GRAPH[0].author, relative: relative(GRAPH[0].hours) },
      remote: { host: "github", url: "git@github.com:example/storefront.git" },
    }],
  };
}

function gitGraph(extent, limit) {
  const all = extent === "current" ? GRAPH.filter((c) => c.hash !== H.dark) : GRAPH;
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const now = Math.floor(Date.now() / 1000);
  return {
    commits: all.slice(0, n).map((c) => ({
      hash: c.hash, short: c.hash.slice(0, 7), subject: c.subject, author: c.author, relative: relative(c.hours),
      parents: c.parents, refs: c.refs, head: c.refs.some((r) => r.kind === "head"), time: now - Math.round(c.hours * 3600),
    })),
    clipped: all.length > n,
    extent: extent === "current" ? "current" : "all",
  };
}

function gitShow(request) {
  const c = GRAPH.find((x) => x.hash === request.hash);
  if (!c) return null;
  if (request.files === true) return { hash: c.hash, parent: c.parents, files: c.files, total: c.files.length, clipped: false };
  if (typeof request.file === "string") {
    const old = typeof request.old === "string" ? request.old : null;
    return { hash: c.hash, path: request.file, old, diff: fileDiff(request.file, old), clipped: false };
  }
  return { hash: c.hash, diff: c.files.map((f) => fileDiff(f.path)).join("\n") };
}

const ring = (percent) => ({ percent, resetsAt: null, group: "session", scope: "", windowMinutes: 300, reached: false });

export async function routesShowcase(ctx) {
  const { req, res, url, path, method } = ctx;
    if (!SHOWCASE) return NEXT;
    if (path === "/gw/info" && method === "GET") {
      return json(res, 200, { gateway: true, version: "1.0", setup: false, authenticated: true, user: { username: "demo", role: "admin" } });
    }
    if (path === "/api/usage" && method === "GET") {
      return json(res, 200, {
        fiveHour: { utilization: 34, resetsAt: null }, sevenDay: { utilization: 21, resetsAt: null },
        ring: ring(34), blocking: null, credit: null,
        gate: { enabled: false, threshold: 99, window: null },
      });
    }
    if (path === "/api/usage/codex" && method === "GET") {
      return json(res, 200, {
        connected: true, primary: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
        secondary: { usedPercent: 18, windowMinutes: 300, resetsAt: null }, ring: ring(18), blocking: null,
      });
    }
    if (path === `/api/projects/${projectId}/git` && method === "GET") return json(res, 200, gitTree());
    if (path === `/api/projects/${projectId}/git/log` && method === "POST") {
      const request = await body(req);
      return json(res, 200, gitGraph(request.graph, request.limit));
    }
    if (path === `/api/projects/${projectId}/git/show` && method === "POST") {
      const part = gitShow(await body(req));
      return part ? json(res, 200, part) : json(res, 404, { error: "Unknown commit" });
    }
    if (path === `/api/projects/${projectId}/git/diff` && method === "POST") {
      const request = await body(req);
      return json(res, 200, { path: request.file, staged: !!request.staged, diff: fileDiff(request.file) });
    }
    return NEXT;
}
