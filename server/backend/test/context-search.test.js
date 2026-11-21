// Hybrid knowledge search against the real server: BM25 from the FTS5 index (including German word forms), structure boosts,
// persistent vectors, retrofitting existing databases. The knowledge entries and queries are German ON PURPOSE (stemming, stop words).
//
// The semantic part needs the local embedding model. If it cannot be loaded (e.g. in an environment without a model folder),
// the search degrades to BM25 + boosts — the test then checks exactly that instead of failing. What does NOT depend on the
// model is always checked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "../electron/server/server.js";
import { embeddingsAvailable } from "../electron/server/embeddings.js";
import { parseQuery } from "../electron/server/retrieval.js";

async function json(url, init = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const titles = (rows) => rows.map((r) => r.title);
const byTitle = (rows, t) => rows.find((r) => r.title === t);

test("Question decomposition: stems + prefix expression, stop words out", () => {
  const q = parseQuery("Wie starte ich das Gateway neu?");
  assert.ok(!q.tokens.includes("wie"), "stop word 'wie' must be out");
  assert.ok(!q.tokens.includes("das"), "stop word 'das' must be out");
  // "starte" -> stem "start", phrased as a prefix: also finds "starten"/"Startbefehl".
  assert.ok(q.stems.includes("start"), `stem 'start' missing: ${q.stems.join(",")}`);
  assert.ok(q.stems.includes("gateway"), `stem 'gateway' missing: ${q.stems.join(",")}`);
  assert.match(q.match, /"gateway"\*/);
  assert.match(q.match, / OR /);
  // Shortened only as long as at least four characters remain: "Ports" -> "port" (the prefix search still finds "Ports"), "Port" stays "port".
  assert.equal(parseQuery("Ports").stems[0], "port");
  assert.equal(parseQuery("Port").stems[0], "port");
  assert.equal(parseQuery("Repo").stems[0], "repo");
  // An empty or character-less question must not produce a MATCH expression (otherwise FTS5 throws).
  assert.equal(parseQuery("   ?!  ").match, "");
});

test("Hybrid knowledge search: BM25, word forms, boosts, vector persistence", { timeout: 300_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ctxsearch-"));
  let server;
  const previousBin = process.env.CLAUDE_BIN;
  try {
    // The workspace dump classifies via LLM — fail at once in the test so that the deterministic fallback applies instead of a real CLI.
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;

    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "proj");
    fs.mkdirSync(path.join(projPath, "gateway"), { recursive: true });
    fs.mkdirSync(path.join(projPath, "src"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: projPath, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(projPath, "gateway", "index.js"), "// gateway");
    fs.writeFileSync(path.join(projPath, "src", "ports.js"), "// ports");
    git("add", "-A");
    git("commit", "-qm", "init");

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Search", path: wsPath }) })).body;
    const proj = (await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "proj", path: projPath }) })).body;
    const ctx = `${base}/api/projects/${proj.id}/context`;

    const add = async (payload) => {
      const r = await json(ctx, { method: "POST", body: JSON.stringify({ force: true, ...payload }) });
      assert.equal(r.status, 201, `creating failed: ${JSON.stringify(r.body)}`);
      return r.body;
    };

    // Three entries that separate clearly by subject. The question words of the test deliberately stand in another inflection in the
    // text (or not at all) — exactly what the old LIKE could not do.
    const gw = await add({
      category: "setup", title: "Gateway neu laden",
      body: "Das Gateway der Beispiel-App läuft als systemd-Unit demo-gateway.service. Neu starten über systemctl restart; ein von Hand gestarteter Prozess bleibt systemd unbekannt.",
      summary: "Neustart über systemd statt von Hand.",
      codePaths: ["gateway/"], tags: ["ops", "systemd"],
    });
    await add({
      category: "architecture", title: "Sauerteig ansetzen",
      body: "Den Sauerteig aus Roggenmehl und lauwarmem Wasser ansetzen. Nach drei Tagen verdoppelt sich das Volumen; riecht er nach Aceton, fehlt Futter — dann die Hälfte abnehmen und frisch füttern.",
      summary: "Wie man einen Sauerteig ansetzt und füttert.",
      tags: ["baking"],
    });
    const ports = await add({
      category: "architecture", title: "Portzuteilung",
      body: "project_services ist die einzige Quelle für Ports. Ein Scan zeigt den echten Prozess samt mismatch.",
      summary: "Woher Portnummern kommen.",
      codePaths: ["src/ports.js"], tags: ["ports"],
    });

    // ── 1) Word form: "Gateways" (plural) finds "Gateway" ────────────────────
    // This is the core of the rework. `q` is a substring match — it does NOT find the entry.
    const exact = await json(`${ctx}?q=Gateways&status=all`);
    assert.equal(exact.status, 200);
    assert.equal(exact.body.length, 0, "q is a substring search and must not find the plural");

    const hit = await json(`${ctx}?search=${encodeURIComponent("Wie starte ich die Gateways neu?")}&status=all`);
    assert.equal(hit.status, 200);
    assert.ok(hit.body.length >= 1, "meaning search finds nothing");
    assert.equal(hit.body[0].title, "Gateway neu laden", `wrong hit: ${titles(hit.body).join(" | ")}`);
    assert.ok(hit.body[0].relevance > 0, "relevance missing");
    assert.ok(hit.body[0].scoreParts, "scoreParts missing");
    assert.ok(hit.body[0].scoreParts.signals.includes("bm25"), `BM25 signal missing: ${JSON.stringify(hit.body[0].scoreParts)}`);

    // ── 2) `q` stays exact and unchanged ──────────────────────────────────
    const shift = await json(`${ctx}?q=Roggenmehl&status=all`);
    assert.equal(shift.body.length, 1);
    assert.equal(shift.body[0].title, "Sauerteig ansetzen");

    // ── 3) Structure boost: a path hit lifts the matching entry ───────────
    const viaPath = await json(`${ctx}?search=${encodeURIComponent("ports.js")}&status=all`);
    assert.equal(viaPath.body[0].title, "Portzuteilung", `path boost does not apply: ${titles(viaPath.body).join(" | ")}`);
    assert.ok(viaPath.body[0].scoreParts.signals.includes("path"), `path signal missing: ${JSON.stringify(viaPath.body[0].scoreParts)}`);

    // ── 3b) Noise limit: if the knowledge is missing, the answer is EMPTY ─────────────
    // An everyday word hits almost every entry weakly via BM25. Three irrelevant hits are worse for an agent than none — they cost
    // context and lay a false trail. Measured on real knowledge: usable hits from ~0.19, noise at 0.01–0.10.
    const nothing = await json(`${ctx}?search=${encodeURIComponent("Wie richte ich die Lohnbuchhaltung fuer Schweden ein?")}&status=all`);
    assert.equal(nothing.status, 200);
    assert.equal(nothing.body.length, 0, `noise instead of an empty set: ${nothing.body.map((r) => `${r.title} [${r.relevance}]`).join(" | ")}`);

    // And the tail below a strong find is cut off: "Roggenmehl Aceton Sauerteig lauwarm" hits exactly one entry strongly, the others at most weakly via everyday words.
    const armed = await json(`${ctx}?search=${encodeURIComponent("Roggenmehl Aceton Sauerteig lauwarm")}&status=all`);
    assert.equal(armed.body.length, 1, `tail not cut off: ${armed.body.map((r) => `${r.title} [${r.relevance}]`).join(" | ")}`);
    assert.equal(armed.body[0].title, "Sauerteig ansetzen");

    // ── 3c) Pinned is a sort criterion, no proof of relevance ─────────────
    // Observed live: with B_PINNED == MIN_RELEVANCE, pinning alone carried over the limit, and the same entry came back for EVERY
    // question — also for an unrelated question about booking a ferry.
    await json(`${ctx}/${gw.id}`, { method: "PUT", body: JSON.stringify({ pinned: true }) });
    const despitePin = await json(`${ctx}?search=${encodeURIComponent("Wie buche ich eine Fähre nach Schweden?")}&status=all`);
    assert.equal(despitePin.body.length, 0,
      `a pinned entry without a content signal must not appear: ${despitePin.body.map((r) => `${r.title} [${r.relevance}]`).join(" | ")}`);
    // With a real hit the pin still works — just on top.
    const withPin = await json(`${ctx}?search=${encodeURIComponent("systemd Unit neu starten")}&status=all`);
    assert.equal(withPin.body[0].title, "Gateway neu laden");
    assert.ok(withPin.body[0].scoreParts.signals.includes("pinned"), "pin signal missing on a real hit");
    await json(`${ctx}/${gw.id}`, { method: "PUT", body: JSON.stringify({ pinned: false }) });

    // ── 4) `q` prefilters, `search` sorts ────────────────────────────────
    const combined = await json(`${ctx}?q=Volumen&search=${encodeURIComponent("Roggenmehl Aceton")}&status=all`);
    assert.equal(combined.body.length, 1, "q must prefilter the candidate set");
    assert.equal(combined.body[0].title, "Sauerteig ansetzen");
    // q excludes what search would otherwise have found.
    const filtered = await json(`${ctx}?q=Volumen&search=${encodeURIComponent("systemd Unit neu starten")}&status=all`);
    assert.equal(filtered.body.length, 0, "q must not let the gateway entry through");

    // ── 4b) DOCUMENTED LIMIT: no hit without a common word stem ────
    // The question word for "capacity" is a synonym for the entry's word for "volume" but stands nowhere in the entry. Only semantics could bridge that, and it must not
    // CREATE hits — measured on real data, the cosine distributions of right and wrong entries overlap so strongly that the
    // sharpest threshold would have 57 % false alarms (see the head of retrieval.js). This test holds the decision: a deliberately
    // empty result instead of guessing.
    const onlySemantic = await json(`${ctx}?search=${encodeURIComponent("Wo befindet sich das Fassungsvermögen?")}&status=all`);
    assert.equal(onlySemantic.body.length, 0,
      `semantics must not create hits: ${onlySemantic.body.map((r) => `${r.title} [${r.relevance}]`).join(" | ")}`);

    // ── 5) limit takes effect ───────────────────────────────────────────────────────
    const capped = await json(`${ctx}?search=${encodeURIComponent("Sauerteig Ports Gateway")}&limit=1&status=all`);
    assert.equal(capped.body.length, 1, "limit is not applied");

    // ── 6) meta=1 still delivers NO body, although needed internally ────
    // (The vector arises from title+summary+body; if the body were missing before embedding, the stored vector would be permanently wrong.)
    const metaOnly = await json(`${ctx}?search=${encodeURIComponent("systemd")}&meta=1&status=all`);
    assert.ok(metaOnly.body.length >= 1);
    assert.equal(metaOnly.body[0].body, undefined, "meta=1 must not deliver the body");
    assert.ok(metaOnly.body[0].summary, "the summary must stay with meta=1");

    // ── 7) Freshness is also delivered in the search result ────────────────────
    fs.appendFileSync(path.join(projPath, "gateway", "index.js"), "\n// changed");
    git("add", "-A");
    git("commit", "-qm", "gateway touched");
    const stale = await json(`${ctx}?search=${encodeURIComponent("systemd Unit neu starten")}&status=all`);
    const gwHit = byTitle(stale.body, "Gateway neu laden");
    assert.ok(gwHit, "entry vanished");
    assert.equal(gwHit.freshness?.stale, true, "stale detection missing in the search result");
    // Stale entries are NOT penalised — they should be found and verified.
    assert.equal(stale.body[0].title, "Gateway neu laden");

    // ── 8) deprecated slides down but does not vanish ────────────
    await json(`${ctx}/${ports.id}`, { method: "PUT", body: JSON.stringify({ status: "deprecated" }) });
    const withDeprecated = await json(`${ctx}?search=${encodeURIComponent("ports.js Portquelle")}&status=all`);
    const dep = byTitle(withDeprecated.body, "Portzuteilung");
    assert.ok(dep, "deprecated must not vanish, only be downgraded");
    assert.ok(dep.scoreParts.signals.includes("deprecated"), `downgrade signal missing: ${JSON.stringify(dep.scoreParts)}`);
    // The default (status=active) hides it as before.
    const activeOnly = await json(`${ctx}?search=${encodeURIComponent("ports.js Portquelle")}&status=active`);
    assert.equal(byTitle(activeOnly.body, "Portzuteilung"), undefined);

    // ── 9) Workspace archive: the same path ───────────────────────────────────
    const wsCtx = `${base}/api/workspaces/${ws.id}/context`;
    const dumped = await json(wsCtx, { method: "POST", body: JSON.stringify({
      text: "Der Zugangs-Token der Wetter-API gilt nur befristet. Läuft er ab, bricht jede Verbindung mit HTTP 401 ab.",
      route: "workspace",
    }) });
    assert.equal(dumped.status, 201, `workspace dump creation failed: ${JSON.stringify(dumped.body)}`);
    const wsHit = await json(`${wsCtx}?search=${encodeURIComponent("Tokens laufen ab, Verbindung bricht")}&status=all`);
    assert.equal(wsHit.status, 200);
    assert.ok(wsHit.body.length >= 1, "workspace search finds nothing");
    assert.ok(wsHit.body[0].relevance > 0, "relevance missing in the workspace result");
    // The store form is preserved (the clients read snake_case).
    assert.ok("created_at" in wsHit.body[0], "store form of the workspace entry changed");
    assert.equal(wsHit.body[0].updatedAt, undefined, "helper field updatedAt must not leak out");

    // ── 10) Vectors are persisted in the DB ─────────────────────────────
    const haveModel = await embeddingsAvailable();
    const idx = await json(`${base}/api/context-index`);
    assert.equal(idx.status, 200);
    assert.ok(idx.body.model, "model identifier missing");
    if (haveModel) {
      // Searching wrote the candidates' vectors; reindex catches up with the rest.
      const re = await json(`${base}/api/context-index/reindex`, { method: "POST", body: JSON.stringify({}) });
      assert.equal(re.status, 200);
      assert.equal(re.body.scopes.project.indexed, re.body.scopes.project.total,
        `project vectors incomplete: ${JSON.stringify(re.body.scopes)}`);
      assert.equal(re.body.scopes.workspace.indexed, re.body.scopes.workspace.total,
        `workspace vectors incomplete: ${JSON.stringify(re.body.scopes)}`);

      // Rebuild after a model change: discard everything, restore everything.
      const reset = await json(`${base}/api/context-index/reindex`, { method: "POST", body: JSON.stringify({ reset: true }) });
      assert.ok(reset.body.cleared > 0, "reset discarded no vectors");
      assert.equal(reset.body.scopes.project.indexed, reset.body.scopes.project.total);

      // Semantics alone: a question without a single word in common with the entry.
      const purely = await json(`${ctx}?search=${encodeURIComponent("Wie bringe ich den Dienst nach einer Änderung wieder hoch?")}&status=all`);
      const semHit = byTitle(purely.body, "Gateway neu laden");
      if (semHit) assert.ok(semHit.scoreParts.semantic > 0, "semantic signal missing");
    }

    // ── 11) Retrofitting an existing DB: index complete after restart ──
    // The FTS index is rebuilt from the content on every initStore ('rebuild'). A restart on the same dataRoot must therefore be searchable again without further action.
    await new Promise((resolve) => server.close(resolve));
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base2 = `http://127.0.0.1:${server.address().port}`;
    const after = await json(`${base2}/api/projects/${proj.id}/context?search=${encodeURIComponent("Gateways neu starten")}&status=all`);
    assert.equal(after.status, 200);
    assert.equal(after.body[0]?.title, "Gateway neu laden", `index empty after restart: ${titles(after.body || []).join(" | ")}`);
    assert.equal(byTitle(after.body, "Gateway neu laden").id, gw.id);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
