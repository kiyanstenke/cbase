import CoreGraphics

// Geometry of the workflow canvas: WHERE an edge leaves a node, where it arrives and which
// path it takes in between. Port of web/src/lib/graph-geometry.ts, so that the same graph shows
// the same paths on the iPhone as on the desktop.
//
// The model: nodes without hard-coded outputs have an ordinary dock on the left and on the right.
// Which end is the input and which the output is decided by where the edge is dragged from.
//   · FREE nodes: one dock left, one dock right; each is output (edge dragged out of it) and
//     input (edge dropped on it) at once. The choice is stored in the edge (`fromSide`/`toSide`);
//     without it, out to the right, in from the left. All edges of a dock meet in ONE
//     point (middle of the flank).
//   · FIXED nodes (condition, loop, review — `isFixed`): input one dock on the left, one
//     output per branch on the right in branch order; a stored side is ignored there.
// The calculation only reads the sides and derives none from the neighbors' position. Entry points
// (trigger, start) accept no edge, `end` emits none — the editor decides that.
//
// Pure calculation, deliberately without SwiftUI: everything over CGRect, so that the editor can give start/end a
// different size without anything here knowing.
enum WorkflowGeometry {
    enum Side: String { case left, right }
    /// Flank + position on it (0…1, from the top).
    struct Port: Equatable { var side: Side; var slot: CGFloat }
    /// Fixed output with a mark whether an edge leaves (filled instead of hollow dot).
    struct OutPort: Equatable { var side: Side; var slot: CGFloat; var occupied: Bool }
    /// Per flank: is an edge attached there (in or out)? A free dock is filled as soon as one is.
    struct Docks: Equatable { var left = false; var right = false }

    /// Default size of a node — the same numbers as on the desktop (NODE_W/NODE_H), so that a graph
    /// built there does not drift apart or overlap here. Start and end are a pill
    /// or a flat rectangle (COMPACT_W/COMPACT_H).
    static let nodeSize = CGSize(width: 232, height: 84)
    static let compactSize = CGSize(width: 160, height: 44)
    /// Length of the horizontal stub with which an edge runs out of or into a flank before it
    /// turns. Shorter, and the first corner would sit practically ON the point.
    static let portStub: CGFloat = 24
    /// Distance at which a detour runs around nodes: near enough to visibly belong to the node,
    /// far enough not to touch frame and shadow.
    static let routeGap: CGFloat = 28
    /// From this much horizontal space between two flanks on, an edge runs as a staircase BETWEEN them
    /// (step in the middle). Deliberately small: two cards with only 15 pt of air between them
    /// need a vertical connection, not a detour around one of the cards.
    static let stairMin: CGFloat = 12
    /// This much margin always stays free on a flank: otherwise with many points one would sit in the
    /// card's rounded corner.
    private static let slotMargin: CGFloat = 0.15

    static func isCompact(_ type: WorkflowNodeType) -> Bool { type == .start || type == .end }
    /// Entry points have NO input — the run begins here — and are not a valid edge target.
    static func isEntry(_ type: WorkflowNodeType) -> Bool { type == .trigger || type == .start }
    /// Nodes with fixed, labeled outputs stay rigid — input left, outputs right in
    /// branch order; all others carry one dock on the left and one on the right.
    static func isFixed(_ type: WorkflowNodeType) -> Bool { type == .condition || type == .loop || type == .review }

    static func size(of type: WorkflowNodeType) -> CGSize { isCompact(type) ? compactSize : nodeSize }
    static func rect(of node: WorkflowNode) -> CGRect { CGRect(origin: CGPoint(x: node.x, y: node.y), size: size(of: node.type)) }

    /// Point on a flank with its normal (+1 right, −1 left).
    static func anchorAt(_ r: CGRect, _ side: Side, slot: CGFloat = 0.5) -> (p: CGPoint, nx: CGFloat) {
        switch side {
        case .right: return (CGPoint(x: r.maxX, y: r.minY + r.height * slot), 1)
        case .left: return (CGPoint(x: r.minX, y: r.minY + r.height * slot), -1)
        }
    }

    /// Evenly distributed heights for `count` points on a flank: a single one in the middle,
    /// several symmetrically around it. STRICTLY ascending. From six points on, (k+1)/(count+1) slips into
    /// the margin and is squeezed onto [slotMargin, 1-slotMargin] for ALL points.
    private static func spread(_ count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let n = CGFloat(count)
        let half = 0.5 - 1 / (n + 1)
        let scale = half > 0.5 - slotMargin ? (0.5 - slotMargin) / half : 1
        return (0..<count).map { k in 0.5 + ((CGFloat(k) + 1) / (n + 1) - 0.5) * scale }
    }
    /// Heights for `count` outputs on the right flank of a fixed node.
    static func outSlots(_ count: Int) -> [CGFloat] { spread(count) }

    /// Outputs per kind: condition, loop and review have two labeled ones (right, height from
    /// `WorkflowWiring`), `end` none at all, all others exactly one nameless (`nil`) — it leaves
    /// from the dock that was dragged from.
    static func outPorts(_ type: WorkflowNodeType) -> [WorkflowBranch?] {
        switch type {
        case .condition: return [.yes, .no]
        case .loop: return [.each, .done]
        case .review: return [.ok, .issues]
        case .end: return []
        default: return [nil]
        }
    }
    static func branchKey(_ branch: WorkflowBranch?) -> String { branch?.rawValue ?? "" }

    /// Remove consecutive equal points and intermediate points on a straight run. They
    /// arise when anchors are at the same height — and a zero-length segment at the end would twist the
    /// arrowhead. A U-turn on the same line is kept.
    private static func tidy(_ points: [CGPoint]) -> [CGPoint] {
        func equal(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 1e-6 }
        var out: [CGPoint] = []
        for p in points {
            if let prev = out.last, equal(prev.x, p.x), equal(prev.y, p.y) { continue }
            if out.count >= 2 {
                let prev = out[out.count - 1]
                let pp = out[out.count - 2]
                let verticalContinue = equal(pp.x, prev.x) && equal(prev.x, p.x) && (p.y - prev.y) * (prev.y - pp.y) > 0
                let horizontalContinue = equal(pp.y, prev.y) && equal(prev.y, p.y) && (p.x - prev.x) * (prev.x - pp.x) > 0
                if verticalContinue || horizontalContinue { out.removeLast() }
            }
            out.append(p)
        }
        return out
    }

    /// At what height does a detour run horizontally? In the middle of the vertical gap between the
    /// rectangles (also a narrow one); if they overlap vertically, along below both.
    /// Downward a little above the gap's middle, upward below it — two detours through the same gap
    /// would otherwise merge into ONE line; in a narrow gap the offset shrinks too.
    private static func detourY(_ s: CGRect, _ d: CGRect) -> CGFloat {
        if d.minY >= s.maxY { return (s.maxY + d.minY) / 2 - min(routeGap, d.minY - s.maxY) / 4 }   // d below s
        if s.minY >= d.maxY { return (d.maxY + s.minY) / 2 + min(routeGap, s.minY - d.maxY) / 4 }   // d above s
        return max(s.maxY, d.maxY) + routeGap
    }

    /// Orthogonal polyline from output `from` on `s` to input `to` on `d`. Sharp corners; the
    /// last segment approaches the flank horizontally from outside. `inset` pulls the end point back by
    /// that many points so that the arrowhead ends ON the input point. Three shapes:
    /// staircase (opposite flanks, target in the output direction), bracket (same flank,
    /// cards stacked — a pillar outside past both), otherwise detour.
    static func route(from s: CGRect, _ from: Port, to d: CGRect, _ to: Port, inset: CGFloat = 0) -> [CGPoint] {
        let a = anchorAt(s, from.side, slot: from.slot)
        let b = anchorAt(d, to.side, slot: to.slot)
        let start = a.p
        let end = CGPoint(x: b.p.x + b.nx * inset, y: b.p.y)
        if a.nx != b.nx, (b.p.x - a.p.x) * a.nx >= stairMin {
            if abs(a.p.y - b.p.y) < 0.5 { return [start, end] }
            let midX = (a.p.x + b.p.x) / 2
            return tidy([start, CGPoint(x: midX, y: a.p.y), CGPoint(x: midX, y: b.p.y), end])
        }
        let stacked = s.maxY <= d.minY || d.maxY <= s.minY
        if a.nx == b.nx, stacked {
            let column = a.nx > 0 ? max(a.p.x, b.p.x) + portStub : min(a.p.x, b.p.x) - portStub
            return tidy([start, CGPoint(x: column, y: a.p.y), CGPoint(x: column, y: b.p.y), end])
        }
        let midY = detourY(s, d)
        var x1 = a.p.x + a.nx * portStub
        var x2 = b.p.x + b.nx * portStub
        // Neither pillar may run through the OTHER card (tight neighbors): it then moves
        // onto that card's facing edge.
        func crosses(_ x: CGFloat, _ y0: CGFloat, _ y1: CGFloat, _ r: CGRect) -> Bool {
            x > r.minX && x < r.maxX && max(y0, y1) > r.minY && min(y0, y1) < r.maxY
        }
        if crosses(x1, a.p.y, midY, d) { x1 = a.nx > 0 ? max(a.p.x, d.minX) : min(a.p.x, d.maxX) }
        if crosses(x2, midY, b.p.y, s) { x2 = b.nx > 0 ? max(b.p.x, s.minX) : min(b.p.x, s.maxX) }
        return tidy([start, CGPoint(x: x1, y: a.p.y), CGPoint(x: x1, y: midY), CGPoint(x: x2, y: midY), CGPoint(x: x2, y: b.p.y), end])
    }

    /// Edges that lie on a cycle: `from → to` belongs to it as soon as `to` leads back to `from`.
    /// The editor highlights them. Reachability per edge — the graphs are small.
    static func cycleEdges(_ edges: [(from: String, to: String)]) -> Set<Int> {
        var next: [String: [String]] = [:]
        for e in edges { next[e.from, default: []].append(e.to) }
        var reached: [String: Set<String>] = [:]
        func reach(_ start: String) -> Set<String> {
            if let known = reached[start] { return known }
            var seen: Set<String> = []
            var queue = [start]
            while !queue.isEmpty {
                let cur = queue.removeFirst()
                for t in next[cur] ?? [] where !seen.contains(t) {
                    seen.insert(t)
                    queue.append(t)
                }
            }
            reached[start] = seen
            return seen
        }
        var out: Set<Int> = []
        for (i, e) in edges.enumerated() where reach(e.to).contains(e.from) { out.insert(i) }
        return out
    }
}

/// Connections of all edges of a graph in ONE pass: side and height of every edge end (from
/// the docks stored in the edge), the position of every fixed node's outputs and the occupied
/// docks of every node. A free dock is a point in the middle of its flank; a fixed node's
/// outputs stand on the right one above the other in branch order, its input is a dock on the left.
struct WorkflowWiring {
    typealias Side = WorkflowGeometry.Side
    typealias Port = WorkflowGeometry.Port
    /// Edge index → both ends.
    private(set) var edges: [Int: (from: Port, to: Port)] = [:]
    /// FIXED nodes: node id → branchKey → position of the output (right).
    private(set) var ports: [String: [String: WorkflowGeometry.OutPort]] = [:]
    /// Every node → occupied flanks.
    private(set) var docks: [String: WorkflowGeometry.Docks] = [:]

    /// `rect` supplies a node's rectangle — the editor passes the position INCLUDING a running
    /// drag, so that the edges follow the finger and do not jump only on release.
    /// (The ends do not depend on position; the parameter stays so that the call matches the desktop's
    /// and a later position dependency does not first need a new interface.)
    init(graph: WorkflowGraph, rect: (WorkflowNode) -> CGRect) {
        var types: [String: WorkflowNodeType] = [:]
        for n in graph.nodes {
            types[n.id] = n.type
            docks[n.id] = .init()
            guard WorkflowGeometry.isFixed(n.type) else { continue }
            let branches = WorkflowGeometry.outPorts(n.type)
            let heights = WorkflowGeometry.outSlots(branches.count)
            var own: [String: WorkflowGeometry.OutPort] = [:]
            for (k, b) in branches.enumerated() {
                own[WorkflowGeometry.branchKey(b)] = .init(side: .right, slot: heights[k], occupied: graph.edges.contains { $0.from == n.id && $0.branch == b })
            }
            ports[n.id] = own
        }
        for (i, e) in graph.edges.enumerated() {
            guard let source = types[e.from], let target = types[e.to] else { continue }
            let from: Port
            if WorkflowGeometry.isFixed(source) {
                from = Port(side: .right, slot: ports[e.from]?[WorkflowGeometry.branchKey(e.branch)]?.slot ?? 0.5)
            } else {
                from = Port(side: e.fromSide == "left" ? .left : .right, slot: 0.5)
            }
            let to = Port(side: !WorkflowGeometry.isFixed(target) && e.toSide == "right" ? .right : .left, slot: 0.5)
            if from.side == .left { docks[e.from]?.left = true } else { docks[e.from]?.right = true }
            if to.side == .left { docks[e.to]?.left = true } else { docks[e.to]?.right = true }
            edges[i] = (from, to)
        }
    }
}
