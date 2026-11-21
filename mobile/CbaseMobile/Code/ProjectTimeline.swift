import SwiftUI

// The timeline per project: Projects → Project → "Timeline" (`ProjectTimelinePage`, mounted in Code/ProjectView.swift) and as a sheet
// from the chat header (Chat/ProjectTimelineSheet.swift); same content as the web. Both show THE SAME list (`ProjectTimelineList`):
// vertical, day separators, per event time · kind symbol · title · source ("executed" + tool / "reported", chat title, "Subagent") ·
// tags · short anchor; collecting events expand; filters kind/chat/tag; "Load more" via `further`; dismissing needs a reason;
// dismissed events are greyed out with the reason; the project switch. Tapping the source opens the chat (for a subagent its sheet).
// Reloaded on the SSE event `timeline` (`AppState.timelineTick`). Wire and model: Models/TimelineModels.swift. No surfaces: rows on
// the background.
//
// A real timeline like on the web: per row time · round node with the kind's SF Symbol on a vertical line (per day from the first to
// the last node) · title and below it the small source. Collecting event = accent node, dismissed = dashed grey node and struck-through
// title. Tapping the row opens the sheet `ProjectTimelineDetailSheet` (the web's detail card): kind, full date, title, description,
// source (jumps), anchor, tags (filter), parts, dismissal reason.
//
// Identifiers in title and text are links (the server computes the pieces); the "Links" row opens MR, commit and branch in GitLab or
// GitHub, the "Agenda" row jumps to the agenda item (`agenda`), "revised" expands the earlier revisions, and "Edit …" (row menu and
// sheet) creates a new revision (`ProjectTimelineRevisionSheet`): no new event, the old revision stays.

/// The page inside a project (segment "Timeline").
struct ProjectTimelinePage: View {
    @EnvironmentObject private var state: AppState
    let project: Project
    let visible: Bool
    /// A chat jump: the projects page closes its sheet first (`InstanceJump`).
    let jump: (InstanceJump) -> Void

    @StateObject private var model: ProjectTimelineModel

    init(client: APIClient, project: Project, visible: Bool, jump: @escaping (InstanceJump) -> Void) {
        self.project = project
        self.visible = visible
        self.jump = jump
        _model = StateObject(wrappedValue: ProjectTimelineModel(client: client, projectId: project.id))
    }

    var body: some View {
        ProjectTimelineList(model: model, open: { f in
            guard let cid = f.chatId else { return }
            if let agent = f.subagentId { jump(.agentOpen(chatId: cid, agentId: agent)) } else { jump(.chatOpen(id: cid)) }
        }, agenda: { p in
            // From within the project: the item's chat (its agenda is opened by the chat header).
            if let cid = p.chatId { jump(.chatOpen(id: cid)) }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-timeline")
        .task { if !model.loaded { await model.load() } }
        .onChange(of: state.timelineTick[project.id] ?? 0) { _, _ in Task { await model.load() } }
        .onChange(of: visible) { _, fresh in if fresh { Task { await model.load() } } }
    }
}

/// The list itself, shared by page and sheet.
struct ProjectTimelineList: View {
    @ObservedObject var model: ProjectTimelineModel
    /// A tap on the source (only with a chat).
    let open: (ProjectTimelineCitation) -> Void
    /// A tap on the agenda item in the details (only with a chat); nil ⇒ the item is plain text.
    var agenda: ((ProjectTimelineAgendaPoint) -> Void)? = nil

    @State private var expanded: Set<String> = []
    @State private var dismiss: ProjectTimelineEvent?
    @State private var detail: ProjectTimelineEvent?
    @State private var edit: ProjectTimelineEvent?

    private struct Day: Identifiable {
        let id: String
        let title: String
        let events: [ProjectTimelineEvent]
    }

    /// Grouped by the device's calendar day; the order (newest first) stays the server's.
    private var days: [Day] {
        let cal = Calendar.current
        var out: [Day] = []
        for e in model.events {
            let d = cal.startOfDay(for: e.date)
            let id = String(Int(d.timeIntervalSince1970))
            if out.last?.id == id {
                let last = out.removeLast()
                out.append(Day(id: id, title: last.title, events: last.events + [e]))
            } else {
                out.append(Day(id: id, title: ProjectTimelineText.day(e.date), events: [e]))
            }
        }
        return out
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                if let error = model.error {
                    Text(error)
                        .cbFont(12.5)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .accessibilityIdentifier("timeline-error")
                }
                if !model.loaded {
                    CbRowSkeleton(rows: 4).padding(.horizontal, 8)
                } else if model.events.isEmpty {
                    CbEmpty(symbol: "clock.arrow.circlepath", text: emptyText, identifier: "timeline-empty")
                } else {
                    ForEach(days) { day in
                        CbSectionHeader(title: day.title)
                            .padding(.horizontal, 8)
                            .padding(.top, 14)
                        ForEach(Array(day.events.enumerated()), id: \.element.id) { i, e in
                            row(e, first: i == 0, last: i == day.events.count - 1)
                        }
                    }
                    if model.further != nil {
                        HStack {
                            Spacer()
                            if model.loadingMore {
                                ProgressView()
                            } else {
                                CbTextButton(title: L("Load more")) { Task { await model.loadMore() } }
                                    .accessibilityIdentifier("timeline-more")
                            }
                            Spacer()
                        }
                        .padding(.vertical, 14)
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .cbRefreshable { await model.load() }
        .sheet(item: $dismiss) { e in
            ProjectTimelineDismissSheet(event: e) { reason in
                try await model.dismiss(e.id, justification: reason)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $detail) { e in
            ProjectTimelineDetailSheet(event: e, open: { f in detail = nil; open(f) }, word: { w in detail = nil; model.filterWord = w },
                                       agenda: agenda.map { a in { p in detail = nil; a(p) } },
                                       edit: { detail = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { edit = e } })
                .cbSheet(.half)
        }
        .sheet(item: $edit) { e in
            ProjectTimelineRevisionSheet(event: e) { title, text, reason in
                try await model.revise(e, title: title, text: text, justification: reason)
            }
            .cbSheet(.whole)
        }
    }

    private var emptyText: String {
        if model.filterKind != nil || model.filterChat != nil || model.filterWord != nil { return L("No event matches the filter.") }
        return L("No events yet. The timeline fills up as soon as the timeline agent records something.")
    }

    // ── Header: switch and filters ─────────────────────────────────────────────

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(get: { model.active ?? true }, set: { fresh in Task { await model.activeSet(fresh) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Keep timeline"))
                        .cbFont(15)
                        .foregroundStyle(CbColor.text)
                    if model.active == false {
                        Text(L("Off — the agent records nothing."))
                            .cbFont(12.5)
                            .foregroundStyle(CbColor.textMuted)
                    }
                }
            }
            .disabled(model.active == nil)
            .accessibilityIdentifier("timeline-toggle")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    kindFilter
                    chatFilter
                    wordFilter
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var kindFilter: some View {
        Menu {
            Button(L("All kinds")) { model.filterKind = nil }
            Divider()
            ForEach(ProjectTimelineKind.allCases) { a in
                Button { model.filterKind = a } label: { Label(a.word, systemImage: a.symbol) }
            }
        } label: {
            CbMenuLabel(title: model.filterKind?.word ?? L("Type"), systemImage: model.filterKind?.symbol, active: model.filterKind != nil)
        }
        .accessibilityIdentifier("timeline-filter-kind")
    }

    private var chatFilter: some View {
        let chats = model.knownChats.sorted { $0.value.localizedCaseInsensitiveCompare($1.value) == .orderedAscending }
        return Menu {
            Button(L("All chats")) { model.filterChat = nil }
            if !chats.isEmpty { Divider() }
            ForEach(chats, id: \.key) { c in
                Button(c.value) { model.filterChat = c.key }
            }
        } label: {
            CbMenuLabel(title: model.filterChat.map { model.knownChats[$0] ?? $0 } ?? L("Chat"),
                           systemImage: "bubble.left", active: model.filterChat != nil)
        }
        .accessibilityIdentifier("timeline-filter-chat")
    }

    private var wordFilter: some View {
        Menu {
            Button(L("All tags")) { model.filterWord = nil }
            if !model.knownWords.isEmpty { Divider() }
            ForEach(model.knownWords.sorted(), id: \.self) { w in
                Button("#" + w) { model.filterWord = w }
            }
        } label: {
            CbMenuLabel(title: model.filterWord.map { "#" + $0 } ?? L("Tag"), systemImage: "number", active: model.filterWord != nil)
        }
        .accessibilityIdentifier("timeline-filter-word")
    }

    // ── Row ────────────────────────────────────────────────────────────────

    private func row(_ e: ProjectTimelineEvent, first: Bool, last: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ProjectTimelineRow(event: e, first: first, last: last,
                                 details: { detail = e }, dismiss: { dismiss = e }, edit: { edit = e }) {
                if !e.parts.isEmpty {
                    Button {
                        if expanded.contains(e.id) { expanded.remove(e.id) } else { expanded.insert(e.id) }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: expanded.contains(e.id) ? "chevron.down" : "chevron.right")
                                .font(.symbol(10, weight: .semibold))
                            Text(e.parts.count == 1 ? L("1 part") : L("{n} parts", ["n": e.parts.count]))
                                .cbFont(12.5, weight: .medium)
                        }
                        .foregroundStyle(CbColor.textSecondary)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("timeline-parts-\(e.id)")
                }
            }
            if expanded.contains(e.id) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(e.parts.enumerated()), id: \.element.id) { i, t in
                        ProjectTimelineRow(event: t, part: true, first: i == 0, last: i == e.parts.count - 1,
                                             details: { detail = t }, dismiss: { dismiss = t }, edit: { edit = t }) { EmptyView() }
                    }
                }
                .padding(.leading, 16 + ProjectTimelineRow<EmptyView>.partInset)
                // The day's line continues beside the parts if another event follows.
                .background(alignment: .topLeading) {
                    if !last {
                        Rectangle().fill(CbColor.edge).frame(width: 1)
                            .padding(.leading, ProjectTimelineRow<EmptyView>.lineX - 0.5)
                    }
                }
            }
        }
    }
}

/// A row on the timeline: time · node with the kind symbol on the line · title and source; a tap opens the details.
struct ProjectTimelineRow<Under: View>: View {
    let event: ProjectTimelineEvent
    var part = false
    let first: Bool
    let last: Bool
    let details: () -> Void
    let dismiss: () -> Void
    let edit: () -> Void
    @ViewBuilder let under: () -> Under

    /// Column metrics; the list's line and the parts' line use the same ones.
    static var clockTimeWidth: CGFloat { 44 }
    static var gap: CGFloat { 10 }
    static var node: CGFloat { 28 }
    static var nodePart: CGFloat { 20 }
    static var top: CGFloat { 8 }
    /// The centre of the node column (16 pt margin + time + gap + half a node).
    static var lineX: CGFloat { 16 + clockTimeWidth + gap + node / 2 }
    /// How far the parts are indented: to below the collecting event's title.
    static var partInset: CGFloat { clockTimeWidth + gap + node + gap }

    private var dismissed: Bool { event.dismissed != nil }
    private var collecting: Bool { !event.parts.isEmpty }
    private var d: CGFloat { part ? Self.nodePart : Self.node }

    var body: some View {
        HStack(alignment: .top, spacing: Self.gap) {
            if !part {
                Text(ProjectTimelineText.clockTime(event.date))
                    .cbFont(12, digitsEqual: true)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: Self.clockTimeWidth, height: d, alignment: .trailing)
                    .padding(.top, Self.top)
            }
            // The node column: line above the node (not for the first), node, line below to the end of the row (not for the last).
            VStack(spacing: 0) {
                Rectangle().fill(first ? Color.clear : CbColor.edge).frame(width: 1, height: Self.top)
                node
                Rectangle().fill(last ? Color.clear : CbColor.edge).frame(width: 1).frame(maxHeight: .infinity)
            }
            .frame(width: d)
            .frame(maxHeight: .infinity, alignment: .top)
            VStack(alignment: .leading, spacing: 3) {
                if part {
                    (Text(ProjectTimelineText.clockTime(event.date) + "  ").foregroundStyle(CbColor.textMuted) + Text(event.title))
                        .cbFont(13.5)
                        .lineLimit(2)
                } else {
                    Text(event.title)
                        .cbFont(15)
                        .lineLimit(2)
                }
                if !part, let f = event.citation {
                    Text(citationText(f))
                        .cbFont(12)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
                under()
            }
            .foregroundStyle(dismissed ? CbColor.textMuted : CbColor.text)
            .strikethrough(dismissed, color: CbColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Self.top + (d - 20) / 2)
            .padding(.bottom, Self.top + 4)
            Menu {
                Button(L("Details"), systemImage: "info.circle", action: details)
                Button(L("Edit …"), systemImage: "pencil", action: edit)
                    .disabled(dismissed)
                Button(L("Discard …"), systemImage: "xmark.circle", role: .destructive, action: dismiss)
                    .disabled(dismissed)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.symbol(13, weight: .semibold))
                    .foregroundStyle(CbColor.textMuted)
                    .frame(width: 30, height: d)
                    .contentShape(Rectangle())
            }
            .padding(.top, Self.top)
            .accessibilityLabel(L("Actions"))
            .accessibilityIdentifier("timeline-menu-\(event.id)")
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, part ? 0 : 16)
        .padding(.trailing, part ? 16 : 0)
        .contentShape(Rectangle())
        .onTapGesture(perform: details)
        .accessibilityHint(L("Shows the details"))
        .accessibilityIdentifier("timeline-row-\(event.id)")
    }

    /// The round node: the kind's SF Symbol; collecting event in accent, dismissed dashed and grey.
    private var node: some View {
        let kind = event.kindValue
        return ZStack {
            if dismissed {
                Circle().strokeBorder(CbColor.textMuted.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [2.5, 2]))
            } else if collecting {
                Circle().fill(Color.accentColor.opacity(0.12))
                Circle().strokeBorder(Color.accentColor.opacity(0.55), lineWidth: 1)
            } else {
                Circle().strokeBorder(CbColor.edge, lineWidth: 1)
            }
            Image(systemName: kind.symbol)
                .font(.symbol(part ? 9.5 : 11.5, weight: .medium))
                .foregroundStyle(dismissed ? CbColor.textMuted : collecting ? Color.accentColor : CbColor.textSecondary)
        }
        .frame(width: d, height: d)
        .accessibilityLabel(kind.word)
        .accessibilityIdentifier("timeline-node-\(event.id)")
    }

    private func citationText(_ f: ProjectTimelineCitation) -> String {
        [
            ProjectTimelineText.citation(f),
            f.chatId.map { _ in (f.chatTitle?.isEmpty == false ? f.chatTitle! : L("Chat")) },
            f.subagentId != nil ? L("Subagent") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }
}

/// The details of an event (the web's detail card): kind and date, title, description, source (jumps to the chat), anchor, tags
/// (a tap filters), parts and, if dismissed, who, when and why.
struct ProjectTimelineDetailSheet: View {
    let event: ProjectTimelineEvent
    let open: (ProjectTimelineCitation) -> Void
    let word: (String) -> Void
    var agenda: ((ProjectTimelineAgendaPoint) -> Void)? = nil
    var edit: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var previous = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 6) {
                        Image(systemName: event.kindValue.symbol)
                            .font(.symbol(12, weight: .medium))
                            .foregroundStyle(event.dismissed == nil ? Color.accentColor : CbColor.textMuted)
                        Text(event.kindValue.word + (event.parts.isEmpty ? "" : " · " + L("Collecting event")))
                            .cbFont(12.5, weight: .medium)
                        Spacer(minLength: 8)
                        Text(event.date.formatted(date: .abbreviated, time: .shortened))
                            .cbFont(12.5, digitsEqual: true)
                    }
                    .foregroundStyle(CbColor.textMuted)
                    Text(ProjectTimelineChunk.text(event.titleChunks) ?? AttributedString(event.title))
                        .cbFont(19, weight: .semibold)
                        .foregroundStyle(event.dismissed == nil ? CbColor.text : CbColor.textMuted)
                        .strikethrough(event.dismissed != nil, color: CbColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    if event.text.isEmpty {
                        Text(L("No description."))
                            .cbFont(14)
                            .foregroundStyle(CbColor.textMuted)
                    } else {
                        Text(ProjectTimelineChunk.text(event.textChunks) ?? AttributedString(event.text))
                            .cbFont(15)
                            .foregroundStyle(CbColor.textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("timeline-detail-text")
                    }
                    CbHairline()
                    VStack(alignment: .leading, spacing: 10) {
                        if let f = event.citation { fact(L("Source")) { citation(f) } }
                        if let a = event.anchor?.short {
                            fact(L("Git anchor")) {
                                Text(a).cbFont(13, design: .monospaced).foregroundStyle(CbColor.textSecondary).textSelection(.enabled)
                            }
                        }
                        if let l = event.links, !l.empty {
                            fact(L("Links")) { links(l) }
                        }
                        if let p = event.agendaItem {
                            fact(L("Agenda")) { agendaItem(p) }
                        }
                        if !event.tags.isEmpty {
                            fact(L("Tags")) {
                                ChipFlow(spacing: 6, lineSpacing: 4) {
                                    ForEach(event.tags, id: \.self) { w in
                                        Button { word(w) } label: {
                                            Text("#" + w).cbFont(13).foregroundStyle(CbColor.textSecondary)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        if !event.parts.isEmpty {
                            fact(L("Parts")) {
                                Text(event.parts.count == 1 ? L("1 part") : L("{n} parts", ["n": event.parts.count]))
                                    .cbFont(13).foregroundStyle(CbColor.textSecondary)
                            }
                        }
                    }
                    if event.revisions.count > 1 { revisions }
                    if let v = event.dismissed {
                        CbHairline()
                        Text(ProjectTimelineText.dismissed(v))
                            .cbFont(13.5)
                            .foregroundStyle(CbColor.textMuted)
                            .italic()
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("timeline-dismissed-\(event.id)")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .cbSheetBase()
            .navigationTitle(L("Event"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "timeline-detail-close") { dismiss() }
                if let edit, event.dismissed == nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button(L("Edit"), action: edit)
                            .accessibilityIdentifier("timeline-detail-edit")
                    }
                }
            }
        }
        .accessibilityIdentifier("timeline-detail-\(event.id)")
    }

    /// MR · commit · branch of the anchor in GitLab or GitHub (the server builds the addresses).
    private func links(_ l: ProjectTimelineLinks) -> some View {
        let a = event.anchor
        let parts: [(String, URL, String)] = [
            l.mr.map { (a?.mrIid.map { "!\($0)" } ?? L("MR"), $0, "mr") },
            l.commit.map { (a?.sha.map { String($0.prefix(8)) } ?? L("Commit"), $0, "commit") },
            l.branch.map { (a?.branch ?? L("Branch"), $0, "branch") },
        ].compactMap { $0 }
        return ChipFlow(spacing: 10, lineSpacing: 4) {
            ForEach(parts, id: \.2) { word, url, kind in
                Button { openURL(url) } label: {
                    HStack(spacing: 3) {
                        Text(word).lineLimit(1)
                        Image(systemName: "arrow.up.right").font(.symbol(9, weight: .semibold))
                    }
                    .cbFont(13, design: kind == "mr" ? .default : .monospaced)
                    .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("timeline-link-\(kind)-\(event.id)")
            }
        }
    }

    /// The agenda item: a tap jumps to the chat (or its agenda); gone from the agenda ⇒ plain text.
    @ViewBuilder
    private func agendaItem(_ p: ProjectTimelineAgendaPoint) -> some View {
        if let text = p.text, p.chatId != nil, let agenda {
            Button { agenda(p) } label: {
                HStack(spacing: 4) {
                    Text(text.isEmpty ? p.id : text).lineLimit(2)
                    Image(systemName: "arrow.up.right").font(.symbol(9, weight: .semibold))
                }
                .cbFont(13)
                .foregroundStyle(Color.accentColor)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("timeline-agenda-\(event.id)")
        } else {
            Text(p.text.map { $0.isEmpty ? p.id : $0 } ?? L("Item {id} (no longer in the agenda)", ["id": p.id]))
                .cbFont(13)
                .foregroundStyle(p.text == nil ? CbColor.textMuted : CbColor.textSecondary)
                .accessibilityIdentifier("timeline-agenda-\(event.id)")
        }
    }

    /// "Revised by you · date" and the earlier revisions to expand (newest first).
    private var revisions: some View {
        let last = event.revisions[event.revisions.count - 1]
        let earlier = Array(event.revisions.dropLast().reversed())
        return VStack(alignment: .leading, spacing: 8) {
            CbHairline()
            Button { withAnimation(.snappy) { previous.toggle() } } label: {
                HStack(spacing: 6) {
                    Text((last.from == "human" ? L("Revised by you") : L("Revised by the agent")) + " · "
                         + last.date.formatted(date: .abbreviated, time: .shortened))
                    Spacer(minLength: 8)
                    Image(systemName: previous ? "chevron.down" : "chevron.right").font(.symbol(10, weight: .semibold))
                }
                .cbFont(13, weight: .medium)
                .foregroundStyle(CbColor.textMuted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("timeline-revisions-\(event.id)")
            if !last.justification.isEmpty {
                Text(last.justification).cbFont(13).foregroundStyle(CbColor.textMuted)
            }
            if previous {
                ForEach(Array(earlier.enumerated()), id: \.offset) { i, f in
                    VStack(alignment: .leading, spacing: 3) {
                        Text((f.from == "human" ? L("by you") : L("by the agent")) + " · " + f.date.formatted(date: .abbreviated, time: .shortened)
                             + (i == earlier.count - 1 ? " · " + L("first version") : ""))
                            .cbFont(12)
                            .foregroundStyle(CbColor.textMuted)
                        Text(f.title).cbFont(14, weight: .medium).foregroundStyle(CbColor.textSecondary)
                        if !f.text.isEmpty {
                            Text(f.text).cbFont(13.5).foregroundStyle(CbColor.textSecondary).lineLimit(6)
                        }
                        if !f.justification.isEmpty {
                            Text(f.justification).cbFont(13).italic().foregroundStyle(CbColor.textMuted)
                        }
                    }
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(CbColor.edge).frame(width: 1) }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func fact<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .cbFont(13)
                .foregroundStyle(CbColor.textMuted)
                .frame(width: 96, alignment: .leading)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func citation(_ f: ProjectTimelineCitation) -> some View {
        let text = [
            ProjectTimelineText.citation(f),
            f.chatId.map { _ in (f.chatTitle?.isEmpty == false ? f.chatTitle! : L("Chat")) },
            f.subagentId != nil ? L("Subagent") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
        return Group {
            if f.chatId != nil {
                Button { open(f) } label: {
                    HStack(spacing: 4) {
                        Text(text).lineLimit(2)
                        Image(systemName: "arrow.up.right").font(.symbol(9, weight: .semibold))
                    }
                    .cbFont(13)
                    .foregroundStyle(Color.accentColor)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(L("Opens the chat"))
            } else {
                Text(text).cbFont(13).foregroundStyle(CbColor.textSecondary).lineLimit(2)
            }
        }
        .accessibilityIdentifier("timeline-citation-\(event.id)")
    }
}

/// Dismiss with a mandatory reason; the event stays, greyed out.
struct ProjectTimelineDismissSheet: View {
    let event: ProjectTimelineEvent
    let send: (String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var running = false
    @State private var error: String?
    @FocusState private var focus: Bool

    private var empty: Bool { reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(event.title).cbFont(15)
                }
                Section {
                    TextField(L("Why is this event wrong?"), text: $reason, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focus)
                        .accessibilityIdentifier("timeline-dismiss-reason")
                } header: {
                    Text(L("Reason"))
                } footer: {
                    Text(L("Discarded events stay visible, greyed out with this reason."))
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(L("Discard event"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "timeline-dismiss-close", label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Dismiss")) {
                        running = true
                        Task {
                            do {
                                try await send(reason)
                                dismiss()
                            } catch {
                                self.error = error.localizedDescription
                            }
                            running = false
                        }
                    }
                    .disabled(empty || running)
                    .accessibilityIdentifier("timeline-dismiss-send")
                }
            }
            .onAppear { focus = true }
        }
    }
}

/// A new revision of title and text: no new event; source, time and kind stay, the old revision remains visible in the details.
/// The reason is free.
struct ProjectTimelineRevisionSheet: View {
    let event: ProjectTimelineEvent
    let send: (String, String, String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var text: String
    @State private var reason = ""
    @State private var running = false
    @State private var error: String?

    init(event: ProjectTimelineEvent, send: @escaping (String, String, String) async throws -> Void) {
        self.event = event
        self.send = send
        _title = State(initialValue: event.title)
        _text = State(initialValue: event.text)
    }

    private var possible: Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let x = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && (t != event.title || x != event.text) && !running
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L("Title"), text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .onChange(of: title) { _, fresh in if fresh.count > 200 { title = String(fresh.prefix(200)) } }
                        .accessibilityIdentifier("timeline-revision-title")
                } header: { Text(L("Title")) }
                Section {
                    TextField(L("Description"), text: $text, axis: .vertical)
                        .lineLimit(3...12)
                        .onChange(of: text) { _, fresh in if fresh.count > 4000 { text = String(fresh.prefix(4000)) } }
                        .accessibilityIdentifier("timeline-revision-text")
                } header: { Text(L("Description")) }
                Section {
                    TextField(L("What was wrong or unclear about the previous version?"), text: $reason, axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("timeline-revision-reason")
                } header: {
                    Text(L("Reason (optional)"))
                } footer: {
                    Text(L("A new version of title and text — the previous one stays visible in the detail card. Evidence, time and kind stay."))
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(L("Edit event"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "timeline-revision-close", label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) {
                        running = true
                        Task {
                            do {
                                try await send(title, text, reason)
                                dismiss()
                            } catch {
                                self.error = error.localizedDescription
                            }
                            running = false
                        }
                    }
                    .disabled(!possible)
                    .accessibilityIdentifier("timeline-revision-send")
                }
            }
        }
        .accessibilityIdentifier("timeline-revision-\(event.id)")
    }
}
