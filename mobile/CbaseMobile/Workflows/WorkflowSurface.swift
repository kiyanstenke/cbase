import SwiftUI
import UIKit

// Base of the drawing surface: dot grid and edges, as UIKit layers. Why not a SwiftUI `Canvas`: see the
// call in `canvas`. The edges live in `CAShapeLayer`s, whose path is mapped to screen space before
// rasterizing, so it stays sharp under the zoom transform, and a path change while panning costs no
// bitmap rebuild. The grid is a tiled pattern image (like the desktop's `radial-gradient`): O(1) per
// frame however large the surface gets; it is rebuilt only when the (rounded) zoom stage or the
// appearance changes. The zoom level does NOT come through SwiftUI but directly from the controller
// (scroll view to layers).
/// An edge in surface coordinates, plus a flag for whether it lies on a cycle.
struct WorkflowEdgePath: Equatable {
    var points: [CGPoint]
    var loop: Bool
}

struct WorkflowSurface: UIViewRepresentable {
    let control: WorkflowCanvasControl
    let edges: [WorkflowEdgePath]
    let edgesWithShift: (String, CGSize) -> [WorkflowEdgePath]

    func makeUIView(context: Context) -> WorkflowSurfaceView {
        let view = WorkflowSurfaceView()
        control.surface = view
        view.apply(zoom: control.scroll?.zoomScale ?? 1, edges: edges)
        return view
    }
    func updateUIView(_ view: WorkflowSurfaceView, context: Context) {
        control.surface = view
        control.edgesWithShift = edgesWithShift
        view.apply(edges: edges)
    }
}

final class WorkflowSurfaceView: UIView {
    private let grid = UIView()
    /// Halo under the edges of a cycle, like a highlighter, in the loop's colour. The cycle edges
    /// themselves live in their own layers (`loopLines`, `loopHeads`) because a CAShapeLayer knows
    /// only ONE colour and they are tinted slightly towards it.
    private let halo = CAShapeLayer()
    private let lines = CAShapeLayer()
    private let loopLines = CAShapeLayer()
    private let heads = CAShapeLayer()
    private let loopHeads = CAShapeLayer()
    private var gridZoom: CGFloat = 0
    private var gridStyle: UIUserInterfaceStyle = .unspecified
    private var zoom: CGFloat = 1
    private var edges: [WorkflowEdgePath] = []

    // Fine tile of 24 world pt, with a stronger dot every five cells so that some orientation remains
    // at low zoom without turning into a texture. Dots sit in the middle of their cell (otherwise the
    // tile border would cut each dot into quarters); the grid is offset by half a cell so that one dot
    // lies exactly on world (0,0).
    private static let fine: CGFloat = 24
    private static let coarse: CGFloat = fine * 5

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        grid.isUserInteractionEnabled = false
        addSubview(grid)
        for layer in [halo, lines, loopLines, heads, loopHeads] {
            layer.contentsScale = traitCollection.displayScale
            layer.actions = ["path": NSNull(), "strokeColor": NSNull(), "fillColor": NSNull(), "lineWidth": NSNull()]
            self.layer.addSublayer(layer)
        }
        halo.fillColor = nil
        halo.lineJoin = .round
        halo.lineCap = .round
        for layer in [lines, loopLines] {
            layer.fillColor = nil
            layer.lineJoin = .miter
            layer.lineCap = .butt
        }
        heads.strokeColor = nil
        loopHeads.strokeColor = nil
        // Light/dark switches without a SwiftUI update: the colours depend on the traits.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WorkflowSurfaceView, _) in
            view.apply(zoom: view.zoom, edges: view.edges)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        grid.frame = bounds.insetBy(dx: -Self.fine / 2, dy: -Self.fine / 2)
        for layer in [halo, lines, loopLines, heads, loopHeads] { layer.frame = bounds }
    }

    func apply(edges: [WorkflowEdgePath]) { apply(zoom: zoom, edges: edges) }
    func apply(zoom: CGFloat) { apply(zoom: zoom, edges: edges) }

    func apply(zoom: CGFloat, edges: [WorkflowEdgePath]) {
        self.zoom = zoom
        self.edges = edges
        // Below 50 % a fixed 1.6 pt line would shrink under one display pixel and nearly vanish through
        // antialiasing, so lines and arrowheads keep a legible minimum size on screen.
        let safeZoom = max(0.4, zoom)
        let lineWidth = max(1.6, 1.25 / safeZoom)
        let arrowLength = max(8, 6 / safeZoom)
        let arrowHalf = max(4, 3 / safeZoom)
        let opacity: CGFloat = safeZoom < 0.55 ? 0.88 : 0.65
        let color = UIColor.secondaryLabel.resolvedColor(with: traitCollection).withAlphaComponent(opacity).cgColor
        // Edges of a cycle: a soft halo in the loop colour under the line, the line itself tinted
        // slightly towards it, as on the desktop (LOOP_HALO / LOOP_STROKE).
        let loop = UIColor(WorkflowNodeType.loop.tint).resolvedColor(with: traitCollection)
        let haloColor = loop.withAlphaComponent(0.22).cgColor
        let loopColor = loop.withAlphaComponent(min(1, opacity + 0.2)).cgColor

        let linePath = CGMutablePath()
        let loopPath = CGMutablePath()
        let headPath = CGMutablePath()
        let loopHeadPath = CGMutablePath()
        for edge in edges {
            let points = edge.points
            guard let first = points.first, let end = points.last, points.count >= 2 else { continue }
            let path = edge.loop ? loopPath : linePath
            path.move(to: first)
            for p in points.dropFirst() { path.addLine(to: p) }
            // Filled arrowhead, aligned to the LAST segment, which runs horizontally onto the node's
            // side, from the left or from the right.
            let before = points[points.count - 2]
            let len = hypot(end.x - before.x, end.y - before.y)
            guard len > 0 else { continue }
            let ux = (end.x - before.x) / len, uy = (end.y - before.y) / len
            let base = CGPoint(x: end.x - ux * arrowLength, y: end.y - uy * arrowLength)
            let head = edge.loop ? loopHeadPath : headPath
            head.move(to: CGPoint(x: base.x - uy * arrowHalf, y: base.y + ux * arrowHalf))
            head.addLine(to: end)
            head.addLine(to: CGPoint(x: base.x + uy * arrowHalf, y: base.y - ux * arrowHalf))
            head.closeSubpath()
        }
        halo.path = loopPath
        halo.lineWidth = max(9, 7 / safeZoom)
        halo.strokeColor = haloColor
        lines.path = linePath
        lines.lineWidth = lineWidth
        lines.strokeColor = color
        loopLines.path = loopPath
        loopLines.lineWidth = lineWidth
        loopLines.strokeColor = loopColor
        heads.path = headPath
        heads.fillColor = color
        loopHeads.path = loopHeadPath
        loopHeads.fillColor = loopColor

        // Rebuild the grid only when needed: rounded zoom stage (a few times while pinching, not per
        // frame) or appearance change.
        let bucket = (zoom * 20).rounded() / 20
        let style = traitCollection.userInterfaceStyle
        if bucket != gridZoom || style != gridStyle {
            gridZoom = bucket
            gridStyle = style
            grid.backgroundColor = UIColor(patternImage: Self.gridTile(zoom: max(0.4, bucket), traits: traitCollection))
        }
    }

    // A 120 × 120 world-pt tile, rendered at the pixel density of the ZOOMED screen, otherwise the dots
    // would be blobs when zooming in. The radius divides by the zoom so the dots stay the same size on
    // screen; the fine layer fades out below 45 %, where the dots would sit so close that they form a
    // texture instead of a help.
    private static func gridTile(zoom: CGFloat, traits: UITraitCollection) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = traits.displayScale * zoom
        format.opaque = false
        let fineShare = min(1, max(0, (zoom - 0.45) / 0.3))
        let rFine = 1 / zoom
        let rCoarse = 1.5 / zoom
        let base = UIColor.secondaryLabel.resolvedColor(with: traits)
        return UIGraphicsImageRenderer(size: CGSize(width: coarse, height: coarse), format: format).image { ctx in
            let cg = ctx.cgContext
            let cells = Int(coarse / fine)
            for j in 0..<cells {
                for i in 0..<cells {
                    let c = CGPoint(x: (CGFloat(i) + 0.5) * fine, y: (CGFloat(j) + 0.5) * fine)
                    let coarsePoint = i == 0 && j == 0
                    if !coarsePoint, fineShare <= 0 { continue }
                    let r = coarsePoint ? rCoarse : rFine
                    cg.setFillColor(base.withAlphaComponent(coarsePoint ? 0.5 : 0.28 * fineShare).cgColor)
                    cg.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
                }
            }
        }
    }
}
