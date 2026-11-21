import Foundation

// A project's layout as a pure computation: the Swift twin of `web/src/lib/project-layout.ts`. ONE computation, three places (web,
// iOS, server), bound by ONE fixture set `server/backend/test/fixtures/layout-plan/*.json`: `web/test/layout-ios-binding.test.mjs`
// reads this file as a whole, adds a driver and runs it with `xcrun swift` against every case. Hence Foundation ONLY.
//
// Two deliberate differences from Swift habits:
//   - Paths are compared by UTF-16 units (`compare`, `equal`, `beginsWith`), never with `==`/`hasPrefix`/`<` on String: Swift
//     compares canonically equivalent (NFC == NFD), JavaScript does not, so the preview would differ for an NFD name.
//   - Sorting is stable (index as the last key): `Array.sort` is not stable in Swift, it is in JavaScript.
//
// The tree hangs on PARENT REFERENCES (class `Live`), not on path prefixes; the reason is in the head of the TS file.

enum LayoutKind: String, Codable { case file, folder, codeRepo = "code-repo", worktree, clone }

struct LayoutNode: Codable, Equatable {
    var path: String
    var kind: LayoutKind
    var source: Int?
    var origin: String?
    var size: Int?
    /// "Code repo" mark on a normal folder; nil instead of false (like the field being absent on the web).
    var codeRepo: Bool?
}

enum LayoutStep: Equatable {
    case move(from: String, to: String)
    case leaveOut(path: String)
    case codeRepo(path: String)
    case codeRepoFrom(path: String)
}

struct LayoutNotice: Codable, Equatable {
    var code: String
    var path: String?
    var second: String?
    var step: Int?
}

struct LayoutRules: Codable {
    struct Omit: Codable { var folder: [String]; var files: [String] }
    struct Limits: Codable { var depth: Int; var repos: Int; var skip: [String]; var dependencies: [String] }
    struct Names: Codable { var forbidden: [String]; var prefix: String }
    var omit: Omit
    var limits: Limits
    var names: Names
    var reserveBytes: Int?
}

struct MappingEntry: Codable, Equatable {
    var from: String
    var to: String?
    enum CodingKeys: String, CodingKey { case from, to }
    // `nach: null` means "left out" and must be sent as null (a synthesized Encodable would drop the key).
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(from, forKey: .from)
        try c.encode(to, forKey: .to)
    }
}

struct FinalMapping: Codable, Equatable {
    struct Way: Codable, Equatable { var old: String; var fresh: String }
    var ways: [Way] = []
    var gone: [String] = []
    var codeRepos: [String] = []
}

enum LayoutMode: String { case creation, inventory }

struct LayoutPlan {
    var finalTree: [LayoutNode]
    var mapping: [String: [MappingEntry]]
    var finalMapping: FinalMapping
    var codeRepos: [String]
    var repos: [String]
    var error: [LayoutNotice]
    var warnings: [LayoutNotice]
}

enum ProjectLayout {
    // ── Paths ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    static func equal(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    static func beginsWith(_ a: String, _ p: String) -> Bool { a.utf16.starts(with: p.utf16) }
    static func contains(_ a: String, _ c: Character) -> Bool { a.utf16.contains(String(c).utf16.first!) }
    /// -1, 0, 1 by UTF-16 units (like `<` on strings in JavaScript).
    static func compare(_ a: String, _ b: String) -> Int {
        if equal(a, b) { return 0 }
        return a.utf16.lexicographicallyPrecedes(b.utf16) ? -1 : 1
    }
    static func parentOf(_ p: String) -> String {
        guard let i = p.lastIndex(of: "/") else { return "" }
        return String(p[p.startIndex..<i])
    }
    static func nameOf(_ p: String) -> String {
        guard let i = p.lastIndex(of: "/") else { return p }
        return String(p[p.index(after: i)...])
    }
    /// Is `a` below `b` (or equal)? Empty `b` = the root.
    static func under(_ a: String, _ b: String) -> Bool { b.isEmpty || equal(a, b) || beginsWith(a, b + "/") }
    static func connect(_ a: String, _ b: String) -> String { a.isEmpty ? b : (b.isEmpty ? a : "\(a)/\(b)") }
    static func parts(_ p: String) -> [String] { p.components(separatedBy: "/") }

    static func nameError(_ name: String, _ r: LayoutRules) -> String? {
        if name.isEmpty { return "empty" }
        if r.names.forbidden.contains(where: { equal($0, name) }) { return "forbidden" }
        if name.contains("/") || name.contains("\\") { return "slash" }
        if name.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) { return "controlCharacters" }
        if beginsWith(name.lowercased(), r.names.prefix) { return "prefix" }
        // A Swift string holds no lone surrogates, so "not UTF-8" cannot occur here.
        return nil
    }

    static func repoLocationVisible(_ rel: String, _ r: LayoutRules) -> Bool {
        if rel.isEmpty { return true }
        let t = parts(rel)
        if t.count > r.limits.depth { return false }
        return t.allSatisfy { !$0.isEmpty && !$0.hasPrefix(".") && !r.limits.skip.contains($0) }
    }

    static func isBlock(_ a: LayoutKind) -> Bool { a == .codeRepo || a == .worktree || a == .clone }
    static func isRepo(_ k: LayoutNode) -> Bool { isBlock(k.kind) || (k.kind == .folder && k.codeRepo == true) }

    private static let memory = ["CLAUDE.md", "AGENTS.md"]

    /// Stable sort (Swift does not sort stably, JavaScript does).
    static func stable<T>(_ a: [T], _ before: (T, T) -> Int) -> [T] {
        a.enumerated().sorted { x, y in
            let c = before(x.element, y.element)
            return c != 0 ? c < 0 : x.offset < y.offset
        }.map(\.element)
    }

    private final class Live {
        var k: LayoutNode
        let start: String
        var name: String
        var parent: Live?
        var base: String
        var startParent: Live?
        var gone = false
        var newlyMarked = false
        let wasRepo: Bool
        init(_ k: LayoutNode) {
            self.k = k
            start = k.path
            name = ProjectLayout.nameOf(k.path)
            base = ProjectLayout.parentOf(k.path)
            wasRepo = ProjectLayout.isRepo(k)
        }
    }

    private static func byPath(_ a: LayoutNode, _ b: LayoutNode) -> Int {
        let p = compare(a.path, b.path)
        if p != 0 { return p }
        let q = (a.source ?? 0) - (b.source ?? 0)
        if q != 0 { return q < 0 ? -1 : 1 }
        return compare(a.origin ?? "", b.origin ?? "")
    }

    // ── Steps → plan ─────────────────────────────────────────────────────────────────────────────────────────────────────
    static func computePlan(_ tree: [LayoutNode], _ steps: [LayoutStep], _ rules: LayoutRules, _ mode: LayoutMode) -> LayoutPlan {
        let node: [Live] = tree.map { k in
            var n = LayoutNode(path: k.path, kind: k.kind)
            n.source = k.source
            n.origin = k.origin
            n.size = k.size
            if k.kind == .folder && k.codeRepo == true { n.codeRepo = true }
            return Live(n)
        }
        // Initial parents via a table per starting path (UTF-16 keys like `equal`, never String equality); a `filter` per node
        // was quadratic.
        var byStart: [[UInt16]: [Live]] = [:]
        for y in node { byStart[Array(y.start.utf16), default: []].append(y) }
        for x in node where !x.base.isEmpty {
            let candidates = (byStart[Array(x.base.utf16)] ?? []).filter { $0 !== x }
            if let e = candidates.first(where: { $0.k.source == x.k.source }) ?? candidates.first {
                x.parent = e; x.startParent = e; x.base = ""
            }
        }
        func pathOf(_ x: Live) -> String {
            var t: [String] = []
            var y: Live? = x
            var base = ""
            var seen = Set<ObjectIdentifier>()
            while let z = y, !seen.contains(ObjectIdentifier(z)) {
                seen.insert(ObjectIdentifier(z)); t.insert(z.name, at: 0); base = z.base; y = z.parent
            }
            return connect(base, t.joined(separator: "/"))
        }
        func refresh() { for x in node { x.k.path = pathOf(x) } }
        func below(_ x: Live, _ y: Live) -> Bool {
            var e = y.parent
            while let z = e { if z === x { return true }; e = z.parent }
            return false
        }
        var error: [LayoutNotice] = []
        var warnings: [LayoutNotice] = []
        func find(_ p: String) -> Live? { p.isEmpty ? nil : node.first { !$0.gone && equal($0.k.path, p) } }
        func no(_ code: String, _ i: Int, _ path: String) { error.append(LayoutNotice(code: code, path: path, step: i)) }

        for (i, s) in steps.enumerated() {
            switch s {
            case let .move(from, to):
                guard let x = find(from) else { no("STEP_UNKNOWN", i, from); continue }
                if to.isEmpty || equal(to, from) || under(to, from) { no("STEP_INVALID", i, to); continue }
                let ep = parentOf(to)
                var e: Live?
                if !ep.isEmpty {
                    guard let f = find(ep) else { no("STEP_INVALID", i, to); continue }
                    if isBlock(f.k.kind) { no("IN_CODE_REPO", i, to); continue }
                    if f.k.kind != .folder || f === x || below(x, f) { no("STEP_INVALID", i, to); continue }
                    e = f
                }
                x.parent = e
                x.base = ""
                x.name = nameOf(to)
                refresh()
            case let .leaveOut(p):
                guard let x = find(p) else { no("STEP_UNKNOWN", i, p); continue }
                for y in node where y === x || below(x, y) { y.gone = true }
            case let .codeRepo(p):
                guard let x = find(p) else { no("STEP_UNKNOWN", i, p); continue }
                if x.k.kind != .folder || x.k.codeRepo == true { no("STEP_INVALID", i, p); continue }
                x.k.codeRepo = true
                x.newlyMarked = true
            case let .codeRepoFrom(p):
                guard let x = find(p) else { no("STEP_UNKNOWN", i, p); continue }
                // An existing project has no "remove mark" (it would mean deleting `.git`).
                if mode != .creation || x.k.kind != .folder || x.k.codeRepo != true { no("STEP_INVALID", i, p); continue }
                x.k.codeRepo = nil
                x.newlyMarked = false
            }
        }

        // ── The final tree and its rules ──
        let live = node.filter { !$0.gone }
        let end = stable(live.map(\.k), byPath)
        for k in end where parts(k.path).contains(where: { nameError($0, rules) != nil }) {
            error.append(LayoutNotice(code: "NAME_INVALID", path: k.path))
        }
        if end.count > 1 {
            for i in 1..<end.count where equal(end[i].path, end[i - 1].path) && (i < 2 || !equal(end[i - 2].path, end[i].path)) {
                error.append(LayoutNotice(code: "TARGET_DUPLICATE", path: end[i].path))
            }
        }
        // Creation: a folder with no file or block below it is never created: no code repo, warning FOLDER_EMPTY.
        var empty = Set<[UInt16]>()
        if mode == .creation {
            var content = Set<[UInt16]>()
            for k in end where k.kind == .file || isBlock(k.kind) { for p in ancestors(k.path) { content.insert(Array(p.utf16)) } }
            for k in end where k.kind == .folder && !content.contains(Array(k.path.utf16)) { empty.insert(Array(k.path.utf16)) }
        }
        func isEmpty(_ k: LayoutNode) -> Bool { k.kind == .folder && empty.contains(Array(k.path.utf16)) }
        var repos: [String] = []
        for k in end where isRepo(k) && !isEmpty(k) && !(repos.last.map { equal($0, k.path) } ?? false) { repos.append(k.path) }
        for r in repos where !repoLocationVisible(r, rules) { error.append(LayoutNotice(code: "CODE_REPO_LOCATION", path: r)) }
        if repos.count > rules.limits.repos { error.append(LayoutNotice(code: "TOO_MANY_REPOS")) }
        for a in repos { for b in repos where !equal(a, b) && beginsWith(a, b + "/") {
            error.append(LayoutNotice(code: "REPO_IN_REPO", path: a, second: b))
        } }
        // Via the set of block paths and the ancestors from the shortest (= the first block in path order).
        let blockPaths = Set(end.filter { isBlock($0.kind) }.map { Array($0.path.utf16) })
        if !blockPaths.isEmpty {
            for k in end where !isRepo(k) {
                if let p = ancestors(k.path).first(where: { blockPaths.contains(Array($0.utf16)) }) {
                    error.append(LayoutNotice(code: "IN_CODE_REPO", path: k.path, second: p))
                }
            }
        }
        // The starting path per node of the final tree, taken from the `Live` row, not from the path (two nodes can share one).
        let startList = stable(live.map { ($0.k, $0.start) }) { byPath($0.0, $1.0) }.map(\.1)
        for (j, k) in end.enumerated() {
            if k.kind == .folder && k.codeRepo != true && rules.limits.dependencies.contains(nameOf(k.path)) {
                warnings.append(LayoutNotice(code: "DEPENDENCY", path: k.path))
            }
            let start = startList[j]
            if k.kind == .file && memory.contains(nameOf(start)) && !start.contains("/") && k.path.contains("/") {
                warnings.append(LayoutNotice(code: "MEMORY", path: k.path))
            }
        }
        if mode == .inventory && node.filter(\.wasRepo).count == 1 && repos.count >= 2 { warnings.append(LayoutNotice(code: "REPO_SHARED")) }
        for k in end where isEmpty(k) { warnings.append(LayoutNotice(code: "FOLDER_EMPTY", path: k.path)) }

        // ── Mapping (creation) or final mapping (existing project) ──
        var mapping: [String: [MappingEntry]] = [:]
        var finalMapping = FinalMapping()
        for x in node {
            let e = x.startParent
            let ofStart = x.k.origin ?? x.start
            let carriedOver = e.map { connect($0.k.path, nameOf(x.start)) } ?? x.start
            var entry: MappingEntry?
            if x.gone { if e == nil || e?.gone == false { entry = MappingEntry(from: ofStart, to: nil) } }
            else if e == nil || e?.gone == true || !equal(x.k.path, carriedOver) { entry = MappingEntry(from: ofStart, to: x.k.path) }
            if mode == .creation {
                guard let q = x.k.source, x.k.origin != nil else { continue }
                // A top node of a source is ALWAYS there (otherwise `targetOf` would not find its files).
                if entry == nil && e == nil { entry = MappingEntry(from: ofStart, to: x.k.path) }
                if let one = entry { mapping[String(q), default: []].append(one) }
            } else {
                if let one = entry, one.to == nil { finalMapping.gone.append(x.start) }
                else if let one = entry, let fresh = one.to, e != nil || !equal(fresh, x.start) { finalMapping.ways.append(.init(old: x.start, fresh: fresh)) }
                if !x.gone && x.newlyMarked { finalMapping.codeRepos.append(x.k.path) }
            }
        }
        for (q, l) in mapping { mapping[q] = stable(l) { compare($0.from, $1.from) } }
        finalMapping.ways = stable(finalMapping.ways) { compare($0.old, $1.old) }
        finalMapping.gone = stable(finalMapping.gone, compare)
        finalMapping.codeRepos = stable(finalMapping.codeRepos, compare)

        var codeRepos: [String] = []
        for k in end where k.kind == .folder && k.codeRepo == true && !isEmpty(k) && !(codeRepos.last.map { equal($0, k.path) } ?? false) { codeRepos.append(k.path) }
        return LayoutPlan(finalTree: end, mapping: mapping, finalMapping: finalMapping, codeRepos: codeRepos, repos: repos, error: error, warnings: warnings)
    }

    /// A file's target path: the longest matching `von` prefix wins. `.some(nil)` = left out, `nil` = no entry.
    static func targetOf(_ mapping: [MappingEntry], _ origin: String) -> String?? {
        var best: MappingEntry?
        for e in mapping where !e.from.isEmpty && under(origin, e.from) && (best == nil || e.from.utf16.count > best!.from.utf16.count) { best = e }
        guard let b = best else { return nil }
        guard let to = b.to else { return .some(nil) }
        return .some(to + String(origin.utf16.dropFirst(b.from.utf16.count))!)
    }

    // ── The tree from the selection (creation) ──────────────────────────────────────────────────────────────────────────────────
    struct SelectionFile { var rel: String; var size: Int }
    struct Selection { var seq: Int; var kind: String; var name: String; var files: [SelectionFile] }
    struct UploadFile: Codable, Equatable { var origin: String; var rel: String; var size: Int }
    struct SelectionTree {
        var node: [LayoutNode]
        var upload: [String: [UploadFile]]
        var hints: [LayoutNotice]
        var omitted: Int
    }

    static func normal(_ p: String) -> String {
        var s = p.replacingOccurrences(of: "\\", with: "/")
        while s.hasPrefix("/") { s.removeFirst() }
        while s.hasSuffix("/") { s.removeLast() }
        return s.precomposedStringWithCanonicalMapping
    }

    private static func resolve(_ folder: String, _ target: String) -> String? {
        var stack: [String] = []
        for t in parts(connect(folder, target)) {
            if t.isEmpty || t == "." { continue }
            if t == ".." { if stack.isEmpty { return nil }; stack.removeLast(); continue }
            stack.append(t)
        }
        return stack.joined(separator: "/")
    }

    static func freeName(_ name: String, _ occupied: Set<String>, _ isFolder: Bool) -> String {
        if !occupied.contains(name) { return name }
        let point: String.Index? = isFolder ? nil : name.lastIndex(of: ".")
        let withSuffix = point.map { $0 > name.startIndex } ?? false
        let stem = withSuffix ? String(name[..<point!]) : name
        let suffix = withSuffix ? String(name[point!...]) : ""
        var i = 2
        while true {
            let n = "\(stem)-\(i)\(suffix)"
            if !occupied.contains(n) { return n }
            i += 1
        }
    }

    private static func gitParts(_ p: String) -> Int { parts(p).filter { $0 == ".git" }.count }

    /// The real ancestors of a path, shortest first (`a/b/c` → `a`, `a/b`).
    static func ancestors(_ p: String) -> [String] {
        let t = parts(p)
        guard t.count > 1 else { return [] }
        var out: [String] = []
        var q = t[0]
        out.append(q)
        for i in 1..<(t.count - 1) { q += "/" + t[i]; out.append(q) }
        return out
    }

    /// Control characters (C0, DEL, C1): the same class as `nameError` and `CONTROL_CHARACTERS` in the server's `setup/rules.js`.
    static func hasControlCharacters(_ s: String) -> Bool { s.unicodeScalars.contains { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) } }

    static func treeFromSelection(_ sources: [Selection], _ rules: LayoutRules, _ gitFiles: [String: String] = [:]) -> SelectionTree {
        var node: [LayoutNode] = []
        var upload: [String: [UploadFile]] = [:]
        var hints: [LayoutNotice] = []
        var omitted = 0
        var occupied = Set<String>()
        let gitdirPattern = try! NSRegularExpression(pattern: "^gitdir:[ \\t]*(.+?)[ \\t]*$", options: [.anchorsMatchLines])

        for q in sources {
            if q.kind == "clone" {
                // A clone is ONE block without known content: name and location are editable, the content is not (as on the web).
                let n = normal(q.name)
                let free = freeName(n, occupied, true)
                if free != n { hints.append(LayoutNotice(code: "NAME_SUPPLEMENTED", path: free, second: n)) }
                occupied.insert(free)
                upload[String(q.seq)] = []
                node.append(LayoutNode(path: free, kind: .clone, source: q.seq, origin: n))
                continue
            }
            let prefix = q.kind == "folder" ? normal(q.name) : ""
            var files: [UploadFile] = []
            for d in q.files {
                let rel = normal(d.rel)
                if rel.isEmpty { continue }
                let origin = connect(prefix, rel)
                let t = parts(origin)
                let g = t.firstIndex(of: ".git")
                let folderParts = g.map { Array(t[..<$0]) } ?? Array(t.dropLast())
                if folderParts.contains(where: { rules.omit.folder.contains($0) }) || (g == nil && rules.omit.files.contains(t.last!)) {
                    omitted += 1
                    continue
                }
                files.append(UploadFile(origin: origin, rel: rel, size: max(0, d.size)))
            }

            var repoFolder: [String] = []
            for d in files where d.origin.hasSuffix("/.git/HEAD") && gitParts(d.origin) == 1 {
                let o = String(d.origin.dropLast("/.git/HEAD".count))
                if !repoFolder.contains(o) { repoFolder.append(o) }
            }
            func hasUnder(_ p: String) -> Bool { files.contains { beginsWith($0.origin, p + "/") } }
            var liveGitFile: [String] = []
            var totGit = Set<String>()
            for d in files where nameOf(d.origin) == ".git" && gitParts(d.origin) == 1 {
                let folder = parentOf(d.origin)
                let content = gitFiles["\(q.seq):\(d.origin)"] ?? ""
                var target = ""
                if let m = gitdirPattern.firstMatch(in: content, range: NSRange(content.startIndex..., in: content)), let r = Range(m.range(at: 1), in: content) {
                    target = String(content[r])
                }
                let absolute = target.hasPrefix("/") || target.range(of: "^[A-Za-z]:", options: .regularExpression) != nil
                let resolved = !target.isEmpty && !absolute ? resolve(folder, target) : nil
                let zt = resolved.map(parts) ?? []
                var alive = false
                if let a = resolved, let gi = zt.firstIndex(of: ".git"), gi + 1 < zt.count, zt[gi + 1] == "modules" || zt[gi + 1] == "worktrees" {
                    alive = zt.count > gi + 2 && hasUnder(a) && repoFolder.contains(zt[..<gi].joined(separator: "/"))
                }
                if alive { if !liveGitFile.contains(folder) { liveGitFile.append(folder) } }
                else { totGit.insert(d.origin); hints.append(LayoutNotice(code: "GIT_FILE_TOT", path: d.origin)) }
            }
            var candidates: [(String, LayoutKind)] = repoFolder.map { ($0, .codeRepo) }
            candidates += liveGitFile.filter { !repoFolder.contains($0) }.map { ($0, .worktree) }
            candidates = candidates.filter { !$0.0.isEmpty }
            let blocks = candidates.filter { o in !candidates.contains { $0.0 != o.0 && beginsWith(o.0, $0.0 + "/") } }
            func inBlock(_ p: String) -> Bool { blocks.contains { under(p, $0.0) } }
            // A file that does NOT become a node (inside a block, content of a `.git` folder) with a name the server rejects (control
            // characters) is left out with the notice NAME_OMITTED. A Swift string holds no lone surrogates, so the web's second reason
            // (broken UTF-16) cannot occur here.
            var keep: [UploadFile] = []
            for d in files where !totGit.contains(d.origin) {
                let t = parts(d.origin)
                if (t.contains(".git") || inBlock(d.origin)) && t.contains(where: hasControlCharacters) {
                    hints.append(LayoutNotice(code: "NAME_OMITTED", path: d.origin))
                    continue
                }
                keep.append(d)
            }
            omitted += files.count - keep.count
            if keep.isEmpty {
                hints.append(LayoutNotice(code: "SOURCE_EMPTY", path: prefix.isEmpty ? nil : prefix))
                upload[String(q.seq)] = []
                continue
            }
            upload[String(q.seq)] = keep

            var top: [String: String] = [:]
            var topRow: [String] = []
            for d in keep {
                let first = parts(d.origin)[0]
                if top[first] != nil { continue }
                let free = freeName(first, occupied, d.origin.contains("/"))
                if free != first { hints.append(LayoutNotice(code: "NAME_SUPPLEMENTED", path: free, second: first)) }
                top[first] = free
                topRow.append(free)
            }
            for f in topRow { occupied.insert(f) }
            func target(_ h: String) -> String {
                guard let i = h.firstIndex(of: "/") else { return top[h] ?? h }
                let e = String(h[..<i])
                return (top[e] ?? e) + String(h[i...])
            }

            // The size per folder in ONE pass over each file's ancestors.
            var sizeByPath: [[UInt16]: Int] = [:]
            for d in keep { for p in ancestors(d.origin) { sizeByPath[Array(p.utf16), default: 0] += d.size } }
            func sizeUnder(_ p: String) -> Int { sizeByPath[Array(p.utf16)] ?? 0 }

            var folderPaths: [String] = []
            var folderSeen = Set<String>()
            func rememberParent(_ p: String) {
                let t = parts(p)
                if t.count < 2 { return }
                for i in 1..<t.count {
                    let o = t[..<i].joined(separator: "/")
                    if folderSeen.insert(o).inserted { folderPaths.append(o) }
                }
            }
            for (b, kind) in blocks {
                rememberParent(b)
                node.append(LayoutNode(path: target(b), kind: kind, source: q.seq, origin: b, size: sizeUnder(b)))
            }
            for d in keep {
                if inBlock(d.origin) || parts(d.origin).contains(".git") { continue }
                rememberParent(d.origin)
                node.append(LayoutNode(path: target(d.origin), kind: .file, source: q.seq, origin: d.origin, size: d.size))
            }
            for o in folderPaths {
                if inBlock(o) || parts(o).contains(".git") { continue }
                let marker = q.kind == "folder" && o == prefix && !blocks.contains { beginsWith($0.0, o + "/") }
                node.append(LayoutNode(path: target(o), kind: .folder, source: q.seq, origin: o, size: sizeUnder(o), codeRepo: marker ? true : nil))
            }
        }
        node = stable(node) { a, b in
            let q = (a.source ?? 0) - (b.source ?? 0)
            return q != 0 ? (q < 0 ? -1 : 1) : compare(a.path, b.path)
        }
        return SelectionTree(node: node, upload: upload, hints: hints, omitted: omitted)
    }

    // ── What the UI offers per node ─────────────────────────────────────────────────────────────────────────────
    struct Actions { var move: Bool; var rename: Bool; var leaveOut: Bool; var mark: Bool; var unmark: Bool }

    static func actionsFor(_ k: LayoutNode, _ finalTree: [LayoutNode], _ mode: LayoutMode, onlyView: Bool = false) -> Actions {
        if onlyView { return Actions(move: false, rename: false, leaveOut: false, mark: false, unmark: false) }
        let folder = k.kind == .folder
        let repoInside = finalTree.contains { $0 != k && isRepo($0) && beginsWith($0.path, k.path + "/") }
        let repoAbove = finalTree.contains { $0 != k && isRepo($0) && beginsWith(k.path, $0.path + "/") }
        return Actions(
            // A clone is left out via its source, not via the layout (as on the web).
            move: true, rename: true, leaveOut: k.kind != .clone,
            mark: folder && k.codeRepo != true && !repoInside && !repoAbove,
            unmark: mode == .creation && folder && k.codeRepo == true
        )
    }

    /// The folders `k` may be moved into: the root ("") and every normal folder except `k`, its inside and its current parent folder.
    static func targetsFor(_ k: LayoutNode, _ finalTree: [LayoutNode]) -> [String] {
        let now = parentOf(k.path)
        var targets: [String] = now.isEmpty ? [] : [""]
        for x in finalTree where x.kind == .folder && !under(x.path, k.path) && !equal(x.path, now) {
            if finalTree.contains(where: { isBlock($0.kind) && beginsWith(x.path, $0.path + "/") }) { continue }
            if !targets.contains(where: { equal($0, x.path) }) { targets.append(x.path) }
        }
        return targets
    }
}
