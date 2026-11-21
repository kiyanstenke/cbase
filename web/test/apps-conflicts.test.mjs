// The apps page no longer computes port conflicts itself. There used to be three conflict computations: the findings
// of /api/ports/running, the prompt of the registration agent and this page (`new Set(arr.map((a) => a.projectId)).size > 1`
// over the services). With the project containers: a RELOCATED project has no conflicts (own network namespace), and
// only the server knows that (ops marker AND instance row). A page that keeps computing itself would still show the
// relocated project as a conflict, beside a server list that says "none". The one computation stands in
// `store.projectPortConflicts`, the page reads it through GET /api/ports/conflicts; the server path has its guard in
// server/backend/test/conflict-transition.test.js.
//
// The promise, read by path (kind "contracts"), for BOTH apps pages: web (`web/src/app/apps/page.tsx`) and iOS
// (`mobile/CbaseMobile/Shell/AppsPage.swift`, where `conflictPorts` kept counting the projectIds per port itself, and
// "1 conflict · resolve recommended" stood beside a web that showed none): the page no longer carries the signature
// of the old computation, asks /api/ports/conflicts on loading AND on every refresh of the services (otherwise a
// moved port would stand there with the old conflict for one tick), and a service is in conflict when ITS project
// holds the port there (`conflicts[<service>.projectId]`), not because some project holds the port. Also: an error of
// the conflict route does not tear services and workspaces down with it (on the web: the query stands in no
// `Promise.all`; an error there left the page empty and held every start transition), and it keeps the LAST state
// (never `setConflicts({})` or `?? [:]`: empty would mean "no conflicts", and empty is not unknown).
//
// Counter-tests: the page in the state before the server computation turns the first three checks red; the page
// with `Promise.all` around the conflict query turns "tears down" red; AppsPage.swift with its own count turns
// "computes itself", "queries 0", "per project" red. The built-in sabotage below shows the same patterns red on
// artificial sources.
//
// Run:  node --test web/test/apps-conflicts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(HERE, "..", "src", "app", "apps", "page.tsx");
const PAGE_IOS = path.resolve(HERE, "..", "..", "mobile", "CbaseMobile", "Shell", "AppsPage.swift");

// The signature of the conflict computation: a set of the project ids of a port and its size against 1 or 2 (the same
// pattern as in the backend guard); in Swift the collecting of the projectIds per port (`byPort[port, default: []].insert(…)`).
const COMPUTATION = /new Set\([^;\n]*?\.projectId\)\)\.size\s*(?:[<>]=?|={2,3})\s*[12]\b/;
const COMPUTATION_SWIFT = /\.insert\(\s*\w+\.projectId\s*\)/;
const QUERY = /api<[^>]*>\(\s*"\/api\/ports\/conflicts"\s*\)/g;
const QUERY_SWIFT = /client\.get\(\s*"\/api\/ports\/conflicts"\s*\)/g;
const PER_PROJECT = /conflicts\[\s*s\.projectId\s*\]/;
const PER_PROJECT_SWIFT = /conflicts\[\s*\w+\.projectId\s*\]/;
// The conflict query in a `Promise.all([...])` (not allSettled): its error discards the other results.
// The array ends at `])`; a type like `ProjectService[]>` does not end it.
const TEARS_WITH = /Promise\.all\(\[(?:(?!Promise\.|\]\s*\))[\s\S])*?"\/api\/ports\/conflicts"/;
// … and an error sets the conflicts to empty instead of keeping the last state.
const EMPTY_INSTEAD_UNKNOWN = /setConflicts\(\s*\{\s*\}\s*\)/;
const EMPTY_INSTEAD_UNKNOWN_SWIFT = /"\/api\/ports\/conflicts"\s*\)\s*\)?\s*\?\?\s*\[:\]|conflicts\s*=\s*\[:\]/;

function check(text) {
  return {
    computesSelf: COMPUTATION.test(text),
    query: [...text.matchAll(QUERY)].length,
    perProject: PER_PROJECT.test(text),
    tearsWith: TEARS_WITH.test(text),
    emptyInsteadUnknown: EMPTY_INSTEAD_UNKNOWN.test(text),
  };
}
function checkSwift(text) {
  return {
    computesSelf: COMPUTATION_SWIFT.test(text),
    query: [...text.matchAll(QUERY_SWIFT)].length,
    perProject: PER_PROJECT_SWIFT.test(text),
    emptyInsteadUnknown: EMPTY_INSTEAD_UNKNOWN_SWIFT.test(text),
  };
}

test("apps page (web): no own conflict computation, the conflicts come from /api/ports/conflicts, read per project, without tearing the services down", () => {
  const text = fs.readFileSync(PAGE, "utf8");
  const r = check(text);
  console.log(`[apps-conflicts] ${path.relative(path.resolve(HERE, ".."), PAGE)}: own computation ${r.computesSelf ? "YES" : "no"}, queries ${r.query}, per project ${r.perProject ? "yes" : "NO"}, tears down ${r.tearsWith ? "YES" : "no"}, empty instead of unknown ${r.emptyInsteadUnknown ? "YES" : "no"}`);
  assert.equal(r.computesSelf, false, "the page computes conflicts itself; the one computation is store.projectPortConflicts (GET /api/ports/conflicts)");
  assert.equal(r.query, 1, "GET /api/ports/conflicts in refreshServices: on loading (load calls it) and on every refresh");
  assert.equal(r.perProject, true, "a service is in conflict when ITS project holds the port (conflicts[s.projectId])");
  assert.equal(r.tearsWith, false, "the conflict query stands in a Promise.all; its error discards services and workspaces (use Promise.allSettled)");
  assert.equal(r.emptyInsteadUnknown, false, "an error sets the conflicts to {}; it must keep the last state");
});

test("apps page (iOS): the same promise — no own count of the projectIds per port, /api/ports/conflicts on loading and refreshing", () => {
  const text = fs.readFileSync(PAGE_IOS, "utf8");
  const r = checkSwift(text);
  console.log(`[apps-conflicts] ${path.relative(path.resolve(HERE, "..", ".."), PAGE_IOS)}: own computation ${r.computesSelf ? "YES" : "no"}, queries ${r.query}, per project ${r.perProject ? "yes" : "NO"}, empty instead of unknown ${r.emptyInsteadUnknown ? "YES" : "no"}`);
  assert.equal(r.computesSelf, false, "AppsPage.swift counts the projects per port itself; the one computation is GET /api/ports/conflicts");
  assert.equal(r.query, 1, "GET /api/ports/conflicts in refreshServices(): load() calls it");
  assert.equal(r.perProject, true, "a service is in conflict when ITS project holds the port (conflicts[service.projectId])");
  assert.equal(r.emptyInsteadUnknown, false, "an error of the conflict route sets the conflicts to empty; it must keep the last state");
});

test("built-in sabotage: the old computation, a page without query and a tearing-down query are noticed", () => {
  const old = `
  const conflictPorts = new Set<number>();
  for (const [port, arr] of claimsByPort) {
    if (new Set(arr.map((a) => a.projectId)).size > 1) conflictPorts.add(port);
  }
  const conflict = s.port != null && conflictPorts.has(s.port);`;
  assert.deepEqual(check(old), { computesSelf: true, query: 0, perProject: false, tearsWith: false, emptyInsteadUnknown: false });
  const cascading = `
  const [ps, k] = await Promise.all([api<ProjectService[]>("/api/project-services"), api<PortConflicts>("/api/ports/conflicts")]);
  const inConflict = (s: ProjectService) => Boolean(conflicts[s.projectId]?.items.some((i) => i.port === s.port));`;
  assert.deepEqual(check(cascading), { computesSelf: false, query: 1, perProject: true, tearsWith: true, emptyInsteadUnknown: false });
  const fresh = `
  const [ps, k] = await Promise.allSettled([api<ProjectService[]>("/api/project-services"), api<PortConflicts>("/api/ports/conflicts")]);
  if (k.status === "fulfilled") setConflicts(k.value);
  const inConflict = (s: ProjectService) => Boolean(conflicts[s.projectId]?.items.some((i) => i.port === s.port));`;
  assert.deepEqual(check(fresh), { computesSelf: false, query: 1, perProject: true, tearsWith: false, emptyInsteadUnknown: false });
  // A Promise.all WITHOUT the conflict query, then the query alone: no tearing down (the array ends at `])`).
  const separated = `
  const [w] = await Promise.all([api<Workspace[]>("/api/workspaces")]);
  try { setConflicts(await api<PortConflicts>("/api/ports/conflicts")); } catch { setConflicts({}); }`;
  assert.deepEqual(check(separated), { computesSelf: false, query: 1, perProject: false, tearsWith: false, emptyInsteadUnknown: true });

  const oldSwift = `
    var conflictPorts: Set<Int> {
        var byPort: [Int: Set<String>] = [:]
        for service in services {
            guard let port = service.port else { continue }
            byPort[port, default: []].insert(service.projectId)
        }
        return Set(byPort.filter { $0.value.count > 1 }.keys)
    }`;
  assert.deepEqual(checkSwift(oldSwift), { computesSelf: true, query: 0, perProject: false, emptyInsteadUnknown: false });
  const emptySwift = `conflicts = (try? await client.get("/api/ports/conflicts")) ?? [:]`;
  assert.deepEqual(checkSwift(emptySwift), { computesSelf: false, query: 1, perProject: false, emptyInsteadUnknown: true });
  const newSwift = `
        if let k: [String: PortConflictGroup] = try? await client.get("/api/ports/conflicts") { conflicts = k }
        return conflicts[service.projectId]?.items.contains { $0.port == port } ?? false`;
  assert.deepEqual(checkSwift(newSwift), { computesSelf: false, query: 1, perProject: true, emptyInsteadUnknown: false });
});
