// Guard for lib/separator-tone.ts: completion notices and workflow markers render as a status line with a symbol;
// real boundaries (compaction, clear, hint) stay lines. Counter-test: a renderer that does not ask for the tone is caught.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const tsc = path.join(here, "..", "node_modules", "typescript", "bin", "tsc");
let out = null;
after(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

async function load(file) {
  out = out || fs.mkdtempSync(path.join(os.tmpdir(), "cbase-separator-tone-"));
  execFileSync(process.execPath, [tsc, path.join(src, "lib", file), "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck"], { stdio: "pipe" });
  fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
  return import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
}

test("separatorTone: events get a symbol, boundaries stay lines", async () => {
  const { separatorTone } = await load("separator-tone.ts");
  assert.equal(separatorTone("completionNotice", "Monitor “{name}” ended"), "ok");
  assert.equal(separatorTone("completionNotice", "Monitor “{name}” reports"), "notice");
  assert.equal(separatorTone("completionNotice", "Monitor “{name}” timed out"), "error");
  assert.equal(separatorTone("completionNotice", "Subagent \"{name}\" finished"), "ok");
  assert.equal(separatorTone("completionNotice", "Subagent \"{name}\" failed"), "error");
  assert.equal(separatorTone("completionNotice", "Copy “{name}” not built"), "error");
  assert.equal(separatorTone("completionNotice", "Copy “{name}” ready"), "ok");
  assert.equal(separatorTone("workflow-start", "Workflow “{name}” started"), "start");
  assert.equal(separatorTone("workflow-end", "Workflow “{name}” interrupted"), "error");
  assert.equal(separatorTone("workflow-end", "Workflow “{name}” finished"), "ok");
  assert.equal(separatorTone("hint", "Effort now medium"), null);
  assert.equal(separatorTone(undefined, "Context compacted"), null);
});

test("separator row asks for the tone and then draws a status line (no rule)", () => {
  const q = fs.readFileSync(path.join(src, "components", "chat", "SeparatorRow.tsx"), "utf8");
  const check = (text) => /const tone = separatorTone\(b\.kind, b\.label\);\s*if \(tone\) \{[\s\S]*?<StatusLine /.test(text);
  assert.ok(check(q), "SeparatorRow.tsx does not ask separatorTone or does not draw a status line");
  // Counter-test: without the query the guard would be red.
  assert.equal(check(q.replace("const tone = separatorTone(b.kind, b.label);", "const tone = null;")), false);
});

test("web <-> iOS binding: same error words and same \" reports\" ending (mobile/…/Chat/CompletionNotice.swift SeparatorTone)", () => {
  const web = fs.readFileSync(path.join(src, "lib", "separator-tone.ts"), "utf8");
  const ios = fs.readFileSync(path.join(here, "..", "..", "mobile", "CbaseMobile", "Chat", "CompletionNotice.swift"), "utf8");
  const list = (text, re) => { const m = re.exec(text); assert.ok(m, "list not found"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };
  const w = list(web, /const ERROR = \[([^\]]*)\]/);
  const i = list(ios, /errorWords = \[([^\]]*)\]/);
  assert.deepEqual(i, w, "the error words of web and iOS differ");
  assert.match(web, /endsWith\(" reports"\)/);
  assert.match(ios, /hasSuffix\(" reports"\)/);
  // Counter-test: a missing word on one side is caught.
  assert.notDeepEqual(i.slice(1), w);
});
