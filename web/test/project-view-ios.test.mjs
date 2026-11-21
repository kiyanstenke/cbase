// The "Project" category and the branch sheet on iOS. The choice of the page is a pure computation in
// mobile/CbaseMobile/Code/ProjectCategoryPage.swift and is REALLY compiled with `xcrun swiftc` and EXECUTED here; that
// Code/ProjectsPane.swift and Code/BranchSwitch.swift use it, or the lock, is checked by the second part against the source.
//
// The promises, each with the way that breaks it:
//   (27) In the entered project `projectsSelected` (the services of a project, a value of the whole workspace) applies only to THIS
//        project — otherwise "Project" in B showed the services of A including start and stop for A if "Details" had been tapped at A.
//   (28) If the entered project is missing from the list (loaded at this point), it is gone: "This project no longer exists" with
//        "Leave project", the list reloaded once — otherwise a spinner turned endlessly with no way out.
//   (30) "Discard and switch" switches in the repo whose files were discarded, and the repo picker is locked during a request —
//        otherwise `changeOver` re-read the selection after discarding, which may have changed in the meantime, and switched another repo unasked.
//
// Run:  node --test web/test/project-view-ios.test.mjs   (macOS only: xcrun — latch.json `onlyMacOS`)
// COUNTER-TESTS (each shown red):
//   - against the state before the repair: ProjectCategoryPage.swift is missing, ProjectsPane shows `selected` before `onlyProject` ⇒ both red;
//   - in ProjectCategoryPage.swift the condition `enter == nil || enter == a` removed (the old order) ⇒ "page" red;
//   - in BranchSwitch.swift `await changeOver(o.branch, in: r)` → `await changeOver(o.branch)` ⇒ "views" red.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const APP = path.join(repo, "mobile", "CbaseMobile");
const SOURCE = path.join(APP, "Code", "ProjectCategoryPage.swift");
const read = (...parts) => fs.readFileSync(path.join(APP, ...parts), "utf8");
const withoutComments = (q) => q.split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

const LIST = ["a", "b"];
const CASES = [
  // Workspace (nothing entered): the services of a chosen project, otherwise the list.
  { selected: null, enter: null, projects: LIST, desired: { kind: "list" } },
  { selected: "a", enter: null, projects: LIST, desired: { kind: "details", id: "a" } },
  { selected: "x", enter: null, projects: LIST, desired: { kind: "list" } }, // a removed project: no services page into the void
  // (27) entered in B, A still chosen ⇒ the view of B, not the services of A.
  { selected: "a", enter: "b", projects: LIST, desired: { kind: "project", id: "b" } },
  { selected: "b", enter: "b", projects: LIST, desired: { kind: "details", id: "b" } }, // "Manage services" from the view of B
  { selected: null, enter: "b", projects: LIST, desired: { kind: "project", id: "b" } },
  // (28) the entered project is not (or no longer) in the list ⇒ gone, even if a project is still chosen.
  { selected: null, enter: "c", projects: LIST, desired: { kind: "gone", id: "c" } },
  { selected: "a", enter: "c", projects: LIST, desired: { kind: "gone", id: "c" } },
  { selected: "c", enter: "c", projects: LIST, desired: { kind: "gone", id: "c" } },
  { selected: null, enter: "c", projects: [], desired: { kind: "gone", id: "c" } },
];

const DRIVER = `import Foundation
let cases = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
var outData: [Any] = []
for f in cases {
    let s = ProjectCategoryPage.from(selected: f["selected"] as? String, enter: f["enter"] as? String, projects: f["projects"] as! [String])
    switch s {
    case .details(let id): outData.append(["kind": "details", "id": id])
    case .project(let id): outData.append(["kind": "project", "id": id])
    case .gone(let id): outData.append(["kind": "gone", "id": id])
    case .list: outData.append(["kind": "list"])
    }
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`;

test("page (executed): the services of a project only for the entered one, a missing entered project is gone", () => {
  const text = fs.readFileSync(SOURCE, "utf8");
  assert.deepEqual(text.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "ProjectCategoryPage.swift imports only Foundation");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-view-ios-"));
  const source = path.join(tmp, "ProjectCategoryPage.swift");
  fs.copyFileSync(SOURCE, source);
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, DRIVER);
  const bin = path.join(tmp, "driver");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, source, main], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${err.stderr || err.message}`);
  }
  const file = path.join(tmp, "cases.json");
  fs.writeFileSync(file, JSON.stringify(CASES.map(({ desired: _desired, ...f }) => f)));
  const parsed = JSON.parse(execFileSync(bin, [file], { encoding: "utf8" }).trim().split("\n").pop());
  assert.equal(parsed.length, CASES.length);
  CASES.forEach((f, i) => assert.deepEqual(parsed[i], f.desired, `case ${JSON.stringify(f)}`));
});

test("views (source): ProjectsPane asks for the page and has a way out; the branch sheet switches in the repo of the discard", () => {
  const pane = withoutComments(read("Code", "ProjectsPane.swift"));
  assert.match(pane, /\.from\(selected: state\.projectsSelected, enter: onlyProject, projects: workspace\.projects\.map\(\\\.id\)\)/, "ProjectsPane does not ask for the page");
  assert.ok(!/private var selected: Project\?/.test(pane), "the old choice `selected` (checked before `onlyProject`) is still there");
  assert.match(pane, /switch page \{[^]*case \.details\(let id\):[^]*case \.project\(let pid\):\s*projectPage\(pid\)\s*case \.gone\(let pid\):\s*gonePage\(pid\)\s*case \.list:\s*list/);
  const project = pane.slice(pane.indexOf("private func projectPage"), pane.indexOf("private func gonePage"));
  assert.ok(!/CbLoading/.test(project), "the page of the entered project still spins a loading circle");
  const gone = pane.slice(pane.indexOf("private func gonePage"), pane.indexOf("private var list"));
  assert.match(gone, /L\("This project no longer exists\."\)/);
  assert.match(gone, /button: L\("Leave project"\)[^]*state\.leaveProject\(\)/, "no way out");
  assert.match(gone, /\.task\(id: pid\) \{ await state\.loadWorkspaces\(\) \}/, "a stale list does not heal");
  const en = read("Kit", "LocDEInstances.swift");
  for (const k of ["This project no longer exists.", "It was removed or is no longer in this workspace.", "Leave project"]) {
    assert.ok(en.includes(`"${k}": "`), `LocDEInstances.swift: ${k}`);
  }
  // (30)
  const sheet = withoutComments(read("Code", "BranchSwitch.swift"));
  assert.match(sheet, /Picker\(L\("Repo"\)[^]*?\}\s*\.disabled\(running\)\s*\.accessibilityIdentifier\("branch-repo"\)/, "the repo picker is free during a request");
  assert.match(sheet, /private func changeOver\(_ branch: String, in repoRow: InstanceRepoRow\? = nil\) async \{\s*guard let r = repoRow \?\? selected else \{ return \}/);
  const dismiss = sheet.slice(sheet.indexOf("private func dismiss()"), sheet.indexOf("private func stackRestart()"));
  assert.match(dismiss, /guard let r = selected, let o = open/);
  assert.match(dismiss, /await changeOver\(o\.branch, in: r\)/, "after discarding, the switch happens in the currently chosen repo, not in the one of the discard");
});
