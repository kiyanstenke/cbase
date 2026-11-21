import SwiftUI

// The branch timeline of the big git overview — drawn from the answer of `GET /api/projects/:pid/gitView`
// (Models/GitViewModels.swift), embedded in Code/GitView.swift. The server computes groups, order, counts, branch point,
// dots/bars and key color; here ONLY time → x in the chosen window is computed (`GitTimeAxis`).
//
// The form: the name column is fixed on the left, the tracks of ALL rows lie in ONE horizontal `ScrollView` and scroll together —
// both columns build from the same list of entries (`GitTimeline.entries`) with fixed heights per kind, so name and track
// always line up. On top the axis with dates, below it the main line, then the groups in the order of `GitViewContract.groups`;
// "From cbase" carries the ended branches collapsed under "Finished (n)". The scroll view starts on the right (today).
//
// Per row: the hook of the branch point (└), the line to the last commit, the dots (pushed filled, unpushed hollow), not-yet-fetched
// ones dashed, a bar with a number instead of the dots above POINTS_MAX (`points == nil`), « with a date when the branch point
// lies before the window. A copy row in its key color (`GitKeyColor`, 6 calm colors light/dark), otherwise muted; remote rows
// without a local partner with a dashed line. No merge arc.
//
// Drawing uses `Canvas` — allowed because nothing is zoomed here. If zoom were added, the trap applies: a `Canvas` in a zoomed
// scroll view draws only a section; use UIKit layers then, as in Workflows/WorkflowSurface.swift.

// ── Key colors per copy ─────────────────────────────────────────────────────

/// The key color of a copy (index 0..COLORS-1 from the server, `instances[].color`): six calm tones, each light and dark — muted
/// enough that next to the accent they do not look like an action. The main has none.
enum GitKeyColor {
    static let values: [(light: String, dark: String)] = [
        ("#4f79a8", "#82a8d4"), // slate blue
        ("#5a8a67", "#8dbb98"), // sage
        ("#a5823a", "#d2b06b"), // ochre
        ("#85608b", "#b694bb"), // plum
        ("#3d8986", "#73b8b5"), // petrol
        ("#a8644b", "#d3957e"), // terracotta
    ]

    private static let colors: [Color] = values.map { w in
        let h = AccentColor.uiColor(hex: w.light), d = AccentColor.uiColor(hex: w.dark)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? d : h })
    }

    static func color(_ index: Int?) -> Color? {
        guard let index, !colors.isEmpty else { return nil }
        return colors[((index % colors.count) + colors.count) % colors.count]
    }
}

// ── Time → x ────────────────────────────────────────────────────────────────

/// The axis window: from, until (now) and the width of the track area. Pure.
struct GitTimeAxis: Equatable {
    let from: Double
    let until: Double
    let width: CGFloat

    static let marginLeft: CGFloat = 14
    static let marginRight: CGFloat = 34
    static let dayMs = 86_400_000.0

    /// The x position of a point in time (ms); before the window at the left edge, after it at the right.
    func x(_ t: Double) -> CGFloat {
        let usable = width - Self.marginLeft - Self.marginRight
        guard until > from else { return Self.marginLeft }
        let share = min(max((t - from) / (until - from), 0), 1)
        return Self.marginLeft + CGFloat(share) * usable
    }

    func inWindow(_ t: Double) -> Bool { t >= from }

    /// The window: "7d" and "30d" up to now, "everything" from the earliest point of the answer (at least a week). The width grows
    /// with the days — 46 pt per day at seven, 22 at thirty, at "everything" so much that it becomes ≈ 3,200 pt at most.
    static func compute(window: String, response: GitViewResponse, now: Double) -> GitTimeAxis {
        let days: Double
        let perDay: CGFloat
        switch window {
        case "7d":
            days = 7
            perDay = 46
        case "everything":
            let early = earliest(response) ?? (now - 30 * dayMs)
            days = max(7, ((now - early) / dayMs).rounded(.up) + 1)
            perDay = max(4, min(22, 3200 / CGFloat(days)))
        default:
            days = 30
            perDay = 22
        }
        return GitTimeAxis(from: now - days * dayMs, until: now, width: marginLeft + marginRight + CGFloat(days) * perDay)
    }

    /// The earliest point in time of the answer (main line, branch points, commits).
    static func earliest(_ a: GitViewResponse) -> Double? {
        var values: [Double] = []
        if let v = a.line?.from { values.append(v) }
        if let c = a.line?.commits?.first { values.append(c) }
        for z in a.rows ?? [] {
            if let t = z.branchPoint { values.append(t) }
            if let t = z.last?.t { values.append(t) }
            if let t = z.commits?.points?.first?.t { values.append(t) }
        }
        return values.filter { $0 > 0 }.min()
    }

    /// The ticks of the axis: aligned to midnight, far enough apart that their dates do not collide (≥ 56 pt).
    func strokes() -> [Double] {
        let perDay = (width - Self.marginLeft - Self.marginRight) / CGFloat(max((until - from) / Self.dayMs, 1))
        let steps = [1, 2, 3, 7, 14, 30, 61, 91, 182, 365]
        let step = steps.first { CGFloat($0) * perDay >= 56 } ?? 365
        let calendar = Calendar.current
        var day = calendar.startOfDay(for: Date(timeIntervalSince1970: from / 1000))
        if day.timeIntervalSince1970 * 1000 < from { day = calendar.date(byAdding: .day, value: 1, to: day) ?? day }
        var out: [Double] = []
        // No tick so close before "today" that the two dates overlap.
        let limit = until - Double(56 / max(perDay, 0.1)) * Self.dayMs * 0.9
        while day.timeIntervalSince1970 * 1000 <= limit, out.count < 400 {
            out.append(day.timeIntervalSince1970 * 1000)
            guard let further = calendar.date(byAdding: .day, value: step, to: day) else { break }
            day = further
        }
        return out
    }
}

// ── The timeline ────────────────────────────────────────────────────────────

struct GitTimeline: View {
    let response: GitViewResponse
    let axis: GitTimeAxis
    /// Groups whose switch is off.
    let hidden: Set<String>
    @Binding var endedOpen: Bool
    let open: (GitViewRow) -> Void

    static let nameWidth: CGFloat = 150
    static let heightAxis: CGFloat = 26
    static let heightLine: CGFloat = 38
    static let heightHeader: CGFloat = 32
    static let heightRow: CGFloat = 56
    static let heightFlap: CGFloat = 36

    /// An entry of the timeline — both columns build from the same list.
    enum Entry: Identifiable {
        case header(group: String, count: Int)
        case row(GitViewRow)
        case fold(count: Int)

        var id: String {
            switch self {
            case .header(let g, _): return "header:\(g)"
            case .row(let z): return "row:\(z.id)"
            case .fold: return "fold"
            }
        }

        var height: CGFloat {
            switch self {
            case .header: return GitTimeline.heightHeader
            case .row: return GitTimeline.heightRow
            case .fold: return GitTimeline.heightFlap
            }
        }
    }

    /// The entries in the server's order, per group (`GitViewContract.groups`) with a header; in "cbase" the ended ones behind the fold.
    static func entries(_ rows: [GitViewRow], hidden: Set<String>, endedOpen: Bool) -> [Entry] {
        var out: [Entry] = []
        let known = Set(GitViewContract.groups)
        // A group this app does not know (new server) goes at the end — leaving it out would conceal it.
        let foreign = rows.map(\.group).filter { !known.contains($0) }
        var order = GitViewContract.groups
        for g in foreign where !order.contains(g) { order.append(g) }
        for g in order where !hidden.contains(g) {
            let inGroup = rows.filter { $0.group == g }
            guard !inGroup.isEmpty else { continue }
            out.append(.header(group: g, count: inGroup.count))
            if g == "cbase" {
                let open = inGroup.filter { !$0.ended }
                let ended = inGroup.filter(\.ended)
                out += open.map { .row($0) }
                if !ended.isEmpty {
                    out.append(.fold(count: ended.count))
                    if endedOpen { out += ended.map { .row($0) } }
                }
            } else {
                out += inGroup.map { .row($0) }
            }
        }
        return out
    }

    var body: some View {
        let list = Self.entries(response.rows ?? [], hidden: hidden, endedOpen: endedOpen)
        let now = Date()
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: Self.heightAxis)
                linesName
                ForEach(list) { e in
                    nameCell(e, now: now)
                        .frame(height: e.height)
                        .overlay(alignment: .bottom) { CbHairline() }
                }
            }
            .frame(width: Self.nameWidth)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    GitAxis(axis: axis)
                        .frame(height: Self.heightAxis)
                    GitMainline(line: response.line, axis: axis)
                        .frame(height: Self.heightLine)
                        .overlay(alignment: .bottom) { CbHairline() }
                    ForEach(list) { e in
                        laneCell(e)
                            .frame(height: e.height)
                            .overlay(alignment: .bottom) { CbHairline() }
                    }
                }
                .frame(width: axis.width, alignment: .leading)
                .background(alignment: .topLeading) { GitRaster(axis: axis) }
            }
            .defaultScrollAnchor(.trailing)
        }
    }

    // ── The name column ──────────────────────────────────────────────────────

    private var linesName: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let h = response.mainBranch {
                Text(verbatim: h.name)
                    .cbFont(13.5, weight: .semibold)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                Text(L("Main line"))
                    .cbFont(11)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
            } else if response.mainBranchSupplied {
                Text(L("no main branch detected"))
                    .cbFont(12)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(2)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: Self.heightLine)
        .overlay(alignment: .bottom) { CbHairline() }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("git-mainline")
    }

    @ViewBuilder
    private func nameCell(_ e: Entry, now: Date) -> some View {
        switch e {
        case .header(let g, let count):
            HStack(spacing: 6) {
                Text(GitViewText.group(g))
                    .cbFont(12, weight: .semibold)
                    .foregroundStyle(CbColor.textMuted)
                Text(verbatim: "\(count)")
                    .cbFont(11.5)
                    .monospacedDigit()
                    .foregroundStyle(CbColor.textMuted.opacity(0.8))
            }
            .padding(.leading, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .padding(.bottom, 6)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("git-group-\(g)")
        case .fold(let count):
            Button {
                endedOpen.toggle()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: endedOpen ? "chevron.down" : "chevron.right")
                        .font(.symbol(10, weight: .semibold))
                    Text(L("Finished ({n})", ["n": count]))
                        .cbFont(12.5, weight: .medium)
                }
                .foregroundStyle(CbColor.textSecondary)
                .padding(.leading, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("git-ended")
        case .row(let z):
            Button {
                open(z)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        if z.isCopy {
                            Circle()
                                .fill(GitKeyColor.color(response.instance(z.instance)?.color) ?? CbColor.textMuted)
                                .frame(width: 7, height: 7)
                        }
                        Text(verbatim: z.shownName)
                            .cbFont(13.5, weight: .medium)
                            .foregroundStyle(z.ended ? CbColor.textSecondary : CbColor.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    // Two lines: the column is narrow, and a truncated count ("1 Chat ru…") says nothing.
                    Text(verbatim: GitViewText.shortLine(z, now: now))
                        .cbFont(11)
                        .monospacedDigit()
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.leading, z.isCopy ? 24 : 16)
                .padding(.trailing, 6)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(GitViewText.rowIdentifier(z))
        }
    }

    // ── The tracks ───────────────────────────────────────────────────────────

    @ViewBuilder
    private func laneCell(_ e: Entry) -> some View {
        switch e {
        case .header, .fold:
            Color.clear
        case .row(let z):
            GitLane(row: z, axis: axis, color: color(z))
                .contentShape(Rectangle())
                .onTapGesture { open(z) }
                .accessibilityHidden(true)
        }
    }

    private func color(_ z: GitViewRow) -> Color {
        if z.isCopy, let f = GitKeyColor.color(response.instance(z.instance)?.color) { return f }
        if z.ended { return CbColor.textMuted.opacity(0.7) }
        return z.local ? CbColor.textSecondary : CbColor.textMuted
    }
}

// ── Axis, grid, main line ───────────────────────────────────────────────────

/// The dates above the timeline; at the far right "today".
private struct GitAxis: View {
    let axis: GitTimeAxis
    /// The type of the dates follows the text size (guard tools/check/ios-font.test.mjs): in the Canvas as `Text`, hence via `@CbMetric`.
    @CbMetric private var font: CGFloat = 10

    var body: some View {
        Canvas { ctx, size in
            let y = size.height / 2 + 1
            for t in axis.strokes() {
                let text = Text(verbatim: GitViewText.date(t))
                    .font(.scaled(_font, weight: .medium))
                    .foregroundStyle(CbColor.textMuted)
                ctx.draw(text, at: CGPoint(x: axis.x(t), y: y), anchor: .center)
            }
            let today = Text(L("today"))
                .font(.scaled(_font, weight: .semibold))
                .foregroundStyle(CbColor.textSecondary)
            ctx.draw(today, at: CGPoint(x: axis.x(axis.until) + 4, y: y), anchor: .center)
        }
        .accessibilityHidden(true)
    }
}

/// Vertical hairlines at the axis ticks, behind all tracks.
private struct GitRaster: View {
    let axis: GitTimeAxis

    var body: some View {
        Canvas { ctx, size in
            for t in axis.strokes() + [axis.until] {
                var line = Path()
                let x = axis.x(t)
                line.move(to: CGPoint(x: x, y: GitTimeline.heightAxis))
                line.addLine(to: CGPoint(x: x, y: size.height))
                ctx.stroke(line, with: .color(CbColor.edge), lineWidth: 0.6)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The main line on top: one line across the window, one dot per first-parent commit in the window.
private struct GitMainline: View {
    let line: GitViewLine?
    let axis: GitTimeAxis

    var body: some View {
        Canvas { ctx, size in
            guard let commits = line?.commits else { return }
            let y = size.height / 2
            let start = max(line?.from ?? axis.from, axis.from)
            var line = Path()
            line.move(to: CGPoint(x: axis.x(start), y: y))
            line.addLine(to: CGPoint(x: axis.x(axis.until), y: y))
            ctx.stroke(line, with: .color(Color.accentColor.opacity(0.55)), lineWidth: 2)
            let inWindow = commits.filter { axis.inWindow($0) }
            // When close together the dots shrink so the line does not become a caterpillar.
            let r: CGFloat = inWindow.count > Int(axis.width / 6) ? 1.6 : 2.6
            for t in inWindow {
                let x = axis.x(t)
                ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(Color.accentColor))
            }
        }
        .accessibilityHidden(true)
    }
}

// ── One track ───────────────────────────────────────────────────────────────

/// The drawing of ONE row.
struct GitLane: View {
    let row: GitViewRow
    let axis: GitTimeAxis
    let color: Color
    /// Type of « and the number in the bar — follows the text size (in the Canvas as `Text`, hence via `@CbMetric`).
    @CbMetric private var font: CGFloat = 9.5

    static let radius: CGFloat = 3.6

    var body: some View {
        Canvas { ctx, size in
            let y = size.height / 2
            let end = row.last?.t ?? row.commits?.points?.last?.t ?? row.branchPoint
            guard let end else { return }
            let start = row.branchPoint ?? end
            let clipped = start < axis.from
            var x0 = axis.x(start)

            // « with a date: the branch point lies before the window.
            if clipped {
                let marker = ctx.resolve(Text(verbatim: "« " + GitViewText.date(start))
                    .font(.scaled(_font, weight: .medium))
                    .foregroundStyle(CbColor.textMuted))
                let size = marker.measure(in: CGSize(width: 200, height: size.height))
                ctx.draw(marker, at: CGPoint(x: GitTimeAxis.marginLeft - 10, y: y), anchor: .leading)
                x0 = max(GitTimeAxis.marginLeft - 10 + size.width + 5, axis.x(axis.from))
            } else if row.branchPoint != nil {
                // The hook of the branch point (└): from above (towards the main line) down onto the track.
                var checkMark = Path()
                checkMark.move(to: CGPoint(x: x0, y: 4))
                checkMark.addLine(to: CGPoint(x: x0, y: y))
                ctx.stroke(checkMark, with: .color(color.opacity(0.6)), lineWidth: 1.2)
            }
            let x1 = max(axis.x(end), x0)

            // The line to the last commit — dashed for a remote row without a local partner.
            var line = Path()
            line.move(to: CGPoint(x: x0, y: y))
            line.addLine(to: CGPoint(x: x1, y: y))
            ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: row.local ? [] : [3, 3]))

            // Not fetched: dashed on to the most recent missing commit, each as a dashed circle.
            let missing = (row.commits?.notFetched ?? []).filter { axis.inWindow($0) }
            if let latest = missing.max(), axis.x(latest) > x1 {
                var further = Path()
                further.move(to: CGPoint(x: x1, y: y))
                further.addLine(to: CGPoint(x: axis.x(latest), y: y))
                ctx.stroke(further, with: .color(color.opacity(0.7)), style: StrokeStyle(lineWidth: 1.2, dash: [2.5, 2.5]))
            }

            if let points = row.commits?.points {
                for p in points {
            // Before the window the dot sits at the edge behind «, not on it.
                    let x = p.t < axis.from ? x0 : axis.x(p.t)
                    let circle = Path(ellipseIn: CGRect(x: x - Self.radius, y: y - Self.radius, width: 2 * Self.radius, height: 2 * Self.radius))
                    if p.pushed {
                        ctx.fill(circle, with: .color(color))
                    } else {
                        ctx.fill(circle, with: .color(CbColor.ground))
                        ctx.stroke(circle, with: .color(color), lineWidth: 1.4)
                    }
                }
            } else if let count = row.commits?.count {
            // Above POINTS_MAX: a bar with the number.
                let text = ctx.resolve(Text(verbatim: "\(count)")
                    .font(.scaled(_font, weight: .semibold).monospacedDigit())
                    .foregroundStyle(color))
                let width = max(x1 - x0, text.measure(in: size).width + 12)
                let progressBar = Path(roundedRect: CGRect(x: x0, y: y - 7, width: width, height: 14), cornerRadius: 7)
                ctx.fill(progressBar, with: .color(CbColor.ground))
                ctx.fill(progressBar, with: .color(color.opacity(0.16)))
                ctx.stroke(progressBar, with: .color(color.opacity(0.55)), lineWidth: 1)
            // The number at the newest end: the timeline starts on the right (today), a long bar often reaches out of view to the left.
                ctx.draw(text, at: CGPoint(x: x0 + width - 6, y: y), anchor: .trailing)
            } else {
            // Without a main branch no dots: only the last commit as a dot.
                ctx.fill(Path(ellipseIn: CGRect(x: x1 - Self.radius, y: y - Self.radius, width: 2 * Self.radius, height: 2 * Self.radius)),
                         with: .color(color))
            }

            for t in missing {
                let x = axis.x(t)
                let circle = Path(ellipseIn: CGRect(x: x - Self.radius, y: y - Self.radius, width: 2 * Self.radius, height: 2 * Self.radius))
                ctx.fill(circle, with: .color(CbColor.ground))
                ctx.stroke(circle, with: .color(color.opacity(0.8)), style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
            }
        }
    }
}
