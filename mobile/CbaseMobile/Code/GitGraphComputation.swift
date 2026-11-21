import Foundation

// Lane computation of the graph in the git sheet — the Swift TWIN of web/src/lib/git-graph.ts, line for line.
// Drawing happens in Code/GitGraphSection.swift; the data comes from `POST …/git/log` with `graph` (server git.js gitGraphLog,
// topologically sorted — children before parents), read via `GitBar.normGitGraphLog` (Code/GitBarComputation.swift).
//
// BOUND in web/test/git-bar-ios-binding.test.mjs: the test runs BOTH versions (tsc and `xcrun swift`) over the same cases
// (randomized graphs with merges and tips, linear cases, colors, badges, geometry, "Load more") and compares line by line —
// with built-in sabotage on copies of this file. Hence: ONLY Foundation, no app types, everything under `GitGraph` (the sabotage
// renames the namespace). Whoever changes something here changes it in git-graph.ts too — otherwise the test is red.
//
// What the computation does and where it DEVIATES from VS Code is in the header of git-graph.ts (DECIDED there). Translation traps:
// - FNV-1a over UTF-16 units (`charCodeAt`), not over characters — `utf16`, multiplication with overflow (`&*`, like `Math.imul`).
// - `Math.round` rounds .5 up (+∞), `Math.floor(x) || 1` turns 0 and NaN into 1.
// - `Array.prototype.sort` is stable: equal elements keep their order (here via the index).
// - A JS `Map` with a duplicate key keeps the position of the FIRST entry and the value of the LAST (`badges`).

enum GitGraph {
    /// A lane's color: the accent (HEAD branch) or an index into the palette (0 … LANE_COLORS − 1).
    enum LaneColor: Hashable, Sendable {
        case accent
        case palette(Int)
    }
    static let LANE_COLORS = 5

    struct Ref: Hashable, Sendable {
        var name: String
        var kind: String
    }

    /// What the computation needs from a commit (`GitBar.GraphEntry` supplies it). `parents == nil`: the server names no parents.
    struct Commit: Hashable, Sendable {
        var hash: String
        var parents: [String]?
        var head: Bool
        var refs: [Ref]
    }

    struct Lane: Hashable, Sendable {
        var id: String
        var color: LaneColor
    }

    enum Kind: String, Sendable {
        case head, merge, node
    }

    struct Through: Hashable, Sendable { var from: Int; var to: Int; var color: LaneColor }
    struct Incoming: Hashable, Sendable { var from: Int; var color: LaneColor }
    struct Branching: Hashable, Sendable { var to: Int; var color: LaneColor }

    /// A row: position of the dot and all lines between top edge, dot (middle) and bottom edge.
    struct Row: Hashable, Sendable {
        var column: Int
        var color: LaneColor
        var kind: Kind
        var one: [Lane]
        var outgoing: [Lane]
        /// A lane enters the dot from above (a child is above); its color is that of the incoming lane.
        var top: LaneColor?
        /// The dot continues downwards (first parent) — in its column.
        var bottom: Bool
        /// Lanes passing the dot: from column `from` at the top to column `to` at the bottom.
        var through: [Through]
        /// Further incoming lanes that end in the dot (column ≠ `column`).
        var incoming: [Incoming]
        /// Further parents: from the dot to column `to` at the bottom (column ≠ `column`).
        var branching: [Branching]
    }

    struct Computation: Hashable, Sendable {
        var rows: [Row]
        var width: Int
        var linear: Bool
    }

    // FNV-1a, 32 bit, over UTF-16 units like `charCodeAt`.
    static func fnv(_ s: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for unit in s.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x01000193
        }
        return h
    }

    /// A lane's birth color: from the name, without the colors in `avoid` (if the palette suffices).
    static func laneColorFor(_ name: String, avoid: [LaneColor] = []) -> Int {
        let start = Int(fnv(name) % UInt32(LANE_COLORS))
        for i in 0..<LANE_COLORS {
            let f = (start + i) % LANE_COLORS
            if !avoid.contains(.palette(f)) { return f }
        }
        return start
    }

    static let KIND_RANK: [String: Int] = ["head": 0, "local": 1, "remote": 2, "tag": 3]

    // The name of a new lane at a tip: its branch (local before remote before tag), else the commit. The first ref with the lowest
    // rank (the sort in JS is stable).
    static func tipsName(_ c: Commit) -> String {
        var best: Ref?
        var bestRank = Int.max
        for r in c.refs {
            guard let rank = KIND_RANK[r.kind] else { continue }
            if rank < bestRank { best = r; bestRank = rank }
        }
        guard let r = best else { return c.hash }
        if r.kind == "remote" { return afterTheCut(r.name) }
        return r.name
    }

    /// `name.slice(name.indexOf("/") + 1)` — without "/" the whole name.
    static func afterTheCut(_ name: String) -> String {
        guard let i = name.firstIndex(of: "/") else { return name }
        return String(name[name.index(after: i)...])
    }

    /// The lanes per row. `commits` in the server's order (topological: children before parents).
    static func computeLanes(_ commits: [Commit]) -> Computation {
        let linear = commits.contains { $0.parents == nil }
        var rows: [Row] = []
        var one: [Lane] = []
        var width = 0
        for (i, c) in commits.enumerated() {
            let parent: [String] = linear ? (i + 1 < commits.count ? [commits[i + 1].hash] : []) : (c.parents ?? [])
            let hits = one.firstIndex { $0.id == c.hash }
            let column = hits ?? one.count
            let top: LaneColor? = hits.map { one[$0].color }
            // If several lanes converge in this commit and the accent lane is among them, it continues in the accent.
            let accentIncluded = one.contains { $0.id == c.hash && $0.color == .accent }
            // A new lane avoids its left neighbor's color and that of the lane that stood in its column in the row above.
            let prior: LaneColor? = rows.last.flatMap { z in column < z.one.count ? z.one[column].color : nil }
            let color: LaneColor
            if c.head || accentIncluded {
                color = .accent
            } else if let top {
                color = top
            } else {
                color = .palette(laneColorFor(tipsName(c), avoid: (one.last.map { [$0.color] } ?? []) + (prior.map { [$0] } ?? [])))
            }
            var outgoing: [Lane] = []
            var through: [Through] = []
            var incoming: [Incoming] = []
            for (k, s) in one.enumerated() {
                if s.id == c.hash {
                    if k == column {
                        if let first = parent.first { outgoing.append(Lane(id: first, color: color)) }
                    } else {
                        incoming.append(Incoming(from: k, color: s.color))
                    }
                    continue
                }
                through.append(Through(from: k, to: outgoing.count, color: s.color))
                outgoing.append(s)
            }
            if hits == nil, let first = parent.first { outgoing.append(Lane(id: first, color: color)) }
            var branching: [Branching] = []
            for p in parent.dropFirst() {
                if let present = outgoing.firstIndex(where: { $0.id == p }) {
                    if present != column { branching.append(Branching(to: present, color: outgoing[present].color)) }
                    continue
                }
                // Avoids the dot, the left neighbor, the lanes ending in this dot, and the one that stood in this column above.
                var avoid: [LaneColor] = [color]
                if let left = outgoing.last { avoid.append(left.color) }
                avoid += incoming.map(\.color)
                if outgoing.count < one.count { avoid.append(one[outgoing.count].color) }
                let f = LaneColor.palette(laneColorFor(p, avoid: avoid))
                branching.append(Branching(to: outgoing.count, color: f))
                outgoing.append(Lane(id: p, color: f))
            }
            let kind: Kind = c.head ? .head : parent.count > 1 ? .merge : .node
            rows.append(Row(column: column, color: color, kind: kind, one: one, outgoing: outgoing, top: top, bottom: !parent.isEmpty,
                                through: through, incoming: incoming, branching: branching))
            width = max(width, one.count, outgoing.count, column + 1)
            one = outgoing
        }
        return Computation(rows: rows, width: width, linear: linear)
    }

    // ── An expanded commit: the lanes next to its file rows (see git-graph.ts) ──────────────────────────────────────────
    struct ThroughLane: Hashable, Sendable {
        var column: Int
        var color: LaneColor
        var own: Bool
    }

    static func continuousLanes(_ z: Row) -> [ThroughLane] {
        var outgoing = z.outgoing.enumerated().map { k, s in ThroughLane(column: k, color: s.color, own: z.bottom && k == z.column) }
        if !z.bottom && z.column >= z.outgoing.count { outgoing.append(ThroughLane(column: z.column, color: z.color, own: true)) }
        return outgoing
    }

    // ── Geometry: how wide a lane is, and when it is clipped ────────────────────────────────────────────────────────────────
    static let LANE_PX = 11
    static let LANE_MIN_PX = 6

    struct LaneGeometry: Hashable, Sendable {
        var w: Int
        var clipFrom: Int?
        var columns: Int
    }

    /// `Math.floor(x) || fallback`: 0 and NaN become the fallback.
    private static func floorOr(_ x: Double, _ fallback: Double) -> Double {
        let f = x.rounded(.down)
        return f.isNaN || f == 0 ? fallback : f
    }

    static func laneGeometry(_ width: Double, _ maxPx: Double) -> LaneGeometry {
        let n = max(1, floorOr(width, 1))
        let slot = max(Double(LANE_MIN_PX * 2), floorOr(maxPx, 0))
        if n * Double(LANE_MIN_PX) <= slot {
            let w = max(Double(LANE_MIN_PX), min(Double(LANE_PX), (slot / n).rounded(.down)))
            return LaneGeometry(w: Int(w), clipFrom: nil, columns: Int(n))
        }
        let clipFrom = max(1, (slot / Double(LANE_MIN_PX)).rounded(.down) - 1)
        return LaneGeometry(w: LANE_MIN_PX, clipFrom: Int(clipFrom), columns: Int(clipFrom) + 1)
    }

    /// The most width the graph takes: just under a quarter of the bar, at least 56, at most 132.
    static func graphMaxPx(_ barPx: Double) -> Double {
        let b = barPx.isNaN ? 0 : barPx
        return max(56, min(132, (b * 0.24 + 0.5).rounded(.down)))
    }

    // ── Badges: what sits at the commit ───────────────────────────────────────────────────────────────────────────────────────────
    struct Badge: Hashable, Sendable {
        var name: String
        var kind: String
        var remote: String?
    }

    /// Name ordering like `localeCompare` (locale collation, not byte order).
    static func nameOrdering(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [], range: nil, locale: Locale.current)
    }

    static func badges(_ refs: [Ref]?) -> [Badge] {
        let valid = (refs ?? []).filter { !$0.name.isEmpty && KIND_RANK[$0.kind] != nil }
        // The local ones (head/local) per name: position of the first, value of the last entry (JS Map).
        var outgoing: [Badge] = []
        var place: [String: Int] = [:]
        for r in valid where r.kind == "head" || r.kind == "local" {
            if let i = place[r.name] { outgoing[i] = Badge(name: r.name, kind: r.kind, remote: nil) } else {
                place[r.name] = outgoing.count
                outgoing.append(Badge(name: r.name, kind: r.kind, remote: nil))
            }
        }
        for r in valid {
            if r.kind == "head" || r.kind == "local" { continue }
            if r.kind == "remote", let cut = r.name.firstIndex(of: "/"), cut != r.name.startIndex {
                let localName = String(r.name[r.name.index(after: cut)...])
                if let i = place[localName], outgoing[i].remote == nil {
                    outgoing[i].remote = r.name
                    continue
                }
            }
            outgoing.append(Badge(name: r.name, kind: r.kind, remote: nil))
        }
        return outgoing.enumerated().sorted { x, y in
            let ra = KIND_RANK[x.element.kind] ?? 0, rb = KIND_RANK[y.element.kind] ?? 0
            if ra != rb { return ra < rb }
            let o = nameOrdering(x.element.name, y.element.name)
            if o != .orderedSame { return o == .orderedAscending }
            return x.offset < y.offset
        }.map(\.element)
    }

    // ── "Load more" ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    /// The next limit or nil. The server says via `clipped` whether older ones exist; if it says nothing (nil), the length decides.
    static func loadMore(_ limit: Int, _ loaded: Int, _ clipped: Bool?, _ step: Int, _ max: Int) -> Int? {
        if limit >= max { return nil }
        let maybe = clipped ?? (loaded >= limit)
        return maybe ? min(max, limit + step) : nil
    }

    // ── When to reload, and the choice in the header ──────────────────────────────────────────────────────────────────────────────
    /// A repo's state from the tree (`GET …/git`) on which the graph reloads — no clock of its own.
    static func graphState(hash: String?, branch: String?, detached: Bool?, upstream: String?, ahead: Int?, behind: Int?) -> String {
        [hash ?? "", branch ?? "", detached == true ? "1" : "0", upstream ?? "", String(ahead ?? 0), String(behind ?? 0)]
            .joined(separator: "\u{0}")
    }

    enum Extent: String, Sendable {
        case all, current
    }
    static let GRAPH_EXTENT_KEY = "cbase-git-graph-extent"

    /// The stored choice: only "current" is current, everything else (nothing, nonsense) is the default "all".
    static func readExtent(_ raw: String?) -> Extent {
        raw == "current" ? .current : .all
    }
}
