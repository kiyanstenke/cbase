// Files in the copy, tool part of the loop engine (project container stage 2; server/backend/electron/server/providers/tool-runtime.js).
//
// THE GAP THIS CLOSES. Read, Write, Edit, MultiEdit, Glob, Grep and NotebookEdit run in B. A chat in its copy (ctx.instance = copy)
// therefore read and wrote the MAIN: the copy's overlay view only hangs in the copy container. Now every path under a copy's project
// folder goes through the file access (runtime/fileAccess.js); the runtime folder stays in B.
//
// The promises, each with the way that breaks it:
//   (1) Parity: on the same tree the tools of a copy return the same as those in B without an instance (Read: rows, offset/limit,
//       image block, notebook, "too large", folder; Glob; Grep in all modes, context, multiline, expression error) - the rules of the
//       cores in the container are those of the tools in B.
//   (2) The copy is the truth: what the copy chat writes it reads back there, B (the main) stays byte-exact (sha256); the tool of a chat in
//       the main does not see the copy's file. Edit/MultiEdit/NotebookEdit change there, with the result B would give for the same change.
//   (3) The runtime folder stays in B: a path there leads to not a single `docker exec` into the copy.
//   (4) No fallback: while the container is down, all tools on a path of the copy end with a tool error - the main is untouched, nothing
//       appears in B. If the copy's project folder cannot be determined, the same (closed).
//   (5) The sandbox applies literally: a path outside cwd/addDirs is also rejected in the copy.
//   (6) No way through B into the main: a path that is NOT under the project folder by its wording goes to B - a link in the runtime folder
//       to `<P>/file` or to `<P>`, a link prefix to "/" (like /proc/self/root on Linux) in the runtime folder or outside all roots. Read,
//       Write, Edit, MultiEdit, Glob and Grep report "path leads out of the allowed area", the main stays sha-equal, no new name appears
//       there; what really lies in the runtime folder keeps working. Before, the project folder was a root without an anchor and came into
//       the area in B by realpath - as the folder of the MAIN (runs/runtime-limit.js areaInB).
//   (7) STRICT: a root of the copy without a trusted anchor (a folder in the project folder that the main replaced by a link to the
//       outside in B) does not make "outside" an area.
//   (8) LOCKED: also an area whose trusted anchor itself contains the main's project folder (the runtime folder as a link) does not lead
//       into the main; beside it the area still applies.
//
// No clock: the copy arises through the real queue (stacks-copy-harness.mjs); states are waited on.
//
// COUNTER-TESTS (each ONE sabotage on a copy of the tree via a script; the whole file run; every sabotage red):
//   tool-runtime.js: copy is never recognised                 => (1), (2), (3), (4), (5) red
//   tool-runtime.js: read reads in B                          => (1), (2), (3), (4), (5) red
//   tool-runtime.js: write writes in B                        => (2), (4) red
//   tool-runtime.js: edit changes in B                        => (2), (4) red
//   tool-runtime.js: multiedit changes in B                   => (2), (4) red
//   tool-runtime.js: glob goes to B                           => (4) red
//   tool-runtime.js: grep goes to B                           => (4) red
//   tool-runtime.js: notebook changes in B                    => (2), (4) red
//   tool-runtime.js: runtime folder through the container     => (3) red
//   tool-runtime.js: unknown project folder falls back to B   => (4) red
//   tool-runtime.js: sandbox of the copy without a check      => (5) red
//   tool-runtime.js: grep ignores context                     => (1) red
//   tool-runtime.js: glob without the heavy-folder filter     => (1) red
//   tool-runtime.js: grep without the heavy-folder filter     => (1) red
//   tool-runtime.js: grep ignores case                        => (1) red
//   tool-runtime.js: read too large without a message         => (1) red
//   runtime-limit.js: roots swapped                           => (1), (2), (3), (4), (5) red
// For (6)-(8):
//   real-path.js: realRoot without `strict` (root without an anchor by realpath)   => (7) red
//   real-path.js: inArea without locks                                             => (8) red
//   runtime-limit.js: areaInB without `{ strict: true }`                           => (7) red
//   runtime-limit.js: areaInB without withLocks                                    => (8) red
//   tool-runtime.js: areaOf calculates the copy like the main                      => (6), (8) red
// (6) stays green against EACH SINGLE one of the two halves - each closes the finding's way alone; (7) and (8) each pin one.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBuiltinTool } from "../electron/server/providers/tool-runtime.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import * as dz from "../electron/server/runtime/fileAccess.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, situationDefault, withCopy } from "./stacks-copy-harness.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (p) => sha(fs.readFileSync(p));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "code", metadata: {}, source: ["print(1)\n", "print(2)\n"], outputs: [], execution_count: null },
    { cell_type: "markdown", metadata: {}, source: ["# Titel"] },
  ],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}, null, 1);

// A tree in the main BEFORE the copy starts: it shows through in the copy (lower layer).
function mainTree(root) {
  const write = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  write("lang.txt", Array.from({ length: 12 }, (_, i) => `Row ${i + 1}${i % 4 === 0 ? " TODO" : ""}`).join("\n") + "\n");
  write("image.png", PNG);
  write("nb.ipynb", NOTEBOOK);
  write("nb-b.ipynb", NOTEBOOK);
  write("large.txt", "x".repeat(400_001));
  write("src/a.ts", "export const a = 1; // TODO one\nexport const b = 2;\n");
  write("src/deep/b.ts", "// Todo lower\nconst c = 3;\nconst d = 4;\n");
  write("src/deep/c.md", "# TODO\nText\n");
  write("node_modules/pkg/index.ts", "// TODO in the heavy folder\n"); // Glob and Grep leave it out - also in the container
  write(".hidden/v.ts", "// TODO in the hidden folder\n");
}

async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  const inst = instanceForProject(pid, "copy-k1");
  assert.ok(inst && instanceIsCopy(inst), "the instance of the copy must resolve");
  return inst;
}
// The context of a tool: copy chat (`instance` = copy) or "as in B" (no instance).
const context = (b, instance, extra = {}) => ({ cwd: b.s.path, addDirs: [], env: process.env, instance, ...extra });
const tool = (name, args, ctx) => runBuiltinTool(name, args, ctx);
const execInCopy = (b) => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(b.copy)).length;
const rows = (t) => String(t).split("\n").sort();

test("(1) Parity: on the same tree Read, Glob and Grep in the copy supply the same as in B", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const K = context(b, inst);
    const B = context(b, null);
    const p = (rel) => path.join(b.s.path, rel);
    const both = async (name, args) => {
      const k = await tool(name, args, K);
      const h = await tool(name, args, B);
      return { k, h };
    };
    const equal = async (name, args, what, sorted = false) => {
      const { k, h } = await both(name, args);
      assert.equal(k.isError, h.isError, `${what}: error status (${JSON.stringify(k.content).slice(0, 200)} / ${JSON.stringify(h.content).slice(0, 200)})`);
      if (sorted) assert.deepEqual(rows(k.content), rows(h.content), what);
      else assert.deepEqual(k.content, h.content, what);
      return k;
    };

    // Read: rows with numbers, offset/limit, notebook, image (block with base64), too large, folder.
    const r = await equal("Read", { file_path: p("lang.txt") }, "Read lang.txt");
    assert.match(r.content, /1\tRow 1 TODO/);
    await equal("Read", { file_path: p("lang.txt"), offset: 3, limit: 2 }, "Read offset/limit");
    await equal("Read", { file_path: p("nb.ipynb") }, "Read notebook");
    const image = await equal("Read", { file_path: p("image.png") }, "Read image");
    assert.equal(image.content[1].type, "image");
    assert.equal(image.content[1].source.data, PNG.toString("base64"));
    const large = await equal("Read", { file_path: p("large.txt") }, "Read too large");
    assert.equal(large.isError, true);
    assert.match(large.content, /File too large \(400001 bytes\)/);
    const folder = await equal("Read", { file_path: b.s.path }, "Read of a folder");
    assert.equal(folder.isError, true);
    const missing = await both("Read", { file_path: p("missing.txt") });
    assert.equal(missing.k.isError, true);
    assert.match(missing.k.content, /^Error \(Read\): ENOENT: no such file or directory, open '/);
    assert.equal(missing.h.isError, true);

    // Glob: the same set (the order by modification time differs after copying), relative patterns and a file name alone.
    await equal("Glob", { pattern: "**/*.ts" }, "Glob **/*.ts", true);
    await equal("Glob", { pattern: "*.md" }, "Glob *.md", true);
    await equal("Glob", { pattern: "*.ts", path: p("src") }, "Glob with path", true);
    await equal("Glob", { pattern: "**/*.nichts" }, "Glob without a hit");
    await equal("Glob", { pattern: "*", path: p("src/exists-not") }, "Glob of a missing folder");
    const glob = await tool("Glob", { pattern: "**/*.ts" }, K);
    assert.ok(glob.content.split("\n").every((z) => path.isAbsolute(z) && z.startsWith(b.s.path + path.sep)), `Glob names paths of the copy like B: ${glob.content}`);

    // Grep: all modes; the order of the files follows the directory walk, hence sorted - a single file exactly.
    await equal("Grep", { pattern: "TODO" }, "Grep content", true);
    await equal("Grep", { pattern: "todo", "-i": true }, "Grep -i", true);
    await equal("Grep", { pattern: "TODO", output_mode: "files_with_matches" }, "Grep files_with_matches", true);
    await equal("Grep", { pattern: "TODO", output_mode: "count" }, "Grep count", true);
    await equal("Grep", { pattern: "TODO", glob: "*.ts" }, "Grep glob", true);
    await equal("Grep", { pattern: "TODO", type: "md" }, "Grep type", true);
    await equal("Grep", { pattern: "TODO", "-n": false }, "Grep without numbers", true);
    await equal("Grep", { pattern: "Row 5", path: p("lang.txt"), "-C": 2 }, "Grep of a file with context");
    await equal("Grep", { pattern: "TODO", path: p("lang.txt"), "-B": 1 }, "Grep of a file with two groups");
    await equal("Grep", { pattern: "const c = 3;\\nconst d", multiline: true, path: p("src") }, "Grep multiline", true);
    await equal("Grep", { pattern: "TODO", path: p("lang.txt"), head_limit: 2 }, "Grep head_limit");
    await equal("Grep", { pattern: "exists-not-xyz" }, "Grep without a hit");
    const bad = await equal("Grep", { pattern: "(" }, "Grep with an invalid expression");
    assert.equal(bad.isError, true);
    assert.match(bad.content, /Invalid RegExp/);
    // The hits come from the copy's view: the binary (PNG) and the heavy folders are missing like in B.
    assert.ok(!/image\.png/.test((await tool("Grep", { pattern: ".", output_mode: "files_with_matches" }, K)).content));
  });
});

test("(2) The copy is the truth: Write, Edit, MultiEdit and NotebookEdit change only it - the main stays byte-exact, its tool sees nothing of it", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const K = context(b, inst);
    const H = context(b, instanceForProject(b.s.projectId)); // the chat in the main (instance, but no copy)
    const p = (rel) => path.join(b.s.path, rel);
    const prior = Object.fromEntries(["lang.txt", "nb.ipynb", "nb-b.ipynb", "notes.md"].map((n) => [n, shaFile(p(n))]));
    const mainUnchanged = (what) => { for (const [n, s] of Object.entries(prior)) assert.equal(shaFile(p(n)), s, `${what}: ${n} changed in the main`); };

    // Write: new (with a new folder) and over a file of the main.
    let r = await tool("Write", { file_path: p("fresh/only-copy.txt"), content: "K1\n" }, K);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /^File written: .*only-copy\.txt \(3 bytes\)$/);
    assert.equal(fs.existsSync(p("fresh")), false, "Write of the copy created the folder in B");
    assert.match((await tool("Read", { file_path: p("fresh/only-copy.txt") }, K)).content, /1\tK1/);
    const inMain = await tool("Read", { file_path: p("fresh/only-copy.txt") }, H);
    assert.equal(inMain.isError, true, "the tool in the main sees the copy's file");
    r = await tool("Write", { file_path: p("notes.md"), content: "new in the copy\n" }, K);
    assert.equal(r.isError, false, r.content);
    assert.equal((await tool("Read", { file_path: p("notes.md") }, K)).content.includes("new in the copy"), true);
    assert.equal((await tool("Read", { file_path: p("notes.md") }, H)).content.includes("Notizen"), true, "the main keeps its text");
    mainUnchanged("Write");

    // Edit: unique, not unique (the same error as in B), not found, replace_all.
    r = await tool("Edit", { file_path: p("lang.txt"), old_string: "Row 2", new_string: "Second" }, K);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /^File edited: /);
    let read = (await dz.read(inst, p("lang.txt"))).data.toString();
    assert.match(read, /Second/);
    assert.ok(!/Row 2\n/.test(read));
    r = await tool("Edit", { file_path: p("lang.txt"), old_string: "TODO", new_string: "DONE" }, K);
    assert.equal(r.isError, true);
    assert.match(r.content, /not unique/);
    r = await tool("Edit", { file_path: p("lang.txt"), old_string: "exists-not", new_string: "x" }, K);
    assert.match(r.content, /old_string not found/);
    r = await tool("Edit", { file_path: p("lang.txt"), old_string: "TODO", new_string: "DONE", replace_all: true }, K);
    assert.equal(r.isError, false, r.content);
    read = (await dz.read(inst, p("lang.txt"))).data.toString();
    assert.ok(!/TODO/.test(read) && /DONE/.test(read));
    r = await tool("Edit", { file_path: p("missing.txt"), old_string: "a", new_string: "b" }, K);
    assert.equal(r.isError, true);
    assert.match(r.content, /ENOENT/);

    // MultiEdit: all changes or none.
    r = await tool("MultiEdit", { file_path: p("src/a.ts"), edits: [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "b = 2", new_string: "b = 20" }] }, K);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /^File edited \(2 changes\): /);
    assert.match((await dz.read(inst, p("src/a.ts"))).data.toString(), /a = 10[\s\S]*b = 20/);
    r = await tool("MultiEdit", { file_path: p("src/a.ts"), edits: [{ old_string: "a = 10", new_string: "a = 11" }, { old_string: "exists-not", new_string: "x" }] }, K);
    assert.equal(r.isError, true);
    assert.match((await dz.read(inst, p("src/a.ts"))).data.toString(), /a = 10/, "half a MultiEdit change remained");

    // NotebookEdit: the same result as the same change in B (on the copy of the notebook in the main, without an instance).
    const nb = { edit_mode: "replace", cell_number: 0, new_source: "x = 1\ny = 2\n" };
    r = await tool("NotebookEdit", { notebook_path: p("nb.ipynb"), ...nb }, K);
    assert.equal(r.isError, false, r.content);
    const inB = await tool("NotebookEdit", { notebook_path: p("nb-b.ipynb"), ...nb }, context(b, null));
    assert.equal(inB.isError, false, inB.content);
    assert.equal(r.content.replace("nb.ipynb", "X"), inB.content.replace("nb-b.ipynb", "X"), "the message");
    assert.equal((await dz.read(inst, p("nb.ipynb"))).data.toString(), fs.readFileSync(p("nb-b.ipynb"), "utf8"), "the notebook in the copy like the one in B");
    r = await tool("NotebookEdit", { notebook_path: p("nb.ipynb"), edit_mode: "insert", cell_number: 0, cell_type: "markdown", new_source: "Fresh" }, K);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /^Notebook edited \(insert, cell 0\): /);
    r = await tool("NotebookEdit", { notebook_path: p("nb.ipynb"), edit_mode: "delete", cell_number: 99 }, K);
    assert.equal(r.isError, true);
    assert.match(r.content, /out of range/);

    // After everything: the main is byte-exact (except the notebook nb-b.ipynb, which B changed on purpose).
    delete prior["nb-b.ipynb"];
    mainUnchanged("all tools of the copy");
  });
});

test("(3) The runtime folder stays in B: a path there leads to not a single exec into the copy", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const runtime = locationFor({ projectId: b.s.projectId, converted: true }).root;
    const file = path.join(runtime, "outputs", "chat1", "report.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "Report\nwith TODO\n");
    const K = context(b, inst, { addDirs: [runtime] });
    const beforehand = execInCopy(b);
    let r = await tool("Read", { file_path: file }, K);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /2\twith TODO/);
    r = await tool("Write", { file_path: path.join(runtime, "outputs", "chat1", "fresh.txt"), content: "N\n" }, K);
    assert.equal(r.isError, false, r.content);
    assert.equal(fs.readFileSync(path.join(runtime, "outputs", "chat1", "fresh.txt"), "utf8"), "N\n", "the runtime folder lies in B");
    r = await tool("Edit", { file_path: file, old_string: "Report", new_string: "FinalReport" }, K);
    assert.equal(r.isError, false, r.content);
    assert.equal(fs.readFileSync(file, "utf8"), "FinalReport\nwith TODO\n");
    r = await tool("Glob", { pattern: "*.txt", path: path.join(runtime, "outputs") }, K);
    assert.equal(r.content.split("\n").length, 2, r.content);
    r = await tool("Grep", { pattern: "TODO", path: path.join(runtime, "outputs") }, K);
    assert.match(r.content, /report\.txt:2:with TODO/);
    assert.equal(execInCopy(b), beforehand, "a tool on the runtime folder went into the copy's container");
    // The counter-check of the count: a path of the copy counts.
    await tool("Read", { file_path: path.join(b.s.path, "lang.txt") }, K);
    assert.ok(execInCopy(b) > beforehand, "a path of the copy did not go into the container");
  });
});

test("(4) No fallback: while the container is down all tools on a path of the copy end with an error - the main is untouched, nothing appears in B; the same without a determinable project folder", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const K = context(b, inst);
    const p = (rel) => path.join(b.s.path, rel);
    const prior = { lang: shaFile(p("lang.txt")), nb: shaFile(p("nb.ipynb")), notes: shaFile(p("notes.md")) };
    const cfg = path.join(b.fd.dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [b.copy] }));
    const calls = [
      ["Read", { file_path: p("lang.txt") }],
      ["Write", { file_path: p("fallback.txt"), content: "in B?\n" }],
      ["Edit", { file_path: p("lang.txt"), old_string: "Row 2", new_string: "X" }],
      ["MultiEdit", { file_path: p("lang.txt"), edits: [{ old_string: "Row 2", new_string: "X" }] }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Grep", { pattern: "TODO" }],
      ["Grep", { pattern: "TODO", path: p("lang.txt") }],
      ["NotebookEdit", { notebook_path: p("nb.ipynb"), edit_mode: "replace", cell_number: 0, new_source: "x" }],
    ];
    for (const [name, args] of calls) {
      const r = await tool(name, args, K);
      assert.equal(r.isError, true, `${name}: returned ${JSON.stringify(r.content).slice(0, 160)} instead of an error (fallback to B?)`);
      assert.match(r.content, new RegExp(`^Error \\(${name}\\): `));
    }
    assert.equal(shaFile(p("lang.txt")), prior.lang);
    assert.equal(shaFile(p("nb.ipynb")), prior.nb);
    assert.equal(shaFile(p("notes.md")), prior.notes);
    assert.equal(fs.existsSync(p("fallback.txt")), false, "Write created the file in B");

    // The copy's project folder cannot be determined (the instance belongs to no project of the store): closed, not B.
    const foreign = { projectId: "exists-not", instance: "copy-k9", identifier: "exists-not/copy-k9" };
    const F = context(b, foreign);
    for (const [name, args] of calls) {
      const r = await tool(name, args, F);
      assert.equal(r.isError, true, `${name} without a project folder: ${JSON.stringify(r.content).slice(0, 160)}`);
      assert.match(r.content, /project folder of the copy exists-not\/copy-k9 cannot be determined/);
    }
    assert.equal(shaFile(p("lang.txt")), prior.lang);
    assert.equal(fs.existsSync(p("fallback.txt")), false);
  });
});

test("(5) The sandbox applies literally: a path outside cwd and addDirs is also rejected in the copy; without a copy instance no exec runs", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const K = context(b, inst, { cwd: path.join(b.s.path, "src") }); // the sandbox root is only src/
    const beforehand = execInCopy(b);
    for (const rel of [path.join(b.s.path, "lang.txt"), "../lang.txt", "deep/../../lang.txt"]) { // absolute outside, relative out
      const r = await tool("Read", { file_path: rel }, K);
      assert.equal(r.isError, true, `Read ${rel}`);
      assert.match(r.content, /Path outside the allowed area/);
    }
    const w = await tool("Write", { file_path: path.join(b.s.path, "outside.txt"), content: "x" }, K);
    assert.equal(w.isError, true);
    assert.match(w.content, /Path outside the allowed area/);
    assert.equal(fs.existsSync(path.join(b.s.path, "outside.txt")), false);
    assert.equal((await tool("Read", { file_path: "a.ts" }, K)).isError, false, "a relative path under cwd works");
    assert.equal(execInCopy(b) > beforehand, true);

    // Without a copy instance (none, the main) it stays in B: no exec into the copy.
    const after = execInCopy(b);
    for (const instance of [null, instanceForProject(b.s.projectId)]) {
      const r = await tool("Write", { file_path: path.join(b.s.path, "main.txt"), content: "H\n" }, context(b, instance));
      assert.equal(r.isError, false, r.content);
      assert.equal(fs.readFileSync(path.join(b.s.path, "main.txt"), "utf8"), "H\n");
      assert.equal((await tool("Read", { file_path: path.join(b.s.path, "main.txt") }, context(b, instance))).isError, false);
      fs.rmSync(path.join(b.s.path, "main.txt"));
    }
    assert.equal(execInCopy(b), after, "a tool without a copy instance went into the copy's container");
  });
});

// ── No way through B into the main ─────────────────────────────────────────────────────────────────────────────────────────────────
// A path that is NOT under the project folder by its WORDING goes to B (file way "b") - and B sees the main there. For a copy only what
// lies under a trusted anchor (the runtime folder) counts in B, and no real location in the main's project folder.
const attempts = async (K, w, what) => {
  for (const [name, args] of [
    ["Read", { file_path: w }],
    ["Write", { file_path: w, content: "FROM THE COPY\n" }],
    ["Edit", { file_path: w, old_string: "Row 2", new_string: "EDIT FROM THE COPY" }],
    ["MultiEdit", { file_path: w, edits: [{ old_string: "Row 3", new_string: "X" }] }],
    ["Grep", { pattern: "Row", path: w }],
  ]) {
    const r = await tool(name, args, K);
    assert.equal(r.isError, true, `${what}: ${name} ${w} lieferte ${JSON.stringify(r.content).slice(0, 200)}`);
    assert.match(r.content, /Path leads out of the allowed area|Path outside the allowed area/, `${what}: ${name} ${w}`);
  }
};

test("(6) A link in the runtime folder to the main and a link prefix to \"/\" (like /proc/self/root): Read, Write, Edit, MultiEdit, Glob and Grep of the copy reject, the main stays byte-exact", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const runtime = locationFor({ projectId: b.s.projectId, converted: true }).root;
    const output = path.join(runtime, "outputs", ctx.chat.id);
    fs.mkdirSync(output, { recursive: true });
    const p = (rel) => path.join(b.s.path, rel);
    const target = p("lang.txt");
    const prior = shaFile(target);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-copy-root-"));
    try {
      // What the copy's Bash can create in the rw-mounted runtime folder, and a "/" outside all roots.
      fs.symlinkSync(target, path.join(output, "x.txt"));
      fs.symlinkSync(b.s.path, path.join(output, "project"));
      fs.symlinkSync("/", path.join(output, "root"));
      fs.symlinkSync("/", path.join(outside, "root"));
      const K = context(b, inst, { addDirs: [output] });
      for (const w of [path.join(output, "x.txt"), path.join(output, "project", "lang.txt"), path.join(output, "root") + target, path.join(outside, "root") + target]) {
        await attempts(K, w, "link into the main");
        assert.equal(shaFile(target), prior, `the main was changed through ${w}`);
      }
      // A NEW name behind the link to the project folder: nothing appears in the main.
      for (const w of [path.join(output, "project", "new-from-copy.txt"), path.join(outside, "root") + p("new-from-copy.txt")]) {
        const r = await tool("Write", { file_path: w, content: "x" }, K);
        assert.equal(r.isError, true, `Write ${w}: ${r.content}`);
      }
      assert.equal(fs.existsSync(p("new-from-copy.txt")), false, "Write created a file in the main through a link");
      // Glob and Grep over the folder link: no tree walk through the main.
      for (const [name, args] of [["Glob", { pattern: "**/*.txt", path: path.join(output, "project") }], ["Grep", { pattern: "TODO", path: path.join(output, "project") }]]) {
        const r = await tool(name, args, K);
        assert.equal(r.isError, true, `${name} returned ${JSON.stringify(r.content).slice(0, 200)}`);
        assert.ok(!String(r.content).includes("lang.txt") && !String(r.content).includes("Row 1"), `${name} shows files of the main: ${r.content}`);
      }
      // What really lies in the runtime folder stays in B.
      let r = await tool("Write", { file_path: path.join(output, "real.txt"), content: "REAL\n" }, K);
      assert.equal(r.isError, false, r.content);
      r = await tool("Read", { file_path: path.join(output, "real.txt") }, K);
      assert.match(r.content, /1\tREAL/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("(7) A root of the copy without a trusted anchor does not count in B: a folder in the project folder that the main replaced by a link to the outside does not make \"outside\" an area of the copy", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-copy-root-"));
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-copy-foreign-"));
    try {
      fs.writeFileSync(path.join(foreign, "secret.txt"), "Row 1\nRow 2\nRow 3\n");
      const prior = shaFile(path.join(foreign, "secret.txt"));
      // In B (the main) `sub` is a link to the outside; for the copy `sub` is a root under its project folder - without an anchor in B.
      fs.symlinkSync(foreign, path.join(b.s.path, "sub"));
      fs.symlinkSync("/", path.join(outside, "root"));
      const K = context(b, inst, { addDirs: [path.join(b.s.path, "sub")] });
      const w = path.join(outside, "root") + path.join(foreign, "secret.txt");
      await attempts(K, w, "root without an anchor");
      assert.equal(shaFile(path.join(foreign, "secret.txt")), prior, "a file outside was changed through the root without an anchor");
      const fresh = await tool("Write", { file_path: path.join(outside, "root") + path.join(foreign, "fresh.txt"), content: "x" }, K);
      assert.equal(fresh.isError, true, fresh.content);
      assert.equal(fs.existsSync(path.join(foreign, "fresh.txt")), false);
    } finally {
      fs.rmSync(path.join(b.s.path, "sub"), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
});

test("(8) The lock: also an area whose trusted anchor itself contains the main's project folder (runtime folder as a link) does not lead into the main - what lies beside stays reachable", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const runtime = locationFor({ projectId: b.s.projectId, converted: true }).root;
    const aside = `${runtime}.aside`;
    const top = path.dirname(b.s.path);
    const target = path.join(b.s.path, "lang.txt");
    const prior = shaFile(target);
    fs.renameSync(runtime, aside);
    try {
      fs.symlinkSync(top, runtime); // the anchor (a mount point, B trusts its realpath) contains the main's folder here
      const K = context(b, inst, { addDirs: [runtime] });
      await attempts(K, path.join(runtime, path.basename(b.s.path), "lang.txt"), "anchor above the main");
      assert.equal(shaFile(target), prior, "the main was changed through an anchor that contains it");
      // Beside the project folder the area still applies: the lock cuts out only the main.
      const beside = path.join(runtime, "beside-from-copy.txt");
      const r = await tool("Write", { file_path: beside, content: "D\n" }, K);
      assert.equal(r.isError, false, r.content);
      assert.equal(fs.readFileSync(path.join(top, "beside-from-copy.txt"), "utf8"), "D\n");
      fs.rmSync(path.join(top, "beside-from-copy.txt"));
    } finally {
      fs.rmSync(runtime, { force: true });
      fs.renameSync(aside, runtime);
    }
  });
});
