import SwiftUI

// The layout of an EXISTING project — the counterpart of `web/src/components/projects/LayoutPage.tsx`.
//
// The tree is `ProjectLayoutPage` in the existing-project mode (`LayoutMode.inventory`): it comes level by level from the server
// (`GET …/layout?path=`, read inside the project container), every action becomes a step — the same computation as in project
// creation. At the bottom the collective bar ("N changes — Check", or the state of a job); it opens the sheet
// `LayoutTakeOverSheet` (check, take over, wait list with "Stop", report). An open job shows its steps in the tree, view only;
// so do an open setup, copy, relocation and a root that is itself a code repo — the reason is in the sheet.
//
// Also here are the parts the project list needs: the row of a job (`LayoutDisplay`, twin of `layoutRow` in
// `web/src/lib/project-setup.ts`) and the path mapping after the take-over (`LayoutPaths`, twin of
// `web/src/lib/layout-paths.ts`) for the Code and Git tabs.

// ── The project list row ────────────────────────────────────────────────────────────────────────────────────────────────────

/// The row of a layout job ("row states") and what is locked meanwhile — as on the web.
struct LayoutDisplay {
    let text: String?
    let color: Color
    let deleteLocked: Bool
    let uploadLocked: Bool

    static let stepNames: [String: String] = [
        "quiet": "checking for idle", "prior": "taking stock", "marker": "pausing services", "stop": "stopping services and containers",
        "postWork": "git follow-up", "foreign": "processes in the project", "terminals": "closing terminals",
        "repack": "taking over borrowed objects", "crossCheck": "cross-check", "docker-away": "removing Docker objects",
        "parking": "parking folders", "leaveOut": "Leave out", "place": "placing folders", "code-repos": "creating the code repos",
        "project-repo": "project repo", "worktrees": "repairing worktrees", "alternates": "rewriting alternates",
        "db": "paths in the database", "compose": "recreating Compose stacks", "startUp": "starting up", "recheck": "verifying",
        "completion": "Finishing", "rw-rules": "restoring restart policies", "rw-start-up": "starting up again", "rw-marker": "releasing services",
    ]
    static func stepName(_ s: String) -> String { stepNames[s].map { L($0) } ?? s }

    static func compute(_ g: ProjectLayoutRow?) -> LayoutDisplay {
        guard let g else { return LayoutDisplay(text: nil, color: .secondary, deleteLocked: false, uploadLocked: false) }
        let reason = g.error ?? ""
        switch g.state {
        case "waiting":
            return LayoutDisplay(text: L("Outline waiting for idle ({n})", ["n": g.holders ?? 0]), color: .orange, deleteLocked: false, uploadLocked: true)
        case "running":
            return LayoutDisplay(text: g.backward == true ? L("Outline being reverted") : L("Outline being applied"), color: .accentColor, deleteLocked: true, uploadLocked: true)
        default:
            if g.turned == true {
                return LayoutDisplay(text: L("Outline half applied: {step}", ["step": stepName(g.step ?? "")]), color: .red, deleteLocked: true, uploadLocked: true)
            }
            if g.backward == true {
                return LayoutDisplay(text: L("Reverting the outline interrupted: {reason}", ["reason": reason]), color: .red, deleteLocked: false, uploadLocked: false)
            }
            return LayoutDisplay(text: L("Outline no longer fits: {reason}", ["reason": reason]), color: .red, deleteLocked: false, uploadLocked: true)
        }
    }
}

// ── Paths after the take-over ───────────────────────────────────────────────────────────────────────────────────────────────

/// The end of a job from the event `project/layout` (`kind: "finished"`): only the topmost affected nodes.
struct LayoutEnd: Equatable {
    var ways: [FinalMapping.Way]
    var gone: [String]

    init(ways: [FinalMapping.Way], gone: [String]) { self.ways = ways; self.gone = gone }
    init(_ event: JSONValue) {
        ways = (event["mapping"]?.arrayValue ?? []).compactMap { w in
            guard let old = w["old"]?.stringValue, let fresh = w["fresh"]?.stringValue else { return nil }
            return FinalMapping.Way(old: old, fresh: fresh)
        }
        gone = (event["gone"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
}

enum LayoutPaths {
    /// Where a path (relative to the project root) has moved to: the new path, nil = deleted, otherwise unchanged. The longest
    /// matching `old` wins (the same rule as `ProjectLayout.targetOf`).
    static func newPath(_ path: String, _ end: LayoutEnd) -> String? {
        let mapping = end.ways.map { MappingEntry(from: $0.old, to: $0.fresh) } + end.gone.map { MappingEntry(from: $0, to: nil) }
        switch ProjectLayout.targetOf(mapping, path) {
        case .none: return path
        case .some(let z): return z
        }
    }

    /// The same for a path relative to an area in which the project lies under `prefix` (workspace level; "" = the project
    /// route). Paths outside the project stay as they are.
    static func newPath(_ path: String, _ end: LayoutEnd, prefix: String) -> String? {
        if prefix.isEmpty { return newPath(path, end) }
        let inside: String
        if ProjectLayout.equal(path, prefix) { inside = "" }
        else if ProjectLayout.beginsWith(path, prefix + "/") { inside = String(path.dropFirst(prefix.count + 1)) }
        else { return path }
        guard let n = newPath(inside, end) else { return nil }
        return n.isEmpty ? prefix : prefix + "/" + n
    }
}

// ── Steps on the wire ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// `{ kind: "move", from, to }` · `{ kind: "leaveOut" | "code-repo" | "code-repo-off", path }` — the shape of the server
/// (`projectbox/layout/read.js` normalizeSteps) and of the web.
extension LayoutStep: Codable {
    private enum Key: String, CodingKey { case kind, from, to, path }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "move": self = .move(from: try c.decode(String.self, forKey: .from), to: try c.decode(String.self, forKey: .to))
        case "leaveOut": self = .leaveOut(path: try c.decode(String.self, forKey: .path))
        case "code-repo": self = .codeRepo(path: try c.decode(String.self, forKey: .path))
        case "code-repo-off": self = .codeRepoFrom(path: try c.decode(String.self, forKey: .path))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(kind)")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .move(let from, let to): try c.encode("move", forKey: .kind); try c.encode(from, forKey: .from); try c.encode(to, forKey: .to)
        case .leaveOut(let p): try c.encode("leaveOut", forKey: .kind); try c.encode(p, forKey: .path)
        case .codeRepo(let p): try c.encode("code-repo", forKey: .kind); try c.encode(p, forKey: .path)
        case .codeRepoFrom(let p): try c.encode("code-repo-off", forKey: .kind); try c.encode(p, forKey: .path)
        }
    }
}

// ── The page model ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// The draft per project — survives closing the page ("Open in the Code tab", swiping away), as on the web.
@MainActor
enum LayoutDrafts {
    static var steps: [String: [LayoutStep]] = [:]
    static var check: [String: String] = [:]
}

@MainActor
final class LayoutExistingModel: ObservableObject {
    struct Entry: Decodable {
        let name: String
        let kind: String
        let worktreeOf: String?
        let gitFile: Bool?
        let reference: Bool?
        let special: Bool?
    }
    private struct Level: Decodable {
        let entries: [Entry]
        let truncated: Truncated?
        let rootIsRepo: Bool?
        let copyOpen: LayoutSituation.Copy?
        let locked: LayoutSituation.Locked?
        struct Truncated: Decodable { let cap: Int; let total: Int }
    }

    @Published var node: [LayoutNode] = []
    @Published var info: [String: Entry] = [:]
    @Published var loaded: Set<String> = []
    @Published var loading: Set<String> = []
    @Published var truncated: [String: (cap: Int, total: Int)] = [:]
    @Published var situation: LayoutSituation?
    @Published var loadError = ""
    @Published var steps: [LayoutStep] = [] {
        didSet { if steps.isEmpty { LayoutDrafts.steps[projectId] = nil } else { LayoutDrafts.steps[projectId] = steps } }
    }
    /// Starting paths whose loading failed — not retried automatically (targets, sources); expanding tries again.
    @Published var failed: Set<String> = []
    @Published var job: LayoutJob?
    /// Whether the job was ever answered (a 404 means "none" — before that it is unknown, not gone).
    @Published var jobLoaded = false
    @Published var check: LayoutCheck?
    @Published var busy = false
    @Published var error = ""
    /// Errors while RE-READING the job (poll, event) — the next successful fetch takes it back; errors of an action
    /// stay in `error` and remain.
    @Published var jobError = ""

    let client: APIClient
    let projectId: String
    private var generation = 0
    private var base: String { "/api/projects/\(projectId)/layout" }

    init(client: APIClient, projectId: String) {
        self.client = client
        self.projectId = projectId
        steps = LayoutDrafts.steps[projectId] ?? []
        if let id = LayoutDrafts.check[projectId] {
            check = LayoutCheck(check: id, state: "running", steps: steps, result: nil, error: nil)
        }
    }

    /// Does the job block editing (`waiting`, `running`, `error` after the turnaround or with an open return path)?
    var jobOpen: Bool {
        guard let a = job else { return false }
        return a.state == "waiting" || a.state == "running" || (a.state == "error" && (a.turned || a.backward))
    }
    /// After the turnaround the tree in the project is already (partly) rebuilt — the steps no longer fit it.
    var rebuilt: Bool { jobOpen && job?.turned == true }
    /// What the tree shows: the steps of an open job (none after the turnaround), otherwise the own ones.
    var displayed: [LayoutStep] { jobOpen ? (rebuilt ? [] : (job?.steps ?? [])) : steps }

    /// Expand: an explicit action — also retries a failed level.
    func loadExplicit(_ start: String) {
        failed.remove(start)
        load(start)
    }

    func load(_ start: String) {
        guard !loaded.contains(start), !loading.contains(start) else { return }
        let gen = generation
        loading.insert(start)
        Task {
            defer { if gen == generation { loading.remove(start) } }
            do {
                let r: Level = try await client.get(base, query: [URLQueryItem(name: "path", value: start)])
                guard gen == generation else { return }
                let fresh = r.entries.compactMap { e -> LayoutNode? in
                    guard let kind = LayoutKind(rawValue: e.kind) else { return nil }
                    let path = ProjectLayout.connect(start, e.name)
                    return LayoutNode(path: path, kind: kind, origin: path)
                }
                let paths = Set(fresh.map(\.path))
                node = node.filter { !paths.contains($0.path) } + fresh
                for e in r.entries { info[ProjectLayout.connect(start, e.name)] = e }
                loaded.insert(start)
                if let g = r.truncated { truncated[start] = (g.cap, g.total) }
                situation = LayoutSituation(rootIsRepo: r.rootIsRepo ?? false, copyOpen: r.copyOpen, locked: r.locked)
                failed.remove(start)
                loadError = ""
            } catch {
                if gen == generation {
                    loadError = error.localizedDescription
                    failed.insert(start)
                }
            }
        }
    }

    func loadAgain() {
        generation += 1
        node = []
        info = [:]
        loaded = []
        loading = []
        truncated = [:]
        failed = []
        loadError = ""
        load("")
    }

    /// Which levels are missing so the steps can be computed (twin of `missingLevels` in LayoutPage.tsx): per step with
    /// STEP_UNKNOWN/STEP_INVALID the deepest existing ancestor of its source (or of its target folder) in the state BEFORE the
    /// step — if its level is not loaded, it is loaded, and the step and all later ones are "open".
    func missingLevels(_ plan: LayoutPlan, _ rules: LayoutRules) -> (load: Set<String>, openStartingAt: Int?) {
        var load: Set<String> = []
        var first: Int?
        let list = displayed
        for f in plan.error {
            guard let i = f.step, i < list.count, f.code == "STEP_UNKNOWN" || f.code == "STEP_INVALID" else { continue }
            let q: String
            switch list[i] {
            case .move(let from, let to):
                if f.code == "STEP_UNKNOWN" { q = from } else {
                    let e = ProjectLayout.parentOf(to)
                    guard !e.isEmpty else { continue }
                    q = e + "/_"
                }
            case .leaveOut(let p), .codeRepo(let p), .codeRepoFrom(let p):
                guard f.code == "STEP_UNKNOWN" else { continue }
                q = p
            }
            let before = ProjectLayout.computePlan(node, Array(list.prefix(i)), rules, .inventory).finalTree
            var a = ProjectLayout.parentOf(q)
            while !a.isEmpty {
                if let k = before.first(where: { ProjectLayout.equal($0.path, a) }) {
                    let start = k.origin ?? k.path
                    if k.kind != .file && !loaded.contains(start) && !failed.contains(start) {
                        load.insert(start)
                        first = min(first ?? i, i)
                    }
                    break
                }
                a = ProjectLayout.parentOf(a)
            }
        }
        return (load, first)
    }

    /// Load levels afterwards: every move its target folder (so an equal name there shows up as an error at once) and every
    /// step the levels of its source.
    func targetsReload(_ plan: LayoutPlan, _ rules: LayoutRules) {
        var starts = missingLevels(plan, rules).load
        for s in displayed {
            guard case .move(_, let to) = s else { continue }
            let target = ProjectLayout.parentOf(to)
            guard !target.isEmpty, let k = plan.finalTree.first(where: { ProjectLayout.equal($0.path, target) && $0.kind == .folder }) else { continue }
            starts.insert(k.origin ?? k.path)
        }
        for start in starts where !failed.contains(start) { load(start) }
    }

    func loadJob() async {
        do {
            struct Response: Decodable { let job: LayoutJob }
            let r: Response = try await client.get("\(base)/job")
            let prior = job?.state
            job = r.job
            jobLoaded = true
            jobError = ""
            // An end this page witnessed: the tree is a different one.
            if r.job.state == "finished", let prior, prior != "finished" {
                steps = []
                check = nil
                LayoutDrafts.check[projectId] = nil
                loadAgain()
            }
        } catch let e as APIError where e.code == "NO_JOB" {
            job = nil
            jobLoaded = true
            jobError = ""
        } catch {
            jobError = error.localizedDescription
        }
    }

    // ── Check ──

    var checkStale: Bool { check.map { $0.steps != steps } ?? false }

    func check(_ s: [LayoutStep]? = nil) async {
        let list = s ?? steps
        struct Body: Encodable { let steps: [LayoutStep] }
        struct Response: Decodable { let check: String }
        error = ""
        do {
            let r: Response = try await client.post("\(base)/check", body: Body(steps: list))
            check = LayoutCheck(check: r.check, state: "running", steps: list, result: nil, error: nil)
            LayoutDrafts.check[projectId] = r.check
            await fetchCheck()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func fetchCheck() async {
        guard let p = check else { return }
        do {
            let r: LayoutCheck = try await client.get("\(base)/check/\(p.check)")
            if check?.check == p.check { check = r }
        } catch let e as APIError where e.code == "CHECK_UNKNOWN" {
            if check?.check == p.check { check?.state = "expired"; LayoutDrafts.check[projectId] = nil }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // ── The job ──

    private func tu(_ fn: () async throws -> Void) async {
        busy = true
        error = ""
        do { try await fn() } catch { self.error = error.localizedDescription }
        busy = false
        await loadJob()
    }

    func takeOver() async {
        guard let p = check else { return }
        struct Body: Encodable { let steps: [LayoutStep]; let check: String }
        struct Response: Decodable { let job: LayoutJob }
        await tu {
            let r: Response = try await client.post("\(base)/takeOver", body: Body(steps: p.steps, check: p.check))
            job = r.job
        }
    }

    /// "Revert" — `keep`: the steps come back into the tree (in `waiting` one has merely not taken over yet).
    func revert(keep: Bool) async {
        let old = job?.steps ?? []
        await tu {
            try await client.send("\(base)/job", method: .delete)
            job = nil
            if keep { steps = old }
        }
    }

    func checkAgain() async {
        let old = job?.steps ?? []
        steps = old
        await check(old)
    }

    func again() async {
        await tu { try await client.send("\(base)/job/again") }
    }

    func stop(_ h: LayoutHolder) async {
        struct Body: Encodable { let kind: String; let id: String }
        await tu { try await client.send("\(base)/holders/stop", body: Body(kind: h.kind, id: h.id)) }
    }
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

struct LayoutExistingPage: View {
    let project: Project
    let rules: LayoutRules?
    @StateObject private var model: LayoutExistingModel
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var sheetOpen = false
    @State private var memory = LayoutPlanMemory()

    init(client: APIClient, project: Project, rules: LayoutRules?) {
        self.project = project
        self.rules = rules
        _model = StateObject(wrappedValue: LayoutExistingModel(client: client, projectId: project.id))
    }

    var body: some View {
        Group {
            if let rules, model.loaded.contains("") {
                let plan = memory.plan(model.node, model.displayed, rules, .inventory)
                let missing = model.missingLevels(plan, rules)
                ProjectLayoutPage(
                    rootName: project.name,
                    tree: model.node,
                    steps: Binding(get: { model.displayed }, set: { if !model.jobOpen { model.steps = $0 } }),
                    rules: rules,
                    mode: .inventory,
                    onlyView: model.jobOpen || model.situation?.locked != nil,
                    sourceMarker: marker,
                    levels: LayoutLevels(loaded: model.loaded, loading: model.loading, load: { model.loadExplicit($0) }),
                    openRepo: { k in
                        dismiss()
                        state.enterProject(project)
                        state.showCode(projectId: project.id, path: k.origin ?? k.path)
                    },
                    emptyText: L("The project is empty."),
                    openStartingAt: missing.openStartingAt
                )
                .onChange(of: model.displayed) { model.targetsReload(plan, rules) }
                .onChange(of: model.node.count) { model.targetsReload(plan, rules) }
                .onChange(of: model.loaded) { model.targetsReload(plan, rules) }
                .safeAreaInset(edge: .top) { hints }
                .safeAreaInset(edge: .bottom) { bar(plan) }
            } else if !model.loadError.isEmpty {
                CbEmpty(symbol: "exclamationmark.triangle", text: model.loadError, button: L("Try again")) { model.loadAgain() }
            } else if rules == nil {
                CbEmpty(symbol: "exclamationmark.triangle", text: L("The server's rules have not loaded yet — try again in a moment."))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Embedded in the project view (segment "Layout", `Code/ProjectView.swift`): the view carries title and "Close".
        .task {
            if model.node.isEmpty && model.loaded.isEmpty { model.loadAgain() }
            await model.loadJob()
            if model.check?.state == "running" { await model.fetchCheck() }
        }
        // After the turnaround the tree is re-read with every step of the job (it is a different one).
        .onChange(of: model.rebuilt ? "\(model.job?.state ?? ""):\(model.job?.step ?? "")" : "") { _, fresh in
            if !fresh.isEmpty { model.loadAgain() }
        }
        // Events `project/layout` of this project (job, check, end) — plus a poll while something waits or runs.
        .onChange(of: state.layoutEvents[project.id] ?? 0) {
            Task {
                await model.loadJob()
                if model.check?.state == "running" { await model.fetchCheck() }
            }
        }
        .task(id: tick) {
            guard tick != "quiet" else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(tick == "check" ? 4 : 10))
                if Task.isCancelled { break }
                if tick == "check" { await model.fetchCheck() } else { await model.loadJob() }
            }
        }
        .sheet(isPresented: $sheetOpen) {
            NavigationStack {
                LayoutTakeOverSheet(model: model, planError: rules.map { r in
                    let plan = memory.plan(model.node, model.displayed, r, .inventory)
                    let startAt = model.missingLevels(plan, r).openStartingAt
                    return plan.error.filter { f in startAt.map { a in f.step.map { $0 < a } ?? true } ?? true }.count + (startAt == nil ? 0 : 1)
                } ?? 0)
            }
            .cbSheet(.half)
        }
    }

    /// What is polled: a running check (4 s), a waiting or running job (10 s), otherwise nothing.
    private var tick: String {
        if model.check?.state == "running" { return "check" }
        if model.job?.state == "waiting" || model.job?.state == "running" { return "job" }
        return "quiet"
    }

    private func marker(_ k: LayoutNode) -> String? {
        guard let e = model.info[k.origin ?? k.path] else { return nil }
        if e.kind == "worktree", let from = e.worktreeOf { return L("of {repo}", ["repo": from == "." ? L("Project root") : from]) }
        if e.gitFile == true { return L(".git file") }
        if e.reference == true { return L("Symlink") }
        if e.special == true { return L("Special file") }
        return nil
    }

    /// Above the tree: load error of a level (with the root loaded) and truncated levels — both as on the web.
    @ViewBuilder
    private var hints: some View {
        let truncated = model.truncated.sorted { $0.key < $1.key }
        if !model.loadError.isEmpty || !truncated.isEmpty || !model.jobError.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if !model.loadError.isEmpty { Text(model.loadError).foregroundStyle(.red) }
                if !model.jobError.isEmpty { Text(model.jobError).foregroundStyle(.red) }
                ForEach(truncated, id: \.key) { p, g in
                    Text(L("“{path}” has {total} entries — the first {cap} are shown.", ["path": p.isEmpty ? "/" : p, "total": g.total, "cap": g.cap]))
                        .foregroundStyle(.orange)
                }
            }
            .cbFont(12.5)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    /// The collective bar ("N changes — Check") or the state of the job — a tap opens the sheet.
    @ViewBuilder
    private func bar(_ plan: LayoutPlan) -> some View {
        let text: String? = {
            if let a = model.job, model.jobOpen || a.state == "error" {
                // The same computation as the project list row (twin of layoutRow on the web).
                if a.state == "waiting" { return L("Outline waiting for idle ({n})", ["n": a.holders.count]) }
                return LayoutDisplay.compute(ProjectLayoutRow(state: a.state, turned: a.turned, backward: a.backward, step: a.step, error: a.error, holders: a.holders.count)).text
            }
            if model.situation?.locked != nil { return model.situation?.locked?.text }
            if !model.steps.isEmpty { return L("{n} changes — Check", ["n": model.steps.count]) }
            if model.job?.state == "finished", model.job?.report != nil { return L("The outline has been applied.") }
            return nil
        }()
        if let text {
            Button { sheetOpen = true } label: {
                HStack(spacing: 10) {
                    Text(text).cbFont(14, weight: .medium).lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.up").font(.symbol(12, weight: .semibold))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .foregroundStyle(CbColor.primaryButtonText)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(CbColor.primaryButton))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityIdentifier("layout-bar")
        }
    }
}
