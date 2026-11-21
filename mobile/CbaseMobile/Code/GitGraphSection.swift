import SwiftUI

// The "Graph" section of the git sheet — the counterpart of web/src/components/git-bar/GitGraph.tsx and of `GraphSection` in
// GitSidebar.tsx, designed for mobile.
//
// One row per commit (44 pt — tap target): on the left the strip with the lanes (computation `GitGraph.computeLanes`, Swift twin of
// web/src/lib/git-graph.ts, bound in web/test/git-bar-ios-binding.test.mjs), on the right the subject, below it author and age
// muted and the ref badges (`GitGraph.badges`: HEAD branch as a filled capsule in the accent with a ring, other local ones outlined
// in their lane's color, remote with a cloud, tag with a label; a remote branch on the same commit as its local one becomes its cloud;
// more than fit ⇒ "+n"). Dots: HEAD a hollow ring, merge a ring with a core, otherwise a full dot. The HEAD branch's lane
// carries the accent, the other five calm tones (the same as `--git-lane-0…4` on the web, light and dark).
//
// EXPANDING: a tap on a commit expands it IN PLACE (several at once, like VS Code): below it one row per changed file
// (symbol by file type `GitBar.fileKind`, name, folder muted, status letter in the colors of "Changes"), on the left the lanes
// continue (`GitGraph.continuousLanes`), its own as a bar from the dot to the last row. A tap on a file shows its diff in this
// commit in the diff sheet (`POST …/git/show` with `file`/`old`); the whole commit is shown by the list's last row and the commit
// row's context menu ("Show whole commit"). The first expand fetches the files (`POST …/git/show` with `files: true`), then they are
// kept per hash — a commit never changes. A merge shows them against the FIRST parent and says so; an old server without `files`
// means "not available yet", never "no files".
//
// LOADING (no clock of its own, as on the web): only while the section is open, anew when the state of the shown repo in the tree
// changes (`GitGraph.graphState`), on pull-to-refresh, with "Refresh" in the "…" and with the extent choice ("All" / "Current
// branch", remembered under `GitGraph.GRAPH_EXTENT_KEY`). "Load more" asks the same list longer (`GitGraph.loadMore`: +50, at most 500).
//
// WIDTH: measured on the list itself — the graph takes at most just under a quarter (`GitGraph.graphMaxPx`), each lane 11 pt, when
// tight narrower down to 6 pt, below that clipped (`GitGraph.laneGeometry`: the right columns in ONE dashed collecting column, with a
// note above the list). From 340 pt two badges per row, below that one. Drawn with `Canvas` — allowed because nothing is zoomed here
// (the trap applies to a zoomed UIScrollView).

/// The colors of the lanes and file types — light and dark as on the web (`--git-lane-0…4` = `--kit-copy-0,1,2,3,5`; `--file-<tone>`).
enum GitGraphColors {
    static let lanes: [(light: String, dark: String)] = [
        ("#2f857d", "#5fb3aa"), // teal
        ("#6f5cc0", "#a394e0"), // lilac
        ("#b05a7a", "#d38fa8"), // dusty rose
        ("#87693f", "#b39a77"), // sand
        ("#627a3c", "#9bb07a"), // sage
    ]
    static let tones: [String: (light: String, dark: String)] = [
        "blue": ("#2f7499", "#519aba"), "yellow": ("#8f8414", "#cbcb41"), "orange": ("#b8581c", "#e37933"),
        "purple": ("#7a4fa3", "#a074c4"), "green": ("#4c7d1c", "#8dc149"), "red": ("#a8373d", "#cc5a5f"),
    ]

    private static func dynamic(_ w: (light: String, dark: String)) -> Color {
        let h = AccentColor.uiColor(hex: w.light), d = AccentColor.uiColor(hex: w.dark)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? d : h })
    }

    private static let laneColors: [Color] = lanes.map(dynamic)
    private static let toneColors: [String: Color] = tones.mapValues(dynamic)

    static func lane(_ f: GitGraph.LaneColor) -> Color {
        switch f {
        case .accent: return .accentColor
        case .palette(let i):
            let n = laneColors.count
            return laneColors[((i % n) + n) % n]
        }
    }

    static func tone(_ t: String) -> Color { toneColors[t] ?? CbColor.textMuted }
}

/// The graph's dimensions in points.
enum GitGraphMass {
    static let row: CGFloat = 44
    static let file: CGFloat = 36
    static let hint: CGFloat = 30
    static let margin: CGFloat = 3
    static let stroke: CGFloat = 1.7
    /// Gap between strip and text.
    static let gap: CGFloat = 6
}

/// The x position of a column including the collecting column (`kappe`) — ONE computation for commit and file rows, otherwise the bar would sit
/// beside its lane.
struct GitLaneSituation {
    let w: CGFloat
    let clipFrom: Int?
    let width: CGFloat

    init(_ geo: GitGraph.LaneGeometry) {
        w = CGFloat(geo.w)
        clipFrom = geo.clipFrom
        width = GitGraphMass.margin * 2 + CGFloat(geo.w * geo.columns)
    }

    func x(_ c: Int) -> CGFloat { GitGraphMass.margin + w * CGFloat(clipFrom.map { c >= $0 ? $0 : c } ?? c) + w / 2 }
    func collected(_ c: Int) -> Bool { clipFrom.map { c >= $0 } ?? false }
    /// The bar of an expanded commit's lane: 4 pt, slightly thinner in a narrow lane.
    var progressBar: CGFloat { min(4, max(2.5, w - 3)) }
}

/// What reloads the graph (`task(id:)`): repo, extent, state of the repo in the tree, "Refresh".
private struct GraphJob: Hashable {
    let repo: String
    let extent: GitGraph.Extent
    let snapshot: String
    let fresh: Int
}

struct GitGraphSection: View {
    @ObservedObject var model: GitModel
    @State private var width: CGFloat = 0

    var body: some View {
        if let repo = model.graphRepoObject {
            GitSectionHeader(id: "graph", title: L("Graph"), closed: model.isCollapsed("graph"), toggle: { model.toggle("graph") }) {
                header(repo)
            }
            if !model.isCollapsed("graph") {
                let job = GraphJob(
                    repo: repo.id,
                    extent: model.extent,
                    snapshot: GitGraph.graphState(hash: repo.lastCommit?.hash, branch: repo.branch, detached: repo.detached,
                                               upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind),
                    fresh: model.graphNew
                )
                content(repo)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                    .task(id: job) { await model.loadGraph(repo) }
                    .padding(.bottom, 10)
            }
        }
    }

    @ViewBuilder
    private func content(_ repo: GitRepo) -> some View {
        if let log = model.graphLog {
            if log.commits.isEmpty {
                GitGraphText(text: model.graphError.isEmpty ? L("No commits.") : model.graphError, error: !model.graphError.isEmpty)
            } else {
                GitGraphList(model: model, repo: repo, log: log, limit: model.graphLimit, open: model.openCommits,
                              files: model.commitFiles, width: width, error: model.graphError)
                    .equatable()
            }
        } else {
            GitGraphText(text: model.graphError.isEmpty ? L("Loading…##inline") : model.graphError, error: !model.graphError.isEmpty)
        }
    }

    /// The header on the right: repo (if several), extent, "…" with fetch/pull/push/refresh.
    @ViewBuilder
    private func header(_ repo: GitRepo) -> some View {
        if model.repos.count > 1 {
            Menu {
                ForEach(model.repos) { r in
                    Button { model.setGraphChoice(r.id) } label: {
                        if r.id == repo.id { Label(r.displayName, systemImage: "checkmark") } else { Text(r.displayName) }
                    }
                }
            } label: {
                GitHeaderLabel(text: repo.displayName, systemImage: "book.closed")
            }
            .accessibilityLabel(L("Graph repository: {name}", ["name": repo.displayName]))
            .accessibilityIdentifier("git-graph-repo")
        }
        let extentName = model.extent == .all ? L("All") : L("Current Branch")
        Menu {
            Button { model.setExtent(.all) } label: {
                if model.extent == .all { Label(L("All"), systemImage: "checkmark") } else { Text(L("All")) }
                Text(L("Local and remote branches, tags"))
            }
            Button { model.setExtent(.current) } label: {
                if model.extent == .current { Label(L("Current Branch"), systemImage: "checkmark") } else { Text(L("Current Branch")) }
                Text(L("HEAD and its upstream"))
            }
        } label: {
            GitHeaderLabel(text: extentName, systemImage: "arrow.triangle.branch")
        }
        .accessibilityLabel(L("Graph shows: {name}", ["name": extentName]))
        .accessibilityIdentifier("git-graph-extent")
        Menu {
            Button { Task { await model.fetch(repo) } } label: { Label(L("Fetch (update remote)"), systemImage: "icloud.and.arrow.down") }
                .disabled(repo.remote == nil)
            Button { Task { await model.pull(repo) } } label: {
                Label(repo.behind > 0 ? L("Pull ({behind} behind)", ["behind": repo.behind]) : L("Pull"), systemImage: "arrow.down")
            }
            .disabled(repo.remote == nil)
            Button { Task { await model.push(repo) } } label: {
                Label((repo.upstream ?? "").isEmpty ? L("Push (set upstream)") : L("Push"), systemImage: "arrow.up")
            }
            .disabled(!repo.canPush)
            Divider()
            Button { Task { await model.refresh() } } label: { Label(L("Refresh"), systemImage: "arrow.clockwise") }
        } label: {
            GitMenuButton()
        }
        .accessibilityLabel(L("More actions: {name}", ["name": L("Graph")]))
        .accessibilityIdentifier("git-graph-menu")
    }
}

/// The label of a choice in the header (repo, extent): symbol and name in a glass capsule.
private struct GitHeaderLabel: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).font(.symbol(10, weight: .semibold))
            Text(text).cbFont(12, weight: .medium).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(CbColor.textSecondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 30)
        .frame(maxWidth: 130)
        .fixedSize(horizontal: true, vertical: false)
        .cbGlassButton(Capsule())
    }
}

/// A note without lanes (above and below the list).
private struct GitGraphText: View {
    let text: String
    var error = false
    var inset: CGFloat = 0

    var body: some View {
        Text(text)
            .cbFont(12)
            .foregroundStyle(error ? Color.red : CbColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, inset)
            .frame(maxWidth: .infinity, minHeight: GitGraphMass.hint, alignment: .leading)
    }
}

/// The list. Equal as long as log, limit, expanded set, files, width and error are equal — the sheet often re-renders during a run
/// (clock, typing into the commit field); the lane computation then does not run along.
private struct GitGraphList: View, Equatable {
    let model: GitModel
    let repo: GitRepo
    let log: GitBar.GraphLog
    let limit: Int
    let open: Set<String>
    let files: [String: GitModel.CommitFilesStatus]
    let width: CGFloat
    let error: String

    static func == (a: GitGraphList, b: GitGraphList) -> Bool {
        a.repo.id == b.repo.id && a.log == b.log && a.limit == b.limit && a.open == b.open && a.files == b.files
            && a.width == b.width && a.error == b.error
    }

    var body: some View {
        let computation = GitGraph.computeLanes(log.commits.map(\.asCommit))
        let geo = GitGraph.laneGeometry(Double(computation.width), GitGraph.graphMaxPx(Double(width > 0 ? width : 360)))
        let situation = GitLaneSituation(geo)
        let inset = situation.width + GitGraphMass.gap
        let two = width >= 340
        let more = GitGraph.loadMore(limit, log.commits.count, log.clipped, GitBar.GRAPH_STEP, GitBar.GRAPH_MAX)
        LazyVStack(alignment: .leading, spacing: 0) {
            if computation.linear {
                GitGraphText(text: L("Linear: the server does not send parents yet (the full graph arrives with its next deploy)."))
                    .accessibilityIdentifier("git-graph-linear")
            }
            if let clipFrom = geo.clipFrom {
                GitGraphText(text: L("{n} lanes side by side — from lane {k} on merged into one dashed lane.", ["n": computation.width, "k": clipFrom + 1]))
                    .accessibilityIdentifier("git-graph-clipped-lanes")
            }
            ForEach(Array(log.commits.enumerated()), id: \.element.hash) { i, c in
                let z = computation.rows[i]
                let on = open.contains(c.hash)
                GitCommitRow(c: c, z: z, situation: situation, two: two, open: on,
                               toggle: { Task { await model.toggleCommit(repo, c) } },
                               whole: { Task { await model.showCommit(repo, c) } })
                if on {
                    GitCommitFilesList(c: c, z: z, situation: situation, snapshot: files[c.hash],
                                          file: { d in
                                              let target = GitCommitFileRow.target(d)
                                              Task { await model.showCommitFile(repo, c, file: target.file, old: target.old, title: target.title) }
                                          },
                                          whole: { Task { await model.showCommit(repo, c) } })
                }
            }
            if let more {
                Button { Task { await model.loadMore(repo, limit: more) } } label: {
                    Text(L("Load more"))
                        .cbFont(13, weight: .medium)
                        .foregroundStyle(.tint)
                        .padding(.leading, inset)
                        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("git-graph-more")
            }
            if more == nil && log.clipped == true {
                GitGraphText(text: L("Only the latest {n} commits — the graph does not show older ones.", ["n": log.commits.count]), inset: inset)
                    .accessibilityIdentifier("git-graph-cap")
            }
            if !error.isEmpty { GitGraphText(text: error, error: true, inset: inset) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git-graph-list")
        .accessibilityValue("\(log.commits.count)")
    }
}

/// A commit row: strip, subject, below it author · age and the badges. A tap expands, the context menu shows the whole
/// commit.
private struct GitCommitRow: View {
    let c: GitBar.GraphEntry
    let z: GitGraph.Row
    let situation: GitLaneSituation
    let two: Bool
    let open: Bool
    let toggle: () -> Void
    let whole: () -> Void

    var body: some View {
        let all = GitGraph.badges(c.refs)
        Button(action: toggle) {
            VStack(alignment: .leading, spacing: 3) {
                Text(c.subject.isEmpty ? c.short : c.subject)
                    .cbFont(14, weight: .medium)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                GitMetaLayout {
                    Text(verbatim: "\(c.author) · \(c.relative)")
                        .cbFont(12)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                    GitBadges(all: all, lane: z.color, max: two ? 2 : 1)
                }
            }
            .padding(.leading, situation.width + GitGraphMass.gap)
            .padding(.trailing, 2)
            .frame(maxWidth: .infinity, minHeight: GitGraphMass.row, maxHeight: GitGraphMass.row, alignment: .leading)
            .background(alignment: .leading) {
                GitLaneStrip(z: z, situation: situation, open: open).frame(width: situation.width)
            }
            .background {
                if open { RoundedRectangle(cornerRadius: 10, style: .continuous).fill(CbGlass.inside) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: whole) { Label(L("Show whole commit"), systemImage: "doc.on.doc") }
            Button { UIPasteboard.general.string = c.hash } label: { Label(L("Copy hash"), systemImage: "number") }
        }
        .accessibilityLabel(label(all))
        .accessibilityValue(open ? L("expanded") : L("collapsed"))
        .accessibilityHint(L("Tap to show the files"))
        .accessibilityIdentifier("git-commit-\(c.short)")
    }

    private func label(_ all: [GitGraph.Badge]) -> String {
        var parts = ["\(c.subject.isEmpty ? c.short : c.subject)", "\(c.author) · \(c.relative)"]
        if !all.isEmpty { parts.append(all.map { p in p.remote.map { "\(p.name) · \($0)" } ?? p.name }.joined(separator: ", ")) }
        if z.kind == .merge { parts.append(L("Merge commit ({n} parents)", ["n": c.parents?.count ?? 2])) }
        if z.kind == .head { parts.append("HEAD") }
        return parts.joined(separator: " — ")
    }
}

/// The files of an expanded commit — every row (also "loading…" and the notes) carries the continuous lanes and the bar.
private struct GitCommitFilesList: View {
    let c: GitBar.GraphEntry
    let z: GitGraph.Row
    let situation: GitLaneSituation
    let snapshot: GitModel.CommitFilesStatus?
    let file: (GitBar.CommitFile) -> Void
    let whole: () -> Void

    var body: some View {
        let lanes = GitGraph.continuousLanes(z)
        VStack(alignment: .leading, spacing: 0) {
            switch snapshot {
            case nil, .loading?:
                hint(L("Loading…##inline"), lanes)
            case .error(let text)?:
                hint(text, lanes, error: true)
            case .unknown?:
                hint(L("The server does not know a commit's files yet (after its next deploy) — \"Show whole commit\" works."), lanes)
            case .loaded(let w)?:
                let merge = (w.parent?.count ?? c.parents?.count ?? 0) > 1
                let first = w.parent?.first ?? c.parents?.first ?? ""
                let clipped = w.clipped == true || (w.total.map { $0 > w.files.count } ?? false)
                if merge && !first.isEmpty {
                    hint(L("Against the first parent {short}", ["short": String(first.prefix(8))]), lanes)
                        .accessibilityIdentifier("git-commit-against")
                }
                if w.files.isEmpty {
                    hint(merge ? L("No changes against the first parent.") : L("No files changed."), lanes)
                }
                ForEach(w.files, id: \.self) { d in
                    GitCommitFileRow(d: d, lanes: lanes, situation: situation) { file(d) }
                }
                if clipped {
                    hint(w.total.map { L("Only the first {n} of {m} files — the rest is not shown here.", ["n": w.files.count, "m": $0]) }
                            ?? L("Only the first {n} files — there are more.", ["n": w.files.count]), lanes)
                }
                if w.unreadable > 0 {
                    hint(L("{n} entries could not be read and are missing above.", ["n": w.unreadable]), lanes)
                }
            }
            Button(action: whole) {
                Label(L("Show whole commit"), systemImage: "doc.on.doc")
                    .cbFont(13, weight: .medium)
                    .foregroundStyle(.tint)
                    .padding(.leading, situation.width + GitGraphMass.gap + 4)
                    .frame(maxWidth: .infinity, minHeight: GitGraphMass.file, alignment: .leading)
                    .background(alignment: .leading) { GitThroughStrip(lanes: lanes, situation: situation).frame(width: situation.width) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("git-commit-whole-\(c.short)")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Files of {short}", ["short": c.short]))
        .accessibilityIdentifier("git-commit-files-\(c.short)")
    }

    private func hint(_ text: String, _ lanes: [GitGraph.ThroughLane], error: Bool = false) -> some View {
        Text(text)
            .cbFont(12)
            .foregroundStyle(error ? Color.red : CbColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, situation.width + GitGraphMass.gap + 4)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: GitGraphMass.hint, alignment: .leading)
            .background(alignment: .leading) { GitThroughStrip(lanes: lanes, situation: situation).frame(width: situation.width) }
            // ONE element: otherwise the wrapper carries the caller's identifier AND the text (measured: two hits for `git-commit-against`).
            .accessibilityElement(children: .combine)
    }
}

/// A file of the commit — the same form as the file row under "Changes", plus the symbol by file type and the lanes on the left.
private struct GitCommitFileRow: View {
    let d: GitBar.CommitFile
    let lanes: [GitGraph.ThroughLane]
    let situation: GitLaneSituation
    let open: () -> Void

    /// What `POST …/git/show` gets for this file's diff, and the sheet's title. For a rename both paths (otherwise
    /// git would show an addition); a copy (C) without the source — its own changes do not belong in this diff. A path with a leading "-"
    /// goes as `./-name` (`GitBar.diffPath`).
    static func target(_ d: GitBar.CommitFile) -> (file: String, old: String?, title: String) {
        let file = GitBar.diffPath(d.path)
        let old = d.status == "R" ? d.old.map { GitBar.diffPath($0) } : nil
        let title = d.old.map { a in d.status == "R" || d.status == "C" ? "\(a) → \(d.path)" : d.path } ?? d.path
        return (file, old, title)
    }

    var body: some View {
        let (name, folder) = GitBar.partsPath(d.path)
        let a = GitBar.commitStatusDisplay(d.status)
        let location = d.old.map { old in d.status == "R" || d.status == "C" ? "\(old) → \(d.path)" : d.path } ?? d.path
        Button(action: open) {
            HStack(spacing: 6) {
                GitFileSymbol(kind: GitBar.fileKind(d.path))
                Text(name)
                    .cbFont(13, design: .monospaced)
                    .strikethrough(a.deleted)
                    .foregroundStyle(a.deleted ? CbColor.textMuted : CbColor.text)
                    .lineLimit(1)
                    .layoutPriority(1)
                Text(folder)
                    .cbFont(12)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 2)
                Text(verbatim: a.letter)
                    .cbFont(12, weight: .bold, design: .monospaced)
                    .foregroundStyle(GitKindColor.color(a.kind))
                    .frame(width: 14)
            }
            .padding(.leading, situation.width + GitGraphMass.gap + 4)
            .padding(.trailing, 2)
            .frame(maxWidth: .infinity, minHeight: GitGraphMass.file, maxHeight: GitGraphMass.file, alignment: .leading)
            .background(alignment: .leading) { GitThroughStrip(lanes: lanes, situation: situation).frame(width: situation.width) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("{label}: {path} — tap for diff", ["label": L(a.label), "path": location]))
        .accessibilityIdentifier("git-commit-file-\(d.path)")
    }
}

/// A file's symbol: a shortcut in its language's color (like VS Code's Seti icons) or a line symbol.
private struct GitFileSymbol: View {
    let kind: GitBar.FileKind

    var body: some View {
        let color = kind.tone == "gray" ? CbColor.textMuted : GitGraphColors.tone(kind.tone)
        Group {
            if kind.kind == "shortcut", let k = kind.shortcut {
                Text(verbatim: k).tracking(-0.4).cbFont(9, weight: .bold, design: .monospaced)
            } else {
                Image(systemName: Self.symbol(kind.kind)).font(.symbol(12))
            }
        }
        .foregroundStyle(color)
        .frame(width: 18, height: 16)
        .accessibilityHidden(true)
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "image": return "photo"
        case "config": return "slider.horizontal.3"
        case "lock": return "lock"
        case "text": return "doc.text"
        default: return "doc"
        }
    }
}

// ── Badges ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/// A commit's second row: on the left "author · age", flush right the badges. Each badge as wide as its name (at most
/// `kappe`) — `frame(maxWidth:)` would stretch each to the full cap, so "v1.0" would be as wide as "origin/feature/checkout". If not
/// everything fits, the badges get at least half the row (the text truncates), and the longest is shortened first (with two
/// badges the author would otherwise vanish entirely). The first child is the text, all others are badges.
private struct GitMetaLayout: Layout {
    var gap: CGFloat = 8
    var plakGap: CGFloat = 4
    var clipFrom: CGFloat = 150

    private func widths(_ w: CGFloat, _ subviews: Subviews) -> [CGFloat] {
        guard !subviews.isEmpty else { return [] }
        let ideal = subviews.map { $0.sizeThatFits(.unspecified).width }
        let plateau = ideal.dropFirst().map { Swift.min($0, clipFrom) }
        guard !plateau.isEmpty else { return [Swift.min(ideal[0], w)] }
        let gaps = gap + plakGap * CGFloat(plateau.count - 1)
        let sum = plateau.reduce(0, +)
        if ideal[0] + gaps + sum <= w { return [ideal[0]] + plateau }
        let target = Swift.max(0, Swift.min(sum, Swift.max(w * 0.5 - gaps, w - gaps - ideal[0])))
        // Water level: the longest first down to a common cap c, until the sum fits.
        let sorted = plateau.sorted()
        var rest = target, c = target
        for (i, b) in sorted.enumerated() {
            let share = rest / CGFloat(sorted.count - i)
            if b <= share { rest -= b } else { c = share; break }
        }
        let clipped = plateau.map { Swift.min($0, c) }
        let text = Swift.max(0, Swift.min(ideal[0], w - gaps - clipped.reduce(0, +)))
        return [text] + clipped
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        if let w = proposal.width { return CGSize(width: w, height: height) }
        let b = widths(.infinity, subviews)
        let gaps = b.count > 1 ? gap + plakGap * CGFloat(b.count - 2) : 0
        return CGSize(width: b.reduce(0, +) + gaps, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let b = widths(bounds.width, subviews)
        guard !b.isEmpty else { return }
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: b[0], height: bounds.height))
        let plakWidth = b.dropFirst().reduce(0, +) + plakGap * CGFloat(Swift.max(0, b.count - 2))
        var x = bounds.maxX - plakWidth
        for (i, sv) in subviews.enumerated().dropFirst() {
            sv.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: b[i], height: nil))
            x += b[i] + plakGap
        }
    }
}

/// A commit's badges as individual children of the `GitMetaLayout` (no stack of their own — otherwise the layout could not shorten
/// them individually).
private struct GitBadges: View {
    let all: [GitGraph.Badge]
    let lane: GitGraph.LaneColor
    let max: Int

    var body: some View {
        Group {
            ForEach(Array(all.prefix(max)), id: \.self) { p in GitRefBadge(p: p, lane: lane) }
            if all.count > max {
                Text(verbatim: "+\(all.count - max)")
                    .cbFont(11)
                    .monospacedDigit()
                    .foregroundStyle(CbColor.textMuted)
                    .padding(.horizontal, 6)
                    .frame(height: 20)
                    .overlay(Capsule().strokeBorder(CbColor.edge, lineWidth: 1))
            }
        }
    }
}

private struct GitRefBadge: View {
    let p: GitGraph.Badge
    let lane: GitGraph.LaneColor

    var body: some View {
        if p.kind == "head" {
            HStack(spacing: 3) {
                Image(systemName: "smallcircle.filled.circle").font(.symbol(9, weight: .semibold))
                Text(p.name).cbFont(11, weight: .semibold).lineLimit(1).truncationMode(.middle)
                if p.remote != nil { Image(systemName: "cloud").font(.symbol(8, weight: .semibold)) }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(Capsule().fill(Color.accentColor))
        } else {
            let local = p.kind == "local"
            let color = GitGraphColors.lane(lane)
            HStack(spacing: 3) {
                Image(systemName: local ? "arrow.triangle.branch" : p.kind == "remote" ? "cloud" : "tag")
                    .font(.symbol(9, weight: .semibold))
                    .foregroundStyle(local ? color : CbColor.textMuted)
                Text(p.name)
                    .cbFont(11)
                    .foregroundStyle(local ? CbColor.text : CbColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if p.remote != nil {
                    Image(systemName: "cloud").font(.symbol(8)).foregroundStyle(CbColor.textMuted)
                }
            }
            .padding(.horizontal, 7)
            .frame(height: 20)
            .overlay(Capsule().strokeBorder(local ? color.opacity(0.62) : CbColor.edge, lineWidth: 1))
        }
    }
}

// ── The strips ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Coordinates as on the web (GitGraph.tsx strip): x(column) = margin + w·column + w/2, y 0 (top edge) · middle (dot) · height
// (bottom edge). Lines end just before the dot (the HEAD ring stays hollow, without a mask). Passing lanes that change column
// as an S curve; a lane ending in the dot as a quarter arc into the horizontal; a further parent horizontally outwards and
// as an arc downwards — the SVG's elliptical arcs here as cubic quarters (k = 0.5523). What lies in the collecting column is
// dashed. If the commit is expanded, the bar of its lane starts under the dot instead of the thin line downwards.
private let QUARTER: CGFloat = 0.5523

private struct GitLaneStrip: View {
    let z: GitGraph.Row
    let situation: GitLaneSituation
    let open: Bool

    var body: some View {
        Canvas { ctx, size in
            let h = size.height, m = h / 2
            let w = situation.w
            let r: CGFloat = w >= 10 ? 4.2 : w >= 8 ? 3.6 : 3
            let clearance = z.kind == .node ? r + 1.4 : r + 2.2
            let xs = situation.x(z.column)
            let own = open ? GitGraph.continuousLanes(z).first(where: \.own) : nil
            func stroke(_ p: Path, _ f: GitGraph.LaneColor, dashed: Bool = false, width: CGFloat = GitGraphMass.stroke) {
                ctx.stroke(p, with: .color(GitGraphColors.lane(f)),
                           style: StrokeStyle(lineWidth: width, lineCap: dashed ? .butt : .round, dash: dashed ? [2, 2] : []))
            }
            for s in z.through {
                let a = situation.x(s.from), b = situation.x(s.to)
                var p = Path()
                p.move(to: CGPoint(x: a, y: 0))
                if a == b { p.addLine(to: CGPoint(x: a, y: h)) } else {
                    p.addCurve(to: CGPoint(x: b, y: h), control1: CGPoint(x: a, y: m), control2: CGPoint(x: b, y: m))
                }
                stroke(p, s.color, dashed: situation.collected(s.from) || situation.collected(s.to))
            }
            if let top = z.top {
                stroke(Path { $0.move(to: CGPoint(x: xs, y: 0)); $0.addLine(to: CGPoint(x: xs, y: m - clearance)) }, top)
            }
            for s in z.incoming {
                let a = situation.x(s.from)
                let far = abs(a - xs) - clearance
                if far <= 0 {
                    stroke(Path { $0.move(to: CGPoint(x: a, y: 0)); $0.addLine(to: CGPoint(x: a, y: m - clearance)) }, s.color, dashed: true)
                    continue
                }
                let rx = min(w, far)
                let right = a > xs
                let end = right ? a - rx : a + rx
                var p = Path()
                p.move(to: CGPoint(x: a, y: 0))
                p.addCurve(to: CGPoint(x: end, y: m), control1: CGPoint(x: a, y: QUARTER * m),
                           control2: CGPoint(x: right ? a - rx + QUARTER * rx : a + rx - QUARTER * rx, y: m))
                p.addLine(to: CGPoint(x: right ? xs + clearance : xs - clearance, y: m))
                stroke(p, s.color, dashed: situation.collected(s.from))
            }
            if z.bottom && own == nil {
                stroke(Path { $0.move(to: CGPoint(x: xs, y: m + clearance)); $0.addLine(to: CGPoint(x: xs, y: h)) }, z.color)
            }
            for s in z.branching {
                let b = situation.x(s.to)
                let far = abs(b - xs) - clearance
                if far <= 0 {
                    stroke(Path { $0.move(to: CGPoint(x: b, y: m + clearance)); $0.addLine(to: CGPoint(x: b, y: h)) }, s.color, dashed: true)
                    continue
                }
                let rx = min(w, far), ry = h - m
                let right = b > xs
                let beginning = right ? b - rx : b + rx
                var p = Path()
                p.move(to: CGPoint(x: right ? xs + clearance : xs - clearance, y: m))
                p.addLine(to: CGPoint(x: beginning, y: m))
                p.addCurve(to: CGPoint(x: b, y: h), control1: CGPoint(x: right ? beginning + QUARTER * rx : beginning - QUARTER * rx, y: m),
                           control2: CGPoint(x: b, y: h - QUARTER * ry))
                stroke(p, s.color, dashed: situation.collected(s.to))
            }
            let pointColor = GitGraphColors.lane(z.color)
            let rPoint = z.kind == .head ? r + 0.9 + 0.95 : z.kind == .merge ? r + 0.7 + 0.75 : r
            if let own {
                stroke(Path { $0.move(to: CGPoint(x: xs, y: m + rPoint)); $0.addLine(to: CGPoint(x: xs, y: h)) }, own.color, width: situation.progressBar)
            }
            func circle(_ radius: CGFloat) -> Path { Path(ellipseIn: CGRect(x: xs - radius, y: m - radius, width: 2 * radius, height: 2 * radius)) }
            switch z.kind {
            case .head:
                ctx.stroke(circle(r + 0.9), with: .color(pointColor), lineWidth: 1.9)
            case .merge:
                ctx.stroke(circle(r + 0.7), with: .color(pointColor), lineWidth: 1.5)
                ctx.fill(circle(r * 0.45), with: .color(pointColor))
            case .node:
                ctx.fill(circle(r), with: .color(pointColor))
            }
        }
        .accessibilityHidden(true)
    }
}

/// The strip of a file row: each continuous lane vertically in its color (the collecting column once, dashed), the bar of the
/// own lane on top — over the full height, so row joins row without a seam.
private struct GitThroughStrip: View {
    let lanes: [GitGraph.ThroughLane]
    let situation: GitLaneSituation

    var body: some View {
        Canvas { ctx, size in
            let h = size.height
            var seen = Set<String>()
            for s in lanes where !s.own {
                let k = situation.collected(s.column) ? "collecting" : String(s.column)
                if seen.contains(k) { continue }
                seen.insert(k)
                let x = situation.x(s.column)
                ctx.stroke(Path { $0.move(to: CGPoint(x: x, y: 0)); $0.addLine(to: CGPoint(x: x, y: h)) },
                           with: .color(GitGraphColors.lane(s.color)),
                           style: StrokeStyle(lineWidth: GitGraphMass.stroke, dash: situation.collected(s.column) ? [2, 2] : []))
            }
            if let own = lanes.first(where: \.own) {
                let x = situation.x(own.column)
                ctx.stroke(Path { $0.move(to: CGPoint(x: x, y: 0)); $0.addLine(to: CGPoint(x: x, y: h)) },
                           with: .color(GitGraphColors.lane(own.color)), lineWidth: situation.progressBar)
            }
        }
        .accessibilityHidden(true)
    }
}
