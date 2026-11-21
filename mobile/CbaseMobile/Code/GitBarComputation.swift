import Foundation

// The pure computations of the git sheet — Swift TWINS of the web sheets, function for function:
//   - web/src/lib/git-bar.ts: primary button (commit · publish branch · synchronize · off), what "synchronize" does in
//     order, the selection under "Repositories", which repo the graph shows (`graphRepo`, prefers one with a remote), the remembered
//     choice and the collapsed sections (same keys, here in UserDefaults instead of localStorage);
//   - web/src/lib/git-files.ts: letter, kind and label of a commit's file, name/folder, the path for the diff, the symbol
//     by file type;
//   - web/src/lib/api/git.ts: the allow-lists for the graph's answers (`normGitGraphLog`, `normGitCommitFiles`,
//     `normGitCommitFileDiff`) — A MISSING FIELD IS NOT A STATEMENT: `parents: null` draws linear, `clipped: null` means unknown,
//     an old server without `files` is "unavailable", never "no files".
// Not rebuilt: order and heights of the sections (dragging and moving are no thing on a phone) and ⌘-click on the
// selection (there is no key for it — a tap selects exactly one repo).
//
// BOUND in web/test/git-bar-ios-binding.test.mjs (like Code/GitGraphComputation.swift): both versions run over the same cases, with
// built-in sabotage on copies of this file. Hence ONLY Foundation and `JSONValue` (Models/JSONValue.swift), everything under `GitBar`.

enum GitBar {
    // ── A repo's situation (git-bar.ts RepoSituation) ───────────────────────────────────────────────────────────────────────────
    /// The narrow form of a repo the computations work with — a field not listed here decides nothing here.
    struct RepoSituation: Hashable, Sendable {
        var branch: String?
        var detached: Bool?
        var upstream: String?
        var ahead: Double?
        var behind: Double?
        var remote: Bool
        var statusError: String?
        /// `counts.total`; nil = `counts` missing.
        var countsTotal: Double?
        /// `changes.length`; nil = `changes` missing.
        var changes: Int?
    }

    enum Primary: Hashable, Sendable {
        case commit(unknown: Bool)
        case publish
        case synchronize(ahead: Int, behind: Int)
        case nothing
    }

    private static func count(_ n: Double?) -> Int {
        guard let n, n.isFinite, n > 0 else { return 0 }
        return Int(n.rounded(.down))
    }

    private static func set(_ s: String?) -> Bool { !(s ?? "").isEmpty }

    /// Whether the repo carries known changes (staged, unstaged, untracked or conflict).
    static func hasChanges(_ r: RepoSituation) -> Bool {
        (r.countsTotal ?? r.changes.map(Double.init) ?? 0) > 0
    }

    static func primaryButton(_ r: RepoSituation) -> Primary {
        if set(r.statusError) { return .commit(unknown: true) }
        if hasChanges(r) { return .commit(unknown: false) }
        if r.remote && set(r.upstream) && (count(r.ahead) > 0 || count(r.behind) > 0) {
            return .synchronize(ahead: count(r.ahead), behind: count(r.behind))
        }
        // A detached HEAD is not a branch — nothing to publish.
        if r.remote && !set(r.upstream) && r.detached != true && set(r.branch) { return .publish }
        return .nothing
    }

    /// Whether there is anything to do on this repo — the default for whether it starts expanded under "Changes".
    static func hasSomethingToDo(_ r: RepoSituation) -> Bool { primaryButton(r) != .nothing }

    /// What "Synchronize" runs in order (via `…/git/<step>`).
    static func syncSteps(_ r: RepoSituation) -> [String] {
        if !r.remote { return [] }
        if !set(r.upstream) { return r.detached == true || !set(r.branch) ? [] : ["push"] }
        var s: [String] = []
        if count(r.behind) > 0 { s.append("pull") }
        if count(r.ahead) > 0 { s.append("push") }
        return s.isEmpty ? ["fetch"] : s
    }

    // ── Selection in the "Repositories" section ─────────────────────────────────────────────────────────────────────────────────────────
    /// `nil` is the default: "Changes" shows all repos. A tap selects exactly this repo (a second tap on the solely selected one returns
    /// to the default); `addition` (⌘/Ctrl on the desktop) toggles it on or off — always `false` on the phone.
    static func selectRepo(_ selection: [String]?, _ key: String, _ addition: Bool) -> [String]? {
        if !addition { return selection.map { $0.count == 1 && $0[0] == key } == true ? nil : [key] }
        let base = selection ?? []
        let fresh = base.contains(key) ? base.filter { $0 != key } : base + [key]
        return fresh.isEmpty ? nil : fresh
    }

    /// The selection, cleaned of repos that no longer exist — if nothing is left, the default applies.
    static func tidySelection(_ selection: [String]?, _ existing: [String]) -> [String]? {
        guard let selection else { return nil }
        let rest = selection.filter { existing.contains($0) }
        return rest.isEmpty ? nil : rest
    }

    /// The repos "Changes" shows — in tree order, not selection order.
    static func shownRepos<T>(_ repos: [T], _ key: (T) -> String, _ selection: [String]?) -> [T] {
        guard let choice = tidySelection(selection, repos.map(key)) else { return repos }
        return repos.filter { choice.contains(key($0)) }
    }

    /// The graph's repo: the explicit choice, else the first shown one WITH a remote, else the first shown, else the first.
    static func graphRepo(_ existing: [String], _ choice: String?, _ shown: [String], _ withRemote: [String] = []) -> String? {
        if let choice, !choice.isEmpty, existing.contains(choice) { return choice }
        let present = shown.filter { existing.contains($0) }
        return present.first { withRemote.contains($0) } ?? present.first ?? existing.first
    }

    static let GRAPH_REPO_KEY = "cbase-git-graph-repo"

    /// The remembered graph-repo choice: nonsense means "no choice". Length counts in UTF-16 units as in JS.
    static func readGraphChoice(_ raw: String?) -> String? {
        guard let raw, raw.utf16.count > 0, raw.utf16.count < 2048 else { return nil }
        return raw
    }

    static let GRAPH_STEP = 50
    static let GRAPH_MAX = 500

    // ── Collapsed sections ──────────────────────────────────────────────────────────────────────────────────────────────────
    /// One key for all sections, a JSON object `{ id: true }` per COLLAPSED section; nonsense means "all open".
    static let SECTIONS_KEY = "cbase-git-sections-closed"
    static let GIT_SECTIONS = ["repos", "changes", "graph"]

    static func readCollapsed(_ raw: String?) -> Set<String> {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let object) = value else { return [] }
        var out = Set<String>()
        for id in GIT_SECTIONS where object[id] == .bool(true) { out.insert(id) }
        return out
    }

    static func toggleCollapsed(_ closed: Set<String>, _ id: String) -> Set<String> {
        var fresh = closed
        if fresh.contains(id) { fresh.remove(id) } else { fresh.insert(id) }
        return fresh
    }

    /// The form the state is stored in (like `JSON.stringify` of the object on the web, in section order).
    static func writeCollapsed(_ closed: Set<String>) -> String {
        "{" + GIT_SECTIONS.filter(closed.contains).map { "\"\($0)\":true" }.joined(separator: ",") + "}"
    }

    // ── A commit's files (git-files.ts) ──────────────────────────────────────────────────────────────────────────────────────
    /// The kind of a change (lib/api/git.ts GitChange.kind) per letter of `diff-tree --name-status`, with its label.
    static let COMMIT_STATUS_KIND: [String: (kind: String, label: String)] = [
        "M": ("modified", "modified"),
        "A": ("added", "added"),
        "D": ("deleted", "deleted"),
        "R": ("renamed", "renamed"),
        "C": ("renamed", "copied"),
        "T": ("modified", "type changed"),
        "U": ("conflict", "conflict"),
    ]
    static let KIND_LETTER: [String: String] = ["modified": "M", "added": "A", "deleted": "D", "renamed": "R", "untracked": "U", "conflict": "!"]

    struct StatusDisplay: Hashable, Sendable {
        /// The kind (for the color); nil = unknown, muted.
        var kind: String?
        var letter: String
        var label: String
        var deleted: Bool
    }

    static func commitStatusDisplay(_ status: String) -> StatusDisplay {
        guard let a = COMMIT_STATUS_KIND[status] else {
            return StatusDisplay(kind: nil, letter: status.isEmpty ? "?" : status, label: "modified", deleted: false)
        }
        return StatusDisplay(kind: a.kind, letter: KIND_LETTER[a.kind] ?? status, label: a.label, deleted: a.kind == "deleted")
    }

    /// `src/lib/a.ts` → ("a.ts", "src/lib"); at the root without a folder.
    static func partsPath(_ path: String) -> (name: String, folder: String) {
        guard let i = path.lastIndex(of: "/") else { return (path, "") }
        let name = String(path[path.index(after: i)...])
        return (name.isEmpty ? path : name, String(path[..<i]))
    }

    /// The path as `POST …/git/show` takes it with `file`: a file starting with "-" becomes `./-name`.
    static func diffPath(_ path: String) -> String {
        path.hasPrefix("-") ? "./\(path)" : path
    }

    /// A file's symbol: a shortcut in its language's color or a kind with a line symbol.
    struct FileKind: Hashable, Sendable {
        /// "shortcut", "image", "config", "lock", "text", "file".
        var kind: String
        var shortcut: String?
        /// A tone name: blue, yellow, orange, purple, green, red, gray.
        var tone: String
    }

    static let SHORTCUT: [String: (String, String)] = [
        "ts": ("TS", "blue"), "tsx": ("TS", "blue"), "mts": ("TS", "blue"), "cts": ("TS", "blue"),
        "js": ("JS", "yellow"), "jsx": ("JS", "yellow"), "mjs": ("JS", "yellow"), "cjs": ("JS", "yellow"),
        "json": ("{}", "yellow"), "jsonc": ("{}", "yellow"), "json5": ("{}", "yellow"),
        "md": ("M", "blue"), "mdx": ("M", "blue"), "markdown": ("M", "blue"),
        "css": ("#", "purple"), "scss": ("#", "purple"), "sass": ("#", "purple"), "less": ("#", "purple"),
        "html": ("<>", "orange"), "htm": ("<>", "orange"), "xml": ("<>", "orange"), "vue": ("<>", "green"), "svelte": ("<>", "orange"),
        "py": ("PY", "blue"), "go": ("GO", "blue"), "rs": ("RS", "orange"), "swift": ("SW", "orange"), "java": ("JV", "red"), "kt": ("KT", "purple"),
        "rb": ("RB", "red"), "php": ("P", "purple"), "c": ("C", "blue"), "h": ("H", "purple"), "cc": ("C+", "blue"), "cpp": ("C+", "blue"), "hpp": ("H+", "purple"),
        "cs": ("C#", "purple"), "sql": ("SQ", "orange"), "sh": (">_", "green"), "bash": (">_", "green"), "zsh": (">_", "green"), "fish": (">_", "green"),
        "pl": ("PL", "blue"), "lua": ("LU", "blue"),
    ]
    static let IMAGE: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "icns", "avif", "bmp", "tif", "tiff", "heic"]
    static let CONFIG_SUFFIX: Set<String> = ["yml", "yaml", "toml", "ini", "conf", "cfg", "env", "properties", "plist", "entitlements", "xcconfig"]
    static let CONFIG_NAME: Set<String> = ["dockerfile", "makefile", "procfile", ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".dockerignore", ".prettierrc", ".eslintrc"]
    static let LOCK_NAME: Set<String> = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "gemfile.lock", "poetry.lock", "composer.lock", "podfile.lock", "bun.lockb", "go.sum"]
    static let TEXT: Set<String> = ["txt", "log", "csv", "tsv", "rst", "adoc"]

    static func fileKind(_ path: String) -> FileKind {
        let name = partsPath(path).name.lowercased()
        if LOCK_NAME.contains(name) || name.hasSuffix(".lock") { return FileKind(kind: "lock", shortcut: nil, tone: "gray") }
        if CONFIG_NAME.contains(name) || name.hasPrefix(".env") || name.hasPrefix("dockerfile.") { return FileKind(kind: "config", shortcut: nil, tone: "gray") }
        var suffix = ""
        if let point = name.lastIndex(of: "."), point != name.startIndex { suffix = String(name[name.index(after: point)...]) }
        if suffix.isEmpty { return FileKind(kind: "file", shortcut: nil, tone: "gray") }
        if let k = SHORTCUT[suffix] { return FileKind(kind: "shortcut", shortcut: k.0, tone: k.1) }
        if IMAGE.contains(suffix) { return FileKind(kind: "image", shortcut: nil, tone: "purple") }
        if CONFIG_SUFFIX.contains(suffix) { return FileKind(kind: "config", shortcut: nil, tone: "gray") }
        if TEXT.contains(suffix) { return FileKind(kind: "text", shortcut: nil, tone: "gray") }
        return FileKind(kind: "file", shortcut: nil, tone: "gray")
    }

    // ── The graph's answers (lib/api/git.ts, allow-lists) ─────────────────────────────────────────────────────────────────────
    struct GraphEntry: Hashable, Sendable, Identifiable {
        var id: String { hash }
        var hash: String
        var short: String
        var subject: String
        var author: String
        var relative: String
        var parents: [String]?
        var refs: [GitGraph.Ref]
        var head: Bool
        var time: Double?

        var asCommit: GitGraph.Commit { GitGraph.Commit(hash: hash, parents: parents, head: head, refs: refs) }
    }

    struct GraphLog: Hashable, Sendable {
        var commits: [GraphEntry]
        var clipped: Bool?
        var extent: String?
    }

    static let REF_KINDS = ["head", "local", "remote", "tag"]
    static let EXTENTS = ["all", "current"]
    static let COMMIT_STATUS = ["M", "A", "D", "R", "C", "T", "U"]

    private static func text(_ x: JSONValue?) -> String {
        if case .string(let s)? = x { return s }
        return ""
    }

    private static func object(_ x: JSONValue?) -> [String: JSONValue] {
        if case .object(let o)? = x { return o }
        return [:]
    }

    /// A list of non-empty strings — else nil (`every(p => typeof p === "string" && p !== "")`).
    private static func strings(_ x: JSONValue?) -> [String]? {
        guard case .array(let list)? = x else { return nil }
        var out: [String] = []
        for e in list {
            guard case .string(let s) = e, !s.isEmpty else { return nil }
            out.append(s)
        }
        return out
    }

    static func normGitGraphLog(_ raw: JSONValue?) -> GraphLog {
        let o = object(raw)
        var commits: [GraphEntry] = []
        if case .array(let list)? = o["commits"] {
            for e in list {
                guard case .object(let c) = e else { continue }
                let hash = text(c["hash"])
                if hash.isEmpty { continue }
                var refs: [GitGraph.Ref] = []
                if case .array(let rs)? = c["refs"] {
                    for r in rs {
                        guard case .object(let ro) = r, case .string(let name)? = ro["name"], !name.isEmpty,
                              case .string(let kind)? = ro["kind"], REF_KINDS.contains(kind) else { continue }
                        refs.append(GitGraph.Ref(name: name, kind: kind))
                    }
                }
                var time: Double?
                if case .number(let z)? = c["time"], z.isFinite, z > 0 { time = z }
                let short = text(c["short"])
                commits.append(GraphEntry(
                    hash: hash, short: short.isEmpty ? String(hash.prefix(8)) : short, subject: text(c["subject"]),
                    author: text(c["author"]), relative: text(c["relative"]), parents: strings(c["parents"]), refs: refs,
                    head: c["head"] == .bool(true), time: time))
            }
        }
        var clipped: Bool?
        if case .bool(let b)? = o["clipped"] { clipped = b }
        var extent: String?
        if case .string(let u)? = o["extent"], EXTENTS.contains(u) { extent = u }
        return GraphLog(commits: commits, clipped: clipped, extent: extent)
    }

    struct CommitFile: Hashable, Sendable {
        var path: String
        var old: String?
        var status: String
    }

    struct CommitFiles: Hashable, Sendable {
        var hash: String
        /// The parents (full hash), first one first; empty = root commit; nil = the server does not say.
        var parent: [String]?
        var files: [CommitFile]
        /// All changed files; nil = unknown.
        var total: Int?
        var clipped: Bool?
        /// Entries the allow-list could not read — they are missing from `files`, counted instead of silent.
        var unreadable: Int
    }

    /// nil: the server does not know `files` (old version) — "unavailable", never "no files".
    static func normGitCommitFiles(_ raw: JSONValue?) -> CommitFiles? {
        let o = object(raw)
        guard case .array(let list)? = o["files"] else { return nil }
        var files: [CommitFile] = []
        var unreadable = 0
        for e in list {
            let d = object(e)
            let path = text(d["path"])
            guard !path.isEmpty, case .string(let status)? = d["status"], COMMIT_STATUS.contains(status) else { unreadable += 1; continue }
            let old = text(d["old"])
            files.append(CommitFile(path: path, old: old.isEmpty ? nil : old, status: status))
        }
        var total: Int?
        if case .number(let g)? = o["total"], g.isFinite, g == g.rounded(.down), g >= 0, g < 9_007_199_254_740_992 { total = Int(g) }
        var clipped: Bool?
        if case .bool(let b)? = o["clipped"] { clipped = b }
        return CommitFiles(hash: text(o["hash"]), parent: strings(o["parent"]), files: files, total: total,
                             clipped: clipped, unreadable: unreadable)
    }

    struct CommitFileDiff: Hashable, Sendable {
        var hash: String
        var path: String
        var diff: String
        var clipped: Bool?
    }

    /// `path` = the path as requested (`diffPath`). nil: the answer does not belong to this request (an old server sends
    /// the whole commit — which would otherwise show as the file's diff).
    static func normGitCommitFileDiff(_ raw: JSONValue?, _ path: String) -> CommitFileDiff? {
        let o = object(raw)
        guard !path.isEmpty, o["path"] == .string(path), case .string(let diff)? = o["diff"] else { return nil }
        var clipped: Bool?
        if case .bool(let b)? = o["clipped"] { clipped = b }
        return CommitFileDiff(hash: text(o["hash"]), path: path, diff: diff, clipped: clipped)
    }
}
