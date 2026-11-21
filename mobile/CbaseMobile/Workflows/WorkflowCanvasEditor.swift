import SwiftUI
import UIKit

// ── Canvas editor ───────────────────────────────────────────────────────────
// Full surface, because a graph on a phone needs every point of space.
//
// Interaction (deliberately different from the desktop, where things are dragged):
//  • Moving a step: PRESS AND HOLD, then drag (a UIKit detector on the surface; the scroll view's
//    pan waits for it to fail) — without this separation the pan would take every drag for itself.
//    The surface itself extends beyond the graph on all sides, also into the negative:
//    desktop graphs live there (see `surface`).
//  • Connecting: tap a dock ("Tap the target"), then tap the target step — its left half
//    for the left dock, its right half for the right one (always left on fixed nodes).
//    Hitting a hairline with a finger is unreasonable on a 6-inch screen.
//  • Moving the surface: normal scrolling, even if the swipe starts on a card.
//
// Docks as on the desktop: free nodes carry one dock on the left and one on the right. The dock an edge
// was dragged from is its output; the one it was dropped on is its input — the choice is stored in
// the edge (`fromSide`/`toSide`). Fixed nodes (condition, loop, review) stay rigid: input on the left,
// labeled outputs on the right. Entry points (trigger, start) accept no edge, `end` emits none.
// Edges are orthogonal with sharp corners. Everything is calculated in WorkflowGeometry.swift
// (port of web/src/lib/graph-geometry.ts, checked number by number against the original) — this
// file only says HOW it is drawn.
struct WorkflowCanvasEditor: View {
    let client: APIClient
    let base: String
    /// Workspace and (for a project workflow) project — the step sheet uses them to fetch the
    /// effective skills for its slash picker.
    let workspaceId: String
    let projectId: String?
    let detail: WorkflowDetail
    /// Closes the editor. It is a UIKit fullscreen (see `WorkflowEditorPresentation`) — SwiftUI's
    /// `dismiss` does not know this presentation.
    let close: () -> Void
    var onSaved: () -> Void

    @State private var name: String
    @State private var description: String
    @State private var graph: WorkflowGraph
    @State private var problems: [WorkflowProblem]
    // Run settings (provider, model, permissions, effort, ultracode, check model, compaction,
    // checks, caps) and concurrency — edited in the settings sheet
    // (WorkflowSettings.swift), saved WITH the graph.
    @State private var run: WorkflowRunSettings
    @State private var lock: WorkflowLock
    /// The state of name, description, `run` and `lock` at load or last save. Any
    /// deviation makes the editor "unsaved" — via `onChange`, not via "Done" in the
    /// sheet (a sheet closed by swiping would otherwise leave the change unnoticed).
    @State private var savedMeta: MetaState
    // Trigger state from the server — `detail` is `let` and is not replaced after saving.
    @State private var active: Bool
    @State private var triggers: [WorkflowTriggerView]
    @State private var holding: [WorkflowHolding]
    @State private var armError = ""
    @State private var dirty = false
    @State private var saving = false
    @State private var error = ""
    @State private var selected: WorkflowNode?
    /// Connecting in progress: source, branch and the dock that was tapped (on the right for fixed nodes).
    @State private var linkFrom: (node: String, branch: WorkflowBranch?, side: WorkflowGeometry.Side)?
    @State private var showingMeta = false
    @State private var confirmingClose = false
    // The UIKit wire to scroll view and drawing surface. As `@State`, not `@StateObject`: the
    // editor must NOT observe its changes (the zoom level, every frame) — only the
    // percent label does. Otherwise every pinch frame would rebuild the whole surface.
    @State private var control = WorkflowCanvasControl()
    // Landscape (compact height): navigation and tool bars together cost about
    // 110 of the 402 pt there. Both become narrow capsules floating over the surface — the
    // graph runs underneath.
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var landscape: Bool { verticalSizeClass == .compact }
    // For the badge images of the "Step" menu: the image is rendered without a window and must receive scheme
    // and pixel density of the editor — the fullscreen controller carries the scheme as an override.
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    init(client: APIClient, base: String, workspaceId: String, projectId: String?, detail: WorkflowDetail, close: @escaping () -> Void, onSaved: @escaping () -> Void) {
        self.client = client
        self.base = base
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.detail = detail
        self.close = close
        self.onSaved = onSaved
        _name = State(initialValue: detail.name)
        _description = State(initialValue: detail.description)
        _run = State(initialValue: detail.run)
        _lock = State(initialValue: detail.lock)
        _savedMeta = State(initialValue: MetaState(name: detail.name, description: detail.description, run: detail.run, lock: detail.lock))
        _active = State(initialValue: detail.active)
        _triggers = State(initialValue: detail.triggers)
        _holding = State(initialValue: detail.holding)
        // An empty workflow gets its start immediately — otherwise one faces a blank
        // surface and does not know where the flow begins.
        let initial = detail.graph.nodes.isEmpty
            ? WorkflowGraph(nodes: [WorkflowNode(id: "start", type: .start, title: L("Start##noun"), x: 40, y: 120)], edges: [])
            : detail.graph
        _graph = State(initialValue: initial)
        _problems = State(initialValue: detail.problems)
        _dirty = State(initialValue: detail.graph.nodes.isEmpty)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                InlineError(message: error)
                    .padding(.horizontal, 12)
                if let link = linkFrom {
                    linkBanner(link)
                }
                canvas
                    .overlay(alignment: .top) { if landscape { landscapeHeader } }
                    .overlay(alignment: .bottom) { if landscape { landscapeFootnote } }
                if !landscape { toolbar }
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(landscape ? .hidden : .visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L("Done")) {
                        if dirty { confirmingClose = true } else { close() }
                    }
                        .accessibilityIdentifier("workflow-close")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingMeta = true
                    } label: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityIdentifier("workflow-meta")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? L("Saving…") : L("Save")) { Task { await save() } }
                        .disabled(!dirty || saving)
                        .accessibilityIdentifier("workflow-save")
                }
            }
            .sheet(item: $selected) { node in
                WorkflowNodeSheet(
                    node: node,
                    outgoing: graph.edges.filter { $0.from == node.id },
                    nodeName: { id in graph.nodes.first { $0.id == id }?.title ?? id },
                    client: client,
                    workspaceId: workspaceId,
                    projectId: projectId,
                    inCycle: cycleNodes.contains(node.id),
                    capPlaceholder: capPlaceholder(node),
                    roundsInheritedContinue: roundsInheritedContinue(node),
                    rule: run.rule,
                    limits: detail.limits,
                    onChange: { updated in
                        if let i = graph.nodes.firstIndex(where: { $0.id == updated.id }) {
                            graph.nodes[i] = updated
                            dirty = true
                        }
                    },
                    onRemoveEdge: { edge in
                        graph.edges.removeAll { $0.id == edge.id }
                        dirty = true
                    },
                    onDelete: {
                        graph.nodes.removeAll { $0.id == node.id }
                        graph.edges.removeAll { $0.from == node.id || $0.to == node.id }
                        dirty = true
                        selected = nil
                    }
                )
                .cbSheet(.whole)
            }
            .sheet(isPresented: $showingMeta) {
                WorkflowSettings(
                    client: client, name: $name, description: $description, run: $run, lock: $lock,
                    problems: problems,
                    steps: WorkflowRules.steps(graph.nodes.map(\.type.rawValue)),
                    limits: detail.limits, holding: holding,
                    active: active, triggerNode: graph.nodes.filter { $0.type == .trigger }, triggerState: triggers,
                    saves: saving, armError: armError,
                    arm: { on in Task { await save(active: on) } },
                    openNode: { id in
                        showingMeta = false
                        // Only after closing: SwiftUI does not present two sheets at once.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                            selected = graph.nodes.first { $0.id == id }
                        }
                    }
                )
                .cbSheet(.whole)
            }
            .onChange(of: metaState) { _, fresh in
                if fresh != savedMeta { dirty = true }
            }
            .confirmationDialog(
                L("Discard unsaved changes?"),
                isPresented: $confirmingClose,
                titleVisibility: .visible
            ) {
                Button(L("Dismiss"), role: .destructive) { close() }
                Button(L("Cancel"), role: .cancel) {}
            }
        }
    }

    // ── Surface ──
    /// Margin around the graph in world pt: how far one can scroll past the outermost step,
    /// and how far a step can move outward without the surface growing.
    private static let margin: CGFloat = 320

    /// The surface in WORLD coordinates. It wraps all steps and also begins in the negative
    /// when the graph lies there: on the desktop the camera is free, steps left of or above
    /// (0,0) are normal there — real desktop workflows begin at x = −1104, y = −280.
    /// A surface starting at (0,0) would cut them off, and "scroll further" would not work
    /// because the scroll view had nothing there. Never smaller than 1000 × 700, so that a
    /// single start does not sit on a postage stamp.
    private var surface: CGRect {
        guard let first = graph.nodes.first else { return CGRect(x: 0, y: 0, width: 1000, height: 700) }
        let union = graph.nodes.dropFirst().reduce(WorkflowGeometry.rect(of: first)) { $0.union(WorkflowGeometry.rect(of: $1)) }
        var r = union.insetBy(dx: -Self.margin, dy: -Self.margin)
        r.size.width = max(1000, r.width)
        r.size.height = max(700, r.height)
        return r
    }
    /// The graph with some air, in SURFACE coordinates — the target of "Fit all" and the
    /// anchor around which small content is centered.
    private func graphBounds(in surface: CGRect) -> CGRect? {
        guard let first = graph.nodes.first else { return nil }
        let union = graph.nodes.dropFirst().reduce(WorkflowGeometry.rect(of: first)) { $0.union(WorkflowGeometry.rect(of: $1)) }
        return union.insetBy(dx: -56, dy: -56).offsetBy(dx: -surface.minX, dy: -surface.minY)
    }

    /// Edges as polylines in SURFACE coordinates. `rectOf` supplies a node's rectangle —
    /// while moving the position under the finger, otherwise the graph's. ONE calculation for the
    /// SwiftUI body and the controller's live path, so both ways give the same lines.
    /// Orthogonal with sharp corners; `inset` = radius of the input point, so that the tip ends ON
    /// the point instead of under the card. Edges on a cycle carry the mark `loop` —
    /// the surface highlights them.
    private static func edgeList(graph: WorkflowGraph, surface: CGRect, rectOf: (WorkflowNode) -> CGRect) -> [WorkflowEdgePath] {
        let wiring = WorkflowWiring(graph: graph, rect: rectOf)
        let loops = WorkflowGeometry.cycleEdges(graph.edges.map { (from: $0.from, to: $0.to) })
        let nodesById = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return graph.edges.enumerated().compactMap { i, edge -> WorkflowEdgePath? in
            guard let from = nodesById[edge.from], let to = nodesById[edge.to], let ends = wiring.edges[i] else { return nil }
            let points = WorkflowGeometry.route(
                from: rectOf(from), ends.from,
                to: rectOf(to), ends.to,
                inset: WorkflowGeometry.isCompact(to.type) ? 4 : 5
            )
            guard points.count >= 2 else { return nil }
            return WorkflowEdgePath(points: points.map { CGPoint(x: $0.x - surface.minX, y: $0.y - surface.minY) }, loop: loops.contains(i))
        }
    }

    private var canvas: some View {
        let surface = self.surface
        let graph = self.graph
        // Connections of all edges in ONE pass — the same calculation as in `edgeList`, here for
        // the points on the cards.
        let wiring = WorkflowWiring(graph: graph, rect: WorkflowGeometry.rect(of:))
        return WorkflowZoomScrollView(
            surface: surface,
            fitRect: graphBounds(in: surface),
            control: control,
            // Picking up: the topmost card under the finger (surface coordinates) — the last in the
            // array lies on top in the ZStack.
            hitCard: { p in
                graph.nodes.last { WorkflowGeometry.rect(of: $0).offsetBy(dx: -surface.minX, dy: -surface.minY).contains(p) }?.id
            },
            rasterized: { id, offset in
                guard let node = graph.nodes.first(where: { $0.id == id }) else { return offset }
                let target = Self.targetSituation(node, offset: offset)
                return CGSize(width: target.x - node.x, height: target.y - node.y)
            },
            deposit: { id, offset in
                guard let node = graph.nodes.first(where: { $0.id == id }) else { return }
                move(id, to: Self.targetSituation(node, offset: offset))
            }
        ) {
            ZStack(alignment: .topLeading) {
                // Grid and edges lie as UIKit layers under the cards (WorkflowSurface):
                // a SwiftUI `Canvas` draws only the section it considers visible, and under the
                // scroll view's zoom transform that one is wrong — at 40 % edges and points were missing
                // outside a window of about 500 × 470 world pt, and after scrolling the window moved with the content.
                WorkflowSurface(
                    control: control,
                    edges: Self.edgeList(graph: graph, surface: surface, rectOf: WorkflowGeometry.rect(of:)),
                    // Live path while moving: the same edges, only the picked-up step at
                    // the position under the finger — straight into the layers, without a SwiftUI render.
                    edgesWithShift: { id, offset in
                        Self.edgeList(graph: graph, surface: surface) { n in
                            var r = WorkflowGeometry.rect(of: n)
                            if n.id == id { r.origin.x += offset.width; r.origin.y += offset.height }
                            return r
                        }
                    }
                )
                .frame(width: surface.width, height: surface.height)

                ForEach(graph.nodes) { node in
                    let r = WorkflowGeometry.rect(of: node)
                    WorkflowNodeCard(
                        node: node,
                        wiring: wiring,
                        // Entry points are no target: when connecting they get neither an accent frame
                        // nor an edge.
                        armed: linkFrom != nil && linkFrom?.node != node.id && !WorkflowGeometry.isEntry(node.type),
                        isSelected: selected?.id == node.id,
                        check: WorkflowRules.checksEffective(node.ruleNode, run.rule)
                            ? (node.doneMode == .inherit ? .inherited : .own) : .no,
                        control: control,
                        onTap: { side in type(node, side) },
                        onPort: { branch, side in linkFrom = (node.id, branch, side) }
                    )
                    .position(x: r.midX - surface.minX, y: r.midY - surface.minY)
                }
            }
            .frame(width: surface.width, height: surface.height)
        }
        // The ground under the cards (`CbColor.ground` ↔ card `CbColor.surface`): this way the cards stand out from the surface in
        // BOTH designs.
        .background(CbColor.ground)
        .accessibilityIdentifier("workflow-canvas")
    }

    /// `side`: the half of the card that was tapped — when connecting, the dock where the
    /// edge arrives (always left on fixed nodes, where there is only the one input).
    private func type(_ node: WorkflowNode, _ side: WorkflowGeometry.Side) {
        if let link = linkFrom, link.node != node.id {
            // An entry point accepts no edge — the tap lapses, the banner stays.
            guard !WorkflowGeometry.isEntry(node.type) else { return }
            connect(from: link.node, to: node.id, branch: link.branch, fromSide: link.side, toSide: WorkflowGeometry.isFixed(node.type) ? .left : side)
            linkFrom = nil
        } else {
            selected = node
        }
    }

    /// Grid as on the desktop (GRID = 8): the POSITION snaps, not the distance — a card that stood
    /// off the grid lands on it at the first move. `weg` in world pt.
    private static let raster: CGFloat = 8
    private static func targetSituation(_ node: WorkflowNode, offset: CGSize) -> CGPoint {
        CGPoint(
            x: ((node.x + offset.width) / raster).rounded() * raster,
            y: ((node.y + offset.height) / raster).rounded() * raster
        )
    }

    /// Release after moving: the card already has its position on the grid, here it is taken into the
    /// graph. Only a REAL movement makes the workflow unsaved — a long
    /// press without dragging also arrives here.
    private func move(_ id: String, to situation: CGPoint) {
        guard let i = graph.nodes.firstIndex(where: { $0.id == id }),
              graph.nodes[i].x != situation.x || graph.nodes[i].y != situation.y else { return }
        graph.nodes[i].x = situation.x
        graph.nodes[i].y = situation.y
        dirty = true
    }

    private func linkBanner(_ link: (node: String, branch: WorkflowBranch?, side: WorkflowGeometry.Side)) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.turn.down.right")
            Text(L("Tap the target — connection from “{name}”", ["name": graph.nodes.first { $0.id == link.node }?.title ?? ""]))
                .font(.caption)
                .lineLimit(1)
            Spacer()
            Button(L("Cancel")) { linkFrom = nil }
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.14))
        .accessibilityIdentifier("workflow-link-banner")
    }

    // The step kinds of the "Step" menu — ONE content for the bar in portrait and the capsule
    // in landscape. Without .trigger: setting up a trigger needs an account, project search and
    // event list — that stays on the desktop. Existing triggers are shown here.
    // In front of the name stands the card's badge, as an image: a menu item takes no view
    // (see `WorkflowBadgeImages`). The text stays the item's accessible name.
    @ViewBuilder
    private var stepMenu: some View {
        ForEach([WorkflowNodeType.instruction, .condition, .loop, .parallel, .ask, .review, .end], id: \.self) { type in
            Button {
                addNode(type)
            } label: {
                if let image = WorkflowBadgeImages.image(type, scheme: colorScheme, scale: displayScale) {
                    Label { Text(L(type.displayLabel)) } icon: { Image(uiImage: image).renderingMode(.original) }
                } else {
                    Label(L(type.displayLabel), systemImage: type.symbol)
                }
            }
        }
    }

    // Zoom control: −, level, +, fit — the same four buttons in both orientations. They talk to
    // the scroll view directly; the editor does not know the zoom level.
    @ViewBuilder
    private var zoomButtons: some View {
        Button { control.zoomStep(-0.2) } label: { Image(systemName: "minus.magnifyingglass") }
            .accessibilityIdentifier("workflow-zoom-out")
        WorkflowZoomLabel(control: control)
        Button { control.zoomStep(0.2) } label: { Image(systemName: "plus.magnifyingglass") }
            .accessibilityIdentifier("workflow-zoom-in")
        Button { control.fit() } label: { Image(systemName: "arrow.down.right.and.arrow.up.left") }
            .accessibilityLabel(L("Fit to view"))
            .accessibilityIdentifier("workflow-zoom-fit")
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Menu {
                stepMenu
            } label: {
                Label(L("Step"), systemImage: "plus")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.accentColor, in: Capsule())
                    .foregroundStyle(.white)
            }
            .accessibilityIdentifier("workflow-add")

            Spacer()

            zoomButtons
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    // ── Landscape: floating capsules instead of two bars ──
    // Header: Done · title · info · save. The same three actions as in the (hidden there)
    // navigation bar, with the same identifiers — only one version per orientation is in the tree.
    private var landscapeHeader: some View {
        HStack(spacing: 8) {
            Button(L("Done")) {
                if dirty { confirmingClose = true } else { close() }
            }
            .buttonStyle(FloatingCapsule())
            .accessibilityIdentifier("workflow-close")
            Spacer(minLength: 0)
            Text(name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button {
                showingMeta = true
            } label: {
                Image(systemName: "info.circle")
            }
            .buttonStyle(FloatingCapsule())
            .accessibilityIdentifier("workflow-meta")
            Button(saving ? L("Saving…") : L("Save")) { Task { await save() } }
                .buttonStyle(FloatingCapsule(emphasized: dirty && !saving))
                .disabled(!dirty || saving)
                .accessibilityIdentifier("workflow-save")
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
    }

    // Footer: "Step" on the left, the zoom capsule on the right — as on the desktop, where the zoom capsule sits at the bottom
    // right over the surface.
    private var landscapeFootnote: some View {
        HStack {
            Menu {
                stepMenu
            } label: {
                Label(L("Step"), systemImage: "plus")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 11)
                    .padding(.vertical, 6)
                    .background(Color.accentColor, in: Capsule())
                    .foregroundStyle(.white)
            }
            .accessibilityIdentifier("workflow-add")
            Spacer()
            HStack(spacing: 10) {
                zoomButtons
            }
            .cbFont(15)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(CbColor.edge, lineWidth: 0.5))
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private func addNode(_ type: WorkflowNodeType) {
        // New steps line up to the right of the outermost one so far — not on top of each other.
        // Calculated from the right EDGE, because start/end are narrower than a step.
        let x = (graph.nodes.map { WorkflowGeometry.rect(of: $0).maxX }.max() ?? 0) + 72
        let y = graph.nodes.last?.y ?? 120
        // A review WITHOUT a notification would be a trap: the run stands still until someone looks in.
        let node = WorkflowNode(id: "n\(UUID().uuidString.prefix(8))", type: type, title: L(type.displayLabel), x: x, y: y, notify: type == .review)
        graph.nodes.append(node)
        dirty = true
        // After the immediately opened sheet closes, the new step should be in view
        // and not stand unnoticed outside the display on the right. Fitting happens only
        // after the render that knows the new step (see controller).
        control.fitAfterRender()
        selected = node
    }

    /// `fromSide`/`toSide` = the docks from the gesture. On fixed nodes the field stays empty: there
    /// is only out to the right and in from the left, and `WorkflowWiring` would ignore the value anyway.
    private func connect(from: String, to: String, branch: WorkflowBranch?, fromSide: WorkflowGeometry.Side, toSide: WorkflowGeometry.Side) {
        guard from != to else { return }
        let source = graph.nodes.first { $0.id == from }
        // Entry points (trigger, start) have no input — no edge arrives there.
        if let target = graph.nodes.first(where: { $0.id == to }), WorkflowGeometry.isEntry(target.type) { return }
        // Only ONE edge per branch — except for "parallel", where several branches are the point.
        if source?.type == .parallel {
            graph.edges.removeAll { $0.from == from && $0.to == to }
        } else {
            graph.edges.removeAll { $0.from == from && $0.branch == branch }
        }
        let target = graph.nodes.first { $0.id == to }
        graph.edges.append(WorkflowEdge(
            from: from, to: to, branch: branch,
            fromSide: source.map { WorkflowGeometry.isFixed($0.type) } == true ? nil : fromSide.rawValue,
            toSide: target.map { WorkflowGeometry.isFixed($0.type) } == true ? nil : toSide.rawValue
        ))
        dirty = true
    }

    // ── Round cap: only on a cycle, labeled with the effective value ──
    /// Steps that lie on a cycle (an edge leads back) — the endpoints of the
    /// cycle edges from `WorkflowGeometry.cycleEdges`. Only there does the sheet show the round cap:
    /// off a cycle it never takes effect (the counter runs fresh per loop iteration).
    private var cycleNodes: Set<String> {
        let edgeList = graph.edges.map { (from: $0.from, to: $0.to) }
        var out: Set<String> = []
        for i in WorkflowGeometry.cycleEdges(edgeList) {
            out.insert(edgeList[i].from)
            out.insert(edgeList[i].to)
        }
        return out
    }

    /// The nodes and edges of the editor graph as `WorkflowRules` calculates them.
    private var ruleNode: [WorkflowRules.Node] { graph.nodes.map(\.ruleNode) }
    private var ruleEdges: [WorkflowRules.Edge] { graph.edges.map { WorkflowRules.Edge(from: $0.from, to: $0.to) } }

    /// Label of the stepper at value 0 ("5 · Default" / "20 · from Review") — from
    /// `WorkflowRules.capEffective`, the mirror of `effectiveCaps` (web/src/lib/workflow-node-form.ts)
    /// and `effectiveCap` (workflows.js), calculated WITHOUT an own value: the label applies to value
    /// 0, and on a cycle it would otherwise read "7 · from <own title>" as soon as one steps to 0 in the sheet.
    /// Bound by web/test/cap-binding.test.mjs.
    private func capPlaceholder(_ node: WorkflowNode) -> String {
        let nodes = ruleNode.map { k in k.id == node.id ? WorkflowRules.Node(id: k.id, type: k.type, title: k.title, maxVisits: 0, doneMode: k.doneMode, doneCapMode: k.doneCapMode, loopCapMode: k.loopCapMode) : k }
        let d = WorkflowRules.capEffective(nodes, ruleEdges, fallback: detail.limits.maxVisits, wf: run.rule)[node.id]
        guard let d, !d.from.isEmpty else {
            return L("{n} · default", ["n": String(detail.limits.maxVisits)])
        }
        return L("{n} · from {from}", ["n": String(d.cap), "from": d.from])
    }

    /// What "Like workflow" means for this step's round cap: the effective value if the
    /// step chooses nothing itself (cycle neighbors included).
    private func roundsInheritedContinue(_ node: WorkflowNode) -> Bool {
        let nodes = ruleNode.map { k in k.id == node.id ? WorkflowRules.Node(id: k.id, type: k.type, title: k.title, maxVisits: k.maxVisits, doneMode: k.doneMode, doneCapMode: k.doneCapMode, loopCapMode: .inherit) : k }
        return WorkflowRules.capEffective(nodes, ruleEdges, fallback: detail.limits.maxVisits, wf: run.rule)[node.id]?.auto ?? run.loopCapAuto
    }

    /// Name, description, `run` and `lock` — what the settings sheet changes.
    private var metaState: MetaState { MetaState(name: name, description: description, run: run, lock: lock) }

    /// Saves the whole state — like the web: name, description, graph, `lock` and `run`, when
    /// arming also `active` (the server checks the trigger and sets the waterline to
    /// NOW; without `active` the switch stays as it is — a missing key means
    /// "unchanged", and the synthesized Encodable leaves `nil` out).
    private func save(active activate: Bool? = nil) async {
        struct Body: Encodable {
            let name: String
            let description: String
            let graph: WorkflowGraph
            let lock: WorkflowLock
            let run: WorkflowRunSettings
            let active: Bool?
        }
        saving = true
        defer { saving = false }
        do {
            let saved: WorkflowDetail = try await client.put(
                "\(base)/\(detail.id)",
                body: Body(name: name.trimmingCharacters(in: .whitespacesAndNewlines), description: description, graph: graph, lock: lock, run: run, active: activate)
            )
            // First the comparison state, then the fields: this way `onChange(metaState)` sees the new
            // state equal to the saved one and does not set the mark again.
            savedMeta = MetaState(name: name, description: description, run: saved.run, lock: saved.lock)
            graph = saved.graph
            problems = saved.problems
            run = saved.run
            lock = saved.lock
            active = saved.active
            triggers = saved.triggers
            holding = saved.holding
            dirty = false
            error = ""
            armError = ""
            onSaved()
        } catch {
            if activate != nil { armError = error.localizedDescription }
            self.error = error.localizedDescription
        }
    }
}

/// What the settings sheet changes — compared with the saved state (`dirty`).
private struct MetaState: Equatable {
    var name: String
    var description: String
    var run: WorkflowRunSettings
    var lock: WorkflowLock
}

/// The "checks" checkmark on the card: not at all, inherited from the workflow (dimmed), explicitly on the node.
enum WorkflowCardsCheck: Equatable {
    case no, inherited, own
}

// Percent label of the zoom capsule — the ONLY view that observes the zoom level. That is why it stands
// on its own: the editor itself does not know the level and rebuilds nothing when pinching.
private struct WorkflowZoomLabel: View {
    @ObservedObject var control: WorkflowCanvasControl

    var body: some View {
        Text("\(Int((control.zoom * 100).rounded()))%")
            .cbFont(11, design: .monospaced)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("workflow-zoom-label")
    }
}

// ── Card of a step ──
// A view of its own, so that moving is CHEAP: the position under the finger is a `@State`
// of this card, which the controller sets every frame — only IT is rebuilt, not the editor with
// all cards. The edges follow via the controller straight into the UIKit layers. (The offset
// must not run as `@State` through the whole editor body: 21 cards and all edges per
// frame, the hosted tree re-diffed — dragging visibly stuttered. And on release the card
// jumped: the grid formula must be `((x + dx) / 8).rounded() * 8`, not
// `(x + dx/8).rounded() * 8`, which multiplies the position by eight.)
//
// The gesture itself is NOT a SwiftUI gesture but a `UILongPressGestureRecognizer` on the
// hosted surface (see WorkflowZoomScrollView): with a SwiftUI gesture on the card — exclusive
// or simultaneous — SwiftUI's event path held back the scroll view's pan, and a swipe that
// BEGAN on a card scrolled nothing (with 21 cards almost every swipe begins on one).
// Also the drag was in screen points, not converted back through the zoom (at 50 % the card
// followed the finger only half way). UIKit computes `location(in:)` through the
// transform and lets pan and press fail against each other regularly.
private struct WorkflowNodeCard: View {
    let node: WorkflowNode
    let wiring: WorkflowWiring
    /// Edge target while connecting (accent frame).
    let armed: Bool
    let isSelected: Bool
    /// Does the step check effectively (completion gate)? When inherited from the workflow the checkmark is dimmed.
    let check: WorkflowCardsCheck
    let control: WorkflowCanvasControl
    /// Tap on the card, with the half (left/right) the finger was on.
    let onTap: (WorkflowGeometry.Side) -> Void
    /// Tap on a dock or fixed output: branch and flank.
    let onPort: (WorkflowBranch?, WorkflowGeometry.Side) -> Void

    /// Offset from the position in the graph while the finger holds the card — `nil` means: not
    /// picked up. Set by the controller via the registration in `onAppear`.
    @State private var offset: CGSize? = nil

    // The card's shape tells the role: the trigger is half-round on the left (nothing arrives there),
    // start a pill, end a flat rectangle, every step 14 pt.
    private var shape: AnyShape {
        switch node.type {
        case .trigger: return AnyShape(UnevenRoundedRectangle(topLeadingRadius: 28, bottomLeadingRadius: 28, bottomTrailingRadius: 14, topTrailingRadius: 14))
        case .start: return AnyShape(Capsule())
        case .end: return AnyShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        default: return AnyShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    var body: some View {
        let size = WorkflowGeometry.size(of: node.type)
        let compact = WorkflowGeometry.isCompact(node.type)
        let entry = WorkflowGeometry.isEntry(node.type)
        let shape = self.shape
        let card = CbColor.surface
        let title = node.title.isEmpty ? L(node.type.displayLabel) : node.title
        // Title and type line say the same as long as nobody has renamed — "Instruction" over
        // "INSTRUCTION" would be no information. Then the type line is dropped.
        let showsType = title != L(node.type.displayLabel)
        let command = node.command.trimmingCharacters(in: .whitespacesAndNewlines)
        let outPorts = WorkflowGeometry.outPorts(node.type)
        let ports = wiring.ports[node.id] ?? [:]
        let docks = wiring.docks[node.id] ?? .init()
        let fixed = WorkflowGeometry.isFixed(node.type)
        // Whoever has an output can connect from a dock (`end` has none).
        let draggable = !outPorts.isEmpty
        let holds = offset != nil

        // The card's texts stay FIXED (text size): the card has the web builder's geometry
        // (`WorkflowGeometry`, bound to `web/src/lib/graph-geometry.ts`), edges and docks calculate with it — like
        // `cb-text-fixed` on the web. The surface's zoom enlarges it. Guard exception in ios-font.test.mjs.
        return Group {
            if compact {
                // Start and end: badge and title, nothing else — they carry neither text nor
                // chips (start has no input, end no output).
                HStack(spacing: 8) {
                    WorkflowBadge(type: node.type)
                    Text(title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if node.type == .end, node.notify {
                        Image(systemName: "bell")
                            .font(.symbol(10, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 8)
                .padding(.trailing, 12)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .center, spacing: 10) {
                        WorkflowBadge(type: node.type)
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 5) {
                                Text(title)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                // The "notify" checkmark and the completion gate belong on the
                                // surface — otherwise one would only learn about them after opening each step.
                                if node.notify {
                                    Image(systemName: "bell")
                                        .font(.symbol(10, weight: .medium))
                                        .foregroundStyle(.secondary)
                                }
                                if check != .no {
                                    Image(systemName: "checkmark")
                                        .font(.symbol(10, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                        .opacity(check == .inherited ? 0.45 : 1)
                                }
                            }
                            if showsType {
                                Text(L(node.type.displayLabel).uppercased())
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .tracking(0.6)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    Text(node.type == .trigger
                         ? node.triggerSummary
                         : node.type == .loop && !node.items.isEmpty
                           ? L("List: {items}", ["items": node.items.prefix(3).joined(separator: ", ") + (node.items.count > 3 ? " …" : "")])
                           // A review node needs no text — "(no text)" would read like a defect.
                           : node.type == .review && node.text.trimmingCharacters(in: .whitespaces).isEmpty
                             ? L("The agent writes the test instructions, you judge.")
                             : (node.text.isEmpty ? L("(no text)") : node.text))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(command.isEmpty ? 2 : 1)
                        .multilineTextAlignment(.leading)
                    if !command.isEmpty {
                        HStack(spacing: 3) {
                            Image(systemName: "terminal.fill")
                            Text(node.command)
                                .lineLimit(1)
                        }
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.accentColor)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .leading)
        // Clip the content to the shape BEFORE the connection points lie on top — they deliberately sit
        // half outside the card.
        .clipShape(shape)
        // The shadow hangs on the surface, not on the text: a `.shadow` on the whole card
        // would put a soft edge under every line too. When picked up the card rises: more
        // shadow — the only feedback that the press has taken hold.
        .background(shape.fill(card).shadow(color: .black.opacity(holds ? 0.22 : 0.08), radius: holds ? 10 : 3, y: holds ? 6 : 1))
        .overlay {
            // Selection in the type color, edge target in the accent, otherwise a calm hairline.
            shape.stroke(
                armed ? Color.accentColor : isSelected ? node.type.tint : CbColor.edge,
                lineWidth: armed || isSelected ? 2 : 1
            )
        }
        .overlay(alignment: .topLeading) {
            // Connection points in ONE layer above the card, in its coordinates: `position` sets the
            // center, so every point lies exactly ON the flank.
            ZStack(alignment: .topLeading) {
                // Free nodes: a dock on the left, a dock on the right. Each is output (tap, then
                // the target) and input (target of a connect) at once — the gesture decides the role,
                // afterwards it is stored in the edge. Filled as soon as an edge hangs there, otherwise
                // hollow with a frame in the type color. 12 pt visible, 32 pt hit area. `end` has
                // no output: its docks are only a target, no button.
                if !fixed {
                    ForEach([WorkflowGeometry.Side.left, .right], id: \.rawValue) { side in
                        let occupied = side == .left ? docks.left : docks.right
                        let point = Circle()
                            .fill(occupied ? node.type.tint : card)
                            .frame(width: compact ? 10 : 12, height: compact ? 10 : 12)
                            .overlay(Circle().stroke(occupied ? card : armed ? Color.accentColor : node.type.tint, lineWidth: 2))
                            .scaleEffect(armed ? 1.25 : 1)
                        Group {
                            if draggable {
                                Button { onPort(nil, side) } label: { point }
                                    .frame(width: 32, height: 32)
                                    .contentShape(Rectangle())
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(L("Connect"))
                                    .accessibilityIdentifier("workflow-port-\(node.id)-\(side == .left ? "links" : "right")")
                            } else {
                                point.allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                        .position(x: side == .right ? size.width : 0, y: size.height / 2)
                    }
                }
                // Fixed nodes: ONE input on the left (target only — a tap belongs to the card) and one
                // output per branch on the right, in branch order, with its pill beside it.
                if fixed {
                    Circle()
                        .fill(docks.left ? node.type.tint : card)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(docks.left ? card : armed ? Color.accentColor : node.type.tint, lineWidth: 2))
                        .scaleEffect(armed ? 1.25 : 1)
                        .position(x: 0, y: size.height / 2)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    ForEach(Array(outPorts.enumerated()), id: \.offset) { _, branch in
                        let port = ports[WorkflowGeometry.branchKey(branch)] ?? .init(side: .right, slot: 0.5, occupied: false)
                        let y = port.slot * size.height
                        Button {
                            onPort(branch, .right)
                        } label: {
                            Circle()
                                .fill(port.occupied ? node.type.tint : card)
                                .frame(width: 12, height: 12)
                                .overlay(Circle().stroke(port.occupied ? card : node.type.tint, lineWidth: 2))
                        }
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                        .buttonStyle(.plain)
                        .position(x: size.width, y: y)
                        .accessibilityLabel(branch.map { L("Connect: {label}", ["label": L($0.displayLabel)]) } ?? L("Connect"))
                        .accessibilityIdentifier("workflow-port-\(node.id)-\(branch?.rawValue ?? "next")")
                        // The branch carries its word as a pill BESIDE the dot, ABOVE the line (as
                        // in n8n) — it belongs to the node, not the edge, and stays when
                        // no edge leaves yet. No touch target.
                        if let branch {
                            Text(L(branch.displayLabel))
                                .font(.system(size: 10, weight: .semibold))
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, 6)
                                .frame(height: 16)
                                // Opaque like the card, the tint on top: a translucent
                                // pill would let the edge running under it show through.
                                .background(Capsule().fill(card).overlay(Capsule().fill(node.type.tint.opacity(0.14))))
                                .overlay(Capsule().stroke(node.type.tint.opacity(0.35), lineWidth: 1))
                                .offset(x: size.width + 10, y: y - 11 - 8)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                }
            }
            .frame(width: size.width, height: size.height)
        }
        .contentShape(shape)
        // When connecting, the card half tells the dock: left or right of the center.
        .onTapGesture(coordinateSpace: .local) { p in onTap(p.x > size.width / 2 ? .right : .left) }
        // The card follows the finger (offset from the controller), picked up above the others.
        .offset(offset ?? .zero)
        .zIndex(holds ? 1 : 0)
        .onAppear { control.register(node.id) { offset = $0 } }
        .onDisappear { control.forget(node.id) }
        .accessibilityIdentifier("workflow-node-\(node.id)")
    }
}

// Button as a narrow capsule on material — for the editor's floating bars in landscape.
// `emphasized` colors the text in the accent (Save with unsaved changes).
private struct FloatingCapsule: ButtonStyle {
    var emphasized = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(!isEnabled ? Color.secondary : emphasized ? Color.accentColor : Color.primary)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(CbColor.edge, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

// ── Presentation of the editor and screen orientation ──
// The editor is a UIKit fullscreen, not a `fullScreenCover`. The reason is "open in landscape":
// WHICH orientation the screen has is decided by UIKit anew at every reconciliation — from the
// intersection of the orientations the TOPMOST controller allows with the device's orientation.
// `requestGeometryUpdate` is only a request to the scene: a first version made it before
// presenting, the scene rotated to landscape — and at the next reconciliation (the cover appears, a
// sheet opens) UIKit rotated back, because the device is held upright and SwiftUI's
// cover controller allowed portrait. Reported as "first horizontal, then it jumps to vertical".
// From inside the cover the request was not possible at all ("Requested: landscapeRight; supported:
// portrait", UISceneErrorDomain 101).
//
// A controller of its own says itself what it allows: landscape only, as long as the lock stands. UIKit
// then rotates by itself when presenting and back to the device orientation when closing — without a
// request, without a race. The lock falls when the device is held in landscape FIRST and upright AGAIN
// afterwards: whoever turns upright to type may do so; whoever does not move the phone keeps landscape.
enum WorkflowOrientation {
    /// default on; `-cbase.mobile.workflow.landscape 0` (UI tests that measure the portrait rule of the
    /// node sheet) or a stored `false` switch it off.
    // Like `boot-splash`: a launch argument arrives as a string, `bool(forKey:)` reads "0" — an
    // `as? Bool` would read nil and take the default for set.
    static var desired: Bool {
        UserDefaults.standard.object(forKey: "cbase.mobile.workflow.landscape") == nil
            || UserDefaults.standard.bool(forKey: "cbase.mobile.workflow.landscape")
    }
    /// Only the phone is rotated — the iPad shows the graph wide enough in any orientation.
    static var landscapeForce: Bool { desired && UIDevice.current.userInterfaceIdiom == .phone }

    /// After closing: UIKit rotates back to the device orientation by itself — but only if the
    /// device has one. If it lies flat (`faceUp`), the app would stay in landscape; then back to
    /// the portrait the editor was opened in. A rejected request is no error.
    static func editorClosed() {
        guard landscapeForce, !UIDevice.current.orientation.isLandscape,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              scene.effectiveGeometry.interfaceOrientation.isLandscape else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in }
    }
}

/// The editor's controller: holds the landscape lock and tells UIKit the allowed orientations.
final class WorkflowEditorController: UIHostingController<AnyView> {
    private var landscapeLock: Bool
    /// Whether this controller has subscribed to the device orientation — paired with `end` in deinit.
    private let listensDevice: Bool
    /// Whether the device has been held in landscape once since opening — only then does portrait release the
    /// lock. Otherwise merely lifting the phone off the table (faceUp → portrait) would release it.
    private var landscapeSeen = false

    init(rootView: AnyView, landscape: Bool) {
        landscapeLock = landscape
        listensDevice = landscape
        super.init(rootView: rootView)
        modalPresentationStyle = .fullScreen
        if landscape {
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            NotificationCenter.default.addObserver(self, selector: #selector(deviceRotated), name: UIDevice.orientationDidChangeNotification, object: nil)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    deinit {
        NotificationCenter.default.removeObserver(self)
        // Paired with `begin` — the counter in UIDevice is a stack.
        if listensDevice { UIDevice.current.endGeneratingDeviceOrientationNotifications() }
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        if landscapeLock { return .landscape }
        return UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }
    /// UIKit rotates to this orientation when presenting if the current one is not allowed.
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        landscapeLock ? .landscapeRight : super.preferredInterfaceOrientationForPresentation
    }

    @objc private func deviceRotated() {
        let situation = UIDevice.current.orientation
        if situation.isLandscape { landscapeSeen = true }
        guard landscapeLock, landscapeSeen, situation == .portrait else { return }
        landscapeLock = false
        // UIKit asks for the allowed orientations anew and follows the device.
        setNeedsUpdateOfSupportedInterfaceOrientations()
    }
}

/// Presents the editor as fullscreen as soon as `detail` is set, and clears `detail` on
/// closing. Sits as an invisible anchor in the list's tree — presenting happens from there.
struct WorkflowEditorPresentation: UIViewControllerRepresentable {
    @Binding var detail: WorkflowDetail?
    /// A presented controller does not inherit SwiftUI's environment — the effective color scheme comes
    /// along as a UIKit override, otherwise the editor would ignore the theme switch (like ChatTimelineStage).
    let colorScheme: ColorScheme
    let onDismiss: () -> Void
    let content: (WorkflowDetail, @escaping () -> Void) -> WorkflowCanvasEditor

    final class Anchor: UIViewController {}

    final class Coordinator {
        var parent: WorkflowEditorPresentation
        weak var editor: WorkflowEditorController?
        /// Set as soon as presenting begins — before appearing, so that a second update does not
        /// present twice.
        var open = false

        init(_ parent: WorkflowEditorPresentation) { self.parent = parent }

        func close() {
            guard let editor else { open = false; return }
            editor.dismiss(animated: true) { [self] in
                self.open = false
                self.parent.detail = nil
                self.parent.onDismiss()
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> Anchor { Anchor() }

    func updateUIViewController(_ anchor: Anchor, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        coordinator.editor?.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        if let detail, !coordinator.open {
            coordinator.open = true
            let editor = WorkflowEditorController(
                rootView: AnyView(content(detail) { coordinator.close() }.cbAccent()),
                landscape: WorkflowOrientation.landscapeForce
            )
            editor.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
            coordinator.editor = editor
            // Do not present in the middle of a SwiftUI update — one run loop later the anchor is
            // safely in the window and UIKit is free to rotate.
            DispatchQueue.main.async { [weak anchor] in
                guard let anchor, coordinator.open, coordinator.editor === editor else { return }
                anchor.present(editor, animated: true)
            }
        } else if detail == nil, coordinator.open, let editor = coordinator.editor, !editor.isBeingDismissed {
            // Closed from outside (does not happen in normal operation — the editor closes itself).
            editor.dismiss(animated: true)
            coordinator.open = false
        }
    }
}


// Icon badge of the node (28 pt on the card, 22 in the menu and in the step sheet's header): SHAPE tells
// the role, COLOR the kind — as on the desktop. Hexagon for the entry points (the house symbol: here
// the run enters cbase), full fill only where the run waits for a HUMAN
// (question, review), graphite for the end, otherwise the type color at 16 % on the card. The symbol
// is mixed a touch toward the text color: amber and emerald would be too pale on their own tint in light mode,
// and in dark mode the same mix brightens by itself.
private struct WorkflowBadge: View {
    let type: WorkflowNodeType
    /// Edge length; symbol and rounding scale along, so that 22 is the same shape as 28.
    var size: CGFloat = 28
    // The scheme comes from the ENVIRONMENT, not from a dynamic UIColor: the menu image is rendered
    // without a window (`WorkflowBadgeImages`), and there only the environment exists, no trait.
    @Environment(\.colorScheme) private var colorScheme

    private var entry: Bool { WorkflowGeometry.isEntry(type) }
    private var full: Bool { type == .ask || type == .review || type == .end }
    // The badge symbols differ from those of the menus: there the symbol carries its circle
    // itself (bolt.circle), on the badge the shape IS the frame — a circle in the hexagon would be
    // a ring in a ring.
    private var symbol: String {
        switch type {
        case .trigger: return "bolt.fill"
        case .start: return "play.fill"
        case .instruction: return "doc.text"
        case .condition: return "arrow.triangle.branch"
        case .loop: return "arrow.triangle.2.circlepath"
        case .parallel: return "arrow.triangle.pull"
        case .ask: return "questionmark.bubble"
        case .review: return "person.fill.checkmark"
        case .end: return "stop.fill"
        }
    }
    private var shape: AnyShape { entry ? AnyShape(WorkflowHexagon()) : AnyShape(RoundedRectangle(cornerRadius: 8 * size / 28, style: .continuous)) }
    private var fill: Color {
        if type == .end { return colorScheme == .dark ? Color(white: 0.36) : Color(white: 0.19) }
        return full ? type.tint : type.tint.opacity(0.16)
    }
    private var foreground: Color { full ? .white : type.tint.mix(with: .primary, by: 0.2) }

    var body: some View {
        ZStack {
            shape.fill(fill)
            Image(systemName: symbol)
                .font(.symbol((entry ? 12 : 13) * size / 28, weight: .semibold))
                .foregroundStyle(foreground)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// The badge images of the "Step" menu. A SwiftUI `Menu` hands its buttons to UIKit as a UIMenu,
// and a menu item there carries text and IMAGE, no view — so the badge must become a `UIImage`.
// Rendered ONCE per type and color scheme with `ImageRenderer` without a window and kept:
// fill (graphite) and foreground (`.primary` mix) depend on the scheme, hence two entries per
// type. The caller must use `.renderingMode(.original)` — otherwise the menu tints the image as a
// template in the accent color.
@MainActor
private enum WorkflowBadgeImages {
    static let size: CGFloat = 22

    // The pixel density belongs in the key: the fullscreen controller supplies it reliably only in the window,
    // and an image once rendered at 1× would stay blurry forever.
    private struct Key: Hashable {
        let type: WorkflowNodeType
        let scheme: ColorScheme
        let scale: CGFloat
    }
    private static var cache: [Key: UIImage] = [:]

    static func image(_ type: WorkflowNodeType, scheme: ColorScheme, scale: CGFloat) -> UIImage? {
        let key = Key(type: type, scheme: scheme, scale: scale)
        if let image = cache[key] { return image }
        let renderer = ImageRenderer(content: WorkflowBadge(type: type, size: size).environment(\.colorScheme, scheme))
        renderer.scale = scale
        guard let image = renderer.uiImage else { return nil }
        cache[key] = image
        return image
    }
}

// Regular hexagon with the point up — the same corner points as the clip-path on the desktop.
private struct WorkflowHexagon: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let pts: [(CGFloat, CGFloat)] = [(0.5, 0), (0.933, 0.25), (0.933, 0.75), (0.5, 1), (0.067, 0.75), (0.067, 0.25)]
        for (i, (fx, fy)) in pts.enumerated() {
            let pt = CGPoint(x: r.minX + r.width * fx, y: r.minY + r.height * fy)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}

// ── Controller: the editor's UIKit wire ──
// Holds scroll view and drawing surface and runs everything that happens EVERY FRAME — moving, zooming,
// fitting — past SwiftUI. (Every finger frame must not run as `@State` through the
// whole editor body: 21 cards rebuilt, all edges recalculated, the hosted tree re-diffed — moving
// stuttered, and the zoom ran as a two-way binding against the pinch (the binding lagged a frame behind,
// `updateUIView` reset the scroll view to it.)
// Now SwiftUI rebuilds the surface only on a CHANGE of the graph; the level flows in ONE
// direction (scroll view → label), and the buttons talk to the scroll view directly.
final class WorkflowCanvasControl: ObservableObject {
    /// Zoom level of the scroll view — observed ONLY by the percent label, not by the editor.
    @Published private(set) var zoom: CGFloat = 1

    weak var scroll: UIScrollView?
    weak var surface: WorkflowSurfaceView?
    /// Edges in surface coordinates for a step moved by `offset` — set by the editor on every
    /// render (it knows graph and surface origin).
    var edgesWithShift: ((String, CGSize) -> [WorkflowEdgePath])?
    /// The graph with air, in surface coordinates: target of "Fit" and anchor of centering.
    var fitRect: CGRect?
    /// Size of the surface (unzoomed) — for centering small content.
    var surfacesSize = CGSize.zero
    /// Offset receivers of the cards, per node id — registered on appearing. Only the picked-up
    /// card gets a value every frame and rebuilds itself.
    private var cardsOffset: [String: (CGSize?) -> Void] = [:]
    /// World path → path snapped to the grid (the editor knows the node's position).
    var rasterized: ((String, CGSize) -> CGSize)?
    /// Release: node id and world path — the editor takes the position into the graph.
    var deposit: ((String, CGSize) -> Void)?

    func register(_ id: String, offset: @escaping (CGSize?) -> Void) { cardsOffset[id] = offset }
    func forget(_ id: String) { cardsOffset[id] = nil }
    /// Fit as soon as the scroll view has dimensions and the next render is through (opening, new
    /// step, rotation).
    private(set) var fitPending = true
    /// During a programmatic zoom rebuild (surface change) the delegate notification is silent.
    var silent = false

    static let minZoom: CGFloat = 0.3
    static let maxZoom: CGFloat = 2.2

    // ── Moving (called by the scroll view's long press, paths in world pt) ──
    func beginMove(_ id: String) {
        // The only feedback that the press has taken hold, besides the card's shadow.
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        cardsOffset[id]?(.zero)
    }
    func move(_ id: String, by offset: CGSize) {
        let v = rasterized?(id, offset) ?? offset
        cardsOffset[id]?(v)
        if let edgeList = edgesWithShift?(id, v) { surface?.apply(edges: edgeList) }
    }
    /// `dropped`: released (the position goes into the graph) — otherwise cancelled (call, swipe from the
    /// edge): card and edges back to the old position.
    func endMove(_ id: String, by offset: CGSize, deposited: Bool) {
        if deposited {
            // First the graph, then the offset: both in ONE run loop, SwiftUI rebuilds once — the
            // card does not briefly jump back to the old position.
            deposit?(id, offset)
            cardsOffset[id]?(nil)
        } else {
            cardsOffset[id]?(nil)
            if let edgeList = edgesWithShift?(id, .zero) { surface?.apply(edges: edgeList) }
        }
    }

    // ── Zoom ──
    func zoomStep(_ delta: CGFloat) {
        guard let scroll else { return }
        let target = max(Self.minZoom, min(Self.maxZoom, scroll.zoomScale + delta))
        scroll.setZoomScale(target, animated: true)
    }
    /// Delegate notification of the scroll view: level to the label and to the layers (line width, grid).
    func zoomChanged(_ scroll: UIScrollView) {
        centerSmallContent(scroll)
        guard !silent else { return }
        let value = scroll.zoomScale
        surface?.apply(zoom: value)
        guard abs(zoom - value) > 0.005 else { return }
        // Delegate calls can arrive in the middle of a SwiftUI update.
        DispatchQueue.main.async { [weak self] in
            guard let self, abs(self.zoom - value) > 0.005 else { return }
            self.zoom = value
        }
    }

    // ── Fit ──
    func fit() { fitPending = true; fitIfPossible() }
    /// After a graph change: only the render knows the new `fitRect`, `updateUIView` then calls.
    func fitAfterRender() { fitPending = true }

    func fitIfPossible() {
        guard fitPending, let scroll, let rect = fitRect,
              scroll.bounds.width > 1, scroll.bounds.height > 1, rect.width > 1, rect.height > 1 else { return }
        fitPending = false
        let targetZoom = max(Self.minZoom, min(1.2, min(scroll.bounds.width / rect.width, scroll.bounds.height / rect.height)))
        let visible = CGSize(width: scroll.bounds.width / targetZoom, height: scroll.bounds.height / targetZoom)
        var origin = CGPoint(x: rect.midX - visible.width / 2, y: rect.midY - visible.height / 2)
        origin.x = max(0, min(origin.x, max(0, surfacesSize.width - visible.width)))
        origin.y = max(0, min(origin.y, max(0, surfacesSize.height - visible.height)))
        scroll.zoom(to: CGRect(origin: origin, size: visible), animated: true)
    }

    /// The scroll view has new dimensions (rotation, bars come and go). Small content is re-centered;
    /// a different WIDTH fits again — the old section matched the old shape.
    /// Only the width: the connect banner and error line change the height, and a tap on an
    /// output must not make the section jump.
    func massChanged(_ scroll: UIScrollView, old: CGSize) {
        centerSmallContent(scroll)
        if old.width > 1, old.width != scroll.bounds.width { fitPending = true }
        // Do not zoom from inside `layoutSubviews` — one run loop later the dimensions are there.
        guard fitPending else { return }
        DispatchQueue.main.async { [weak self] in self?.fitIfPossible() }
    }

    // If the surface is smaller than the section, it is inset so that the GRAPH stands in the
    // middle — not the surface: that one carries air all around, and with the surface's center as the anchor
    // the graph stuck in a corner (measured in landscape). It is inset only as far
    // as there is air; the surface stays entirely within the section.
    func centerSmallContent(_ scroll: UIScrollView) {
        let z = scroll.zoomScale
        let scaled = CGSize(width: surfacesSize.width * z, height: surfacesSize.height * z)
        let anchor = fitRect.map { CGPoint(x: $0.midX, y: $0.midY) }
            ?? CGPoint(x: surfacesSize.width / 2, y: surfacesSize.height / 2)
        var inset = UIEdgeInsets.zero
        if scaled.height < scroll.bounds.height {
            let clearance = scroll.bounds.height - scaled.height
            inset.top = max(0, min(clearance, scroll.bounds.height / 2 - anchor.y * z))
            inset.bottom = clearance - inset.top
        }
        if scaled.width < scroll.bounds.width {
            let clearance = scroll.bounds.width - scaled.width
            inset.left = max(0, min(clearance, scroll.bounds.width / 2 - anchor.x * z))
            inset.right = clearance - inset.left
        }
        if scroll.contentInset != inset { scroll.contentInset = inset }
    }
}

/// Real two-finger zoom for the workflow graph. A `UIScrollView` keeps the point between the fingers
/// stable when zooming and allows pan + pinch at the same time. The
/// earlier combination of SwiftUI `ScrollView`, `scaleEffect` and a gesture of its own scaled
/// only the presentation and fought with the built-in scroll recognizer.
///
/// `surface` is the WORLD rectangle of the surface: its size is the content size, its origin the
/// world point at the top left corner. If the origin moves (a step was pushed to the left or
/// top), the section is carried along by the difference — the same world point
/// stays under the finger.
private struct WorkflowZoomScrollView<Content: View>: UIViewRepresentable {
    let surface: CGRect
    let fitRect: CGRect?
    let control: WorkflowCanvasControl
    /// Surface point → id of the topmost card below (picking up on long press).
    let hitCard: (CGPoint) -> String?
    /// World path → path snapped to the grid.
    let rasterized: (String, CGSize) -> CGSize
    /// Release: id and world path.
    let deposit: (String, CGSize) -> Void
    let content: Content

    init(
        surface: CGRect,
        fitRect: CGRect?,
        control: WorkflowCanvasControl,
        hitCard: @escaping (CGPoint) -> String?,
        rasterized: @escaping (String, CGSize) -> CGSize,
        deposit: @escaping (String, CGSize) -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.surface = surface
        self.fitRect = fitRect
        self.control = control
        self.hitCard = hitCard
        self.rasterized = rasterized
        self.deposit = deposit
        self.content = content()
    }

    func makeCoordinator() -> Coordinator { Coordinator(control) }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = BoundsReportingScrollView()
        // If the bounds change (rotation, bars come and go), small content is re-centered
        // and refitted at a new width — otherwise the inset of the old height
        // stays and the graph sticks to the top.
        scroll.massChanged = { [control] scroll, old in control.massChanged(scroll, old: old) }
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = WorkflowCanvasControl.minZoom
        scroll.maximumZoomScale = WorkflowCanvasControl.maxZoom
        scroll.bouncesZoom = true
        scroll.decelerationRate = .fast
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.showsHorizontalScrollIndicator = true
        scroll.showsVerticalScrollIndicator = true
        // `delaysContentTouches` stays ON (default): the scroll view holds the touch back for 150 ms
        // and takes a movement in that time for itself. Without the delay the
        // SwiftUI card saw the touch immediately, its recognizers held back the scroll view's pan —
        // a swipe that began on a card scrolled nothing and moved nothing.
        // The price: holding counts only after the 150 ms.
        // One finger moves the surface; two fingers clearly belong to the pinch zoom.
        scroll.panGestureRecognizer.maximumNumberOfTouches = 1
        scroll.accessibilityIdentifier = "workflow-canvas"

        // The environment (and with it the accent from the settings) does not cross this host's
        // boundary — without the wrapper the cards would stay on the asset (terracotta).
        let host = UIHostingController(rootView: CbAccentWrapper(content: content))
        host.view.backgroundColor = .clear
        host.view.frame = CGRect(origin: .zero, size: surface.size)
        scroll.addSubview(host.view)
        scroll.contentSize = surface.size
        context.coordinator.host = host
        context.coordinator.surface = surface
        control.scroll = scroll
        control.surfacesSize = surface.size
        control.fitRect = fitRect

        // Picking up a step: PRESS AND HOLD on the card, then drag. The recognizer sits
        // on the hosted surface (UIKit, not SwiftUI — see WorkflowNodeCard), the scroll view's
        // pan waits for it to fail regularly: if the finger moves before the deadline expires,
        // the press fails and the surface scrolls; if it holds still, the drag is its own.
        // `location(in:)` returns surface coordinates, converted back through the zoom.
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPress(_:)))
        press.minimumPressDuration = 0.3
        press.delegate = context.coordinator
        host.view.addGestureRecognizer(press)
        scroll.panGestureRecognizer.require(toFail: press)
        context.coordinator.press = press
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.host?.rootView = CbAccentWrapper(content: content)
        coordinator.hitCard = hitCard
        control.scroll = scroll
        control.fitRect = fitRect
        control.surfacesSize = surface.size
        control.rasterized = rasterized
        control.deposit = deposit
        if coordinator.surface != surface {
            let old = coordinator.surface
            let z = scroll.zoomScale
            let offset = scroll.contentOffset
            // `frame` is transformed during a zoom and therefore unsuitable. Briefly go to the
            // base scale, change the real content size and restore the same zoom
            // — silently, so that the label does not report "100 %" in between.
            control.silent = true
            scroll.setZoomScale(1, animated: false)
            coordinator.host?.view.frame = CGRect(origin: .zero, size: surface.size)
            scroll.contentSize = surface.size
            scroll.setZoomScale(z, animated: false)
            control.silent = false
            // The same world point stays in the section: the content has shifted by the
            // origin's movement, the section follows by the same amount.
            var fresh = CGPoint(x: offset.x + (old.minX - surface.minX) * z, y: offset.y + (old.minY - surface.minY) * z)
            fresh.x = max(0, min(fresh.x, max(0, surface.width * z - scroll.bounds.width)))
            fresh.y = max(0, min(fresh.y, max(0, surface.height * z - scroll.bounds.height)))
            scroll.contentOffset = fresh
            coordinator.surface = surface
        }
        // Open fit (opening, new step, rotation): one run loop later — at the first
        // update SwiftUI has sometimes not yet given the scroll view its final bounds.
        if control.fitPending {
            DispatchQueue.main.async { [control] in control.fitIfPossible() }
        }
        control.centerSmallContent(scroll)
    }

    /// `UIScrollView` that reports a change of its bounds' size. `layoutSubviews` runs on
    /// every scroll — only a DIFFERENT size is reported, not a different origin.
    final class BoundsReportingScrollView: UIScrollView {
        var massChanged: ((UIScrollView, CGSize) -> Void)?
        private var lastSize = CGSize.zero

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.size != lastSize else { return }
            let old = lastSize
            lastSize = bounds.size
            massChanged?(self, old)
        }
    }

    /// Delegate of the scroll view — passes through to the controller that holds the state — and target
    /// of the long press.
    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        let control: WorkflowCanvasControl
        var host: UIHostingController<CbAccentWrapper<Content>>?
        var surface = CGRect.zero
        var hitCard: (CGPoint) -> String? = { _ in nil }
        weak var press: UILongPressGestureRecognizer?
        /// Picked-up card and the point of pick-up (surface coordinates).
        private var moves: String?
        private var start = CGPoint.zero

        init(_ control: WorkflowCanvasControl) { self.control = control }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { host?.view }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { control.zoomChanged(scrollView) }

        /// The press begins only over a card — on an empty surface it fails, and the
        /// scroll view gets the drag even if the finger starts moving late.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard g === press, let view = g.view else { return true }
            return hitCard(g.location(in: view)) != nil
        }

        @objc func longPress(_ g: UILongPressGestureRecognizer) {
            guard let view = g.view else { return }
            let p = g.location(in: view)
            let offset = CGSize(width: p.x - start.x, height: p.y - start.y)
            switch g.state {
            case .began:
                guard let id = hitCard(p) else { return }
                moves = id
                start = p
                control.beginMove(id)
            case .changed:
                guard let id = moves else { return }
                control.move(id, by: offset)
            case .ended:
                guard let id = moves else { return }
                moves = nil
                control.endMove(id, by: offset, deposited: true)
            default:
                guard let id = moves else { return }
                moves = nil
                control.endMove(id, by: .zero, deposited: false)
            }
        }
    }
}

// Inspector of a step (title, command, text, loop list, options, outgoing connections).
//
// Minimalist: no type hint in the header, no usage hint under the fields, at most ONE footnote per
// section, and only where it carries a rule. The round cap appears ONLY on steps on a cycle
// (`imKreis`) — off a cycle it never takes effect. The command stays ABOVE the text: on the iPhone it must
// be reachable without scrolling (`testWorkflowsPaneCreatesWorkflowAndAddsStep` measures that).
struct WorkflowNodeSheet: View {
    /// The two harness commands as quick-pick chips. CONTRACT with the web guard
    /// `web/test/workflow-node-form.test.mjs`: it reads THIS line and holds it against `NODE_COMMANDS`
    /// (web/src/lib/workflow-node-form.ts) and `isHarnessCommand` (electron/server/workflows.js).
    /// Name, literal array and slashes are part of the contract.
    static let nodeCommands = ["/clear", "/compact"]
    /// The three placeholders of a step text as chips — CONTRACT with the SAME guard: it also
    /// reads this line and holds it against `PLACEHOLDER` (web/src/lib/workflow-node-form.ts). Character-identical
    /// today, and without the guard a fourth placeholder on the web would silently be missing here.
    static let placeholder = ["{{input}}", "{{element}}", "{{answer}}"]

    @State var node: WorkflowNode
    let outgoing: [WorkflowEdge]
    let nodeName: (String) -> String
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    /// Does the step lie on a cycle? Only there is there a round cap.
    let inCycle: Bool
    /// Label of the cap stepper at value 0: the EFFECTIVE value ("5 · Default", "20 · from
    /// Review") — calculated in the editor (`capPlaceholder`).
    let capPlaceholder: String
    /// What "Like workflow" means for the round cap here (cycle neighbors included) — calculated
    /// in the editor, which knows the graph.
    let roundsInheritedContinue: Bool
    /// The run settings the node inherits ("Like workflow (on)").
    let rule: WorkflowRules.Rule
    let limits: WorkflowLimits
    var onChange: (WorkflowNode) -> Void
    var onRemoveEdge: (WorkflowEdge) -> Void
    var onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var itemsText: String
    /// The leading "/word" in the command — as long as it is one, the picker stands under the field.
    @State private var slashQuery: String?
    /// The effective skills, fetched on OPENING the picker (as in the composer: a "/name" the
    /// CLI does not know swallows the whole message — an old list would be no cosmetic flaw).
    @State private var skills: [SkillSummary] = []

    init(
        node: WorkflowNode,
        outgoing: [WorkflowEdge],
        nodeName: @escaping (String) -> String,
        client: APIClient,
        workspaceId: String,
        projectId: String?,
        inCycle: Bool,
        capPlaceholder: String,
        roundsInheritedContinue: Bool,
        rule: WorkflowRules.Rule,
        limits: WorkflowLimits,
        onChange: @escaping (WorkflowNode) -> Void,
        onRemoveEdge: @escaping (WorkflowEdge) -> Void,
        onDelete: @escaping () -> Void
    ) {
        _node = State(initialValue: node)
        self.outgoing = outgoing
        self.nodeName = nodeName
        self.client = client
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.inCycle = inCycle
        self.capPlaceholder = capPlaceholder
        self.roundsInheritedContinue = roundsInheritedContinue
        self.rule = rule
        self.limits = limits
        self.onChange = onChange
        self.onRemoveEdge = onRemoveEdge
        self.onDelete = onDelete
        _itemsText = State(initialValue: node.items.joined(separator: "\n"))
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    HStack(spacing: 7) {
                        WorkflowBadge(type: node.type, size: WorkflowBadgeImages.size)
                        Text(L(node.type.displayLabel)).font(.subheadline.weight(.semibold))
                    }
                }
                Section(L("Title")) {
                    TextField(L("Title"), text: $node.title)
                        .accessibilityIdentifier("workflow-node-title")
                }
                if node.type != .end {
                    commandSection
                }
                if node.type == .trigger {
                    Section {
                        Text(node.triggerSummary).font(.subheadline)
                    } header: {
                        Text(L("Triggers"))
                    } footer: {
                        // The one rule of this section: not adjustable here.
                        Text(L("Triggers are set up on the desktop (account, project, events). They stay untouched here — moving and connecting is safe."))
                    }
                }
                if node.type != .start && node.type != .end && node.type != .trigger {
                    Section(sectionTitle) {
                        TextField(placeholder, text: $node.text, axis: .vertical)
                            .lineLimit(3...12)
                            .accessibilityIdentifier("workflow-node-text")
                        // No caret in SwiftUI's TextField — the token goes to the end (as with the composer's
                        // slash picker), without extra spaces.
                        HStack(spacing: 8) {
                            ForEach(Self.placeholder, id: \.self) { token in
                                Button(token) { node.text += token }
                                    .buttonStyle(.bordered)
                                    .font(.system(.caption, design: .monospaced))
                            }
                        }
                    }
                }
                if node.type == .loop {
                    Section(L("Fixed list")) {
                        TextField(L("empty = the model builds it"), text: $itemsText, axis: .vertical)
                            .lineLimit(2...8)
                            .accessibilityIdentifier("workflow-node-items")
                        Stepper(L("Max. items: {n}", ["n": String(node.maxIterations)]), value: $node.maxIterations, in: 1...limits.maxIterations)
                    }
                }
                if rows.cap || rows.doneMode || rows.notification {
                    optionsSection
                }
                if !outgoing.isEmpty {
                    Section(L("Connections")) {
                        ForEach(outgoing) { edge in
                            HStack {
                                Text(nodeName(edge.to)).font(.subheadline)
                                if let branch = edge.branch {
                                    Text(L(branch.displayLabel))
                                        .cbFont(10, weight: .medium)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Color.secondary.opacity(0.14), in: Capsule())
                                }
                                Spacer()
                                Button(role: .destructive) {
                                    onRemoveEdge(edge)
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(.red)
                            }
                        }
                    }
                }
                if node.type != .start {
                    Section {
                        Button(L("Delete step"), role: .destructive) {
                            onDelete()
                            dismiss()
                        }
                        .accessibilityIdentifier("workflow-node-delete")
                    }
                }
            }
            .navigationTitle(node.title.isEmpty ? L(node.type.displayLabel) : node.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The ✕ takes the step over and closes — like "Done" on the right before (`cbSheet`).
                SheetClose(identifier: "workflow-node-done", label: L("Done")) {
                    node.items = itemsText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    // Picker and chips write "/name " — the space closes the picker
                    // and makes room for an argument, it is not stored.
                    node.command = node.command.trimmingCharacters(in: .whitespaces)
                    onChange(node)
                    dismiss()
                }
            }
            .onChange(of: node.command) { _, fresh in
                let before = slashQuery != nil
                slashQuery = slashWord(in: fresh)
                if !before, slashQuery != nil { Task { await loadSkills() } }
            }
        }
    }

    // ── Command in front: mono field, slash picker, two chips ──
    private var commandSection: some View {
        Section(L("Command first")) {
            TextField(L("/clear, /compact or a message"), text: $node.command, axis: .vertical)
                .lineLimit(1...4)
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("workflow-node-command")
            // The same picker as in the composer (Chat/SlashPicker.swift), with the step's small stock:
            // the two harness commands and the skills. NOT the chat's client commands
            // (goal, model, effort, …) — the CLI would run them on the step itself.
            if slashQuery != nil {
                SlashPicker(commands: hits.commands, skills: hits.skills, prefix: "workflow-node") { name in
                    node.command = "/\(name) "
                }
                .fixedSize(horizontal: false, vertical: true)
                // Without row inset: the panel brings its own margin (10 pt).
                .listRowInsets(EdgeInsets())
            }
            HStack(spacing: 8) {
                ForEach(Self.nodeCommands, id: \.self) { command in
                    Button(command) { node.command = command + " " }
                        .buttonStyle(.bordered)
                        .font(.system(.caption, design: .monospaced))
                }
            }
        }
    }

    // ── Options: form rows are hairline rows anyway ──
    private var optionsSection: some View {
        Section {
            if rows.cap {
                // Value 0 means "inherited": the stepper then shows the cycle's effective value.
                Stepper(value: $node.maxVisits, in: 0...limits.maxVisitsLimit) {
                    HStack {
                        Text(L("Rounds per run"))
                        Spacer()
                        Text(node.maxVisits > 0 ? String(node.maxVisits) : capPlaceholder)
                            .foregroundStyle(node.maxVisits > 0 ? .primary : .secondary)
                            // A long source title ("20 · from Run tests") wraps —
                            // right-aligned, so that it hangs on the stepper.
                            .multilineTextAlignment(.trailing)
                    }
                }
                .accessibilityIdentifier("workflow-node-maxvisits")
            }
            if rows.loopCap {
                modeRow(L("At the round cap"), inherited: roundsInheritedContinue ? L("continue") : L("Question##ask"), id: "workflow-node-loopcap-mode", selection: $node.loopCapMode, options: [
                    (.inherit, L("Like workflow")), (.ask, L("Question##ask")), (.further, L("Continue")),
                ])
            }
            // Completion gate: "Like workflow" follows "Check all work steps"; with a check a model
            // judges after the turn and lets the same step keep working.
            if rows.doneMode {
                modeRow(L("Check for completion"), inherited: rule.doneAll ? L("on") : L("off"), id: "workflow-node-done-mode", selection: $node.doneMode, options: [
                    (.inherit, L("Like workflow")), (.on, L("On")), (.off, L("Off")),
                ])
            }
            if rows.scale {
                TextField(L("Yardstick (optional)"), text: $node.doneText, axis: .vertical)
                    .lineLimit(1...5)
                    .accessibilityIdentifier("workflow-node-donetext")
            }
            if rows.doneCap {
                modeRow(L("At the check cap"), inherited: rule.doneCapAuto ? L("continue") : L("Question##ask"), id: "workflow-node-donecap-mode", selection: $node.doneCapMode, options: [
                    (.inherit, L("Like workflow")), (.ask, L("Question##ask")), (.further, L("Continue")),
                ])
            }
            if rows.notification {
                Toggle(node.type == .review ? L("Notify when the review is due") : L("Notify on arrival"), isOn: $node.notify)
                    .accessibilityIdentifier("workflow-node-notify")
            }
        } header: {
            Text(L("Options"))
        } footer: {
            if rows.cap {
                Text(L("Empty = the cycle sets the cap. \"Like workflow\" follows the workflow settings (Caps & checks)."))
            }
        }
    }

    /// Which rows the sheet carries — from `WorkflowRules.rows`, the mirror of `rowsFor`
    /// (web/src/lib/workflow-node-form.ts), bound by web/test/wfe-ios-binding.test.mjs. The
    /// yardstick and "At the check cap" appear only if the step EFFECTIVELY checks (own value
    /// or inherited), the round cap only on a cycle.
    private var rows: WorkflowRules.Rows {
        WorkflowRules.rows(inCycle ? [node.id] : [], node.ruleNode, rule)
    }

    /// A three-valued row: title with the INHERITED value ("Workflow: on") above a segment bar
    /// "Like workflow · … · …". The inherited value stands in the title line and not in the segment (as on the
    /// web, "Like workflow (on)"): three equally wide segments on a 6-inch screen cut off "Like workflow
    /// (ask)" — a cut you cannot see is indistinguishable from a complete text.
    private func modeRow<Value: Hashable>(_ title: String, inherited: String, id: String, selection: Binding<Value>, options: [(Value, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                Text(L("Workflow: {value}", ["value": inherited]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Picker(title, selection: selection) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, o in Text(o.1).tag(o.0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier(id)
        }
    }

    private var sectionTitle: String {
        switch node.type {
        case .condition: return L("Condition")
        case .ask: return L("Question")
        case .loop: return L("Build the list from")
        case .review: return L("Guidance (optional)")
        default: return L("Instruction")
        }
    }
    private var placeholder: String {
        switch node.type {
        case .condition: return L("e.g. The tests are green.")
        case .review: return L("e.g. Also name the test account.")
        default: return L("What should happen here?")
        }
    }

    // ── Slash picker ──
    // Detection ("/word" at the very front, no space) and sorting are the SAME functions
    // as in the composer: `slashWord(in:)` and `slashSorted` from Chat/ChatViewModel+Slash.swift —
    // no copy that could silently drift. The whole text is checked, because SwiftUI's TextField
    // passes no insertion point outward.

    /// The picker entries of the two harness commands — from `nodeCommands`, so that chips and picker
    /// have ONE list. The descriptions are literal `L` calls (the loc-audit sees only those).
    private var commands: [ChatViewModel.SlashCommand] {
        Self.nodeCommands.map { command in
            let name = String(command.dropFirst())
            return ChatViewModel.SlashCommand(
                name: name,
                description: name == "clear"
                    ? L("Clear the context before the step runs")
                    : L("Compact the context before the step runs")
            )
        }
    }

    /// First the commands, then the skills, both filtered to the search — like `ChatViewModel.slashHits`.
    private var hits: (commands: [ChatViewModel.SlashCommand], skills: [SkillSummary]) {
        guard let q = slashQuery?.lowercased(), !q.isEmpty else { return (commands, skills) }
        return (slashSorted(commands, search: q, name: \.name), slashSorted(skills, search: q, name: \.name))
    }

    /// The effective skills of the workspace or project — the same route as the draft chat
    /// (`ChatViewModel.loadSkills`).
    private func loadSkills() async {
        skills = (try? await client.get(
            "/api/workspaces/\(workspaceId)/effective-skills",
            query: [URLQueryItem(name: "projectId", value: projectId ?? "")]
        )) ?? []
    }
}
