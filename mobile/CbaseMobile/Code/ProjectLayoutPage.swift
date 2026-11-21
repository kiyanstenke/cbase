import SwiftUI

// A project's layout as a page: counterpart of `web/src/components/projects/ProjectLayout.tsx`. It ALWAYS shows
// `ProjectLayout.computePlan(…)`, the same computation the upload later uses to decide targets (`ProjectCreationComputation.body`);
// bound to the web through the fixture set (`web/test/layout-ios-binding.test.mjs`).
//
// On mobile instead of dragging: pressing and holding opens a menu per node (rename, move to…, mark as code repo, remove the mark
// during creation, leave out). "Move to…" is a sheet of the allowed targets (`targetsFor`), rename an alert with a text field. Errors and
// warnings are a second line on the node (no hover on a phone), errors without a node get their own section, the changes below;
// swiping undoes one.

/// Recomputes the plan only when tree or changes differ: `body` runs on every keystroke (name field, rename) and every expand and
/// collapse. Comparing the fields is cheap (`Array ==` recognises identical storage at once), while recomputing would give the same answer.
final class LayoutPlanMemory {
    private var tree: [LayoutNode]?
    private var steps: [LayoutStep]?
    private var mode: LayoutMode?
    private var plan: LayoutPlan?
    func plan(_ tree: [LayoutNode], _ steps: [LayoutStep], _ rules: LayoutRules, _ mode: LayoutMode) -> LayoutPlan {
        if let p = plan, self.mode == mode, self.tree == tree, self.steps == steps { return p }
        let p = ProjectLayout.computePlan(tree, steps, rules, mode)
        (self.tree, self.steps, self.mode, plan) = (tree, steps, mode, p)
        return p
    }
}

/// Existing project: lazy loading of the levels (see `ProjectLayoutPage.levels`).
struct LayoutLevels {
    var loaded: Set<String>
    var loading: Set<String>
    var load: (String) -> Void
}

struct ProjectLayoutPage: View {
    let rootName: String
    let tree: [LayoutNode]
    @Binding var steps: [LayoutStep]
    let rules: LayoutRules
    var mode: LayoutMode = .creation
    var onlyView = false
    /// Creation: the source's marker on a node, e.g. "ZIP" on an archive's top node. Existing project: e.g. "from <repo>" on a worktree block.
    var sourceMarker: ((LayoutNode) -> String?)? = nil
    /// Existing project: the tree arrives level by level from the server. `loaded`/`loading` name STARTING PATHS (`origin`), `load`
    /// fetches one level. nil: the tree is complete (creation).
    var levels: LayoutLevels? = nil
    /// Existing project: "Open in the Code tab" on a code repo or worktree block (the layout does not show its inside).
    var openRepo: ((LayoutNode) -> Void)? = nil
    var emptyText: String? = nil
    /// Existing project: from this step on a level it needs is still loading (`LayoutExistingModel.openStartingAt`); its errors (and
    /// those of all later steps) would flash briefly and are not shown.
    var openStartingAt: Int? = nil

    @State private var open: Set<String> = []
    @State private var rename: LayoutNode?
    @State private var newName = ""
    @State private var move: MoveNode?
    @State private var memory = LayoutPlanMemory()

    private struct MoveNode: Identifiable { let node: LayoutNode; var id: String { node.path } }
    private struct Visible: Identifiable { let node: LayoutNode; let depth: Int; let id: String }

    private var plan: LayoutPlan {
        var p = memory.plan(tree, steps, rules, mode)
        if let start = openStartingAt { p.error = p.error.filter { f in f.step.map { $0 < start } ?? true } }
        return p
    }

    var body: some View {
        let plan = self.plan
        let children = Self.children(plan.finalTree)
        let notices = Self.noticesOn(plan)
        let freeError = plan.error.filter { f in
            f.path == nil || f.step != nil || !plan.finalTree.contains { ProjectLayout.equal($0.path, f.path ?? "") }
        }
        let stepError = Set(plan.error.compactMap(\.step))
        CbList {
            Section {
                HStack(spacing: 10) {
                    Image(systemName: "folder.fill").foregroundStyle(Color.accentColor)
                    Text(rootName.isEmpty ? L("Project root") : rootName)
                        .cbFont(15, weight: .semibold)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(L("Project root")).cbFont(12).foregroundStyle(CbColor.textMuted)
                }
                if plan.finalTree.isEmpty {
                    Text(emptyText ?? L("Nothing chosen yet — an empty project."))
                        .cbFont(13.5)
                        .foregroundStyle(CbColor.textMuted)
                }
                ForEach(visible(children)) { s in
                    row(s.node, depth: s.depth, children: children, notices: notices[s.node.path], finalTree: plan.finalTree)
                }
            } header: {
                Text(L("Outline"))
            } footer: {
                if !onlyView && !plan.finalTree.isEmpty {
                    Text(L("Press and hold to rename, move, leave out, or mark a folder as a code repo."))
                }
            }
            if !freeError.isEmpty {
                Section {
                    ForEach(Array(freeError.prefix(6).enumerated()), id: \.offset) { _, f in
                        Text(Self.noticeText(f, limitRepos: rules.limits.repos))
                            .cbFont(13.5)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if freeError.count > 6 {
                        Text(L("… and {n} more", ["n": freeError.count - 6])).cbFont(13).foregroundStyle(.red)
                    }
                } header: {
                    Text(L("Error"))
                }
            }
            if !steps.isEmpty {
                Section {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                        Text(Self.stepText(s))
                            .cbFont(14)
                            .foregroundStyle(stepError.contains(i) ? Color.red : CbColor.text)
                            .lineLimit(2)
                            .swipeActions {
                                if !onlyView { Button(L("Undo")) { steps.remove(at: i) }.tint(.orange) }
                            }
                    }
                    if !onlyView {
                        Button(L("Undo all"), role: .destructive) { steps = [] }
                            .accessibilityIdentifier("layout-all-revert")
                    }
                } header: {
                    Text(L("Changes ({n})", ["n": steps.count]))
                } footer: {
                    if !onlyView { Text(L("Swipe left to undo a change.")) }
                }
            }
        }
        .navigationTitle(L("Outline"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(L("Rename"), isPresented: Binding(get: { rename != nil }, set: { if !$0 { rename = nil } })) {
            TextField(L("Name"), text: $newName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(L("Cancel"), role: .cancel) { rename = nil }
            Button(L("Rename")) {
                if let k = rename {
                    let name = newName.trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty && !ProjectLayout.equal(name, ProjectLayout.nameOf(k.path)) {
                        steps.append(.move(from: k.path, to: ProjectLayout.connect(ProjectLayout.parentOf(k.path), name)))
                    }
                }
                rename = nil
            }
        }
        .sheet(item: $move) { v in
            targetSheet(v.node, plan.finalTree)
            .cbSheet(.half)
        }
    }

    // ── Rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────

    private func visible(_ children: [String: [LayoutNode]]) -> [Visible] {
        var out: [Visible] = []
        func go(_ parent: String, _ depth: Int) {
            for (i, k) in (children[parent] ?? []).enumerated() {
                out.append(Visible(node: k, depth: depth, id: "\(k.path)#\(i)"))
                if !ProjectLayout.isBlock(k.kind), open.contains(k.path) { go(k.path, depth + 1) }
            }
        }
        go("", 0)
        return out
    }

    private func unloaded(_ k: LayoutNode) -> Bool {
        guard let levels, k.kind == .folder else { return false }
        return !levels.loaded.contains(k.origin ?? k.path)
    }

    @ViewBuilder
    private func row(_ k: LayoutNode, depth: Int, children: [String: [LayoutNode]], notices: (error: [LayoutNotice], warnings: [LayoutNotice])?, finalTree: [LayoutNode]) -> some View {
        let hasChildren = !ProjectLayout.isBlock(k.kind) && (!(children[k.path] ?? []).isEmpty || unloaded(k))
        let on = open.contains(k.path)
        let acts = ProjectLayout.actionsFor(k, finalTree, mode, onlyView: onlyView)
        let texts = (notices?.error ?? []) + (notices?.warnings ?? [])
        let hasError = !(notices?.error ?? []).isEmpty
        HStack(alignment: .top, spacing: 8) {
            Color.clear.frame(width: CGFloat(depth) * 14, height: 1)
            Image(systemName: hasChildren ? (on ? "chevron.down" : "chevron.right") : "chevron.right")
                .font(.symbol(11, weight: .semibold))
                .foregroundStyle(CbColor.textMuted)
                .opacity(hasChildren ? 1 : 0)
                .frame(width: 12)
                .padding(.top, 4)
            Image(systemName: Self.symbol(k))
                .font(.symbol(14))
                .foregroundStyle(ProjectLayout.isRepo(k) ? Color.accentColor : CbColor.textSecondary)
                .frame(width: 18)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(ProjectLayout.nameOf(k.path))
                        .cbFont(14.5)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let marker = sourceMarker?(k) {
                        Text(marker)
                            .cbFont(11, weight: .medium)
                            .foregroundStyle(CbColor.textSecondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(CbColor.textSecondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }
                    if ProjectLayout.isRepo(k) {
                        Text(k.kind == .worktree ? L("Worktree") : k.kind == .clone ? L("Clone") : L("Code repo"))
                            .cbFont(11, weight: .medium)
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    if !texts.isEmpty {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.symbol(12))
                            .foregroundStyle(hasError ? Color.red : Color.orange)
                            .accessibilityLabel(hasError ? L("Error") : L("Warning"))
                    }
                }
                ForEach(Array(texts.prefix(3).enumerated()), id: \.offset) { _, m in
                    Text(Self.noticeText(m, limitRepos: rules.limits.repos))
                        .cbFont(12)
                        .foregroundStyle(hasError ? Color.red : Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if on, let levels, levels.loading.contains(k.origin ?? k.path) {
                ProgressView().controlSize(.mini).padding(.top, 2)
            }
            if let g = k.size {
                Text(sizeText(g)).cbFont(12).monospacedDigit().foregroundStyle(CbColor.textMuted).padding(.top, 2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard hasChildren else { return }
            if on { open.remove(k.path) } else {
                open.insert(k.path)
                if unloaded(k), let levels, !levels.loading.contains(k.origin ?? k.path) { levels.load(k.origin ?? k.path) }
            }
        }
        .accessibilityIdentifier("layout-node-\(k.path)")
        .contextMenu {
            if let openRepo, ProjectLayout.isBlock(k.kind) {
                Button { openRepo(k) } label: { Label(L("Open in the Code tab"), systemImage: "chevron.left.forwardslash.chevron.right") }
            }
            if !onlyView {
                if acts.rename {
                    Button { newName = ProjectLayout.nameOf(k.path); rename = k } label: { Label(L("Rename"), systemImage: "pencil") }
                }
                if acts.move {
                    Button { move = MoveNode(node: k) } label: { Label(L("Move to…"), systemImage: "folder") }
                        .disabled(ProjectLayout.targetsFor(k, finalTree).isEmpty)
                }
                if acts.mark {
                    Button { steps.append(.codeRepo(path: k.path)) } label: { Label(L("Mark as code repo"), systemImage: "arrow.triangle.branch") }
                }
                if acts.unmark {
                    Button { steps.append(.codeRepoFrom(path: k.path)) } label: { Label(L("Remove code repo mark"), systemImage: "arrow.uturn.backward") }
                }
                if acts.leaveOut {
                    Divider()
                    Button(role: .destructive) { steps.append(.leaveOut(path: k.path)) } label: {
                        Label(mode == .creation ? L("Leave out (don't upload)") : L("Leave out"), systemImage: "minus.circle")
                    }
                }
            }
        }
    }

    private func targetSheet(_ k: LayoutNode, _ finalTree: [LayoutNode]) -> some View {
        NavigationStack {
            CbList {
                Section {
                    ForEach(ProjectLayout.targetsFor(k, finalTree), id: \.self) { z in
                        Button {
                            steps.append(.move(from: k.path, to: ProjectLayout.connect(z, ProjectLayout.nameOf(k.path))))
                            move = nil
                        } label: {
                            Label(z.isEmpty ? "\(rootName.isEmpty ? L("Project root") : rootName) (\(L("root")))" : z, systemImage: "folder")
                                .cbFont(14.5)
                                .foregroundStyle(CbColor.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                } header: {
                    Text(L("Move “{path}” to:", ["path": k.path]))
                }
            }
            .navigationTitle(L("Move to…"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { move = nil }
            }
        }
    }

    // ── Display computations (as on the web) ─────────────────────────────────────────────────────────────────────────────

    /// Children per parent path, folders before files, then by name. A duplicate path (TARGET_DUPLICATE) stays listed twice.
    static func children(_ finalTree: [LayoutNode]) -> [String: [LayoutNode]] {
        var m: [String: [LayoutNode]] = [:]
        for k in finalTree { m[ProjectLayout.parentOf(k.path), default: []].append(k) }
        for (e, l) in m {
            m[e] = ProjectLayout.stable(l) { a, b in
                let fa = a.kind == .file ? 1 : 0, fb = b.kind == .file ? 1 : 0
                if fa != fb { return fa - fb }
                switch a.path.localizedStandardCompare(b.path) {
                case .orderedAscending: return -1
                case .orderedDescending: return 1
                default: return 0
                }
            }
        }
        return m
    }

    static func noticesOn(_ plan: LayoutPlan) -> [String: (error: [LayoutNotice], warnings: [LayoutNotice])] {
        var m: [String: (error: [LayoutNotice], warnings: [LayoutNotice])] = [:]
        for f in plan.error where f.step == nil { if let p = f.path { m[p, default: ([], [])].error.append(f) } }
        for w in plan.warnings { if let p = w.path { m[p, default: ([], [])].warnings.append(w) } }
        return m
    }

    static func symbol(_ k: LayoutNode) -> String {
        if ProjectLayout.isRepo(k) { return "arrow.triangle.branch" }
        return k.kind == .folder ? "folder" : "doc"
    }

    static func noticeText(_ m: LayoutNotice, limitRepos: Int? = nil) -> String {
        let path = (m.path ?? "").isEmpty ? "/" : m.path!
        switch m.code {
        case "NAME_INVALID": return L("Name not allowed: {path}", ["path": path])
        case "TARGET_DUPLICATE": return L("Two entries with the same target: {path}", ["path": path])
        case "CODE_REPO_LOCATION": return L("The repo search cannot find a code repo here (too deep or below an excluded folder): {path}", ["path": path])
        case "TOO_MANY_REPOS": return L("More than {n} code repos", ["n": limitRepos ?? 25])
        case "REPO_IN_REPO": return L("A code repo lies inside another one: {path}", ["path": path])
        case "IN_CODE_REPO": return L("Lies inside a code repo: {path}", ["path": path])
        case "STEP_UNKNOWN", "STEP_INVALID": return L("Change {n} does not fit (any more): {path}", ["n": (m.step ?? 0) + 1, "path": path])
        case "DEPENDENCY": return L("“{name}” is a dependency folder and stays out of the project repo", ["name": ProjectLayout.nameOf(path)])
        case "MEMORY": return L("{name} only takes effect in the project root", ["name": ProjectLayout.nameOf(path)])
        case "REPO_SHARED": return L("One code repo becomes two")
        case "GIT_FILE_TOT": return L("A .git file without a valid target is left out: {path}", ["path": path])
        case "SOURCE_EMPTY": return L("Nothing to upload: {path}", ["path": path])
        case "NAME_SUPPLEMENTED": return L("“{old}” already existed — now called “{fresh}”", ["old": m.second ?? "", "fresh": path])
        // The path carries exactly the characters no row can take here, shown as "?".
        case "NAME_OMITTED":
            let visible = String(String.UnicodeScalarView(path.unicodeScalars.map { ProjectLayout.hasControlCharacters(String($0)) ? "?" : $0 }))
            return L("Left out, the name contains control characters: {path}", ["path": visible])
        case "FOLDER_EMPTY": return L("Empty folder, will not be created: {path}", ["path": path])
        default: return m.path.map { "\(m.code): \($0)" } ?? m.code
        }
    }

    static func stepText(_ s: LayoutStep) -> String {
        switch s {
        case .move(let from, let to):
            return ProjectLayout.equal(ProjectLayout.parentOf(from), ProjectLayout.parentOf(to))
                ? L("“{from}” renamed to “{fresh}”", ["from": from, "fresh": ProjectLayout.nameOf(to)])
                : L("“{from}” to “{to}”", ["from": from, "to": to])
        case .leaveOut(let path): return L("“{path}” left out", ["path": path])
        case .codeRepo(let path): return L("“{path}” marked as code repo", ["path": path])
        case .codeRepoFrom(let path): return L("Code repo mark removed from “{path}”", ["path": path])
        }
    }
}
