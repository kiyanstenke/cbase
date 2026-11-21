import Foundation
import SwiftUI

// Read the folders and files of a new project and upload them into the project container, plus the setup state per row. Twin of
// `web/src/lib/project-upload.ts` and `web/src/lib/project-setup.ts`: same routes, same order:
//
//   1. read      `readFolder` (security-scoped URL from `fileImporter([.folder])`) or `readFiles`; folders on the omit list
//                (`GET /api/projectCreation/rules`) are not entered, except inside `.git`; every `.git` FILE is read too.
//   2. create    `creationBody` → body of the POST and per source the files with target path (`targetOf` of the layout).
//   3. upload    `ProjectUploads.start`: `begin` in batches of at most 5,000 paths (waits for the ready container), chunks with
//                `offset` to `POST /api/projects/:id/upload?operation=…`, finally `finished`. The app must stay in the foreground
//                for this; an aborted upload stays resumable ("Resume upload").
let projectUploadChunk = 3 * 1024 * 1024
let pathsPerStack = 5000 // internal: also used by Code/ProjectRetroactive.swift

// ── Creation mode and rules (once per app run) ──────────────────────────────────────────────────────────────────────────

@MainActor
final class ProjectCreationStatus: ObservableObject {
    static let shared = ProjectCreationStatus()
    /// "container" (server mode: menu, setup) or "folder" (without it: the old dialog). `nil` = not asked yet.
    @Published private(set) var mode: String?
    @Published private(set) var rules: LayoutRules?
    private var running = false

    func load(_ client: APIClient) async {
        guard !running, mode == nil || (mode == "container" && rules == nil) else { return }
        running = true
        defer { running = false }
        // The creation mode is IN the rules response (`modus`): ONE question for both; `/api/health` only as a fallback for a server
        // without the field.
        struct Response: Decodable {
            let mode: String?
            let rules: LayoutRules
            enum K: String, CodingKey { case mode }
            init(from d: Decoder) throws {
                mode = try d.container(keyedBy: K.self).decodeIfPresent(String.self, forKey: .mode)
                rules = try LayoutRules(from: d)
            }
        }
        let a: Response? = try? await client.get("/api/projectCreation/rules")
        if let m = a?.mode { mode = m == "container" ? "container" : "folder" }
        struct Health: Decodable { let projectCreation: String? }
        if mode == nil, let h: Health = try? await client.get("/api/health") {
            mode = h.projectCreation == "container" ? "container" : "folder"
        }
        if mode == "container", rules == nil { rules = a?.rules }
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────

struct SelectedSource {
    var kind: String // "folder" | "files" | "zip" | "clone"
    /// Folder: its name; files: empty; ZIP: the top folder in the project, i.e. the archive's parent folder or the file name without
    /// `.zip`.
    var name: String
    var files: [ProjectLayout.SelectionFile] = []
    var urls: [String: URL] = [:]
    var gitContents: [String: String] = [:]
    var skippedFolder = 0
    /// The security-scoped URLs the upload requests access to again later (the folder or each file).
    var access: [URL] = []
    /// ZIP only: the archive and what the mapping needs (`ProjectCreationComputation.zipMapping`).
    var zip: ZipSource?
    /// Clone only: the checked https address and the branch (empty = the remote's default). Without files; the content only arrives in the container.
    var clone: CloneSource?
}

struct CloneSource: Encodable {
    let url: String
    let branch: String?
}

struct ZipSource {
    let file: URL
    let fileName: String
    let size: Int
    /// The archive's parent folder, or nil, in which case `name` is an imagined folder that does not exist in the archive.
    let parentFolder: String?
    /// Modification time of the file (s since 1970); with name and size the identity when resuming.
    var changed: Double? = nil
    /// Archive paths with a control character in one part.
    var controlCharacters: [String] = []
}

/// A ZIP the `PROVISIONER` would surely reject; the source does not even enter the list.
struct ZipDenied: LocalizedError {
    let reason: ZipDirectory.Reason
    let names: [String]
    var errorDescription: String? {
        let n = names.prefix(3).joined(separator: ", ")
        switch reason {
        case .encrypted: return L("The archive contains encrypted entries and is not accepted: {names}", ["names": n])
        case .encoding: return L("The archive contains names that cannot be read and is not accepted: {names}", ["names": n])
        case .unsafe: return L("The archive contains unsafe paths and is not accepted: {names}", ["names": n])
        }
    }
}

enum ProjectRead {
    /// Read a chosen folder. Access is opened and closed here; the upload opens it again.
    static func readFolder(_ url: URL, _ rules: LayoutRules) -> SelectedSource {
        let open = url.startAccessingSecurityScopedResource()
        defer { if open { url.stopAccessingSecurityScopedResource() } }
        var q = SelectedSource(kind: "folder", name: url.lastPathComponent, access: [url])
        let omit = Set(rules.omit.folder)
        let root = url.standardizedFileURL.path
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys, options: []) else { return q }
        while let kind = walker.nextObject() as? URL {
            let values = try? kind.resourceValues(forKeys: Set(keys))
            var rel = kind.standardizedFileURL.path
            if rel.hasPrefix(root) { rel = String(rel.dropFirst(root.count)) }
            rel = rel.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let parts = rel.components(separatedBy: "/")
            let inGit = parts.dropLast().contains(".git")
            if values?.isDirectory == true {
                // Nothing is omitted inside a repo's `.git`; it belongs to the repo.
                if !inGit, let n = parts.last, omit.contains(n) { q.skippedFolder += 1; walker.skipDescendants() }
                continue
            }
            guard values?.isRegularFile == true else { continue }
            q.files.append(.init(rel: rel, size: values?.fileSize ?? 0))
            q.urls[rel] = kind
            if parts.last == ".git", !inGit, let d = try? Data(contentsOf: kind), d.count <= 4096 {
                q.gitContents[rel] = String(decoding: d, as: UTF8.self)
            }
        }
        return q
    }

    /// Individually chosen files (target: the root).
    static func readFiles(_ urls: [URL]) -> SelectedSource {
        var q = SelectedSource(kind: "files", name: "", access: urls)
        for url in urls {
            let open = url.startAccessingSecurityScopedResource()
            defer { if open { url.stopAccessingSecurityScopedResource() } }
            let rel = url.lastPathComponent
            guard q.urls[rel] == nil else { continue }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            q.files.append(.init(rel: rel, size: size))
            q.urls[rel] = url
        }
        return q
    }

    /// A ZIP as a source: the central directory, without unpacking (`ZipDirectory.swift`). For the layout it is a FOLDER named `name`:
    /// same computation, same default; `zipMapping` translates the origin into archive paths. `__MACOSX/` is not included. Throws
    /// `ZipError` or `ZipDenied`.
    static func readZip(_ url: URL) throws -> SelectedSource {
        let open = url.startAccessingSecurityScopedResource()
        defer { if open { url.stopAccessingSecurityScopedResource() } }
        let v = try ZipReader.read(url)
        if let a = v.denied { throw ZipDenied(reason: a.reason, names: a.names) }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        var z = ZipSource(file: url, fileName: url.lastPathComponent, size: size, parentFolder: v.parentFolder,
                          changed: values?.contentModificationDate?.timeIntervalSince1970)
        var q = SelectedSource(kind: "zip", name: v.parentFolder ?? ZipReader.targetName(url.lastPathComponent), access: [url])
        // Paths by scalars (ZipReader.parts/begins/withoutFront), like the web and the PROVISIONER, never by graphemes.
        for e in v.entries {
            let parts = ZipReader.parts(e.name)
            if ProjectLayout.equal(parts.first ?? "", "__MACOSX") { continue }
            if parts.contains(where: { $0.unicodeScalars.contains { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) } }) { z.controlCharacters.append(e.name) }
            if e.folder { continue }
            // Next to the parent folder only lies what the server omits anyway (`.DS_Store`, otherwise there would be no parent folder).
            if let o = v.parentFolder, !ZipReader.begins(e.name, o + "/") { continue }
            let rel = v.parentFolder.map { ZipReader.withoutFront(e.name, $0.unicodeScalars.count + 1) } ?? e.name
            if rel.isEmpty { continue }
            q.files.append(.init(rel: rel, size: e.size))
            let t = ZipReader.parts(rel)
            let git = { (x: String) in ProjectLayout.equal(x, ".git") }
            if git(t.last ?? ""), !t.dropLast().contains(where: git) { q.gitContents[rel] = ZipReader.smallEntry(url, e) ?? "" }
        }
        q.zip = z
        return q
    }

    /// The keys of the `.git` files for `treeFromSelection`: `<seq>:<origin>`.
    static func gitFiles(_ sources: [(seq: Int, q: SelectedSource)]) -> [String: String] {
        var out: [String: String] = [:]
        for (seq, q) in sources {
            for (rel, content) in q.gitContents {
                let origin = q.kind != "files" ? "\(q.name.precomposedStringWithCanonicalMapping)/\(rel.precomposedStringWithCanonicalMapping)" : rel.precomposedStringWithCanonicalMapping
                out["\(seq):\(origin)"] = content
            }
        }
        return out
    }

    /// For the layout a ZIP is a folder (`readZip`).
    static func selection(_ sources: [(seq: Int, q: SelectedSource)]) -> [ProjectLayout.Selection] {
        sources.map { .init(seq: $0.seq, kind: $0.q.kind == "files" ? "files" : $0.q.kind == "clone" ? "clone" : "folder", name: $0.q.name, files: $0.q.files) }
    }
}

// ── Body of the POST and upload list ───────────────────────────────────────────────────────────────────────────────────

struct UploadFile { let target: String; let url: URL; let size: Int }
struct SourceUpload {
    /// Number at the server (order in the body, from 1).
    let seq: Int
    /// Number of the selection (key of the mapping).
    let source: Int
    let kind: String
    let target: String
    let files: [UploadFile]
    let access: [URL]
    /// ZIP only: the archive goes up (`files` is empty), `archiveSize` is its size; `fresh` uploads it from the start at the server
    /// (`begin` with `fresh: true` truncates the partial one to 0) instead of resuming from its size.
    var archive: URL? = nil
    var archiveSize = 0
    var fresh = false
}

struct CreationBody: Encodable {
    /// `mapping` only for ZIP, `clone` only for a clone, `bytes` not for a clone (a nil key is dropped by the synthesized Encodable,
    /// intended).
    struct Source: Encodable { let kind: String; let target: String; let name: String?; let bytes: Int?; var mapping: [MappingEntry]? = nil; var clone: CloneSource? = nil }
    let name: String
    let sources: [Source]
    let codeRepos: [String]
}

enum ProjectCreationComputation {
    /// Like `creationBody` on the web: a source without files is dropped; a folder source whose top folder is in the final tree goes
    /// as `folder` with its final path, otherwise as `files` into the root.
    struct BodyError: LocalizedError { let errorDescription: String? }

    static func body(name: String, sources: [(seq: Int, q: SelectedSource)], tree: ProjectLayout.SelectionTree, plan: LayoutPlan) throws -> (CreationBody, [SourceUpload]) {
        var rq: [CreationBody.Source] = []
        var uploads: [SourceUpload] = []
        for (seq, q) in sources {
            let pathMapping = plan.mapping[String(seq)] ?? []
            if let k = q.clone {
                // A clone is ONE node: its final path is `<location>/<name>`; if left out it is dropped. Nothing is uploaded; the server
                // clones in the container. Looked up under the SAME origin as the node (`normal`); if missing, that is a computation
                // error, not a leave-out (otherwise the clone would silently fall out of the body).
                let n = ProjectLayout.normal(q.name)
                guard let entry = pathMapping.first(where: { ProjectLayout.equal($0.from, n) }) else {
                    throw BodyError(errorDescription: L("Outline: no target for the repository “{name}”", ["name": q.name]))
                }
                guard let to = entry.to else { continue }
                rq.append(.init(kind: "clone", target: to, name: ProjectLayout.nameOf(to), bytes: nil, clone: k))
                continue
            }
            if let z = q.zip {
                // A ZIP goes up as a whole; the server unpacks it by the mapping. If no file remains, it is dropped.
                let up = tree.upload[String(seq)] ?? []
                guard up.contains(where: { (ProjectLayout.targetOf(pathMapping, $0.origin) ?? nil) != nil }) else { continue }
                let n = q.name.precomposedStringWithCanonicalMapping
                let target = pathMapping.first(where: { ProjectLayout.equal($0.from, n) })?.to ?? ""
                let withoutName = tree.hints.filter { $0.code == "NAME_OMITTED" }.compactMap(\.path)
                let source = CreationBody.Source(kind: "zip", target: target, name: z.fileName, bytes: z.size,
                                                mapping: zipMapping(q, pathMapping, withoutName: withoutName))
                rq.append(source)
                uploads.append(SourceUpload(seq: rq.count, source: seq, kind: "zip", target: target, files: [], access: q.access, archive: z.file, archiveSize: z.size))
                continue
            }
            var files: [UploadFile] = []
            for d in tree.upload[String(seq)] ?? [] {
                guard let target = ProjectLayout.targetOf(pathMapping, d.origin) else { continue } // not covered: cannot happen
                guard let z = target, let url = q.urls[d.rel] else { continue } // left out
                files.append(UploadFile(target: z, url: url, size: d.size))
            }
            if files.isEmpty { continue }
            let bytes = files.reduce(0) { $0 + $1.size }
            let top = q.kind == "folder" ? pathMapping.first(where: { !$0.from.contains("/") }) : nil
            let source: CreationBody.Source
            if let o = top, let to = o.to {
                source = .init(kind: "folder", target: to, name: ProjectLayout.nameOf(to), bytes: bytes)
            } else {
                source = .init(kind: "files", target: "", name: nil, bytes: bytes)
            }
            rq.append(source)
            uploads.append(SourceUpload(seq: rq.count, source: seq, kind: source.kind, target: source.target, files: files, access: q.access))
        }
        return (CreationBody(name: name.trimmingCharacters(in: .whitespaces), sources: rq, codeRepos: plan.codeRepos), uploads)
    }

    /// Like `zipMapping` on the web: the plan's mapping (origin = `name/…`) into archive paths. With a parent folder the origin is
    /// already the archive path; without one the imagined prefix is dropped and the imagined folder's entry becomes `von: ""`, the
    /// archive root (one entry per first path part would make a flat archive with more than 50,000 files exceed the mapping cap).
    /// The longest prefix wins. Every file of this archive with NAME_OMITTED gets `nach: null`. Prefixes by UTF-16 as on the web.
    static func zipMapping(_ q: SelectedSource, _ pathMapping: [MappingEntry], withoutName: [String]) -> [MappingEntry] {
        guard let z = q.zip else { return pathMapping }
        let n = q.name.precomposedStringWithCanonicalMapping
        func archivePath(_ h: String) -> String? {
            if z.parentFolder != nil { return h }
            if ProjectLayout.equal(h, n) { return "" }
            return ProjectLayout.beginsWith(h, n + "/") ? String(decoding: Array(h.utf16.dropFirst(n.utf16.count + 1)), as: UTF16.self) : nil
        }
        var merged: [MappingEntry] = []
        for e in pathMapping {
            guard let a = archivePath(e.from) else { continue }
            merged.append(MappingEntry(from: a, to: e.to))
        }
        var uploaded = Set(merged.map { Array($0.from.utf16) })
        let inArchive = Set(z.controlCharacters.map { Array($0.utf16) })
        for h in withoutName {
            guard let a = archivePath(h), !a.isEmpty, inArchive.contains(Array(a.utf16)), uploaded.insert(Array(a.utf16)).inserted else { continue }
            merged.append(MappingEntry(from: a, to: nil))
        }
        return merged.sorted { Array($0.from.utf16).lexicographicallyPrecedes(Array($1.from.utf16)) }
    }

    // "Resume upload": the creation's mapping per project and server source (UserDefaults); it carries every move. Plus `kind`/`name`
    // of the SELECTION: a folder whose top node was left out goes to the server as `files`, but its mapping starts with the folder
    // name; it can only be resumed with the folder dialog.
    /// `size`/`changed` for ZIP only: with the name the archive's identity when resuming.
    struct Remembered: Codable { var kind: String?; var name: String?; var mapping: [MappingEntry]; var size: Int? = nil; var changed: Double? = nil }
    private static func key(_ pid: String, _ seq: Int) -> String { "cbase.mobile.creation-mapping.\(pid).\(seq)" }
    static func remember(_ pid: String, _ seq: Int, kind: String, name: String, _ mapping: [MappingEntry], size: Int? = nil, changed: Double? = nil) {
        let g = Remembered(kind: kind, name: name, mapping: mapping, size: size, changed: changed)
        if let d = try? JSONEncoder().encode(g) { UserDefaults.standard.set(d, forKey: key(pid, seq)) }
    }

    /// Like `sameArchive` on the web: is the chosen archive demonstrably the one whose beginning is already at the server? What is
    /// known is compared: name and size from the server's view (valid on every device), plus what is remembered here (name, size,
    /// modification time). Without any data not demonstrable ⇒ false; the caller then asks and uploads from the start (`fresh`).
    static func sameArchive(_ z: ZipSource, server: ProjectSetup.Source, remembered g: Remembered?) -> Bool {
        var check: [Bool] = []
        if let n = server.name, !n.isEmpty { check.append(ProjectLayout.equal(n, z.fileName)) }
        if let b = server.bytes { check.append(b == z.size) }
        if let g, g.kind == "zip" {
            check.append(ProjectLayout.equal(g.name ?? "", z.fileName))
            if let b = g.size { check.append(b == z.size) }
            if let t = g.changed, let now = z.changed { check.append(abs(t - now) < 0.001) }
        }
        return !check.isEmpty && !check.contains(false)
    }
    static func forget(_ pid: String, _ seq: Int) { UserDefaults.standard.removeObject(forKey: key(pid, seq)) }
    /// What is remembered; an entry from the first version (only the mapping as a list) is read too.
    static func remembered(_ pid: String, _ seq: Int) -> Remembered? {
        guard let d = UserDefaults.standard.data(forKey: key(pid, seq)) else { return nil }
        if let g = try? JSONDecoder().decode(Remembered.self, from: d) { return g }
        return (try? JSONDecoder().decode([MappingEntry].self, from: d)).map { Remembered(kind: nil, name: nil, mapping: $0) }
    }
    /// Which dialog resumes: the remembered choice; without a reliable `kind` a folder selection is recognised by a "/" in the origin.
    /// `nil` = nothing remembered (then the kind of the server source).
    static func rememberedChoice(_ pid: String, _ seq: Int) -> String? {
        guard let g = remembered(pid, seq) else { return nil }
        if g.kind == "zip" { return "zip" }
        return g.kind == "folder" || g.mapping.contains(where: { $0.from.contains("/") }) ? "folder" : "files"
    }

    /// The files of a newly chosen selection for a waiting source. Without a remembered mapping the creation default
    /// (folder → `<target>/<path>`, files → root).
    static func resumption(_ pid: String, source: ProjectSetup.Source, selected: SelectedSource, rules: LayoutRules) -> (files: [UploadFile], notCaptured: Int) {
        let selection = ProjectLayout.treeFromSelection(ProjectRead.selection([(1, selected)]), rules, ProjectRead.gitFiles([(1, selected)]))
        let remembered = remembered(pid, source.seq)?.mapping
        var files: [UploadFile] = []
        var notCaptured = 0
        for d in selection.upload["1"] ?? [] {
            let target: String??
            if let g = remembered { target = ProjectLayout.targetOf(g, d.origin) }
            else if source.kind == "folder" {
                let rest = d.origin.firstIndex(of: "/").map { String(d.origin[d.origin.index(after: $0)...]) }
                target = .some(rest.map { "\(source.target)/\($0)" } ?? source.target)
            } else { target = .some(d.origin) }
            guard let captured = target else { notCaptured += 1; continue }
            guard let z = captured else { continue }
            guard let url = selected.urls[d.rel] else { notCaptured += 1; continue }
            files.append(UploadFile(target: z, url: url, size: d.size))
        }
        return (files, notCaptured)
    }
}

// ── The upload ──────────────────────────────────────────────────────────────────────────────────────────────────────

struct UploadProgress: Equatable { var files = 0; var filesTotal = 0; var bytes = 0; var bytesTotal = 0 }

@MainActor
final class ProjectUploads: ObservableObject {
    /// ONE store for the whole app: an upload survives leaving the projects page (the app must stay in the foreground).
    static let shared = ProjectUploads()
    enum State: Equatable { case waiting, running, finished, aborted, error(String) }
    /// One run per (project, source); `call` is the `start` call it belongs to. A second call in the same project ("resume" of one
    /// source while another uploads) replaces only its own entries.
    struct SourceRun: Identifiable, Equatable { let seq: Int; let target: String; let call: UUID; var state: State = .waiting; var progress = UploadProgress(); var id: Int { seq } }
    @Published private(set) var runs: [String: [SourceRun]] = [:]
    private var abort: Set<UUID> = []

    /// Uploads these sources one after the other. `finished` is called afterwards (reload the list).
    func start(_ client: APIClient, projectId: String, uploads: [SourceUpload], resume: Bool, finished: @escaping () async -> Void) {
        guard !uploads.isEmpty else { return }
        let call = UUID()
        let nrs = Set(uploads.map(\.seq))
        let old = runs[projectId] ?? []
        for q in old where nrs.contains(q.seq) { abort.insert(q.call) } // an older call for the same source ends
        runs[projectId] = (old.filter { !nrs.contains($0.seq) } + uploads.map { SourceRun(seq: $0.seq, target: $0.target, call: call) }).sorted { $0.seq < $1.seq }
        Task {
            var everythingGood = true
            for u in uploads {
                if abort.contains(call) { set(projectId, u.seq, call) { $0.state = .aborted }; everythingGood = false; continue }
                set(projectId, u.seq, call) { $0.state = .running }
                do {
                    let aborted: @MainActor () -> Bool = { [weak self] in self?.abort.contains(call) ?? true }
                    let progress: @MainActor (UploadProgress) -> Void = { [weak self] f in self?.set(projectId, u.seq, call) { $0.progress = f } }
                    if u.archive != nil {
                        try await ProjectUploadRun.uploadArchive(client, projectId: projectId, upload: u, resume: resume, aborted: aborted, progress: progress)
                    } else {
                        try await ProjectUploadRun.performUpload(client, projectId: projectId, upload: u, resume: resume, aborted: aborted, progress: progress)
                    }
                    set(projectId, u.seq, call) { $0.state = .finished }
                    ProjectCreationComputation.forget(projectId, u.seq)
                } catch is CancellationError {
                    everythingGood = false
                    set(projectId, u.seq, call) { $0.state = .aborted }
                } catch {
                    everythingGood = false
                    set(projectId, u.seq, call) { $0.state = .error(ProjectUploads.text(error)) }
                }
            }
            if everythingGood, let l = runs[projectId] {
                let rest = l.filter { $0.call != call }
                runs[projectId] = rest.isEmpty ? nil : rest
            }
            abort.remove(call)
            await finished()
        }
    }

    func abort(_ projectId: String) { for q in runs[projectId] ?? [] { abort.insert(q.call) } }
    func hide(_ projectId: String) { runs[projectId] = nil }
    /// Is an upload for this source running in THIS app?
    func own(_ projectId: String, _ seq: Int) -> Bool {
        runs[projectId]?.contains { $0.seq == seq && ($0.state == .waiting || $0.state == .running) } ?? false
    }

    private func set(_ pid: String, _ seq: Int, _ call: UUID, _ f: (inout SourceRun) -> Void) {
        guard var l = runs[pid], let i = l.firstIndex(where: { $0.seq == seq && $0.call == call }) else { return }
        f(&l[i])
        runs[pid] = l
    }

    static func text(_ error: Error) -> String {
        if let a = error as? APIError {
            // Without a measurement (df failed, `free`/`needed` null) the server's message says what is going on.
            if a.code == "SLOT", let free = a.free, let needed = a.needed {
                return L("Not enough space on the server: {free} free, {needed} needed.", ["free": sizeText(free), "needed": sizeText(needed)])
            }
            if a.code == "UPLOAD_RUNNING" { return L("An upload is already running for this source (in another tab?).") }
            return a.message
        }
        return error.localizedDescription
    }
}

func sizeText(_ n: Int) -> String {
    if n >= 1_000_000_000 { return String(format: "%.1f GB", Double(n) / 1e9) }
    if n >= 1_000_000 { return String(format: "%.1f MB", Double(n) / 1e6) }
    if n >= 1_000 { return "\(Int((Double(n) / 1e3).rounded())) kB" }
    return "\(n) B"
}

enum ProjectUploadRun {
    private struct Path: Encodable { let path: String; let size: Int }
    private struct Begin: Encodable { let bytes: Int; let paths: [Path]; let operation: String? }
    private struct BeginResponse: Decodable { struct V: Decodable { let path: String; let size: Int }; let operation: String; let existing: [V]? }
    private struct Chunk: Encodable { let path: String; let dataB64: String; let offset: Int }
    private struct Body: Encodable { let files: [Chunk] }
    private struct Snapshot: Decodable { let id: String; let setup: ProjectSetup? }

    static func performUpload(_ client: APIClient, projectId: String, upload u: SourceUpload, resume: Bool,
                         aborted: @escaping @MainActor () -> Bool, progress: @escaping @MainActor (UploadProgress) -> Void) async throws {
        let open = u.access.map { ($0, $0.startAccessingSecurityScopedResource()) }
        defer { for (url, yes) in open where yes { url.stopAccessingSecurityScopedResource() } }
        func hold() async throws { if await aborted() { throw CancellationError() } }
        let total = u.files.reduce(0) { $0 + $1.size }
        let snapshot = UploadProgress(files: 0, filesTotal: u.files.count, bytes: 0, bytesTotal: total)

        // 1. begin: in batches, from the second with the first one's operation; waits for the ready container.
        var operation: String?
        var existing: [String: Int] = [:]
        var i = 0
        repeat {
            let paths = u.files[i..<min(i + pathsPerStack, u.files.count)].map { Path(path: $0.target, size: $0.size) }
            let r = try await begin(client, projectId, u.seq, Begin(bytes: total, paths: paths, operation: operation), hold: hold)
            operation = r.operation
            for v in r.existing ?? [] { existing[v.path] = v.size }
            i += pathsPerStack
        } while i < u.files.count
        guard let vg = operation else { return }
        await progress(snapshot)

        // 2. Chunks.
        _ = try await chunksUp(client, projectId: projectId, operation: vg, files: u.files, already: existing, resume: resume, snapshot: snapshot, hold: hold, progress: progress)

        // 3. finished: the source is staged, the setup continues.
        try await hold()
        try await client.send("/api/projects/\(projectId)/setup/sources/\(u.seq)/finished")
    }

    /// The chunks of ONE operation into its staging area (creation and retroactive). `already` = the sizes of the files already
    /// STAGED: with `resume` a complete one is skipped and a started one continues from its size; without it every file starts at 0.
    /// Small files from 0 go together, everything else one by one with an offset; a 409 OFFSET resumes that one file from the reported
    /// size. → the state afterwards.
    static func chunksUp(_ client: APIClient, projectId: String, operation vg: String, files: [UploadFile], already existing: [String: Int], resume: Bool,
                            snapshot beginning: UploadProgress, hold: () async throws -> Void, progress: @MainActor (UploadProgress) -> Void) async throws -> UploadProgress {
        var snapshot = beginning
        let path = "/api/projects/\(projectId)/upload"
        // The operation is in the URL: the server stamps the request at its start, before the body (busy); in the body it would be
        // "unresolved" until reading ends and hold every other source of the project with 409 UPLOAD_RUNNING.
        let address = [URLQueryItem(name: "operation", value: vg)]
        var batch: [Chunk] = []
        var batchBytes = 0
        var collectedFiles = 0
        func empty() async throws {
            guard !batch.isEmpty else { return }
            try await client.send(path, query: address, body: Body(files: batch))
            snapshot.bytes += batchBytes; snapshot.files += collectedFiles
            batch = []; batchBytes = 0; collectedFiles = 0
            await progress(snapshot)
        }

        for d in files {
            try await hold()
            let uploaded = existing[d.target]
            if resume, uploaded == d.size { snapshot.files += 1; snapshot.bytes += d.size; await progress(snapshot); continue }
            var pos = resume && (uploaded ?? 0) < d.size ? (uploaded ?? 0) : 0
            if pos == 0 && d.size <= projectUploadChunk {
                if batchBytes + d.size > projectUploadChunk { try await empty() }
                let data = try Data(contentsOf: d.url)
                batch.append(Chunk(path: d.target, dataB64: data.base64EncodedString(), offset: 0))
                batchBytes += data.count; collectedFiles += 1
                if batchBytes >= projectUploadChunk { try await empty() }
                continue
            }
            try await empty()
            let handle = try FileHandle(forReadingFrom: d.url)
            defer { try? handle.close() }
            snapshot.bytes += pos
            var attempts = 0
            while pos < d.size {
                try await hold()
                try handle.seek(toOffset: UInt64(pos))
                guard let part = try handle.read(upToCount: projectUploadChunk), !part.isEmpty else { break }
                do {
                    try await client.send(path, query: address, body: Body(files: [Chunk(path: d.target, dataB64: part.base64EncodedString(), offset: pos)]))
                } catch let a as APIError where a.code == "OFFSET" {
                    attempts += 1
                    guard let g = a.size, g <= d.size, attempts <= 3 else { throw a }
                    snapshot.bytes += g - pos
                    pos = g
                    await progress(snapshot)
                    continue
                }
                pos += part.count
                snapshot.bytes += part.count
                await progress(snapshot)
            }
            snapshot.files += 1
            await progress(snapshot)
        }
        try await empty()

        return snapshot
    }

    /// `fresh` only if set (a nil key is dropped by the synthesized Encodable).
    private struct ArchiveBegin: Encodable { let bytes: Int; var fresh: Bool? = nil; var name: String? = nil }
    private struct ArchiveResponse: Decodable { let archiveId: String; let size: Int? }
    private struct ArchiveChunk: Encodable { let archiveId: String; let offset: Int; let dataB64: String }
    private struct ArchiveFinished: Encodable { let archiveId: String; let size: Int }

    /// Uploads the archive of ONE ZIP source and reports it `finished`; unpacking happens on the server. `begin` assigns the `archiveId`
    /// once per source and names the size already there: resuming goes from it, otherwise the first chunk starts at 0 (replace). A 409
    /// OFFSET resumes from the reported size.
    static func uploadArchive(_ client: APIClient, projectId: String, upload u: SourceUpload, resume: Bool,
                               aborted: @escaping @MainActor () -> Bool, progress: @escaping @MainActor (UploadProgress) -> Void) async throws {
        guard let archive = u.archive else { return }
        let open = u.access.map { ($0, $0.startAccessingSecurityScopedResource()) }
        defer { for (url, yes) in open where yes { url.stopAccessingSecurityScopedResource() } }
        func hold() async throws { if await aborted() { throw CancellationError() } }
        let total = u.archiveSize
        var snapshot = UploadProgress(files: 0, filesTotal: 1, bytes: 0, bytesTotal: total)
        // A different archive (different size) is rejected by the server without `fresh` with 409 ARCHIVE_DIFFERENT, since it would hang on the old beginning.
        let r: ArchiveResponse = try await beginArchive(client, projectId, u.seq, ArchiveBegin(bytes: total, fresh: u.fresh ? true : nil, name: u.fresh ? archive.lastPathComponent : nil), hold: hold)
        guard !r.archiveId.isEmpty else { throw APIError(status: 409, message: L("The server did not assign an archive id.")) }
        let uploaded = max(0, r.size ?? 0)
        var pos = resume && !u.fresh && uploaded <= total ? uploaded : 0
        snapshot.bytes = pos
        await progress(snapshot)
        var attempts = 0
        while true {
            snapshot = try await archiveChunksUp(client, projectId: projectId, archiveId: r.archiveId, archive: archive, total: total, from: pos, snapshot: snapshot, hold: hold, progress: progress)
            try await hold()
            do {
                try await client.send("/api/projects/\(projectId)/setup/sources/\(u.seq)/finished", body: ArchiveFinished(archiveId: r.archiveId, size: total))
                break
            } catch let a as APIError where a.code == "ARCHIVE_INCOMPLETE" {
                // The server counts at the descriptor: if less is there, it continues from there; no chunk heals more than the archive.
                attempts += 1
                guard let g = a.size, g < total, attempts <= 3 else { throw a }
                pos = g
                snapshot.bytes = pos
                await progress(snapshot)
            }
        }
        snapshot.files = 1
        await progress(snapshot)
    }

    /// The chunks of an archive from `from` to `POST …/archive` (creation and retroactive). A 409 OFFSET resumes from the reported size
    /// (at most three times). → the state afterwards.
    static func archiveChunksUp(_ client: APIClient, projectId: String, archiveId: String, archive: URL, total: Int, from beginning: Int, snapshot old: UploadProgress,
                                  hold: () async throws -> Void, progress: @MainActor (UploadProgress) -> Void) async throws -> UploadProgress {
        var snapshot = old
        var pos = beginning
        snapshot.bytes = pos
        // The id is in the URL too: the server stamps the request before the body (like `?operation=` for the folder).
        let path = "/api/projects/\(projectId)/archive"
        let address = [URLQueryItem(name: "archiveId", value: archiveId)]
        let handle = try FileHandle(forReadingFrom: archive)
        defer { try? handle.close() }
        var attempts = 0
        while pos < total { // a ZIP has at least 22 bytes: the first chunk at 0 always replaces
            try await hold()
            try handle.seek(toOffset: UInt64(pos))
            guard let part = try handle.read(upToCount: projectUploadChunk), !part.isEmpty else { break }
            do {
                try await client.send(path, query: address, body: ArchiveChunk(archiveId: archiveId, offset: pos, dataB64: part.base64EncodedString()))
            } catch let a as APIError where a.code == "OFFSET" {
                attempts += 1
                guard let g = a.size, g <= total, attempts <= 3 else { throw a }
                pos = g
                snapshot.bytes = pos
                await progress(snapshot)
                continue
            }
            pos += part.count
            snapshot.bytes = pos
            await progress(snapshot)
        }
        return snapshot
    }

    private static func beginArchive(_ client: APIClient, _ pid: String, _ seq: Int, _ body: ArchiveBegin, hold: () async throws -> Void) async throws -> ArchiveResponse {
        while true {
            try await hold()
            do {
                return try await client.post("/api/projects/\(pid)/setup/sources/\(seq)/begin", body: body)
            } catch let a as APIError where a.code == "NOT_READY" || a.code == "RUNNING" {
                try await waitReady(client, pid)
            }
        }
    }

    /// Between two `begin`s while the container is not ready: if the setup ends in `error` (or the project is gone) it throws;
    /// otherwise a three-second pause.
    private static func waitReady(_ client: APIClient, _ pid: String) async throws {
        if let all: [Snapshot] = try? await client.get("/api/projects") {
            guard let p = all.first(where: { $0.id == pid }) else { throw APIError(status: 404, message: L("The project no longer exists.")) }
            guard let e = p.setup else { throw APIError(status: 409, message: L("The setup is already finished.")) }
            // The server carries only the reason in `error`; the prefix is added here.
            if e.state == "error" { throw APIError(status: 409, message: L("Setup failed: {reason}", ["reason": e.error ?? e.code ?? ""])) }
        }
        try await Task.sleep(nanoseconds: 3_000_000_000)
    }

    private static func begin(_ client: APIClient, _ pid: String, _ seq: Int, _ body: Begin, hold: () async throws -> Void) async throws -> BeginResponse {
        while true {
            try await hold()
            do {
                return try await client.post("/api/projects/\(pid)/setup/sources/\(seq)/begin", body: body)
            } catch let a as APIError where a.code == "NOT_READY" || a.code == "RUNNING" {
                // RUNNING: a setup step is working right now (container being created); wait as for the ready container.
                try await waitReady(client, pid)
            }
        }
    }
}

// ── What a project row says about the setup (like `web/src/lib/project-setup.ts`) ──────────────────────────────────

enum SetupAction: Hashable {
    case resume(Int), takeOver(Int), leaveOut(Int), abort(Int)
    case again, overwrite, skip, abortConflict, erase
    /// "Add access" on a clone that lacked access or whose access was rejected, then "Try again". `change`: the host rejected a stored
    /// access (ACCESS_REJECTED), the button is then "Change access" (like `change` on the web).
    case access(Int, change: Bool = false)

    var title: String {
        switch self {
        case .access(_, let change): return change ? L("Change access") : L("Add access")
        case .resume: return L("Resume upload")
        case .takeOver: return L("Take as is")
        case .leaveOut: return L("Continue without this source")
        case .abort, .abortConflict: return L("Cancel")
        case .again: return L("Try again")
        case .overwrite: return L("Overwrite")
        case .skip: return L("Skip")
        case .erase: return L("Delete")
        }
    }
    var identifier: String {
        switch self {
        case .resume(let n): return "resume-\(n)"
        case .takeOver(let n): return "take-over-\(n)"
        case .leaveOut(let n): return "leave-out-\(n)"
        case .abort(let n): return "abort-\(n)"
        case .again: return "again"
        case .overwrite: return "overwrite"
        case .skip: return "skip"
        case .abortConflict: return "conflict-abort"
        case .erase: return "erase"
        case .access(let n, _): return "access-\(n)"
        }
    }
    var seq: Int? {
        switch self {
        case .resume(let n), .takeOver(let n), .leaveOut(let n), .abort(let n), .access(let n, _): return n
        default: return nil
        }
    }
}

struct SetupRow: Hashable {
    enum Tone: Hashable { case running, waiting, error }
    let text: String
    let tone: Tone
    var actions: [SetupAction]
    let seq: Int?

    var color: Color {
        switch tone {
        case .running: return .accentColor
        case .waiting: return .orange
        case .error: return .red
        }
    }
}

struct SetupDisplay {
    var rows: [SetupRow] = []
    var deleteLocked = false
    var uploadLocked = false
    var layoutLocked = false

    static let uploadQuietMs: Double = 60_000

    private static func stepName(_ s: String) -> String {
        switch s {
        case "container": return L("creating the container")
        case "place": return L("placing the files")
        case "code-repos": return L("creating the code repos")
        case "project-repo": return L("Initial commit")
        default: return L("Sources")
        }
    }
    private static func stepRunning(_ s: String) -> String {
        switch s {
        case "container": return L("Creating container")
        case "place": return L("placing files")
        case "code-repos": return L("creating code repos")
        default: return L("Initial commit")
        }
    }

    /// For these clone errors a (new) access for the host helps (like `ACCESS_HELPS` on the web).
    static let accessHelps: Set<String> = ["NO_ACCESS", "ACCESS_REJECTED", "SUBMODULE_ACCESS"]

    /// The sentence of a failed clone, like `CLONE_ERROR` in `web/src/lib/project-setup.ts`.
    private static func cloneError(_ q: ProjectSetup.Source, _ name: String) -> String {
        let host = q.host ?? ""
        let reason = q.error ?? q.code ?? ""
        switch q.code ?? "" {
        case "NO_ACCESS": return L("{source}: no access for {host}", ["source": name, "host": host])
        case "ACCESS_REJECTED": return L("{source}: the access for {host} was rejected", ["source": name, "host": host])
        // `{reason}` is the name here: "Submodule "x"" (server clone.js); what is meant is "is missing or was rejected".
        case "SUBMODULE_ACCESS": return L("{source}: {reason} needs access for {host}", ["source": name, "reason": reason, "host": host])
        case "TARGET_OCCUPIED": return L("{source}: something already exists at the target", ["source": name])
        case "CLONE": return L("{source}: cloning failed: {reason}", ["source": name, "reason": reason])
        case "SUBMODULE": return L("{source}: submodules failed: {reason}", ["source": name, "reason": reason])
        case "LFS": return L("{source}: LFS files failed: {reason}", ["source": name, "reason": reason])
        default: return L("{source}: setup failed: {reason}", ["source": name, "reason": reason])
        }
    }

    static func compute(_ e: ProjectSetup?, _ detection: ProjectDetection?, now: Date = Date()) -> SetupDisplay {
        var a = SetupDisplay()
        let ms = now.timeIntervalSince1970 * 1000
        if let e {
            a.uploadLocked = true
            a.layoutLocked = true
            if e.state == "error" {
                if e.code == "INTERRUPTED" {
                    a.rows.append(.init(text: L("Setup interrupted: {step}", ["step": stepName(e.step)]), tone: .error, actions: [.again, .erase], seq: nil))
                } else {
                    a.rows.append(.init(text: L("Setup failed: {reason}", ["reason": e.error ?? e.code ?? ""]), tone: .error, actions: [.again, .erase], seq: nil))
                }
            } else if e.waiting == "conflict" {
                a.rows.append(.init(text: L("{n} files already exist", ["n": e.conflict?.existing ?? 0]), tone: .waiting,
                                      actions: [.overwrite, .skip, .abortConflict], seq: nil))
            } else if e.step != "sources" {
                a.rows.append(.init(text: stepRunning(e.step), tone: .running, actions: [], seq: nil))
                a.deleteLocked = true
            }
            if e.state != "error" && e.waiting == "storage" {
                a.rows.append(.init(text: L("waiting for memory"), tone: .waiting, actions: [], seq: nil))
            }
            if !(e.state == "error" && e.code == "INTERRUPTED") {
                let open = e.sources.filter { $0.state != "leftOut" }
                let still = (!open.isEmpty && open.allSatisfy { $0.state == "staged" }) || e.step != "sources"
                // "Take as is" in `error`/`aborted` is only accepted by the server in the step `sources` (otherwise 409 NOT_READY).
                let inSources = e.state == "setUp" && e.step == "sources"
                // A clone is at `clone` from creation on; cloning only happens in the ready container (like `beforeContainer` on the web).
                let beforeContainer = e.step == "container" || e.waiting == "container"
                for q in e.sources {
                    let name = q.target.isEmpty ? "/" : q.target
                    switch q.state {
                    case "staged":
                        if !still { a.rows.append(.init(text: L("{source}: ready — waiting for the other sources", ["source": name]), tone: .waiting, actions: [], seq: q.seq)) }
                    case "wait-upload":
                        if let t = q.lastChunk, ms - t < uploadQuietMs {
                            a.rows.append(.init(text: L("{source}: upload running", ["source": name]), tone: .running, actions: [], seq: q.seq))
                            a.deleteLocked = true
                        } else {
                            // ZIP: a half archive cannot be unpacked, so "Take as is" only in `error`/`aborted` (web lib/project-setup.ts);
                            // a complete one that was only not reported finished is completed by "Resume".
                            a.rows.append(.init(text: L("{source}: waiting for upload", ["source": name]), tone: .waiting,
                                                  actions: q.kind == "zip" ? [.resume(q.seq), .leaveOut(q.seq), .erase]
                                                      : [.resume(q.seq), .takeOver(q.seq), .leaveOut(q.seq), .erase], seq: q.seq))
                        }
                    case "error" where q.kind == "clone", "aborted" where q.kind == "clone":
                        // "Try again" resumes at its step; "Take as is" only if the repository itself is fetched (`fetched`), then the
                        // server takes it without missing submodules or LFS files, as on the web.
                        let access = q.state == "error" && !(q.host ?? "").isEmpty && accessHelps.contains(q.code ?? "")
                        let over = inSources && q.fetched == true && q.code != "INTERRUPTED"
                        let text = q.state == "aborted" ? L("{source}: cancelled", ["source": name]) : cloneError(q, name)
                        a.rows.append(.init(text: text, tone: .error,
                                              actions: (access ? [.access(q.seq, change: q.code == "ACCESS_REJECTED")] : []) + [.again]
                                                  + (over ? [.takeOver(q.seq)] : []) + [.leaveOut(q.seq), .erase], seq: q.seq))
                    case "clone" where q.kind == "clone" && beforeContainer:
                        a.rows.append(.init(text: L("{source}: waiting for the container…", ["source": name]), tone: .waiting, actions: [.abort(q.seq)], seq: q.seq))
                    case "error":
                        // Not for an interrupted source (still stored in the server state ⇒ 409 SOURCE_STATE), as on the web.
                        let over = inSources && q.code != "INTERRUPTED"
                        a.rows.append(.init(text: L("{source}: setup failed: {reason}", ["source": name, "reason": q.error ?? q.code ?? ""]), tone: .error,
                                              actions: over ? [.again, .takeOver(q.seq), .leaveOut(q.seq), .erase] : [.again, .leaveOut(q.seq), .erase], seq: q.seq))
                    case "aborted":
                        a.rows.append(.init(text: L("{source}: cancelled", ["source": name]), tone: .error,
                                              actions: inSources ? [.again, .takeOver(q.seq), .leaveOut(q.seq), .erase] : [.again, .leaveOut(q.seq), .erase], seq: q.seq))
                    case "unpack", "clone", "submodule", "lfs":
                        let text: String
                        switch q.state {
                        case "unpack": text = L("{source}: extracting", ["source": name])
                        case "clone": text = L("{source}: cloning", ["source": name])
                        case "submodule": text = L("{source}: fetching submodules", ["source": name])
                        default: text = L("{source}: fetching LFS files", ["source": name])
                        }
                        a.rows.append(.init(text: text, tone: .running, actions: [.abort(q.seq)], seq: q.seq))
                        a.deleteLocked = true
                    default:
                        break
                    }
                }
            }
        }
        if detection?.status == "running" { a.rows.append(.init(text: L("Detecting services"), tone: .running, actions: [], seq: nil)) }
        else if detection?.status == "error" { a.rows.append(.init(text: L("Service detection failed"), tone: .error, actions: [], seq: nil)) }
        // "Try again" and "Delete" apply to the whole project: once, on the first row that carries them.
        var seen = Set<SetupAction>()
        for i in a.rows.indices {
            a.rows[i].actions = a.rows[i].actions.filter { acts in
                if acts.seq != nil { return true }
                return seen.insert(acts).inserted
            }
        }
        return a
    }
}
