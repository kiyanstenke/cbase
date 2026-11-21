// Duplicate detection of the knowledge WRITE path — unit test of the measure plus end to end against the real server.
//
// Background: a cosine against a guessed threshold (0.5) used to decide here. On real data that was measurably worthless — the
// distributions of "the same reworded" and "another entry of the same project" overlap completely, and a long entry on a
// COMPLETELY unrelated topic was reported as a duplicate (0.533). Because the protocol then tells the model "extend the named
// entry instead", a false alarm would have merged new knowledge into an unrelated entry. These tests hold the new, measured rule.
//
// The knowledge entries below are German ON PURPOSE: the measure (word stems, stop words) works on German user texts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DUP_BLOCK, DUP_HINT, MIN_CAND_STEMS, contentStems, findSimilarContext } from "../electron/server/dedup.js";
import { startServer } from "../electron/server/server.js";

async function json(url, init = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// A realistic inventory: same project, same vocabulary, different statements.
const INVENTORY = [
  {
    id: 1, category: "architecture", title: "Die CSV-Layer erkennt das Trennzeichen aus der Kopfzeile",
    summary: "Papa Parse bekommt das Trennzeichen nicht geraten, sondern aus der ersten Zeile gezählt.",
    body: "Die Vorschau zählt in der Kopfzeile Semikolon, Komma und Tabulator und übergibt das häufigste Zeichen als delimiter an Papa Parse. Die Seitenlogik blättert danach über die geparsten Zeilen, nicht über den Rohtext.",
  },
  {
    id: 2, category: "architecture", title: "Die DOCX-Layer säubert das HTML aus mammoth mit DOMPurify",
    summary: "mammoth liefert HTML, das ungefiltert in die Vorschau ginge; DOMPurify entfernt Skripte und Stile.",
    body: "mammoth wandelt die Datei in HTML. Bevor die Vorschau es einhängt, läuft DOMPurify mit einer engen Erlaubnisliste darüber. Ohne diesen Schritt käme fremdes Markup aus einem hochgeladenen Dokument direkt in die Seite.",
  },
  {
    id: 3, category: "pitfalls", title: "Die Content-API meldet keine Dateigröße und kein Range",
    summary: "Der Endpunkt liefert den vollständigen Inhalt ohne Content-Length; Teilabrufe gibt es nicht.",
    body: "Der Content-Endpunkt antwortet immer mit dem ganzen Dokument. Es gibt weder eine Größenangabe im Kopf noch Unterstützung für Range-Anfragen. Große Dateien muss die Vorschau deshalb vollständig laden oder vorher über einen anderen Weg begrenzen.",
  },
];

test("Dedup measures word coverage, not meaning", () => {
  // 1) The same knowledge, reworded -> blocked as a duplicate.
  const rephrased = {
    category: "architecture", title: "Trennzeichen der CSV-Layer kommt aus der Kopfzeile",
    summary: "Das Trennzeichen wird in der ersten Zeile gezählt und an Papa Parse übergeben.",
    body: "Die CSV-Preview zählt in der Kopfzeile Semikolon, Komma und Tabulator; das häufigste Zeichen geht als delimiter an Papa Parse. Geblättert wird über die geparsten Zeilen.",
  };
  const dup = findSimilarContext(INVENTORY, rephrased);
  assert.equal(dup[0].id, 1, "the matching entry must come first");
  assert.ok(dup[0].score >= DUP_BLOCK, `coverage ${dup[0].score} should be >= ${DUP_BLOCK}`);
  assert.equal(dup[0].blocking, true);

  // 2) Another topic, SAME vocabulary — exactly the case where the cosine failed.
  const otherThema = {
    category: "pitfalls", title: "Die Vorschau lädt pdf.js erst beim Öffnen",
    summary: "Der Import ist dynamisch, damit das Bündel klein bleibt.",
    body: "pdf.js wird per dynamischem Import geholt, sobald der Nutzer ein PDF öffnet. Vorher steckt die Bibliothek nicht im Startbündel. Die Textebene entsteht danach als eigene Schicht über der gezeichneten Seite.",
  };
  assert.deepEqual(findSimilarContext(INVENTORY, otherThema).filter((c) => c.blocking), [],
    "another topic must never block");

  // 3) A completely unrelated topic -> no hit at all.
  assert.deepEqual(findSimilarContext(INVENTORY, {
    category: "domain", title: "Urlaub wird im Personalportal beantragt",
    summary: "Die Teamleitung gibt frei, Resturlaub verfällt Ende März.",
    body: "Urlaubsanträge stellt jeder selbst im Personalportal. Die Freigabe erteilt die Teamleitung. Resturlaub verfällt am 31. März des Folgejahres.",
  }), []);
});

test("Dedup does not block on too few words", () => {
  // A candidate made almost only of everyday words reaches 100 % coverage quickly — with six words that is no evidence.
  // Measured: title-only candidates (6–11 stems) reached up to 0.73 on FOREIGN entries, real short entries stayed below 0.35.
  const tiny = { category: "architecture", title: "CSV-Layer", summary: "", body: "" };
  assert.ok(contentStems(`${tiny.title} ${tiny.summary} ${tiny.body}`).length < MIN_CAND_STEMS);
  const found = findSimilarContext(INVENTORY, tiny);
  assert.ok(found.every((c) => !c.blocking), "below MIN_CAND_STEMS nothing may block");
});

test("Thresholds are ordered and the hint level is the weaker one", () => {
  assert.ok(DUP_HINT < DUP_BLOCK, "the hint threshold must lie below the block threshold");
});

test("Create: a strong duplicate blocks, a weak hit comes along as a hint", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dedup-"));
  let server;
  const previousBin = process.env.CLAUDE_BIN;
  try {
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "proj");
    fs.mkdirSync(path.join(projPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(projPath, "src", "csv.js"), "one");

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Dedup", path: wsPath }) })).body;
    const proj = (await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "proj", path: projPath }) })).body;
    const ctx = `${base}/api/projects/${proj.id}/context`;

    const first = await json(ctx, { method: "POST", body: JSON.stringify(INVENTORY[0]) });
    assert.equal(first.status, 201);
    assert.equal(first.body.similar, undefined, "the first entry has nothing it could resemble");

    // The same once more, worded differently -> 200 with duplicate:true, NOTHING created.
    const again = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Trennzeichen der CSV-Layer kommt aus der Kopfzeile",
      summary: "Das Trennzeichen wird in der ersten Zeile gezählt und an Papa Parse übergeben.",
      body: "Die CSV-Preview zählt in der Kopfzeile Semikolon, Komma und Tabulator; das häufigste Zeichen geht als delimiter an Papa Parse. Geblättert wird über die geparsten Zeilen.",
    }) });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.candidates[0].id, first.body.id);
    assert.equal((await json(`${ctx}?meta=1`)).body.length, 1, "nothing may have been created");

    // force overrides the block.
    const forced = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Trennzeichen der CSV-Layer kommt aus der Kopfzeile",
      summary: "Das Trennzeichen wird in der ersten Zeile gezählt.",
      body: "Die CSV-Preview zählt in der Kopfzeile die Kandidaten und übergibt das häufigste Zeichen.",
      slug: "csv-delimiter-second-revision", force: true,
    }) });
    assert.equal(forced.status, 201);

    // A separate entry with related vocabulary is created — and only ACCOMPANIED.
    const related = await json(ctx, { method: "POST", body: JSON.stringify(INVENTORY[1]) });
    assert.equal(related.status, 201, "a related topic must be created");
    assert.ok(related.body.id, "the entry must really exist");
    if (related.body.similar) {
      assert.ok(related.body.hint, "similar comes with the explanatory hint");
      assert.ok(related.body.similar.every((c) => !c.blocking));
    }
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (previousBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = previousBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Knowledge stays readable when the project folder is not a git repo", { timeout: 120_000 }, async () => {
  // Three calls in the real chat history ended with "fatal: not a git repository" INSTEAD of a knowledge list — a read failed on a
  // side computation. Freshness is an extra; if it is missing, the entry is "not assessable", not an error.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-nogit-"));
  let server;
  const previousBin = process.env.CLAUDE_BIN;
  try {
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "proj");
    fs.mkdirSync(path.join(projPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(projPath, "src", "a.js"), "one");
    // Deliberately NO git init.
    fs.symlinkSync(path.join(projPath, "src", "way.js"), path.join(projPath, "src", "dead.js"));
    assert.throws(() => execFileSync("git", ["status"], { cwd: projPath, stdio: "pipe" }));

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "NoGit", path: wsPath }) })).body;
    const proj = (await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "proj", path: projPath }) })).body;
    const ctx = `${base}/api/projects/${proj.id}/context`;

    const created = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Ohne Repo geht es auch",
      summary: "Der Eintrag hängt an Dateien, die in keinem Git-Repo liegen.",
      body: "Die Veraltet-Erkennung braucht Commits. Gibt es keine, bleibt der Eintrag unbewertet — lesbar ist er trotzdem. Der tote Symlink daneben darf die Pfadgruppierung nicht umwerfen.",
      codePaths: ["src/a.js"], force: true,
    }) });
    assert.equal(created.status, 201, "creating must not fail on a missing git");

    const list = await json(`${ctx}?meta=1`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const searched = await json(`${ctx}?meta=1&search=${encodeURIComponent("Was passiert ohne Git-Repo?")}`);
    assert.equal(searched.status, 200, "the meaning search must answer too");

    const one = await json(`${ctx}/${created.body.id}`);
    assert.equal(one.status, 200);

    // Verifying is not possible here by the subject — but with an EXPLANATION, not git gibberish.
    const verified = await json(`${ctx}/${created.body.id}/verify`, { method: "POST" });
    assert.equal(verified.status, 400);
    assert.ok(/Git-Repo|git repo/i.test(verified.body.error));
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (previousBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = previousBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
