// The language servers per language — package, start command, `initializationOptions` and the answers to
// `workspace/configuration`. A leaf over node:* and the contract.
//
// WHERE THE PACKAGES LIVE. In production globally in the backend image (`npm install -g`, pinned in server/backend/Dockerfile,
// guards tools/check/projectbox-dockerfile.test.mjs and server/backend/test/lsp-core.test.js) under /usr/local/lib/node_modules —
// in B AND read-only at the same path in every project container (projectbox/creation.js SYSTEM_PATHS). They are started with
// the `node` that B itself runs (process.execPath, /usr/local/bin/node — mounted as well). The search order is
// `CBASE_LSP_PACKAGES`, then `<prefix of node>/lib/node_modules` (where `npm -g` puts them, also on a Mac), then
// /usr/local/lib/node_modules. If the package is missing the state is `missing` (the local server without the global packages) —
// never a silent fallback to another program.
//
// MEASURED: TS/JS takes 680–865 MB per server including tsserver AND its syntax server ⇒ `tsserver.useSyntaxServer: "never"`;
// JSON formats only with `provideFormatter: true`; basedpyright does not format. Also (not measured, chosen): no automatic type
// acquisition from npm (`disableAutomaticTypingAcquisition`) — a project container does not always have network, and a server
// waiting there delays the first answer.
//
// TEST SEAM. `setLspTable(t)` replaces the table in the process (`null` takes it back); `CBASE_LSP_FAKE` (JSON array
// `[program, …arguments]`) starts the same program for EVERY language with `--language <language>` appended — for a server as a
// child process (language-service-fifo.test.js) whose table the test cannot set. Both for tests only.
//
// LANGUAGE OF THE MESSAGES. Like VS Code with the display language (`vscode.env.language`, here the UI language of cbase,
// `ctx.locale`): `locale` in initialize (LSP; basedpyright and yaml-language-server read it, both ship their German texts),
// `initializationOptions.locale` for typescript-language-server (→ `tsserver --locale`, TypeScript ships `lib/de`), and for CSS,
// JSON and Markdown the environment `VSCODE_L10N_BUNDLE_LOCATION` (that is how VS Code's client sets it; the servers read it
// through @vscode/l10n). THEIR German bundles are NOT shipped by `vscode-langservers-extracted` — they are in the German language
// pack (microsoft/vscode-loc, `translations/extensions/vscode.<extension>.i18n.json`) and are kept verbatim in `lsp/l10n/de/`; the
// image puts them under `/usr/local/lib/node_modules/cbase-lsp-l10n/` (server/backend/Dockerfile), where a project container
// sees them too. When the UI language changes, a session restarts (sessions.js) — VS Code reloads the window for that.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUFFIXES, LANGUAGES } from "./contract.js";

/** The five packages of the image — name → the start scripts in the package (empty: library only). Bound to the Dockerfile (every
 *  script with `test -f`, test/lsp-core.test.js). `vscode-langservers-extracted` carries three servers: JSON, CSS (also SCSS/Less)
 *  and Markdown. What is started there is the entry point VS Code starts (`*ServerNodeMain.js`, for Markdown `workerMain.js`) — it
 *  reads `VSCODE_L10N_BUNDLE_LOCATION` and then loads the server; the package's `bin/` scripts jump straight into the server and
 *  skip the language (the messages then stay English although the environment is set on the process). */
export const PACKAGES = Object.freeze({
  "typescript-language-server": Object.freeze(["lib/cli.mjs"]),
  typescript: Object.freeze([]),
  basedpyright: Object.freeze(["langserver.index.js"]),
  "yaml-language-server": Object.freeze(["bin/yaml-language-server"]),
  "vscode-langservers-extracted": Object.freeze([
    "lib/json-language-server/node/jsonServerNodeMain.js", "lib/css-language-server/node/cssServerNodeMain.js", "lib/markdown-language-server/node/workerMain.js",
  ]),
});

/** Language → package of the server. */
export const SERVER_PACKAGE = Object.freeze({
  ts: "typescript-language-server",
  python: "basedpyright",
  yaml: "yaml-language-server",
  json: "vscode-langservers-extracted",
  css: "vscode-langservers-extracted",
  markdown: "vscode-langservers-extracted",
});
/** Language → start script in the package (one from PACKAGES). */
export const SERVER_SCRIPT = Object.freeze({
  ts: "lib/cli.mjs",
  python: "langserver.index.js",
  yaml: "bin/yaml-language-server",
  json: "lib/json-language-server/node/jsonServerNodeMain.js",
  css: "lib/css-language-server/node/cssServerNodeMain.js",
  markdown: "lib/markdown-language-server/node/workerMain.js",
});

// The defaults of VS Code 1.143 for CSS, SCSS and Less (extensions/css-language-features/package.json `contributes.configuration`)
// — the same set per language; the server queries them per document under its languageId.
const CSS_LINT = Object.freeze({
  compatibleVendorPrefixes: "ignore", vendorPrefix: "warning", duplicateProperties: "ignore", emptyRules: "warning", importStatement: "ignore",
  boxModel: "ignore", universalSelector: "ignore", zeroUnits: "ignore", fontFaceProperties: "warning", hexColorLength: "error",
  argumentsInColorFunction: "error", unknownProperties: "warning", validProperties: [], ieHack: "ignore", unknownVendorSpecificProperties: "ignore",
  propertyIgnoredDueToDisplay: "warning", important: "ignore", float: "ignore", idSelector: "ignore", unknownAtRules: "warning",
});
const cssSet = () => ({
  validate: true, lint: { ...CSS_LINT },
  completion: { triggerPropertyValueCompletion: true, completePropertyWithSemicolon: true },
  hover: { documentation: true, references: true },
  format: {
    enable: true, newlineBetweenSelectors: true, newlineBetweenRules: true, spaceAroundSelectorSeparator: false, braceStyle: "collapse",
    preserveNewLines: true, maxPreserveNewLines: null,
  },
});

/** The suffixes of the `markdown` language without the dot (VS Code: `markdownFileExtensions` from the language's suffixes) — from the contract. */
export const MARKDOWN_SUFFIXES = Object.freeze(Object.entries(SUFFIXES).filter(([, [sp]]) => sp === "markdown").map(([e]) => e.slice(1)));

// The defaults of VS Code 1.143 for Markdown (extensions/markdown-language-features/package.json), including
// `markdown.validate.enabled: false`. cbase has no editor settings, so the default applies.
const markdownSet = () => ({
  markdown: {
    preferredMdPathExtensionStyle: "auto",
    suggest: { paths: { enabled: true, includeWorkspaceHeaderCompletions: "onDoubleHash" } },
    occurrencesHighlight: { enabled: false },
    validate: {
      enabled: false,
      referenceLinks: { enabled: "warning" }, fragmentLinks: { enabled: "warning" },
      fileLinks: { enabled: "warning", markdownFragmentLinks: "inherit" },
      ignoredLinks: [], unusedLinkDefinitions: { enabled: "hint" }, duplicateLinkDefinitions: { enabled: "warning" },
    },
    server: { log: "off" },
  },
});

const PACKAGE_LOCATIONS = () => [
  process.env.CBASE_LSP_PACKAGES || "",
  path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules"),
  "/usr/local/lib/node_modules",
].filter(Boolean);

/** The folder under which `pack` lives — or null. */
export function packageLocation(pack) {
  for (const location of PACKAGE_LOCATIONS()) { try { if (fs.statSync(path.join(location, pack, "package.json")).isFile()) return location; } catch { /* next */ } }
  return null;
}
/** The version of an installed package (from its package.json) — or null. */
export function packageVersion(pack) {
  const location = packageLocation(pack);
  if (!location) return null;
  try { return String(JSON.parse(fs.readFileSync(path.join(location, pack, "package.json"), "utf8")).version || "") || null; } catch { return null; }
}

// A value under a dotted section ("basedpyright.analysis") — for `workspace/configuration`.
function section(settings, name) {
  if (!name) return settings;
  let v = settings;
  for (const part of String(name).split(".")) { if (v === null || typeof v !== "object" || !(part in v)) return null; v = v[part]; }
  return v;
}

/** The bundles from the German language pack: language → name of the VS Code extension whose bundle carries the server's texts. */
export const L10N_EXTENSION = Object.freeze({ css: "css-language-features", json: "json-language-features", markdown: "markdown-language-features" });
/** The folder in the image (next to the packages, visible in every project container) or in the source tree (only a server in B). */
export const L10N_FOLDER = "cbase-lsp-l10n";
const L10N_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "l10n");

/**
 * The bundle of a language for the UI language `locale` — a `file:` URL or null (English needs none, a language without a bundle
 * stays English). `inContainer`: only the place next to the packages counts (B's source tree is not mounted in the project container).
 */
export function l10nBundle(language, locale, { inContainer = false } = {}) {
  const erw = L10N_EXTENSION[language];
  if (!erw || !locale || locale === "en" || !/^[a-z]{2}(-[a-z]{2})?$/.test(locale)) return null;
  const file = path.join(locale, `vscode.${erw}.i18n.json`);
  const locations = [...PACKAGE_LOCATIONS().map((o) => path.join(o, L10N_FOLDER)), ...(inContainer ? [] : [L10N_SOURCE])];
  for (const o of locations) { const p = path.join(o, file); try { if (fs.statSync(p).isFile()) return pathToFileURL(p).href; } catch { /* next */ } }
  return null;
}
const l10nEnvironment = (language, ctx) => {
  const b = l10nBundle(language, ctx?.locale, { inContainer: Boolean(ctx?.inContainer) });
  return b ? { VSCODE_L10N_BUNDLE_LOCATION: b } : {};
};

/** The built-in table. `ctx`: `{ interpreter, locale, inContainer }` (Python: the path of the chosen interpreter or null; `locale`
 *  the UI language "de"/"en"; `inContainer` — does the server run in a project container). `environment(ctx)`: addition to the
 *  environment of the process. */
const BUILTIN = Object.freeze({
  ts: {
    init: (ctx = {}) => {
      const ts = packageLocation("typescript");
      return {
        hostInfo: "cbase",
        ...(ctx.locale ? { locale: ctx.locale } : {}), // VS Code `typescript.locale` "auto" = the display language
        disableAutomaticTypingAcquisition: true,
        tsserver: { useSyntaxServer: "never", ...(ts ? { fallbackPath: path.join(ts, "typescript", "lib") } : {}) },
        preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
      };
    },
    settings: () => ({}),
  },
  python: {
    init: () => ({}),
    settings: ({ interpreter } = {}) => ({
      python: interpreter ? { pythonPath: interpreter } : {},
      basedpyright: { analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", autoSearchPaths: true, useLibraryCodeForTypes: true } },
    }),
  },
  yaml: {
    init: () => ({}),
    settings: () => ({ yaml: { validate: true, hover: true, completion: true, format: { enable: true } }, redhat: { telemetry: { enabled: false } } }),
  },
  json: {
    init: () => ({ provideFormatter: true }),
    settings: () => ({ json: { validate: { enable: true }, format: { enable: true } } }),
    environment: (ctx) => l10nEnvironment("json", ctx),
  },
  // VS Code starts the CSS server with `provideFormatter: false` and registers formatting itself (css.format.enable) — here the
  // server formats as for JSON (the same options, the same computation: vscode-css-languageservice `format`).
  css: {
    init: () => ({ handledSchemas: ["file"], provideFormatter: true }),
    settings: () => ({ css: cssSet(), scss: cssSet(), less: cssSet() }),
    environment: (ctx) => l10nEnvironment("css", ctx),
  },
  // The client side (markdown/parse, markdown/fs/*) is answered by B — lsp/markdown.js.
  markdown: {
    init: () => ({ markdownFileExtensions: [...MARKDOWN_SUFFIXES] }),
    settings: () => markdownSet(),
    environment: (ctx) => l10nEnvironment("markdown", ctx),
  },
});

let fallback = null;
/** Test seam (see the header): `{ <language>: { command: [program, …arguments], init?, settings? } }` — missing languages then have
 *  NO server (`missing`). `null` takes it back. */
export function setLspTable(t) { fallback = t && typeof t === "object" ? t : null; }

/**
 * The entry of a language: `{ command: [program, …arguments] | null, pack, version, init(ctx), environment(ctx),
 * response(section, ctx), settings(ctx) }`.
 * `command` is null if the package is missing (state `missing`).
 */
export function entryFor(language) {
  if (!LANGUAGES.includes(language)) return null;
  const wrong = process.env.CBASE_LSP_FAKE;
  if (fallback || wrong) {
    let command = null;
    if (fallback) command = Array.isArray(fallback[language]?.command) ? fallback[language].command.map(String) : null;
    else { try { const a = JSON.parse(wrong); if (Array.isArray(a) && a.length) command = [...a.map(String), "--language", language]; } catch { command = null; } }
    const e = fallback?.[language] || {};
    const settings = (ctx) => (typeof e.settings === "function" ? e.settings(ctx) : e.settings || BUILTIN[language].settings(ctx));
    return {
      command, pack: "wrong", version: "wrong",
      init: (ctx) => (typeof e.init === "function" ? e.init(ctx) : e.init || {}),
      environment: (ctx) => (typeof e.environment === "function" ? e.environment(ctx) || {} : {}),
      settings,
      response: (name, ctx) => section(settings(ctx), name),
    };
  }
  const pack = SERVER_PACKAGE[language];
  const location = packageLocation(pack);
  const script = SERVER_SCRIPT[language];
  const b = BUILTIN[language];
  return {
    command: location ? [process.execPath, path.join(location, pack, script), "--stdio"] : null,
    pack,
    version: location ? packageVersion(pack) : null,
    init: (ctx) => b.init(ctx),
    environment: (ctx) => (b.environment ? b.environment(ctx) : {}),
    settings: (ctx) => b.settings(ctx),
    response: (name, ctx) => section(b.settings(ctx), name),
  };
}
