import SwiftUI

// Check and take over a layout of an existing project — the counterpart of `web/src/components/projects/LayoutTakeOver.tsx`. The
// sheet opens from the collective bar of the page (`LayoutInventory.swift`).
//
// The steps from the tree go to `POST …/layout/check`; the result (rules, "Will be deleted" with unsaved work and Docker objects,
// warnings, citations) is shown here, "Take over" creates the job after a confirmation. The job waits for quiet (wait list,
// "Stop" per holder), runs, fails (before the turnaround nothing is changed, after it "Try again") or ends with a report. The
// server is the boundary: whatever is grey here, it answers with 409 anyway.

// ── What the server delivers (projectbox/layout/read.js check, job.js jobView, procedure.js report) ─────────────────
// Every field optional: a new server with new fields must never make the sheet unreadable. A LIST is read per entry
// (`LayoutTolerant`): an unreadable entry must never empty the whole list — for "Will be deleted" that would make a deletion
// look like none. How many entries were unreadable is counted and blocks the take-over.

/// An entry that could not be read becomes `nil` instead of dragging the whole list along.
struct LayoutTolerant<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct LayoutSituation: Decodable, Equatable {
    struct Copy: Decodable, Equatable { let name: String; let count: Int? }
    struct Locked: Decodable, Equatable { let reason: String; let code: String?; let text: String; let name: String? }
    let rootIsRepo: Bool
    let copyOpen: Copy?
    let locked: Locked?
}

struct LayoutHolder: Decodable, Identifiable, Equatable {
    let kind: String
    let id: String
    let chatId: String?
    let name: String?
    let text: String
    let stoppable: Bool?
    var key: String { "\(kind):\(id)" }
}

struct LayoutReport: Decodable, Equatable {
    struct End: Decodable, Equatable { let at: Double?; let ways: [FinalMapping.Way]?; let gone: [String]?; let codeRepos: [String]? }
    struct Name: Decodable, Equatable { let name: String? }
    struct Removed: Decodable, Equatable { let container: [Name]?; let volumes: [Name]?; let networks: [Name]?; let images: [Name]? }
    struct Add: Decodable, Equatable { let kind: String; let name: String }
    struct Superseded: Decodable, Equatable { let name: String; let afterwards: String?; let fresh: String? }
    struct Services: Decodable, Equatable {
        struct Way: Decodable, Equatable { let name: String; let old: String?; let fresh: String? }
        let rewritten: [Way]?
        let dropped: [Name]?
    }
    let warnings: [String]?
    let foreign: [Name]?
    let removed: Removed?
    let add: [Add]?
    let superseded: [Superseded]?
    let services: Services?
    let findings: [String]?
    let end: End?
}

struct LayoutJob: Decodable, Equatable {
    let state: String
    let turned: Bool
    let backward: Bool
    let step: String
    let error: String?
    let steps: [LayoutStep]
    let holders: [LayoutHolder]
    let hints: [LayoutHolder]
    let report: LayoutReport?

    private enum CodingKeys: String, CodingKey { case state, turned, backward, step, error, steps, holders, hints, report }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(String.self, forKey: .state)
        turned = (try? c.decodeIfPresent(Bool.self, forKey: .turned)) ?? false
        backward = (try? c.decodeIfPresent(Bool.self, forKey: .backward)) ?? false
        step = (try? c.decodeIfPresent(String.self, forKey: .step)) ?? ""
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        steps = (try? c.decodeIfPresent([LayoutStep].self, forKey: .steps)) ?? []
        holders = (try? c.decodeIfPresent([LayoutHolder].self, forKey: .holders)) ?? []
        hints = (try? c.decodeIfPresent([LayoutHolder].self, forKey: .hints)) ?? []
        report = (try? c.decodeIfPresent(LayoutReport.self, forKey: .report)) ?? nil
    }
}

struct LayoutResult: Decodable, Equatable {
    struct Finding: Decodable, Equatable { let code: String; let path: String?; let second: String?; let step: Int?; let prior: Bool?; let text: String? }
    struct Repo: Decodable, Equatable {
        struct Unpushed: Decodable, Equatable { let total: Int }
        struct Ignored: Decodable, Equatable { let count: Int; let names: [String] }
        struct Backup: Decodable, Equatable { let name: String; let branches: [String] }
        /// A linked worktree of a code repo that is dropped.
        struct Worktree: Decodable, Equatable {
            let path: String
            let branch: String?
            let missing: Bool?
            let changes: Int?
        }
        let path: String
        let kind: String
        let worktreeOf: String?
        let branch: String?
        let noRemote: Bool?
        let unpushed: Unpushed?
        let unpushedCount: Int?
        let commits: Int?
        let withoutUpstream: [String]?
        let copyBackups: [Backup]?
        let stashes: Int?
        let changes: Int?
        let ignored: Ignored?
        let worktrees: [Worktree]?
        let unreadable: [String]?

        private enum CodingKeys: String, CodingKey { case path, kind, worktreeOf, branch, noRemote, unpushed, commits, withoutUpstream, copyBackups, stashes, changes, ignored, worktrees, unreadable }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = try c.decode(String.self, forKey: .path)
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "code-repo"
            worktreeOf = (try? c.decodeIfPresent(String.self, forKey: .worktreeOf)) ?? nil
            branch = (try? c.decodeIfPresent(String.self, forKey: .branch)) ?? nil
            noRemote = (try? c.decodeIfPresent(Bool.self, forKey: .noRemote)) ?? nil
            // A code repo carries `unpushed` as an object, a worktree as a number.
            unpushed = (try? c.decodeIfPresent(Unpushed.self, forKey: .unpushed)) ?? nil
            unpushedCount = (try? c.decodeIfPresent(Int.self, forKey: .unpushed)) ?? nil
            commits = (try? c.decodeIfPresent(Int.self, forKey: .commits)) ?? nil
            withoutUpstream = (try? c.decodeIfPresent([String].self, forKey: .withoutUpstream)) ?? nil
            copyBackups = (try? c.decodeIfPresent([Backup].self, forKey: .copyBackups)) ?? nil
            stashes = (try? c.decodeIfPresent(Int.self, forKey: .stashes)) ?? nil
            changes = (try? c.decodeIfPresent(Int.self, forKey: .changes)) ?? nil
            ignored = (try? c.decodeIfPresent(Ignored.self, forKey: .ignored)) ?? nil
            worktrees = ((try? c.decodeIfPresent([LayoutTolerant<Worktree>].self, forKey: .worktrees)) ?? nil)?.compactMap(\.value)
            unreadable = (try? c.decodeIfPresent([String].self, forKey: .unreadable)) ?? nil
        }
    }
    struct Named: Decodable, Equatable { let name: String?; let state: String?; let size: Int?; let tags: [String]? }
    struct Docker: Decodable, Equatable {
        struct Stays: Decodable, Equatable { let name: String; let usedBy: [String] }
        let container: [Named]?
        let volumes: [Named]?
        let networks: [Named]?
        let images: [Named]?
        let stays: [Stays]?
    }
    struct LeaveOut: Decodable, Equatable {
        struct Count: Decodable, Equatable { let count: Int }
        /// Sum of the lstat sizes under the path (program.js `details`): `{ bytes, files }`, nil = not readable.
        struct Size: Decodable, Equatable { let bytes: Int; let files: Int? }
        let path: String
        let size: Size?
        let repos: [Repo]?
        let projectRepo: Count?
        let services: [Named]?
        let knowledge: Int?
        let docker: Docker?
        /// How many repos could not be read — they are missing from `repos`, so the take-over is blocked.
        let reposUnreadable: Int

        private enum CodingKeys: String, CodingKey { case path, size, repos, projectRepo, services, knowledge, docker }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = try c.decode(String.self, forKey: .path)
            size = (try? c.decodeIfPresent(Size.self, forKey: .size)) ?? nil
            let r = (try? c.decodeIfPresent([LayoutTolerant<Repo>].self, forKey: .repos)) ?? nil
            repos = r?.compactMap(\.value)
            reposUnreadable = (r ?? []).filter { $0.value == nil }.count
            projectRepo = (try? c.decodeIfPresent(Count.self, forKey: .projectRepo)) ?? nil
            services = (try? c.decodeIfPresent([Named].self, forKey: .services)) ?? nil
            knowledge = (try? c.decodeIfPresent(Int.self, forKey: .knowledge)) ?? nil
            docker = try c.decodeIfPresent(Docker.self, forKey: .docker)
        }
    }
    struct Move: Decodable, Equatable { let old: String; let fresh: String; let container: [Named]? }
    struct Citations: Decodable, Equatable {
        struct Place: Decodable, Equatable { let kind: String; let name: String; let field: String; let row: Int?; let text: String?; let secret: Bool? }
        let list: [Place]
        let total: Int
        let unreadable: [String]?
    }
    struct DockerState: Decodable, Equatable { let read: Bool; let error: String? }

    let finalMapping: FinalMapping
    let error: [Finding]
    let warnings: [Finding]
    let leaveOut: [LeaveOut]
    let move: [Move]
    let citations: Citations?
    let docker: DockerState?
    /// Entries of `leaveOut` that could not be read (including unreadable repos in them) — then the take-over is blocked, because a
    /// deletion whose extent is not shown must not be confirmed.
    let leaveOutUnreadable: Int

    private enum CodingKeys: String, CodingKey { case finalMapping, error, warnings, leaveOut, move, citations, docker }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        finalMapping = (try? c.decodeIfPresent(FinalMapping.self, forKey: .finalMapping)) ?? FinalMapping()
        error = (try? c.decodeIfPresent([Finding].self, forKey: .error)) ?? []
        warnings = (try? c.decodeIfPresent([Finding].self, forKey: .warnings)) ?? []
        if c.contains(.leaveOut) {
            if let list = try? c.decode([LayoutTolerant<LeaveOut>].self, forKey: .leaveOut) {
                leaveOut = list.compactMap(\.value)
                leaveOutUnreadable = list.filter { $0.value == nil }.count + leaveOut.reduce(0) { $0 + $1.reposUnreadable }
            } else {
                leaveOut = []
                leaveOutUnreadable = 1
            }
        } else {
            leaveOut = []
            leaveOutUnreadable = 0
        }
        move = (try? c.decodeIfPresent([Move].self, forKey: .move)) ?? []
        citations = (try? c.decodeIfPresent(Citations.self, forKey: .citations)) ?? nil
        docker = (try? c.decodeIfPresent(DockerState.self, forKey: .docker)) ?? nil
    }

    var changes: Int { finalMapping.ways.count + finalMapping.gone.count + finalMapping.codeRepos.count }
}

struct LayoutCheck: Decodable, Equatable {
    /// read.js startCheck: `{ code, text }`.
    struct Failure: Decodable, Equatable { let code: String?; let text: String? }
    let check: String
    var state: String
    let steps: [LayoutStep]
    let result: LayoutResult?
    let error: Failure?

    init(check: String, state: String, steps: [LayoutStep], result: LayoutResult?, error: Failure?) {
        (self.check, self.state, self.steps, self.result, self.error) = (check, state, steps, result, error)
    }
    private enum CodingKeys: String, CodingKey { case check, state, steps, result, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        check = try c.decode(String.self, forKey: .check)
        state = try c.decode(String.self, forKey: .state)
        steps = (try? c.decodeIfPresent([LayoutStep].self, forKey: .steps)) ?? []
        result = (try? c.decodeIfPresent(LayoutResult.self, forKey: .result)) ?? nil
        error = (try? c.decodeIfPresent(Failure.self, forKey: .error)) ?? nil
    }
}

// ── The sheet ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

struct LayoutTakeOverSheet: View {
    @ObservedObject var model: LayoutExistingModel
    /// Errors of the computation on the device — they block the take-over (the server computes again on the whole tree).
    let planError: Int
    @Environment(\.dismiss) private var dismiss
    @State private var questionTakeOver = false
    @State private var stopQuestion: LayoutHolder?
    @State private var reportGone = false

    var body: some View {
        CbList {
            if !model.error.isEmpty {
                Section { Text(model.error).cbFont(13.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            }
            if let a = model.job, model.jobOpen {
                jobSections(a)
            } else {
                if let a = model.job, a.state == "error" {
                    Section {
                        Text(L("The outline no longer fits: {reason}. Nothing in the project was changed.", ["reason": a.error ?? ""]))
                            .cbFont(14).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                        Button(L("Check again")) { Task { await model.checkAgain() } }
                            .disabled(model.busy || model.situation?.locked != nil)
                        Button(L("Undo"), role: .destructive) { Task { await model.revert(keep: false) } }
                            .disabled(model.busy)
                    }
                }
                if let a = model.job, a.state == "finished", let b = a.report, !reportGone, model.steps.isEmpty {
                    reportSections(b)
                    Section { Button(L("Dismiss##hide")) { reportGone = true } }
                }
                if let g = model.situation?.locked {
                    Section { Text(g.text).cbFont(14).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                } else if model.job?.state != "error" || !model.steps.isEmpty {
                    // After an error before the turnaround: "Check again" puts the steps back — check and take-over are then here.
                    checkSections
                }
            }
        }
        .navigationTitle(L("Adopt"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { SheetClose(label: L("Done")) { dismiss() } }
        .confirmationDialog(takeOverText, isPresented: $questionTakeOver, titleVisibility: .visible) {
            Button(L("Adopt"), role: (result?.leaveOut.isEmpty ?? true) ? nil : .destructive) { Task { await model.takeOver() } }
            Button(L("Cancel"), role: .cancel) {}
        }
        .confirmationDialog(
            stopQuestion.map { L("Stop “{text}”?", ["text": $0.text]) } ?? "",
            isPresented: Binding(get: { stopQuestion != nil }, set: { if !$0 { stopQuestion = nil } }),
            titleVisibility: .visible
        ) {
            if let h = stopQuestion {
                Button(L("Stop"), role: .destructive) { stopQuestion = nil; Task { await model.stop(h) } }
            }
            Button(L("Cancel"), role: .cancel) { stopQuestion = nil }
        }
    }

    private var result: LayoutResult? {
        guard let p = model.check, p.state == "finished", !model.checkStale else { return nil }
        return p.result
    }

    private var takeOverText: String {
        let n = result?.leaveOut.count ?? 0
        return n > 0
            ? L("{n} entries will be deleted permanently — together with everything listed under “Will be deleted”. Apply the outline as soon as the project is idle?", ["n": n])
            : L("Apply the outline as soon as the project is idle? Services and affected containers are stopped briefly for it.")
    }

    // ── Check ──

    @ViewBuilder
    private var checkSections: some View {
        if model.steps.isEmpty {
            Section {
                Text(L("Press and hold to rename, move, leave out or mark a folder as a code repo. Then check and apply."))
                    .cbFont(14).foregroundStyle(CbColor.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Section {
                if model.checkStale { Text(L("The changes are newer than the check.")).cbFont(13.5).foregroundStyle(.orange) }
                if model.check?.state == "expired" && !model.checkStale { Text(L("The check has expired.")).cbFont(13.5).foregroundStyle(.orange) }
                if model.check?.state == "running" && !model.checkStale {
                    HStack(spacing: 8) { ProgressView(); Text(L("Checking repos, Docker and mentions in the project container…")).cbFont(13.5).foregroundStyle(CbColor.textSecondary) }
                }
                if model.check?.state == "error" && !model.checkStale {
                    let f = model.check?.error
                    Text(L("Check failed: {reason}", ["reason": f?.text ?? f?.code ?? L("unknown")])).cbFont(13.5).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.check?.state == "aborted" && !model.checkStale {
                    Text(L("The check was cancelled — check again.")).cbFont(13.5).foregroundStyle(.orange)
                }
                Button(result == nil ? L("Check") : L("Check again")) { Task { await model.check() } }
                    .disabled(model.busy || model.check?.state == "running")
                    .accessibilityIdentifier("layout-check")
                if let e = result {
                    Button(L("Adopt")) { questionTakeOver = true }
                        .disabled(model.busy || !adoptable(e))
                        .accessibilityIdentifier("layout-take-over")
                }
            } header: {
                Text(L("{n} changes", ["n": model.steps.count]))
            } footer: {
                if result != nil {
                    Text(L("Running work (turns, agents, terminals, uploads) is only checked when applying: the order waits until the project is idle."))
                }
            }
            if let e = result { resultSections(e) }
        }
    }

    private func adoptable(_ e: LayoutResult) -> Bool {
        e.error.isEmpty && planError == 0 && e.changes > 0 && e.leaveOutUnreadable == 0 && model.situation?.locked == nil && !(e.docker?.read == false && e.docker?.error != nil)
    }

    private func notice(_ f: LayoutResult.Finding) -> String {
        if let t = f.text, !t.isEmpty { return t }
        return ProjectLayoutPage.noticeText(LayoutNotice(code: f.code, path: f.path, second: f.second, step: f.step))
    }

    @ViewBuilder
    private func resultSections(_ e: LayoutResult) -> some View {
        if !e.error.isEmpty {
            Section {
                ForEach(Array(e.error.enumerated()), id: \.offset) { _, f in
                    Text(notice(f) + (f.prior == true ? " " + L("(already the case before)") : "")).cbFont(13.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            } header: { Text(L("Error")) }
        }
        if e.changes == 0 {
            Section { Text(L("These changes change nothing.")).cbFont(13.5).foregroundStyle(.orange) }
        }
        if e.leaveOutUnreadable > 0 {
            Section { Text(L("What would be deleted could not be read completely — applying needs a new check first.")).cbFont(13.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
        if let d = e.docker, !d.read, let f = d.error {
            Section { Text(L("Docker in the project container could not be read ({reason}) — applying needs a successful read.", ["reason": f])).cbFont(13.5).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
        }
        if !e.leaveOut.isEmpty {
            Section {
                ForEach(e.leaveOut, id: \.path) { w in leaveOutRow(w) }
            } header: { Text(L("Will be deleted ({n})", ["n": e.leaveOut.count])) }
        }
        if !e.warnings.isEmpty {
            Section {
                ForEach(Array(e.warnings.enumerated()), id: \.offset) { _, w in
                    Text(notice(w)).cbFont(13.5).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            } header: { Text(L("Warnings ({n})", ["n": e.warnings.count])) }
        }
        let withContainers = e.move.filter { !($0.container ?? []).isEmpty }
        if !withContainers.isEmpty {
            Section {
                ForEach(withContainers, id: \.old) { v in
                    Text(L("{old} → {fresh}: {names}", ["old": v.old, "fresh": v.fresh, "names": (v.container ?? []).compactMap(\.name).joined(separator: ", ")]))
                        .cbFont(13.5).fixedSize(horizontal: false, vertical: true)
                }
            } header: { Text(L("Containers that will be recreated")) }
        }
        if let f = e.citations, f.total > 0 {
            Section {
                ForEach(Array(f.list.enumerated()), id: \.offset) { _, s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(s.kind) · \(s.name) · \(s.field)\(s.row.map { ":\($0)" } ?? "")").cbFont(13).lineLimit(1)
                        if s.secret == true {
                            Text(L("A secret — only its key is shown.")).cbFont(12).foregroundStyle(CbColor.textMuted)
                        } else if let t = s.text {
                            Text(t).cbFont(12, design: .monospaced).foregroundStyle(CbColor.textMuted).lineLimit(2)
                        }
                    }
                }
                if f.total > f.list.count { Text(L("… and {n} more", ["n": f.total - f.list.count])).cbFont(13) }
            } header: { Text(L("Mentions of the old path ({n}) — nothing is replaced", ["n": f.total])) }
        }
    }

    private func leaveOutRow(_ w: LayoutResult.LeaveOut) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(w.path).cbFont(14, weight: .medium).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Text(w.size.map { g in (g.files ?? 0) > 1 ? L("{size} in {n} files", ["size": sizeText(g.bytes), "n": g.files ?? 0]) : sizeText(g.bytes) } ?? L("Size unknown"))
                    .cbFont(12).monospacedDigit().foregroundStyle(CbColor.textMuted)
            }
            ForEach(Array(repoRows(w).enumerated()), id: \.offset) { _, z in
                Text(z.0).cbFont(12.5).foregroundStyle(z.1).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("layout-way-\(w.path)")
    }

    /// What would be lost at a folder that is dropped — each row only if it says something.
    private func repoRows(_ w: LayoutResult.LeaveOut) -> [(String, Color)] {
        var z: [(String, Color)] = []
        for r in w.repos ?? [] {
            if r.kind == "worktree" {
                z.append((L("Worktree of {repo}{branch}", ["repo": r.worktreeOf ?? "?", "branch": r.branch.map { " (\($0))" } ?? ""]), CbColor.textSecondary))
                if let n = r.unpushedCount, n > 0 { z.append((L("{n} commits not pushed", ["n": n]), .red)) }
            } else {
                z.append((L("Code repo {path}{branch}", ["path": r.path, "branch": r.branch.map { " (\($0))" } ?? ""]), CbColor.textSecondary))
                if let u = r.unpushed, u.total > 0 { z.append((L("{n} commits not pushed", ["n": u.total]), .red)) }
                if r.noRemote == true { z.append((L("No remote — {n} commits exist only here", ["n": r.commits.map(String.init) ?? "?"]), .red)) }
                if let o = r.withoutUpstream, !o.isEmpty, r.noRemote != true { z.append((L("Branches without upstream: {names}", ["names": o.joined(separator: ", ")]), .orange)) }
                for k in r.copyBackups ?? [] { z.append((L("Backup of the copy “{name}”: {branches}", ["name": k.name, "branches": k.branches.joined(separator: ", ")]), .orange)) }
                if let s = r.stashes, s > 0 { z.append((L("{n} stashes", ["n": s]), .red)) }
                if let i = r.ignored, i.count > 0 { z.append((L("{n} ignored files, e.g. {names}", ["n": i.count, "names": i.names.joined(separator: ", ")]), .orange)) }
                for w in r.worktrees ?? [] {
                    let changes = w.missing == true ? " — " + L("missing")
                        : (w.changes ?? 0) > 0 ? " — " + L("{n} uncommitted changes", ["n": w.changes ?? 0]) : ""
                    z.append((L("Linked worktree {path}{branch}{changes}", ["path": w.path, "branch": w.branch.map { " (\($0))" } ?? "", "changes": changes]),
                              (w.changes ?? 0) > 0 ? .red : CbColor.textSecondary))
                }
            }
            if let a = r.changes, a > 0 { z.append((L("{n} uncommitted changes", ["n": a]), .red)) }
            if let u = r.unreadable, !u.isEmpty { z.append((L("Not readable: {what}", ["what": u.joined(separator: ", ")]), .orange)) }
        }
        if let p = w.projectRepo, p.count > 0 { z.append((L("{n} files are tracked in the project repo — they stay in the creation commit.", ["n": p.count]), CbColor.textSecondary)) }
        if let d = w.services, !d.isEmpty { z.append((L("Services removed with it: {names}", ["names": d.compactMap(\.name).joined(separator: ", ")]), .orange)) }
        if let n = w.knowledge, n > 0 { z.append((L("{n} knowledge entries depend only on this folder", ["n": n]), .orange)) }
        if let d = w.docker {
            if let c = d.container, !c.isEmpty { z.append((L("Containers: {names}", ["names": c.map { "\($0.name ?? "?") (\($0.state ?? "?"))" }.joined(separator: ", ")]), .red)) }
            if let v = d.volumes, !v.isEmpty { z.append((L("Volumes: {names}", ["names": v.map { "\($0.name ?? "?")\($0.size.map { " (\(sizeText($0)))" } ?? "")" }.joined(separator: ", ")]), .red)) }
            if let n = d.networks, !n.isEmpty { z.append((L("Networks: {names}", ["names": n.compactMap(\.name).joined(separator: ", ")]), CbColor.textSecondary)) }
            if let i = d.images, !i.isEmpty { z.append((L("Images: {names}", ["names": i.map { $0.tags?.first ?? "?" }.joined(separator: ", ")]), CbColor.textSecondary)) }
            for b in d.stays ?? [] { z.append((L("Stays: {name} — used by {usedBy}", ["name": b.name, "usedBy": b.usedBy.joined(separator: ", ")]), CbColor.textSecondary)) }
        }
        return z
    }

    // ── The job ──

    @ViewBuilder
    private func jobSections(_ a: LayoutJob) -> some View {
        switch a.state {
        case "waiting":
            Section {
                Text(a.holders.isEmpty ? L("Checking whether the project is idle…")
                     : L("Waiting for the project to be idle — applied as soon as nothing is working any more ({n}).", ["n": a.holders.count]))
                    .cbFont(14).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if !a.holders.isEmpty {
                Section {
                    ForEach(a.holders, id: \.key) { h in holderRow(h, stoppable: h.stoppable == true) }
                } header: { Text(L("Waiting list")) }
            }
            if !a.hints.isEmpty {
                Section {
                    ForEach(a.hints, id: \.key) { h in holderRow(h, stoppable: false) }
                } header: { Text(L("Waits afterwards, does not hold up")) }
            }
            Section {
                Button(L("Undo"), role: .destructive) { Task { await model.revert(keep: true) } }
                    .disabled(model.busy)
                    .accessibilityIdentifier("layout-revert")
            }
        case "running":
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(a.backward ? L("Reverting: {step}", ["step": LayoutDisplay.stepName(a.step)])
                         : L("Applying: {step}", ["step": LayoutDisplay.stepName(a.step)]))
                        .cbFont(14)
                }
            }
        default:
            Section {
                Text(a.turned
                     ? L("Half applied at “{step}”: {reason}. The project stays locked until the rest has run.", ["step": LayoutDisplay.stepName(a.step), "reason": a.error ?? ""])
                     : L("Reverting was interrupted: {reason}", ["reason": a.error ?? ""]))
                    .cbFont(14).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                Button(L("Try again")) { Task { await model.again() } }
                    .disabled(model.busy)
                    .accessibilityIdentifier("layout-again")
            }
        }
    }

    private func holderRow(_ h: LayoutHolder, stoppable: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(h.text).cbFont(14).fixedSize(horizontal: false, vertical: true)
                if let n = h.name, !n.isEmpty { Text(n).cbFont(12).foregroundStyle(CbColor.textMuted) }
            }
            Spacer(minLength: 8)
            if stoppable {
                Button(L("Stop"), role: .destructive) { stopQuestion = h }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("layout-stop-\(h.kind)")
            }
        }
    }

    @ViewBuilder
    private func reportSections(_ b: LayoutReport) -> some View {
        Section { Text(L("The outline has been applied.")).cbFont(14).foregroundStyle(.green) }
        if let e = b.end, !(e.ways ?? []).isEmpty || !(e.gone ?? []).isEmpty || !(e.codeRepos ?? []).isEmpty {
            Section {
                ForEach(e.ways ?? [], id: \.old) { w in Text(L("{old} → {fresh}", ["old": w.old, "fresh": w.fresh])).cbFont(13.5) }
                ForEach(e.gone ?? [], id: \.self) { p in Text(L("{path} deleted", ["path": p])).cbFont(13.5) }
                ForEach(e.codeRepos ?? [], id: \.self) { p in Text(L("{path} is now a code repo", ["path": p])).cbFont(13.5) }
            } header: { Text(L("Updated")) }
        }
        let removed = (b.removed?.container ?? []) + (b.removed?.volumes ?? []) + (b.removed?.networks ?? [])
        if !removed.isEmpty || !(b.removed?.images ?? []).isEmpty {
            Section {
                ForEach(Array(removed.enumerated()), id: \.offset) { _, n in Text(n.name ?? "?").cbFont(13.5) }
                if let i = b.removed?.images, !i.isEmpty { Text(L("{n} images", ["n": i.count])).cbFont(13.5) }
            } header: { Text(L("Docker objects removed ({n})", ["n": removed.count + (b.removed?.images?.count ?? 0)])) }
        }
        if let h = b.add, !h.isEmpty {
            Section {
                ForEach(Array(h.enumerated()), id: \.offset) { _, x in Text("\(x.kind): \(x.name)").cbFont(13.5).foregroundStyle(.orange) }
            } header: { Text(L("Added after the confirmation and deleted as well")) }
        }
        if let a = b.superseded, !a.isEmpty {
            Section {
                ForEach(Array(a.enumerated()), id: \.offset) { _, x in Text(L("{name} — the stack is now called {fresh}", ["name": x.afterwards ?? x.name, "fresh": x.fresh ?? "?"])).cbFont(13.5) }
            } header: { Text(L("Old containers (stopped, removable on the Services page)")) }
        }
        if let d = b.services, !(d.rewritten ?? []).isEmpty || !(d.dropped ?? []).isEmpty {
            Section {
                ForEach(Array((d.rewritten ?? []).enumerated()), id: \.offset) { _, x in
                    Text(L("{name}: {old} → {fresh}", ["name": x.name, "old": (x.old ?? "").isEmpty ? "/" : x.old!, "fresh": (x.fresh ?? "").isEmpty ? "/" : x.fresh!])).cbFont(13.5)
                }
                ForEach(Array((d.dropped ?? []).enumerated()), id: \.offset) { _, x in Text(L("{name} deleted", ["name": x.name ?? "?"])).cbFont(13.5).foregroundStyle(.orange) }
            } header: { Text(L("Services")) }
        }
        if let f = b.foreign, !f.isEmpty {
            Section { Text(L("Stopped because they ran in the project: {names}", ["names": f.compactMap(\.name).joined(separator: ", ")])).cbFont(13.5).foregroundStyle(.orange) }
        }
        let toCheck = (b.warnings ?? []) + (b.findings ?? [])
        if !toCheck.isEmpty {
            Section {
                ForEach(Array(toCheck.enumerated()), id: \.offset) { _, w in Text(w).cbFont(13.5).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            } header: { Text(L("To check")) }
        }
    }
}
