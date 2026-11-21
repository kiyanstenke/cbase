import Foundation
import SwiftUI

// Upload into an existing project afterwards. Twin of `web/src/lib/project-upload.ts` (section "retroactive upload"),
// `web/src/lib/project-setup.ts` retroactiveDisplay and `web/src/components/projects/ProjectUpload.tsx`: same routes, same order:
//
//   Files · folder  `POST /api/projects/:id/upload/begin` `{ paths, operation? }` in batches → conflict question if target files
//                   already exist ("skip" does not even upload them, "abort" discards the operation) → chunks with `offset` to
//                   `…/upload?operation=` → `…/upload/:operation/finished` `{ conflict? }` (409 CONFLICT ⇒ the question only now).
//   ZIP             `begin` `{ archive: { bytes, name } }` → chunks to `…/archive` → `…/archive/check` → conflict question →
//                   `…/archive/unpack` `{ operation, mode? }` (without a conflict WITHOUT a mode: the server takes "keep"; what only
//                   appears during unpacking comes back as a question on the row, never silently discarded).
//
// The target is the root: files into the root, a folder into `<folder name>/`, a ZIP into `<top folder>/` or `<zip name>/`. No
// layout preview, no dragging (menus instead). The app must stay in the foreground; an aborted upload stays on the server and the
// server's row offers "Resume · Dismiss": in this session without a new choice (the selection is in memory), otherwise chosen
// again with the same selection.
//
// The conflict questions live in a queue, each with its own answer (a second question must not end the first with "abort" and so
// discard an upload unasked). "Cancel" of a run and "Later" in the question HALT (`halt`, ends as CancellationError, the operation
// stays); only "Dismiss upload" discards. The question shows on the list AND in the project sheet (`RetroactiveQuestionDialog`);
// a view below an open sheet presents nothing.

// ── What a project row says about open retroactive operations (like `retroactiveDisplay` on the web) ───────────────────

enum RetroactiveAction: Hashable {
    case resume(String), dismiss(String), abort(String), overwrite(String), skip(String)

    var operation: String {
        switch self {
        case .resume(let v), .dismiss(let v), .abort(let v), .overwrite(let v), .skip(let v): return v
        }
    }
    var title: String {
        switch self {
        case .resume: return L("Resume")
        case .dismiss: return L("Dismiss")
        case .abort: return L("Cancel")
        case .overwrite: return L("Overwrite")
        case .skip: return L("Skip")
        }
    }
    var kind: String {
        switch self {
        case .resume: return "resume"
        case .dismiss: return "dismiss"
        case .abort: return "abort"
        case .overwrite: return "overwrite"
        case .skip: return "skip"
        }
    }
}

struct RetroactiveRow: Hashable {
    let text: String
    let tone: SetupRow.Tone
    let actions: [RetroactiveAction]
    let operation: String
    var examples: [String] = []

    var color: Color {
        switch tone {
        case .running: return .accentColor
        case .waiting: return .orange
        case .error: return .red
        }
    }
}

struct RetroactiveDisplay {
    var rows: [RetroactiveRow] = []
    var deleteLocked = false

    /// `own`: the operations THIS app is uploading right now (running only); it shows them with its own progress. `ended`: operations
    /// whose upload was aborted or failed in this app; they count as interrupted at once (as on the web, `retroactiveDisplay`
    /// `ended`). A running place/unpack and an upload from another device lock deletion. The server computes `interrupted` on load;
    /// until the next load the page's clock keeps computing (without a chunk younger than the upload quiet period the upload is
    /// interrupted).
    static func compute(_ uploads: [RetroactiveUpload]?, own: Set<String> = [], ended: Set<String> = [], now: Date = Date(),
                       quietMs: Double = SetupDisplay.uploadQuietMs) -> RetroactiveDisplay {
        var a = RetroactiveDisplay()
        let nowMs = now.timeIntervalSince1970 * 1000
        for u in uploads ?? [] {
            let v = u.operation
            let archive = u.kind == "archive"
            switch u.state {
            case "upload":
                if own.contains(v) { a.deleteLocked = true; continue }
                let last = max(u.lastChunk ?? 0, u.since ?? 0)
                if u.interrupted != true && !ended.contains(v) && !(last > 0 && nowMs - last >= quietMs) {
                    a.rows.append(.init(text: archive ? L("ZIP upload running") : L("Upload running"), tone: .running, actions: [], operation: v))
                    a.deleteLocked = true
                    continue
                }
                let text: String
                if archive { text = L("ZIP upload interrupted") }
                else if let n = u.staged {
                    text = u.capped == true ? L("Upload interrupted (at least {n} files staged)", ["n": n]) : L("Upload interrupted ({n} files staged)", ["n": n])
                } else { text = L("Upload interrupted") }
                a.rows.append(.init(text: text, tone: .waiting, actions: [.resume(v), .dismiss(v)], operation: v))
            case "place", "unpack":
                let unpacked = u.state == "unpack"
                if u.interrupted == true {
                    a.rows.append(.init(text: unpacked ? L("Extracting interrupted") : L("Placing files interrupted"), tone: .waiting, actions: [.resume(v), .dismiss(v)], operation: v))
                    continue
                }
                a.rows.append(.init(text: unpacked ? L("extracting") : L("placing files"), tone: .running, actions: [.abort(v)], operation: v))
                a.deleteLocked = true
            case "error":
                if u.code == "CONFLICT" {
                    a.rows.append(.init(text: L("{n} files already exist", ["n": u.existing ?? 0]), tone: .waiting,
                                          actions: [.overwrite(v), .skip(v), .dismiss(v)], operation: v, examples: u.examples ?? []))
                    continue
                }
                a.rows.append(.init(text: L("Upload failed: {reason}", ["reason": u.error ?? u.code ?? ""]), tone: .error, actions: [.resume(v), .dismiss(v)], operation: v))
            default:
                continue // a state from a newer server stays quiet
            }
        }
        return a
    }

    /// May one upload into this project now? Only without an open setup and with a ready instance.
    static func uploadPossible(_ p: Project, _ e: SetupDisplay) -> Bool {
        p.setup == nil && p.instance?.state == "ready" && !e.uploadLocked
    }
}

// ── Remembered per operation (which dialog resumes, which archive it was) ───────────────────────────────────────────────────

enum RetroactiveRemembered {
    struct Value: Codable { let choice: String; let name: String; var size: Int? = nil; var changed: Double? = nil }
    private static func key(_ pid: String, _ v: String) -> String { "cbase.mobile.retroactive.\(pid).\(v)" }
    static func remember(_ pid: String, _ v: String, _ w: Value) {
        if let d = try? JSONEncoder().encode(w) { UserDefaults.standard.set(d, forKey: key(pid, v)) }
    }
    static func remembered(_ pid: String, _ v: String) -> Value? {
        guard let d = UserDefaults.standard.data(forKey: key(pid, v)) else { return nil }
        return try? JSONDecoder().decode(Value.self, from: d)
    }
    static func forget(_ pid: String, _ v: String) { UserDefaults.standard.removeObject(forKey: key(pid, v)) }
}

// ── The routes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `placed`: the server places the files (202); `dismissed`: the user discarded at the conflict question, the operation is gone.
enum RetroactiveResult { case placed, dismissed }

/// The conflict question as a callback: `existing`, up to five examples → "overwrite" | "skip" | "abort" (discard) |
/// "halt" (the run ends as CancellationError, the operation stays resumable).
typealias ConflictQuestionFn = @MainActor (_ existing: Int, _ examples: [String]) async -> String

struct ArchiveCheck: Decodable {
    let operation: String
    let target: String?
    let existing: Int
    let examples: [String]?
}

enum RetroactiveRun {
    private struct Path: Encodable { let path: String; let size: Int }
    private struct Begin: Encodable { let paths: [Path]; let operation: String? }
    private struct BeginResponse: Decodable {
        struct B: Decodable { let path: String; let size: Int }
        let operation: String
        let existing: Int?
        let examples: [String]?
        let existingPaths: [String]?
        let staged: [B]?
    }
    private struct ArchiveDetail: Encodable { let bytes: Int; let name: String }
    private struct ArchiveBegin: Encodable { let archive: ArchiveDetail; let operation: String? }
    private struct ArchiveResponse: Decodable { let operation: String; let archiveId: String; let size: Int? }
    private struct Conflict: Encodable { let conflict: String? }
    private struct OnlyOperation: Encodable { let operation: String }
    /// A nil `mode` is dropped by the synthesized Encodable; the server then takes "keep".
    private struct Unpack: Encodable { let operation: String; let mode: String? }

    static func dismiss(_ client: APIClient, _ pid: String, _ operation: String) async {
        _ = try? await client.send("/api/projects/\(pid)/upload/\(operation)", method: .delete)
    }

    /// Why the server would not accept the target path `rel`, or nil. The same rule as `uploadPath` in the server's `setup/rules.js`
    /// (and `targetError` on the web): every part by `nameError`, inside `.git` and names with the cbase prefix are allowed. An invalid
    /// path makes `begin` reject the whole batch (e.g. "Icon\r" of a folder with its own icon).
    static func targetError(_ rel: String, _ r: LayoutRules) -> String? {
        if rel.isEmpty || rel.hasPrefix("/") { return "empty" }
        for (i, t) in ProjectLayout.parts(rel).enumerated() {
            let inside = i > 0 && (t == ".git" || t.lowercased().hasPrefix(r.names.prefix))
            if let f = ProjectLayout.nameError(inside ? "x" + t : t, r) { return f }
        }
        return nil
    }

    /// Upload files or a folder afterwards. `operation` resumes an interrupted one (what is already staged is not uploaded again).
    /// `onOperation` reports the id as soon as there is one.
    static func files(_ client: APIClient, projectId pid: String, files all: [UploadFile], access: [URL], operation: String?,
                        question: ConflictQuestionFn, onOperation: @escaping @MainActor (String) -> Void,
                        aborted: @escaping @MainActor () -> Bool, progress: @escaping @MainActor (UploadProgress) -> Void) async throws -> RetroactiveResult {
        let open = access.map { ($0, $0.startAccessingSecurityScopedResource()) }
        defer { for (url, yes) in open where yes { url.stopAccessingSecurityScopedResource() } }
        func hold() async throws { if await aborted() { throw CancellationError() } }

        // 1. begin: in batches, from the second (and when resuming) with the operation.
        var vg = operation
        var existing = 0
        var examples: [String] = []
        var existingPaths = Set<String>()
        var already: [String: Int] = [:]
        var i = 0
        repeat {
            try await hold()
            let paths = all[i..<min(i + pathsPerStack, all.count)].map { Path(path: $0.target, size: $0.size) }
            let r: BeginResponse = try await client.post("/api/projects/\(pid)/upload/begin", body: Begin(paths: paths, operation: vg))
            if vg == nil { await onOperation(r.operation) }
            vg = r.operation
            existing += r.existing ?? 0
            for b in r.examples ?? [] where examples.count < 5 { examples.append(b) }
            existingPaths.formUnion(r.existingPaths ?? [])
            for b in r.staged ?? [] { already[b.path] = b.size }
            i += pathsPerStack
        } while i < all.count
        guard let v = vg else { throw APIError(status: 409, message: L("The server did not assign an upload.")) }

        // 2. The conflict question, once; "skip" does not even upload the existing files.
        var conflict: String?
        if existing > 0 {
            let a = await question(existing, examples)
            if a == "halt" { throw CancellationError() }
            if a == "abort" { await dismiss(client, pid, v); return .dismissed }
            conflict = a
        }
        let files = conflict == "skip" ? all.filter { !existingPaths.contains($0.target) } : all

        // 3. Chunks, always with resume: in a new operation nothing is staged.
        let snapshot = UploadProgress(files: 0, filesTotal: files.count, bytes: 0, bytesTotal: files.reduce(0) { $0 + $1.size })
        await progress(snapshot)
        _ = try await ProjectUploadRun.chunksUp(client, projectId: pid, operation: v, files: files, already: already, resume: true, snapshot: snapshot, hold: hold, progress: progress)

        // 4. finished: counted against the root as of NOW; if a conflict appeared since `begin`, the server asks (409 CONFLICT).
        try await hold()
        return try await finished(client, pid, v, conflict: conflict, question: question, hold: hold)
    }

    /// `POST …/upload/:operation/finished`, on 409 CONFLICT with the conflict question (once). Also "Resume" of a placing. `halt` after
    /// the answer: a cancel while the question was open places nothing any more.
    static func finished(_ client: APIClient, _ pid: String, _ v: String, conflict: String?, question: ConflictQuestionFn,
                       hold: () async throws -> Void = {}) async throws -> RetroactiveResult {
        let path = "/api/projects/\(pid)/upload/\(v)/finished"
        do {
            try await client.send(path, body: Conflict(conflict: conflict))
            return .placed
        } catch let a as APIError where a.code == "CONFLICT" && conflict == nil {
            let response = await question(a.existing ?? 0, Array((a.examples ?? []).prefix(5)))
            if response == "halt" { throw CancellationError() }
            if response == "abort" { await dismiss(client, pid, v); return .dismissed }
            try await hold()
            try await client.send(path, body: Conflict(conflict: response))
            return .placed
        }
    }

    /// Upload a ZIP afterwards. `operation` resumes (the server names the size already there; the caller checks it is the same
    /// archive).
    static func archive(_ client: APIClient, projectId pid: String, archive url: URL, size total: Int, operation: String?,
                       question: ConflictQuestionFn, onOperation: @escaping @MainActor (String) -> Void,
                       aborted: @escaping @MainActor () -> Bool, progress: @escaping @MainActor (UploadProgress) -> Void) async throws -> RetroactiveResult {
        let open = url.startAccessingSecurityScopedResource()
        defer { if open { url.stopAccessingSecurityScopedResource() } }
        func hold() async throws { if await aborted() { throw CancellationError() } }
        var snapshot = UploadProgress(files: 0, filesTotal: 1, bytes: 0, bytesTotal: total)
        let r: ArchiveResponse = try await client.post("/api/projects/\(pid)/upload/begin",
                                                     body: ArchiveBegin(archive: ArchiveDetail(bytes: total, name: url.lastPathComponent), operation: operation))
        if operation == nil { await onOperation(r.operation) }
        guard !r.archiveId.isEmpty else { throw APIError(status: 409, message: L("The server did not assign an archive id.")) }
        var at = min(total, max(0, r.size ?? 0))
        await progress(snapshot)
        var check: ArchiveCheck?
        var attempts = 0
        while check == nil {
            snapshot = try await ProjectUploadRun.archiveChunksUp(client, projectId: pid, archiveId: r.archiveId, archive: url, total: total, from: at, snapshot: snapshot, hold: hold, progress: progress)
            try await hold()
            do {
                check = try await client.post("/api/projects/\(pid)/archive/check", body: OnlyOperation(operation: r.operation))
            } catch let a as APIError where a.code == "ARCHIVE_INCOMPLETE" {
                attempts += 1
                guard let g = a.size, g < total, attempts <= 3 else { throw a }
                at = g
            }
        }
        try await hold() // a cancel during the check unpacks nothing any more
        snapshot.files = 1
        await progress(snapshot)
        return try await unpack(client, pid, check!, question: question, hold: hold)
    }

    /// If an operation's archive is already complete on the server, the server checks it; nil means "bytes are missing".
    static func checkIfComplete(_ client: APIClient, _ pid: String, _ v: String) async throws -> ArchiveCheck? {
        do { return try await client.post("/api/projects/\(pid)/archive/check", body: OnlyOperation(operation: v)) }
        catch let a as APIError where a.code == "ARCHIVE_INCOMPLETE" { return nil }
    }

    /// Conflict question after the check, then `archive/unpack`; `mode` only after an answer, without it the server places with "keep".
    static func unpack(_ client: APIClient, _ pid: String, _ p: ArchiveCheck, question: ConflictQuestionFn,
                          hold: () async throws -> Void = {}) async throws -> RetroactiveResult {
        var mode: String?
        if p.existing > 0 {
            let a = await question(p.existing, Array((p.examples ?? []).prefix(5)))
            if a == "halt" { throw CancellationError() }
            if a == "abort" { await dismiss(client, pid, p.operation); return .dismissed }
            mode = a
        }
        try await hold()
        try await client.send("/api/projects/\(pid)/archive/unpack", body: Unpack(operation: p.operation, mode: mode))
        return .placed
    }
}

// ── This app's runs and the conflict question ───────────────────────────────────────────────────────────────────────────────

/// A conflict question of the queue. `run`: the run that asks (cancelling it halts the question too); `partial`: when resuming a
/// placing, part of it is already in the project. `services`: the project's running services (nil = not loaded yet).
struct RetroactiveQuestion: Identifiable, Equatable {
    let id = UUID()
    let projectId: String
    let project: String
    let title: String
    let run: UUID?
    let partial: Bool
    let existing: Int
    let examples: [String]
    var services: [String]?
}

/// What a run uploads, kept in memory for this session so "Resume" continues without a new choice.
enum RetroactiveSource {
    case files([UploadFile], access: [URL], title: String, choice: String, name: String)
    case zip(ZipSource)
}

@MainActor
final class ProjectRetroactive: ObservableObject {
    /// ONE store for the whole app (like `ProjectUploads`): an upload survives leaving the projects page.
    static let shared = ProjectRetroactive()
    /// An aborted run disappears (the server's row takes over); a failed one stays with its message.
    enum State: Equatable { case running, error(String) }
    struct Run: Identifiable, Equatable {
        let id: UUID
        var operation: String?
        let title: String
        var state: State = .running
        var progress = UploadProgress()
    }
    @Published private(set) var runs: [String: [Run]] = [:]
    /// The queue of conflict questions; the oldest is shown.
    @Published private(set) var questions: [RetroactiveQuestion] = []
    var question: RetroactiveQuestion? { questions.first }
    /// Operations whose upload was aborted or failed in this app (key "pid|operation").
    @Published private(set) var endedSet: Set<String> = []
    private var responses: [UUID: CheckedContinuation<String, Never>] = [:]
    private var abort: Set<UUID> = []
    private var sources: [String: RetroactiveSource] = [:]

    private static func key(_ pid: String, _ v: String) -> String { pid + "|" + v }

    /// Ask the conflict question and wait for the answer. The running services are added after opening. If the run is already
    /// aborted, it ends at once with "halt".
    func questionP6(_ client: APIClient, projectId pid: String, project: String, title: String, run: UUID?, partial: Bool,
                 existing: Int, examples: [String]) async -> String {
        if let run, abort.contains(run) { return "halt" }
        let f = RetroactiveQuestion(projectId: pid, project: project, title: title, run: run, partial: partial, existing: existing, examples: examples)
        questions.append(f)
        Task { [weak self] in
            struct Response: Decodable { struct S: Decodable { struct St: Decodable { let running: Bool? }; let name: String; let status: St? }; let services: [S]? }
            let d: Response? = try? await client.get("/api/projects/\(pid)/services")
            let names = (d?.services ?? []).filter { $0.status?.running == true }.map(\.name)
            if let self, let i = self.questions.firstIndex(where: { $0.id == f.id }) { self.questions[i].services = names }
        }
        return await withCheckedContinuation { c in responses[f.id] = c }
    }

    /// Answer a question exactly once; an already answered id has no effect.
    func respond(_ id: UUID, _ a: String) {
        questions.removeAll { $0.id == id }
        responses.removeValue(forKey: id)?.resume(returning: a)
    }

    /// The conflict question for a run of this app (the run halts it when aborted).
    func questionFn(_ client: APIClient, _ p: Project, title: String, run: UUID?, partial: Bool = false) -> ConflictQuestionFn {
        let pid = p.id, name = p.name
        return { [weak self] existing, examples in
            await self?.questionP6(client, projectId: pid, project: name, title: title, run: run, partial: partial, existing: existing, examples: examples) ?? "halt"
        }
    }

    /// Drive an upload: `run` gets the question and callbacks; `placed`/`dismissed` clear the row, so does an abort (the server's row
    /// then shows the operation as interrupted), an error stays.
    func run(_ client: APIClient, _ p: Project, title: String, operation: String?, source: RetroactiveSource, finished: @escaping () async -> Void,
               _ run: @escaping (_ question: @escaping ConflictQuestionFn, _ onOperation: @escaping @MainActor (String) -> Void,
                                  _ aborted: @escaping @MainActor () -> Bool,
                                  _ progress: @escaping @MainActor (UploadProgress) -> Void) async throws -> RetroactiveResult) {
        let id = UUID(), pid = p.id
        runs[pid, default: []].append(Run(id: id, operation: operation, title: title))
        if let v = operation { endedSet.remove(Self.key(pid, v)); sources[Self.key(pid, v)] = source }
        let question = questionFn(client, p, title: title, run: id)
        Task {
            var vg = operation
            do {
                _ = try await run(
                    question,
                    { [weak self] v in vg = v; self?.sources[Self.key(pid, v)] = source; self?.set(pid, id) { $0.operation = v } },
                    { [weak self] in self?.abort.contains(id) ?? true },
                    { [weak self] f in self?.set(pid, id) { $0.progress = f } }
                )
                remove(pid, id)
                if let v = vg { RetroactiveRemembered.forget(pid, v); sources[Self.key(pid, v)] = nil }
            } catch is CancellationError {
                if let v = vg { endedSet.insert(Self.key(pid, v)) }
                remove(pid, id)
            } catch {
                if let v = vg { endedSet.insert(Self.key(pid, v)) }
                set(pid, id) { $0.state = .error(ProjectUploads.text(error)) }
            }
            abort.remove(id)
            await finished()
        }
    }

    /// Halt a run, also at an open question (it ends with "halt", the operation stays resumable).
    func abort(_ pid: String, _ id: UUID) {
        abort.insert(id)
        for f in questions where f.run == id { respond(f.id, "halt") }
    }
    func abortAll(_ pid: String) { for l in runs[pid] ?? [] { abort(pid, l.id) } }
    func remove(_ pid: String, _ id: UUID) {
        let rest = (runs[pid] ?? []).filter { $0.id != id }
        runs[pid] = rest.isEmpty ? nil : rest
    }
    /// An operation is gone (dismissed, placed): the selection in memory and the "ended" mark are dropped.
    func forget(_ pid: String, _ v: String) {
        sources[Self.key(pid, v)] = nil
        endedSet.remove(Self.key(pid, v))
        RetroactiveRemembered.forget(pid, v)
    }
    /// An operation's selection from this session, or nil (then the user chooses again).
    func source(_ pid: String, _ v: String) -> RetroactiveSource? { sources[Self.key(pid, v)] }
    /// The operations this app is uploading for a project right now (running only); their server row is dropped.
    func own(_ pid: String) -> Set<String> { Set((runs[pid] ?? []).filter { $0.state == .running }.compactMap(\.operation)) }
    /// Operations whose upload was aborted or failed in this app; they count as interrupted at once.
    func ended(_ pid: String) -> Set<String> {
        Set(endedSet.filter { $0.hasPrefix(pid + "|") }.map { String($0.dropFirst(pid.count + 1)) })
    }
    /// Is an upload into this project running in this app? (Removal stays locked meanwhile.)
    func active(_ pid: String) -> Bool { (runs[pid] ?? []).contains { $0.state == .running } }

    private func set(_ pid: String, _ id: UUID, _ f: (inout Run) -> Void) {
        guard var l = runs[pid], let i = l.firstIndex(where: { $0.id == id }) else { return }
        f(&l[i])
        runs[pid] = l
    }
}

// ── The conflict question as a dialog ─────────────────────────────────────────────────────────────────────────────────────────────

/// The conflict question, on the project list (`active` = no sheet open) AND in the project sheet (a view below an open sheet
/// presents nothing, the upload would wait invisibly). The shown question is its own state: after an answer the next in the queue
/// moves up, without closing the dialog answering it too.
struct RetroactiveQuestionDialog: ViewModifier {
    @ObservedObject var retroactive: ProjectRetroactive
    let active: Bool
    @State private var shown: RetroactiveQuestion?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                shown.map { $0.existing == 1 ? L("1 file already exists") : L("{n} files already exist", ["n": $0.existing]) } ?? "",
                isPresented: Binding(get: { shown != nil }, set: { if !$0 { shown = nil; moveUp() } }),
                titleVisibility: .visible,
                presenting: shown
            ) { f in
                Button(L("Overwrite")) { retroactive.respond(f.id, "overwrite") }
                    .accessibilityIdentifier("project-conflict-overwrite")
                Button(L("Skip")) { retroactive.respond(f.id, "skip") }
                    .accessibilityIdentifier("project-conflict-skip")
                Button(f.partial ? L("Discard the rest") : L("Discard upload"), role: .destructive) { retroactive.respond(f.id, "abort") }
                    .accessibilityIdentifier("project-conflict-dismiss")
                Button(L("Later"), role: .cancel) { retroactive.respond(f.id, "halt") }
            } message: { f in
                Text(Self.text(retroactive.questions.first(where: { $0.id == f.id }) ?? f))
            }
            .onAppear { moveUp() }
            .onChange(of: retroactive.question?.id) { _, _ in moveUp() }
            .onChange(of: active) { _, _ in moveUp() }
    }

    /// Show the next question one tick later, so a just-closed dialog does not continue the same presentation.
    private func moveUp() {
        guard active, let f = retroactive.question else { if !active { shown = nil }; return }
        guard shown?.id != f.id else { return }
        shown = nil
        DispatchQueue.main.async { if active, retroactive.question?.id == f.id { shown = retroactive.question } }
    }

    static func text(_ f: RetroactiveQuestion) -> String {
        var parts = [L("{title} in “{project}”", ["title": f.title, "project": f.project])]
        if !f.examples.isEmpty {
            var list = f.examples.joined(separator: "\n")
            if f.existing > f.examples.count { list += "\n" + L("and {n} more", ["n": f.existing - f.examples.count]) }
            parts.append(list)
        }
        parts.append(f.partial
            ? L("Overwrite replaces them with the uploaded ones, Skip leaves them as they are. “Discard the rest” deletes what is still on the server; files already placed stay in the project. “Later” only pauses the upload.")
            : L("Overwrite replaces them with the uploaded ones, Skip leaves them as they are. “Discard upload” deletes it on the server; “Later” only pauses it — it can be resumed."))
        if let d = f.services, !d.isEmpty {
            parts.append(L("Services of this project are running ({names}) — while the files are placed, they see old and new files side by side.", ["names": d.joined(separator: ", ")]))
        }
        return parts.joined(separator: "\n\n")
    }
}
