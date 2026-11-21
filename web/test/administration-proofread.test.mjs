// Findings from the proofreading of the administration, one guard each. The pure computations
// (src/lib/administration-procedure.ts, src/lib/escape-level.ts) are EXECUTED; the wiring in web and iOS that no
// type error reports is read as text; the UI-test fixture is DRIVEN with a wrong req/res.
//   (W2) Draft per user: arises only from an input, Save and Discard delete it. An unchanged draft hid newer saved
//        values, and Save wrote foreign changes back. Web and iOS.
//   (W4) Escape in a sheet of the administration closed the WHOLE settings including the input: the kit modal
//        listens on `document`, takes the press only if no element inside has taken it already, and consumes it
//        (`preventDefault`); the settings on `window` leave a consumed one alone. NO capture phase with
//        `stopImmediatePropagation`: the rename in the layout (ProjectLayout.tsx, `stopPropagation` in the field)
//        would otherwise close the creation dialog.
//   (W5) A jump to a filtered page (administration as non-admin) showed "Provider" while nothing was marked:
//        marking and cross-fade hang on the page that REALLY stands (`active.key`).
//   (I1) A manual action without an answer (iOS: 45 s of the URLSession; both: the tunnel's 524 after ~100 s) meant
//        "failed", the mark dropped, a second press started a second time: own deadlines on iOS (180 s, erase
//        300 s), "still running", the mark stays, reloading continues until the state shows the action. Web and
//        iOS compute alike (cases and deadlines bound).
//   (I2) The UI-test fixture (mobile/test-fixtures/chat-gateway/routes-settings.mjs) behaves like the gateway:
//        start/restart of a locked user 409; "last admin" counts only ACTIVE admins (demoting a locked admin
//        works), and locking or demoting the last active admin is 400.
//
// Counter-tests (one sabotage each, shown red):
//   AdministrationSettings.tsx `toggle` creates `setDrafts((e) => ({ ...e, [n.id]: n.resources! }))` again   => (W2, web) red
//   lib/administration-procedure.ts `draftGone` always returns `drafts`                                       => (W2, computation) red
//   Settings/AdministrationSettings.swift `setDraft` sets `draft = fresh` (without the fallback to nil)        => (W2, iOS) red
//   CbKit.tsx Modal back to `window.addEventListener("keydown", h)`                                            => (W4, wiring) red
//   SettingsModal.tsx back to `if (e.key === "Escape") onClose();`                                             => (W4, wiring) red
//   lib/escape-level.ts without `!e.cancelBubble`                                                              => (W4, computation) red
//   SettingsModal.tsx `const on = s.key === section;`                                                          => (W5) red
//   lib/administration-procedure.ts `arrived` "restart" without the comparison of `since`                      => (I1, computation) red
//   Models/AdministrationModels.swift `containerAction` without `timeout:`                                     => (I1, iOS) red
//   lib/api/core.ts without `Object.assign(err, { httpStatus: r.status });`                                    => (I1, web) red
//   AdministrationSettings.tsx `manualAction` without the branch `if (runningStill(e)) { … bringAlong … }`    => (I1, web) red
//   AdministrationSettings.tsx `alive` cleared only in the cleanup (`useEffect(() => () => { alive.current = false; }, [])`) => (I1, web) red
//   routes-settings.mjs without the 409 for locked users                                                       => (I2) red
//   routes-settings.mjs without the 400 for locking the last active admin                                      => (I2) red
//   routes-settings.mjs demoting with the old count (`n.role === "admin" && … active admins <= 1`)             => (I2) red
//
// The counter-tests ran against the file, not the browser: (W4, computation) simulates the propagation (React on
// `document`, the sheet after it on `document`, the settings on `window`); there is no DOM in the suite (no jsdom in
// web/node_modules).
//
// Run:  node --test --test-reporter=tap web/test/administration-proofread.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const repo = path.resolve(webDir, "..");
const ios = path.join(repo, "mobile", "CbaseMobile");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");
const readIos = (rel) => fs.readFileSync(path.join(ios, rel), "utf8");

// A function body from its header line to the closing brace at the same indentation, alone on its line: a multi-line
// signature (`}: {` and `}) {` of the kit `Modal`, of the delete sheet) also begins its lines with `}`.
function body(text, header) {
  const i = text.indexOf(header);
  assert.ok(i >= 0, `not found: ${header}`);
  const lineStart = text.lastIndexOf("\n", i) + 1;
  const inset = text.slice(lineStart, i).match(/^\s*/)[0];
  const end = text.indexOf(`\n${inset}}\n`, i);
  assert.ok(end > i, `end not found: ${header}`);
  return text.slice(i, end + inset.length + 2);
}

let A = null;
let E = null;
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-administration-proofread-"));
if (fs.existsSync(tsc)) {
  execFileSync(process.execPath, [
    tsc, path.join(src, "lib", "administration-procedure.ts"), path.join(src, "lib", "escape-level.ts"),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  A = await import(pathToFileURL(path.join(out, "administration-procedure.js")).href);
  E = await import(pathToFileURL(path.join(out, "escape-level.js")).href);
}
process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));

// ── W2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(W2, computation) a draft arises only from a deviating input; Save and Discard delete it; otherwise the CURRENT state is shown", (t) => {
  if (!A) { t.skip("node_modules missing (tsc)"); return; }
  const old = { ramGiB: 16, cpuPrio: "normal", cpuMax: null };
  const newStatus = { ramGiB: 24, cpuPrio: "up", cpuMax: 8 }; // a second admin has saved in the meantime
  let e = {};
  // Expanding alone creates nothing; the saved state is shown, also the new one.
  assert.equal(A.displayedStatus(e, "u1", old), old);
  assert.equal(A.displayedStatus(e, "u1", newStatus), newStatus, "without a draft the row shows what is saved NOW");
  // An input equal to the saved state is no draft.
  e = A.draftAfterInput(e, "u1", { ...old }, old);
  assert.deepEqual(e, {});
  // A deviating input is one, and an input back to the saved state removes it again.
  const ram20 = { ...old, ramGiB: 20 };
  e = A.draftAfterInput(e, "u1", ram20, old);
  assert.equal(A.displayedStatus(e, "u1", old), ram20);
  e = A.draftAfterInput(e, "u1", { ...old }, old);
  assert.deepEqual(e, {}, "back to the saved state: no draft any more");
  // Save deletes the sent draft; an input WHILE saving (another object) stays.
  e = A.draftAfterInput(e, "u1", ram20, old);
  const during = A.draftAfterInput(e, "u1", { ...old, ramGiB: 22 }, old);
  assert.deepEqual(A.draftGone(during, "u1", ram20), during, "a newer input survives the save");
  assert.deepEqual(A.draftGone(e, "u1", ram20), {}, "saved: the draft drops");
  // Discard deletes unconditionally; a foreign draft stays; without a draft the same reference.
  const two = A.draftAfterInput(A.draftAfterInput({}, "u1", ram20, old), "u2", ram20, old);
  assert.deepEqual(Object.keys(A.draftGone(two, "u1")), ["u2"]);
  const empty = {};
  assert.equal(A.draftGone(empty, "u1"), empty);
  assert.equal(A.sameValues(old, null), false, "without a saved state every input is a draft");
});

test("(W2, web) AdministrationSettings.tsx: expanding creates no draft; input, save, discard and display go through the computation", () => {
  const v = read("components/settings/AdministrationSettings.tsx");
  const toggle = body(v, "function toggle(");
  assert.ok(!toggle.includes("setDrafts"), "toggle creates a draft again");
  const setter = v.match(/setDrafts\([^\n]*/g) ?? [];
  assert.ok(setter.length > 0);
  for (const z of setter) {
    assert.match(z, /setDrafts\(\(e\) => draft(AfterInput|Gone)\(/, `a draft is set past the computation: ${z}`);
  }
  assert.ok(v.includes("onChange={(r) => setDrafts((e) => draftAfterInput(e, n.id, r, n.resources))}"), "the input does not go through draftAfterInput");
  assert.ok(v.includes("onDismiss={() => setDrafts((e) => draftGone(e, n.id))}"), "Discard does not delete the draft");
  assert.ok(body(v, "async function save(").includes("setDrafts((e) => draftGone(e, n.id, draft));"), "Save does not delete the sent draft");
  assert.ok(v.includes("const draft = displayedStatus(drafts, n.id, n.resources);"), "the row shows neither the draft nor the CURRENT state");
});

test("(W2, iOS) Settings/AdministrationSettings.swift: a draft arises only in `setDraft` (with fallback to nil), Save and Discard set nil", () => {
  const s = readIos("Settings/AdministrationSettings.swift");
  const assignments = s.match(/\bdraft = [^\n]*/g) ?? [];
  assert.deepEqual(assignments.sort(), [
    "draft = fresh == n.resources ? nil : fresh",
    "draft = nil }",
    "draft = nil }",
  ].sort(), `foreign assignments to the draft: ${JSON.stringify(assignments)}`);
  assert.ok(s.includes("if ok && draft == e { draft = nil }"), "Save does not delete the draft (or also deletes a newer input)");
  assert.ok(s.includes('Button(L("Discard changes##draft")) { draft = nil }'), "Discard does not delete the draft");
  assert.equal((s.match(/setDraft\(AdministrationResources\(/g) ?? []).length, 3, "RAM, priority and upper limit go through setDraft");
});

// ── W4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The piece of DOM at stake: React listens on `document` (Next.js `hydrateRoot(document)`, registered first), the kit
// modal then also on `document`, the settings on `window`. `stopPropagation` stops before `window`, not before the
// next listener on the same node; that is why the sheet asks `cancelBubble`.
function press({ react, sheet, settings }) {
  const e = {
    key: "Escape", defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; },
  };
  const to = { sheet: false, settings: false };
  react?.(e);
  if (sheet && E.sheetTakesEscape(e)) { e.preventDefault(); to.sheet = true; }
  if (!e.cancelBubble && settings && E.sheetTakesEscape(e)) to.settings = true;
  return to;
}

test("(W4, computation) Escape in the sheet closes only the sheet; a field that takes Escape itself keeps both; without a sheet the settings close", (t) => {
  if (!E) { t.skip("node_modules missing (tsc)"); return; }
  assert.deepEqual(press({ sheet: true, settings: true }), { sheet: true, settings: false }, "password sheet: only the sheet closes");
  assert.deepEqual(press({ sheet: false, settings: true }), { sheet: false, settings: true }, "without a sheet: the settings close");
  // The rename in the layout (ProjectLayout.tsx): `stopPropagation` in the field; the sheet (creation dialog) stays open.
  assert.deepEqual(press({ react: (e) => e.stopPropagation(), sheet: true, settings: true }), { sheet: false, settings: false });
  // An element that consumes Escape (an open search field): both stay.
  assert.deepEqual(press({ react: (e) => e.preventDefault(), sheet: true, settings: true }), { sheet: false, settings: false });
  assert.equal(E.sheetTakesEscape({ key: "Enter", defaultPrevented: false, cancelBubble: false }), false);
});

test("(W4, wiring) the kit modal listens on document, only the topmost, with preventDefault; the settings ask the same rule", () => {
  const kit = read("components/CbKit.tsx");
  const modal = body(kit, "export function Modal(");
  assert.ok(modal.includes('document.addEventListener("keydown", h);') && modal.includes('document.removeEventListener("keydown", h);'),
    "the kit modal does not listen on document");
  assert.ok(!modal.includes('window.addEventListener("keydown"'), "the kit modal listens on window again; the settings would come first");
  assert.ok(!modal.includes("stopImmediatePropagation") && !/addEventListener\("keydown", h, true\)/.test(modal),
    "capture phase or stopImmediatePropagation: a field in the sheet that takes Escape itself would no longer get it");
  const h = modal.slice(modal.indexOf("const h = (e: KeyboardEvent) => {"), modal.indexOf('document.addEventListener("keydown", h);'));
  assert.ok(h.includes("if (modalStack.at(-1) !== me || !sheetTakesEscape(e)) return;"), "not only the topmost sheet, or past the rule");
  assert.ok(h.indexOf("e.preventDefault();") >= 0 && h.indexOf("e.preventDefault();") < h.indexOf("onClose();"), "the press is not consumed before closing");
  assert.ok(modal.includes("modalStack.push(me);") && modal.includes("modalStack.splice(i, 1)"), "the stack of open sheets is missing");
  const former = read("components/settings/SettingsModal.tsx");
  assert.ok(former.includes("const onKey = (e: KeyboardEvent) => { if (sheetTakesEscape(e)) onClose(); };"), "the settings also close on a consumed press");
  assert.ok(former.includes('window.addEventListener("keydown", onKey);'), "the settings no longer listen on window (behind document)");
  // The case the rule protects is still there; if it falls, the rule may be renegotiated, not silently.
  assert.ok(read("components/projects/ProjectLayout.tsx").includes('if (e.key === "Escape") setRename(null); e.stopPropagation();'));
});

// ── W5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(W5) SettingsModal: marking and cross-fade hang on the page that stands (`active.key`), not on the request (`section`)", () => {
  const former = read("components/settings/SettingsModal.tsx");
  assert.ok(former.includes("const active = flat.find((s) => s.key === section) ?? flat[0];"));
  assert.ok(former.includes("const on = s.key === active.key;"), "the marking does not hang on the standing page");
  assert.ok(former.includes("<AnimatedSwitch token={active.key}>"), "the cross-fade does not hang on the standing page");
  assert.ok(!/s\.key === section\b(?!\))/.test(former.replace("flat.find((s) => s.key === section)", "")), "another marking on the request");
  assert.ok(!former.includes("token={section}"));
});

// ── I1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(I1, computation) still running on 524; arrived per manual action at the loaded state", (t) => {
  if (!A) { t.skip("node_modules missing (tsc)"); return; }
  assert.equal(A.runningStill(Object.assign(new Error("HTTP 524"), { httpStatus: 524 })), true);
  assert.equal(A.runningStill(Object.assign(new Error("Below consumption"), { httpStatus: 409 })), false);
  assert.equal(A.runningStill(new Error("no status")), false);
  assert.equal(A.runningStill(null), false);
  const n = (state, since, extra = {}) => ({ container: { state, since }, resources: { ramGiB: 8, cpuPrio: "normal", cpuMax: null }, deviating: false, ...extra });
  const prior = n("running", "2026-10-16T08:00:00Z");
  assert.equal(A.arrived("restart", prior, n("running", "2026-10-16T08:00:00Z"), null), false, "the same start is not yet a restart");
  assert.equal(A.arrived("restart", prior, n("stopped", "2026-10-16T08:01:00Z"), null), false);
  assert.equal(A.arrived("restart", prior, n("running", "2026-10-16T08:02:00Z"), null), true);
  assert.equal(A.arrived("start", n("stopped", null), n("running", "x"), null), true);
  assert.equal(A.arrived("start", n("stopped", null), n("stopped", null), null), false);
  assert.equal(A.arrived("stop", prior, n("stopped", "x"), null), true);
  assert.equal(A.arrived("stop", prior, n(null, null), null), false, "an unknown state is no stop");
  assert.equal(A.arrived("erase", prior, null, null), true);
  assert.equal(A.arrived("erase", prior, prior, null), false);
  const target = { ramGiB: 12, cpuPrio: "up", cpuMax: 4 };
  assert.equal(A.arrived("save", prior, n("running", "x", { resources: { ...target } }), target), true);
  assert.equal(A.arrived("save", prior, n("running", "x", { resources: { ...target }, deviating: true }), target), false, "saved, but not applied");
  assert.equal(A.arrived("save", prior, n("running", "x"), target), false);
  assert.deepEqual([A.gracePeriodMs("restart"), A.gracePeriodMs("save"), A.gracePeriodMs("erase"), A.RELOAD_MS], [180_000, 180_000, 300_000, 5_000]);
});

test("(I1, web) api() puts the status on the error; at 524 the page keeps the mark and reloads, the delete sheet hands over to the row", () => {
  const core = read("lib/api/core.ts");
  const assign = core.indexOf("if (typeof data === \"object\" && data) Object.assign(err, data);");
  const status = core.indexOf("Object.assign(err, { httpStatus: r.status });");
  assert.ok(assign > 0 && status > assign, "the status is not on the error (or BEFORE the body, which would overwrite it)");
  const v = read("components/settings/AdministrationSettings.tsx");
  const hg = body(v, "async function manualAction(");
  assert.ok(hg.includes("if (runningStill(e)) { further = true; void bringAlong(id, what, prior, target); }"), "a manual action without an answer means \"failed\" again");
  assert.ok(hg.includes("if (!further) setWork((a) => ({ ...a, [id]: undefined }));"), "the work mark drops although the gateway keeps working");
  const nz = body(v, "async function bringAlong(");
  assert.ok(nz.includes("arrived(what, prior, fresh.user.find((x) => x.id === id) ?? null, target)") && nz.includes("gracePeriodMs(what)") && nz.includes("RELOAD_MS"),
    "reloading does not ask the computation");
  // Reloading stops when the page is gone (`alive`); the mark must be set on MOUNT: StrictMode unmounts and mounts
  // again in development, a ref that is only cleared would stay `false`, and "still running" would abort at once while the mark stood.
  assert.ok(nz.includes("alive.current"), "reloading does not ask whether the page still stands");
  assert.ok(/useEffect\(\(\) => \{\n\s*alive\.current = true;\n\s*return \(\) => \{ alive\.current = false; \};\n\s*\}, \[\]\);/.test(v),
    "`alive` is not set on mount (StrictMode: false forever after the trial unmount)");
  assert.ok(body(v, "function DeleteSheet(").includes("if (runningStill(err)) { onRunningStill(); return; }"), "the delete sheet reports a delete without an answer as an error");
  assert.ok(v.includes("void bringAlong(n.id, \"erase\", n, null);"), "the row does not take over the delete without an answer");
});

test("(I1, iOS) own deadlines on the long paths, \"still running\" on deadline and 524, same cases and deadlines as in the web", () => {
  const api = readIos("Models/APIClient.swift");
  assert.ok(api.includes("func post<T: Decodable>(_ path: String, timeout: TimeInterval? = nil) async throws -> T {"), "post without deadline");
  assert.ok(api.includes("func put<T: Decodable, Body: Encodable>(_ path: String, body: Body, timeout: TimeInterval? = nil) async throws -> T {"), "put without deadline");
  assert.ok(api.includes("func send(_ path: String, method: HTTPMethod = .post, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) async throws -> Data {"), "send without deadline");
  const send = body(api, "func send<Body: Encodable>(");
  assert.ok(send.includes("if let timeout { request.timeoutInterval = timeout }"), "send does not set the deadline on the request");
  const m = readIos("Models/AdministrationModels.swift");
  assert.ok(m.includes('try await post("/gw/admin/users/\\(id)/\\(action)", timeout: AdministrationProcedure.deadlineManualAction)'), "container actions without own deadline");
  assert.ok(m.includes('try await put("/gw/admin/users/\\(id)/resources", body: resources, timeout: AdministrationProcedure.deadlineManualAction)'), "limits without own deadline");
  assert.ok(/send\("\/gw\/admin\/users\/\\\(id\)", method: \.delete,[^)]*\)\],\s*timeout: AdministrationProcedure\.deadlineDelete\)/.test(m), "delete without own deadline");
  const procedure = body(m, "enum AdministrationProcedure {");
  assert.ok(procedure.includes("static let deadlineManualAction: TimeInterval = 180") && procedure.includes("static let deadlineDelete: TimeInterval = 300")
    && procedure.includes("static let reloadEvery: TimeInterval = 5"), "the deadlines differ from the web (180/300/5 s)");
  assert.ok(procedure.includes("error.code == .timedOut") && procedure.includes("error.status == 524"), "still-running does not recognize deadline or 524");
  // The same cases in both computations.
  const cases = (text) => [...text.matchAll(/case "([a-z]+)":/g)].map((x) => x[1]).sort();
  const web = read("lib/administration-procedure.ts");
  assert.deepEqual(cases(body(procedure, "static func arrived(")), cases(body(web, "export function arrived(")), "iOS and web know different manual actions");
  assert.ok(procedure.includes('case "restart": return now?.container.state == "running" && now?.container.since != prior?.container.since'), "the restart does not compare the start time");
  // The page: the mark stays, reloading goes through the computation; the delete too.
  const s = readIos("Settings/AdministrationSettings.swift");
  const hg = body(s, "func manualAction(");
  assert.ok(hg.includes("} catch let absent where AdministrationProcedure.runningStill(absent) {") && hg.includes("ok = await bringAlong(id, what, prior: prior, target: target)"),
    "a manual action without an answer means \"failed\" again");
  const nz = body(s, "func bringAlong(");
  assert.ok(nz.includes("AdministrationProcedure.arrived(what, prior: prior, now: user(id), target: target)") && nz.includes("AdministrationProcedure.gracePeriod(what)"), "reloading does not ask the computation");
  const erase = body(s, "private func erase(withData: Bool) async {");
  assert.ok(erase.includes("AdministrationProcedure.runningStill(absent)") && erase.includes('await model.bringAlong(id, "erase", prior: prior, target: nil)'), "the delete does not know \"still running\"");
  assert.ok(s.includes('.accessibilityIdentifier("administration-running-still")'), "\"still running\" is not on the page");
});

// ── I2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(I2) UI-test fixture like the gateway: locked => start/restart 409; \"last admin\" counts only active admins", async () => {
  const fx = path.join(repo, "mobile", "test-fixtures", "chat-gateway");
  const { routesSettings } = await import(pathToFileURL(path.join(fx, "routes-settings.mjs")).href);
  const { S } = await import(pathToFileURL(path.join(fx, "state.mjs")).href);
  S.administration = null; // seed afresh
  async function calls(method, filePath, bodyData) {
    const req = (async function* () { if (bodyData !== undefined) yield Buffer.from(JSON.stringify(bodyData)); })();
    const response = { status: 0, text: "" };
    const res = { writeHead(s) { response.status = s; }, end(t) { response.text = String(t ?? ""); } };
    const url = new URL(`http://127.0.0.1${filePath}`);
    await routesSettings({ req, res, url, path: url.pathname, method });
    return { status: response.status, body: response.text ? JSON.parse(response.text) : null };
  }
  const snapshot = async () => (await calls("GET", "/gw/admin/administration")).body.user;
  assert.ok((await snapshot()).find((n) => n.id === "u-new").locked, "the seed has a locked user");
  // Locked: no container; start and restart 409 with plain text, stopping works.
  for (const action of ["start", "restart"]) {
    const r = await calls("POST", `/gw/admin/users/u-new/${action}`, {});
    assert.equal(r.status, 409, `${action} of a locked user`);
    assert.match(r.body.error, /locked/);
  }
  assert.equal((await calls("POST", "/gw/admin/users/u-new/stop", {})).status, 200);
  assert.equal((await calls("POST", "/gw/admin/users/u-jonas/start", {})).status, 200, "an active user starts");
  // Admins: mobile-fixture (itself) is the only one. Jonas and Mara become admins, Mara gets locked.
  assert.equal((await calls("PATCH", "/gw/admin/users/u-jonas", { role: "admin" })).status, 200);
  assert.equal((await calls("PATCH", "/gw/admin/users/u-mara", { role: "admin" })).status, 200);
  assert.equal((await calls("PATCH", "/gw/admin/users/u-mara", { locked: true })).status, 200, "three admins, one of them locked");
  // Demoting oneself works as long as Jonas stays an active admin.
  assert.equal((await calls("PATCH", "/gw/admin/users/u-fixture", { role: "user" })).status, 200);
  // Jonas is now the last ACTIVE admin: locking or demoting him is 400; the locked admin Mara does not count.
  const lock = await calls("PATCH", "/gw/admin/users/u-jonas", { locked: true });
  assert.equal(lock.status, 400, "locking the last active admin");
  assert.match(lock.body.error, /last active admin/);
  assert.equal((await calls("PATCH", "/gw/admin/users/u-jonas", { role: "user" })).status, 400, "demoting the last active admin");
  // Demoting the LOCKED admin works (as in the gateway: he holds nobody back).
  assert.equal((await calls("PATCH", "/gw/admin/users/u-mara", { role: "user" })).status, 200, "demoting a locked admin");
  // Unlocking is not locking; it always works.
  assert.equal((await calls("PATCH", "/gw/admin/users/u-mara", { locked: false })).status, 200);
  S.administration = null;
});
