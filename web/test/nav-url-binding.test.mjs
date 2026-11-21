// The address-bar rule exists twice — and it must be the same one.
//
// The streamed browser normalises SERVER-SIDE: the pane sends the raw text, `act navigate` calls `normalizeNavUrl`
// (server/backend/electron/server/browsers.js) and loads the result. The client's native browser, by contrast, loads in the client
// process, which gets the URL ready-made from the web — so the rule must live in the web (web/src/lib/nav-url.ts). Two places for the
// same rule: deleting one is impossible (a sheet in web/src/lib cannot call a server function, and a route for it would be an
// intermediate layer that is only cheaper — and it would run on EVERY keystroke of the address bar). So bind them.
//
// What is measured is not "the same stands there" but "the same comes out": both functions run over the same table of inputs. The table
// covers the branches of the rule that were once wrong or easily become wrong: host:port looks like a scheme ("localhost:5173"), local
// networks get http instead of https, text without a dot becomes a search, a scheme stays untouched.
//
// browsers.js is free of side effects on import (measured: no Chromium start, no DIRS, only a `process.on("exit")` cleaner) — hence the
// direct import instead of an excerpt.
//
// Counter-probes: in nav-url.ts `!u.includes(".")` turned into `u.includes(".")` => "web and backend answer differently" red with 8
// deviating inputs; the local network `192.168.` struck from the list => one deviation ("192.168.1.5" => https instead of http) red.
//
// Run:  node --test web/test/nav-url-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeNavUrl as backend } from "../../server/backend/electron/server/browsers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

// The web source is compiled with the local tsc and imported — the real module text is checked, not a replica (model:
// browser-stream.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-nav-url-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "nav-url.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { normalizeNavUrl: web } = await import(pathToFileURL(path.join(out, "nav-url.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// Every line is a branch of the rule or a case that once looked wrong.
const INPUTS = [
  "",                                  // empty stays empty (the pane then does not navigate)
  "   ",                               // spaces only — trimmed also empty
  "https://example.com",               // scheme stays
  "http://example.com/path?q=1#top",
  "about:blank",                       // scheme without "//" (the second regex)
  "data:text/html,<p>hi</p>",
  "file:///Users/x/y.html",
  "view-source:https://example.com",
  "chrome://version",
  "devtools://devtools/bundled/inspector.html",
  "mailto:someone@example.com",
  "javascript:void(0)",
  "blob:https://example.com/abc",
  "localhost:3000",                    // host:port looks like a scheme — the core case
  "localhost",                         // local without a dot and without a port
  "localhost:5173/app?x=1",
  "127.0.0.1:8080/path",
  "127.0.0.1",
  "0.0.0.0:9000",
  "[::1]:7718",
  "[::1]",
  "10.0.0.5:8000",
  "172.16.0.1:3000",
  "172.31.255.254",
  "172.32.0.1",                        // NOT in the private range — https
  "192.168.1.5",
  "192.168.1.5:8080",
  "example.com",                       // foreign => https
  "example.com:8443/x",
  "www.example.com/path",
  "sub.domain.example.co.uk",
  "cbase",                           // no dot, no port, not local => search
  "foo bar",                           // space => search
  "how do I build a browser",
  "example.com and something else",   // dot AND space => search (space wins)
  " localhost:3000 ",                  // edge spaces are trimmed, no search case
  "cbase.example.org",
  "a:1",                               // shortest host:port
  "192.168.1.5:8080/path#hash",
  "störung",                           // umlaut, no dot => search with percent encoding
  "b?q=1",                             // no dot, no port => search
];

test("address bar: web and backend calculate the same URL — over all branches of the rule", () => {
  assert.ok(INPUTS.length >= 20, "the table covers too few inputs");
  const deviations = INPUTS
    .map((e) => ({ e, w: web(e), b: backend(e) }))
    .filter(({ w, b }) => w !== b);
  console.log(`  [nav-url] ${INPUTS.length} inputs, ${deviations.length} deviations`);
  assert.deepEqual(
    deviations.map(({ e, w, b }) => `${JSON.stringify(e)}: web=${JSON.stringify(w)} backend=${JSON.stringify(b)}`),
    [],
    "web/src/lib/nav-url.ts and browsers.js normalizeNavUrl answer differently — one of the two was changed, the other not",
  );
});

test("address bar: the rule itself — host:port before scheme, local http, foreign https, text becomes a search", () => {
  // Not only "both the same" but also "both right": if both were wrong, the test above would be green. The statements below are the
  // ones a user notices.
  assert.equal(web("localhost:3000"), "http://localhost:3000", "host:port must not be read as a scheme");
  assert.equal(web("example.com"), "https://example.com");
  assert.equal(web("192.168.1.5:8080"), "http://192.168.1.5:8080", "private networks via http — there is rarely a certificate there");
  assert.equal(web("foo bar"), `https://www.google.com/search?q=${encodeURIComponent("foo bar")}`);
  assert.equal(web("https://example.com"), "https://example.com", "a scheme stays untouched");
  assert.equal(web(""), "", "empty stays empty");
});

test("binding: the web version names its source, and the native pane normalises with it", () => {
  // A copy without a provenance line is a second opinion in half a year.
  const source = read("src/lib/nav-url.ts");
  assert.ok(/browsers\.js/.test(source), "nav-url.ts does not name browsers.js as the source of the rule");
  assert.ok(/nav-url-binding\.test\.mjs/.test(source), "nav-url.ts does not name this test as the binding — whoever changes the rule must know where it turns red");
  // And the pane must CALL it: without the call the raw text would go to the client, and "localhost:3000" would land in Chromium as
  // the scheme "localhost:".
  const pane = read("src/components/BrowserNative.tsx");
  assert.ok(/import\s*\{\s*normalizeNavUrl\s*\}\s*from\s*"@\/lib\/nav-url"/.test(pane),
    "BrowserNative.tsx does not import normalizeNavUrl from @/lib/nav-url");
  const start = pane.indexOf("const navigate = () => {");
  assert.ok(start >= 0, "the function `navigate` is in BrowserNative.tsx — renamed? Update the anchor, do not delete the test");
  const body = pane.slice(start, pane.indexOf("\n  };", start));
  assert.ok(/normalizeNavUrl\(urlInput\)/.test(body),
    "`navigate` does not normalise the address-bar text — the raw text would go to the client, and \"localhost:3000\" would land in Chromium as the scheme \"localhost:\"");
  assert.ok(/bridge\.navigate\(scope, url\)/.test(body), "`navigate` does not hand the normalised URL to the client");
});
