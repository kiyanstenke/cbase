// Facade: the content lives in lib/api/<part>.ts, cut along the `// ──` sections of the old file. Importers
// stay with `@/lib/api`. The `.js` endings are deliberate: web/test/global-events.test.mjs compiles this file
// with tsc WITHOUT a tsconfig and loads the result as ESM in Node — without an ending Node would not find the
// parts; Next resolves `.js` → `.ts` via experimental.extensionAlias (next.config.ts).
export * from "./api/core.js";
export * from "./api/events.js";
export * from "./api/workflows.js";
export * from "./api/workspace.js";
export * from "./api/git.js";
export * from "./api/devtools.js";
export * from "./api/adjust.js";
export * from "./api/archive.js";
export * from "./api/communication.js";
export * from "./api/outerloop.js";
export * from "./api/preview.js";
export * from "./api/instances.js";
export * from "./api/copy-progress.js";
export * from "./api/skills.js";
export * from "./api/skill-history.js";
export * from "./api/agenda.js";
export * from "./api/scheduled.js";
export * from "./api/administration.js";
export * from "./api/usage.js";
export * from "./api/gitView.js";
export * from "./api/lsp.js";
export * from "./api/outputs.js";
export * from "./api/timeline.js";
export * from "./api/instructions.js";
export * from "./api/log-window.js";
