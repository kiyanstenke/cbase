import SwiftUI

/// The sheet behind the "Agenda" header button (`chat-agenda`) — the iOS counterpart of the "Agenda" section of the web's right
/// chat bar (`web/src/components/chat/AgendaPanel.tsx`). Presented from the chat root (`ChatView`).
///
/// READ-ONLY: the chat's agent maintains the agenda (`cbase_agenda_write`); what should change, the human tells it in the
/// chat. The sheet reads the model LIVE (`agendaState`, updated from the `agenda` event) — an item the agent ticks off moves
/// while the sheet is open.
///
/// A TREE of headings, as little text as possible: on top the title (one line) with "done/total", below it ONE line per visible
/// item — arrow (only with subitems), status symbol, text (truncated), "n/m" on items with subitems, project label on
/// top-level items, a small note symbol if there is a note. Description and notes are NOT in the flow: the symbol opens them as
/// a sheet with `MarkdownView`. Fully done subtrees start folded; the user folds per item (remembered per device and chat,
/// UserDefaults, same key as on the web). Shape per the HIG: a `List`, indent 12 pt per stage. The computations (visible rows,
/// stage, folding, progress, "… ago") live in `Chat/Agenda.swift`; the status of a top-level item is computed by the server.
///
/// An item the agenda keeper created or set (`upkeep`) carries a small ring in the accent colour on its status symbol — the row
/// stays ONE line. What the keeper did is in the item's sheet ("Set by the agenda keeper · before: in work · 4 min ago"); the
/// symbol leading there sits on every item with a note OR a mark. The ring stays even if the main agent touches the item
/// afterwards, and the explanation says so ("… · afterwards taken back by the main agent").
///
/// NAVIGATION as on the web: done points are hidden (a footer row "n done" shows them again, remembered per device and chat);
/// a search field (`.searchable`) searches the active tree locally and the archive on the server and replaces the list with one
/// row per hit (path below, "Archive" mark); a tap on an active hit makes it visible and scrolls there, on an archived hit opens
/// its archive entry. At the end the archive: "Archive (n)" collapsed, entries page by page, an entry expands to its archived
/// points (read-only, notes behind the usual symbol).
///
/// EVIDENCE as on the web: an item that timeline events of this chat refer to carries a small symbol with their count on the
/// right — nothing more. The symbol opens a sheet with time and title per event. Read via GET …/timeline/belege (only with a
/// project), reloaded on the project's SSE event `timeline` (`AppState.timelineTick`).
struct AgendaSheet: View {
    @ObservedObject var model: ChatViewModel
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    /// Item id → evidence (empty without a project or on an error — the agenda stays, just without the symbol).
    @State private var proofs: [String: [ProjectTimelineEvent]] = [:]
    /// The item whose evidence the sheet shows.
    @State private var proofsPoint: Agenda.Step?
    /// The deviations from the fold default — read from UserDefaults on opening, remembered on every tap.
    @State private var deviations: [String: Bool]
    /// What the note sheet currently shows (a note or the description).
    @State private var note: NoteContent?
    /// Done points shown — read from UserDefaults on opening, remembered on a tap on the footer row.
    @State private var showDone: Bool
    /// The search text and whether the search field is active.
    @State private var query = ""
    @State private var searching = false
    /// The server's hits for `serverQuery` (only its archived ones are used; the active ones are computed here).
    @State private var serverHits: [Agenda.Hit] = []
    @State private var serverQuery = ""
    @State private var hitsMore = false
    @State private var searchError = ""
    /// The archive section: expanded, the loaded entries, more pages, an error.
    @State private var archiveOpen = false
    @State private var archive: [Agenda.ArchiveEntry] = []
    @State private var archiveLoaded = false
    @State private var archiveMore = false
    @State private var archiveLoading = false
    @State private var archiveError = ""
    /// Entry id → its archived points (expanded entries only).
    @State private var archiveTrees: [Int: ArchiveTree] = [:]
    /// The row a jump from the search scrolls to, and the one briefly highlighted after it.
    @State private var scrollTarget: String?
    @State private var flash: String?

    /// Indent per stage (at most `Agenda.stages`).
    private static let inset: CGFloat = 12

    struct NoteContent: Identifiable {
        /// `description` or the item's id.
        let id: String
        let header: String
        let markdown: String
        var footnote: String?
        /// The explanation of the agenda keeper's mark — only on a marked item.
        var upkeep: String?
    }

    /// An expanded archive entry: `steps` nil while loading.
    struct ArchiveTree: Equatable {
        var steps: [Agenda.Step]?
        var error = ""
    }

    init(model: ChatViewModel) {
        self.model = model
        _deviations = State(initialValue: model.agendaDeviations())
        _showDone = State(initialValue: model.agendaShowsDone())
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var archivedCount: Int { model.agendaState.agenda?.archived ?? 0 }
    // Every new revision: a restore and an archive in one write keep the count, so the count alone would miss them.
    private var agendaVersion: Int { model.agendaState.agenda?.version ?? 0 }

    var body: some View {
        let snapshot = model.agendaState
        NavigationStack {
            Group {
                if !snapshot.loaded {
                    if snapshot.error.isEmpty {
                        hint(L("Loading…"), identifier: "chat-agenda-loading")
                    } else {
                        hint(L("The agenda could not be loaded: {error}", ["error": snapshot.error]), identifier: "chat-agenda-error")
                    }
                } else if !snapshot.keepsAgenda {
                    hint(L("This chat keeps no agenda — only coding chats have one."), identifier: "chat-agenda-empty")
                } else if let agenda = snapshot.agenda, !Agenda.empty(agenda) {
                    list(agenda, error: snapshot.error)
                } else {
                    hint(L("No agenda yet. The model creates one as soon as it has a plan."), identifier: "chat-agenda-empty")
                }
            }
            .navigationTitle(L("Agenda"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "chat-agenda-close") { dismiss() } }
            .searchable(text: $query, isPresented: $searching, prompt: L("Search the agenda"))
        }
        // A sheet opened before the first `connected` (or after an error) asks by itself.
        .task { if !model.agendaState.loaded { await model.loadAgenda() } }
        .task(id: "\(trimmedQuery)|\(archivedCount)|\(agendaVersion)") { await searchArchive() }
        .onChange(of: agendaVersion) { _, _ in
            // The archive changed (stream): what was loaded is stale — reload when expanded, else on the next expand.
            archiveTrees = [:]
            archiveLoaded = false
            if archiveOpen { Task { await loadArchive(more: false) } }
        }
        .task(id: proofsKey) { await loadProofs() }
        .sheet(item: $note) { content in noteSheet(content).cbSheet(.half) }
        .sheet(item: $proofsPoint) { p in proofsSheet(p).cbSheet(.half) }
    }

    private var projectId: String? {
        guard let id = model.chat.projectId, !id.isEmpty, !model.isDraft else { return nil }
        return id
    }
    private var proofsKey: String { "\(projectId ?? "")|\(projectId.map { state.timelineTick[$0] ?? 0 } ?? 0)" }

    private func loadProofs() async {
        guard let pid = projectId else { proofs = [:]; return }
        do {
            let a: ProjectTimelineProofsResponse = try await model.client.get("/api/projects/\(pid)/timeline/proofs",
                                                                             query: [URLQueryItem(name: "chat", value: model.chat.id)])
            proofs = a.perItem
        } catch {
            // Without evidence: just no symbol.
        }
    }

    /// The evidence of an item: time and title per event (discarded ones struck through), newest first.
    private func proofsSheet(_ p: Agenda.Step) -> some View {
        NavigationStack {
            List {
                Section {
                    ForEach(proofs[p.id] ?? []) { e in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(ProjectTimelineText.clockTime(e.date))
                                .font(.footnote)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                            Text(e.title)
                                .font(.subheadline)
                                .strikethrough(e.dismissed != nil)
                                .foregroundStyle(e.dismissed != nil ? .secondary : .primary)
                        }
                        .accessibilityIdentifier("chat-agenda-proof-\(e.id)")
                    }
                } header: {
                    Text(p.text).lineLimit(2)
                }
            }
            .navigationTitle(L("Evidence"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "chat-agenda-proofs-close") { proofsPoint = nil } }
        }
    }

    private func hint(_ text: String, identifier: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(identifier)
    }

    private func list(_ agenda: Agenda, error: String) -> some View {
        let shown = showDone ? agenda.steps : Agenda.withoutDone(agenda.steps)
        let rows = Agenda.visibleRows(shown, deviations: deviations)
        let hiddenDone = Agenda.hiddenDone(agenda.steps)
        return ScrollViewReader { proxy in
            CbList {
                if !trimmedQuery.isEmpty {
                    searchSection(agenda)
                } else {
                    Section {
                        header(agenda, error: error)
                    }
                    if !rows.isEmpty || hiddenDone > 0 {
                        Section {
                            ForEach(rows) { z in
                                row(z, all: agenda.steps)
                                    .background(highlight("step:\(z.id)"))
                                    .id("step:\(z.id)")
                            }
                            if hiddenDone > 0 { doneRow(hiddenDone) }
                        }
                    }
                    if agenda.archived > 0 || !archive.isEmpty {
                        archiveSection(count: max(agenda.archived, archive.count))
                    }
                }
            }
            .accessibilityIdentifier("chat-agenda-list")
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation { proxy.scrollTo(target, anchor: .center) }
                scrollTarget = nil
                flash = target
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { if flash == target { flash = nil } }
            }
        }
    }

    /// The brief mark on the row a jump landed on.
    private func highlight(_ id: String) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color.accentColor.opacity(flash == id ? 0.14 : 0))
            .padding(.horizontal, -6)
            .animation(.easeOut(duration: 0.4), value: flash)
    }

    /// The footer row: "n done" shows the done points, "Hide done" hides them again — remembered per device and chat.
    private func doneRow(_ n: Int) -> some View {
        Button {
            showDone.toggle()
            model.rememberAgendaShowsDone(showDone)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: showDone ? "eye.slash" : "checkmark.circle")
                    .frame(width: 14)
                    .accessibilityHidden(true)
                Text(showDone ? L("Hide done") : L("{n} done", ["n": n]))
                    .monospacedDigit()
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("chat-agenda-done-toggle")
    }

    // MARK: Search

    /// Debounced (250 ms) archive search on the server; the active tree is searched locally while typing.
    private func searchArchive() async {
        let q = trimmedQuery
        guard !q.isEmpty else {
            serverHits = []
            serverQuery = ""
            hitsMore = false
            searchError = ""
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        do {
            let page = try await model.searchAgendaArchive(q)
            guard !Task.isCancelled else { return }
            serverHits = page.hits
            serverQuery = q
            hitsMore = page.hitsMore
            searchError = ""
        } catch {
            guard !Task.isCancelled else { return }
            searchError = error.localizedDescription
        }
    }

    /// The hits instead of the list: active ones (local, at once) and archived ones (server, after the pause).
    @ViewBuilder
    private func searchSection(_ agenda: Agenda) -> some View {
        let q = trimmedQuery
        let hits = Agenda.mergeHits(local: Agenda.localHits(agenda.steps, query: q), server: serverQuery == q ? serverHits : [])
        Section {
            if hits.isEmpty {
                Text(serverQuery == q ? L("No matches") : L("Searching…"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat-agenda-search-empty")
            }
            ForEach(hits, id: \.key) { hit in
                Button { open(hit, agenda: agenda) } label: { hitRow(hit) }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("chat-agenda-hit-\(hit.key)")
            }
            if hitsMore && serverQuery == q {
                Text(L("More matches — narrow the search."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !searchError.isEmpty {
                Text(L("The archive could not be searched: {error}", ["error": searchError]))
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func hitRow(_ hit: Agenda.Hit) -> some View {
        HStack(spacing: 8) {
            marker(hit.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.text)
                    .font(.subheadline)
                    .foregroundStyle(hit.status == "done" ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if !hit.path.isEmpty {
                    Text(hit.path.joined(separator: " \u{203A} "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if hit.archived {
                Text(L("Archive##noun"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color(uiColor: .tertiarySystemFill)))
            }
        }
        .contentShape(Rectangle())
    }

    /// A tap on a hit ends the search. Active: unfold the ancestors, show done points if needed (not remembered — the
    /// footer row decides that), scroll there. Archived: open its archive entry.
    private func open(_ hit: Agenda.Hit, agenda: Agenda) {
        query = ""
        searching = false
        if hit.archived {
            guard let entryId = hit.entryId else { return }
            Task { await openArchived(entryId) }
            return
        }
        let r = Agenda.reveal(hit.id, steps: agenda.steps, deviations: deviations)
        deviations = r.deviations
        model.rememberAgendaDeviations(r.deviations)
        if r.needsDone { showDone = true }
        jump(to: "step:\(hit.id)")
    }

    /// Scrolls once the search has closed and the list is back.
    private func jump(to id: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { scrollTarget = id }
    }

    // MARK: Archive

    /// "Archive (n)" collapsed; expanded the entries, newest first, "Load more" at the end.
    @ViewBuilder
    private func archiveSection(count: Int) -> some View {
        Section {
            Button {
                archiveOpen.toggle()
                if archiveOpen && !archiveLoaded { Task { await loadArchive(more: false) } }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(archiveOpen ? 90 : 0))
                        .frame(width: 14)
                        .accessibilityHidden(true)
                    Image(systemName: "archivebox")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(L("Archive ({n})", ["n": count]))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .monospacedDigit()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityValue(archiveOpen ? L("expanded") : L("collapsed"))
            .accessibilityIdentifier("chat-agenda-archive")
            if archiveOpen {
                ForEach(archive) { entry in
                    archiveRow(entry)
                        .background(highlight("archive:\(entry.id)"))
                        .id("archive:\(entry.id)")
                    if let tree = archiveTrees[entry.id] { archiveTreeRows(tree, entry: entry) }
                }
                if archiveLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if archiveMore {
                    Button(L("Load more")) { Task { await loadArchive(more: true) } }
                        .font(.footnote)
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("chat-agenda-archive-more")
                }
                if !archiveError.isEmpty {
                    Text(L("The archive could not be loaded: {error}", ["error": archiveError]))
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private func archiveRow(_ entry: Agenda.ArchiveEntry) -> some View {
        let open = archiveTrees[entry.id] != nil
        return Button { toggleEntry(entry) } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 14)
                    .accessibilityHidden(true)
                Text(entry.text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(L("{n} items", ["n": entry.leaves]))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                if let since = Agenda.sinceText(entry.archivedAt, now: Date().timeIntervalSince1970 * 1000) {
                    Text(L(since.key, ["n": since.n]))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityValue(open ? L("expanded") : L("collapsed"))
        .accessibilityIdentifier("chat-agenda-archive-entry-\(entry.id)")
        .padding(.leading, Self.inset)
    }

    /// The archived points of an expanded entry, indented below it — read-only, notes behind the usual symbol.
    @ViewBuilder
    private func archiveTreeRows(_ tree: ArchiveTree, entry: Agenda.ArchiveEntry) -> some View {
        if let steps = tree.steps {
            ForEach(steps) { p in
                HStack(spacing: 8) {
                    Color.clear.frame(width: 14, height: 1)
                    pointText(p)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if p.subitems > 0 {
                        Text("\(p.done)/\(p.total)")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    if !p.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        noteButton(label: L("Show note"), identifier: "chat-agenda-archive-note-\(entry.id)-\(p.id)") {
                            note = NoteContent(id: "archive:\(entry.id):\(p.id)", header: p.text, markdown: p.note,
                                               upkeep: p.upkeep.map(upkeepText))
                        }
                    }
                }
                .padding(.leading, CGFloat(min(p.depth, Agenda.stages) + 2) * Self.inset)
                .accessibilityIdentifier("chat-agenda-archive-step-\(entry.id)-\(p.id)")
            }
        } else if !tree.error.isEmpty {
            Text(L("The archive could not be loaded: {error}", ["error": tree.error]))
                .font(.footnote)
                .foregroundStyle(.orange)
                .padding(.leading, 2 * Self.inset)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    /// One page of the archive — the first (replaces) or the next (`before` = last entry id).
    private func loadArchive(more: Bool) async {
        guard !archiveLoading else { return }
        archiveLoading = true
        defer { archiveLoading = false }
        do {
            let page = try await model.loadAgendaArchive(before: more ? archive.last?.id : nil)
            if more {
                let known = Set(archive.map(\.id))
                archive += page.entries.filter { !known.contains($0.id) }
            } else {
                archive = page.entries
            }
            archiveMore = page.more
            archiveLoaded = true
            archiveError = ""
        } catch {
            archiveError = error.localizedDescription
        }
    }

    private func toggleEntry(_ entry: Agenda.ArchiveEntry) {
        if archiveTrees[entry.id] != nil {
            archiveTrees[entry.id] = nil
        } else {
            Task { await expand(entry) }
        }
    }

    private func expand(_ entry: Agenda.ArchiveEntry) async {
        archiveTrees[entry.id] = ArchiveTree()
        do {
            let steps = try await model.loadAgendaSubtree(entry.rootId)
            guard archiveTrees[entry.id] != nil else { return }
            archiveTrees[entry.id] = ArchiveTree(steps: steps)
        } catch {
            guard archiveTrees[entry.id] != nil else { return }
            archiveTrees[entry.id] = ArchiveTree(error: error.localizedDescription)
        }
    }

    /// An archived hit: expand the archive, page until its entry is there (at most 20 pages), expand the entry, scroll.
    private func openArchived(_ entryId: Int) async {
        archiveOpen = true
        if !archiveLoaded { await loadArchive(more: false) }
        var pages = 0
        while !archive.contains(where: { $0.id == entryId }) && archiveMore && pages < 20 {
            await loadArchive(more: true)
            pages += 1
        }
        guard let entry = archive.first(where: { $0.id == entryId }) else { return }
        if archiveTrees[entry.id]?.steps == nil { await expand(entry) }
        jump(to: "archive:\(entry.id)")
    }

    private func header(_ agenda: Agenda, error: String) -> some View {
        let f = Agenda.progress(agenda)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(agenda.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-agenda-title")
                if !agenda.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    noteButton(label: L("Show description"), identifier: "chat-agenda-description-button") {
                        note = NoteContent(id: "description", header: agenda.title, markdown: agenda.description, footnote: snapshot(agenda))
                    }
                }
                if f.total > 0 {
                    Text("\(f.done)/\(f.total)")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(L("{done} of {total} done", ["done": f.done, "total": f.total]))
                        .accessibilityIdentifier("chat-agenda-progress")
                }
            }
            if f.total > 0 {
                ProgressView(value: Double(f.done), total: Double(f.total))
                    .accessibilityHidden(true)
            }
            if !error.isEmpty {
                Text(L("The agenda could not be loaded: {error}", ["error": error]))
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 2)
    }

    /// "updated … ago" — only in the description sheet now, not in the flow.
    private func snapshot(_ agenda: Agenda) -> String? {
        Agenda.sinceText(agenda.changedAt, now: Date().timeIntervalSince1970 * 1000).map {
            L("updated {when}", ["when": L($0.key, ["n": $0.n])])
        }
    }

    private func row(_ z: Agenda.Row, all: [Agenda.Step]) -> some View {
        let p = z.point
        return HStack(spacing: 8) {
            if p.subitems > 0 {
                // The whole left side (arrow, symbol, text) folds — a bigger target than the arrow alone.
                Button {
                    let fresh = Agenda.toggleFold(deviations, row: z, steps: all)
                    deviations = fresh
                    model.rememberAgendaDeviations(fresh)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(z.open ? 90 : 0))
                            .frame(width: 14)
                            .accessibilityHidden(true)
                        pointText(p)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityValue(z.open ? L("expanded") : L("collapsed"))
                .accessibilityIdentifier("chat-agenda-step-\(p.id)")
                Text("\(p.done)/\(p.total)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(L("{done} of {total} done", ["done": p.done, "total": p.total]))
            } else {
                HStack(spacing: 8) {
                    Color.clear.frame(width: 14, height: 1)
                    pointText(p)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("chat-agenda-step-\(p.id)")
            }
            if p.depth == 0, let project = p.project, !project.name.isEmpty {
                Text(project.name)
                    .font(.caption2)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color(uiColor: .tertiarySystemFill)))
                    .accessibilityIdentifier("chat-agenda-project-\(p.id)")
            }
            if let b = proofs[p.id], !b.isEmpty {
                Button { proofsPoint = p } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "clock.arrow.circlepath")
                        Text("\(b.count)").monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 28, minHeight: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(L("Evidence in the timeline: {n}", ["n": b.count]))
                .accessibilityIdentifier("chat-agenda-proofs-\(p.id)")
            }
            if !p.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                noteButton(label: L("Show note"), identifier: "chat-agenda-note-\(p.id)") {
                    note = NoteContent(id: p.id, header: p.text, markdown: p.note, upkeep: p.upkeep.map(upkeepText))
                }
            } else if let upkeep = p.upkeep {
                // Without a note a separate, equally quiet symbol opens the item's sheet — only with the explanation.
                noteButton(label: L("Show agenda keeper"), symbol: "info.circle", identifier: "chat-agenda-upkeep-info-\(p.id)") {
                    note = NoteContent(id: p.id, header: p.text, markdown: "", upkeep: upkeepText(upkeep))
                }
            }
        }
        .padding(.leading, CGFloat(z.stage) * Self.inset)
    }

    /// Symbol and text of an item — ONE line, truncated.
    private func pointText(_ p: Agenda.Step) -> some View {
        let done = p.status == "done"
        return HStack(spacing: 8) {
            marker(p.status)
                .overlay(alignment: .topTrailing) {
                    if p.upkeep != nil { upkeepRing }
                }
            Text(p.text)
                .font(.subheadline.weight(p.depth == 0 && p.subitems > 0 ? .medium : .regular))
                .foregroundStyle(done ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    /// The quiet mark of the agenda keeper: a small ring in the accent colour at the top right of the status symbol. The
    /// row's voice says it too ("by the agenda keeper"), the explanation is in the item's sheet. No identifier of its own: the
    /// ring sits in a combined element (the row `chat-agenda-step-<id>` or its button's label), where one would get lost — an
    /// identifier on the stack overrides those of its children. The mark is testable via
    /// `chat-agenda-upkeep-info-<id>` or `chat-agenda-upkeep-text`.
    private var upkeepRing: some View {
        Circle()
            .strokeBorder(.tint, lineWidth: 1.5)
            .frame(width: 7, height: 7)
            .offset(x: 3, y: -3)
            .accessibilityLabel(L("by the agenda keeper"))
    }

    /// "Created by the agenda keeper · 4 min ago" or "Set by the agenda keeper · before: in work · 4 min ago" — the "ago"
    /// part from the same computation as "updated … ago"; without a timestamp it is dropped. Last, what happened afterwards:
    /// "… · afterwards taken back by the main agent" (`Agenda.upkeepAfterwardsWord`; open/unknown: nothing).
    private func upkeepText(_ p: Agenda.Upkeep) -> String {
        var parts = [p.kind == "fresh" ? L("Added by the agenda keeper") : L("Set by the agenda keeper")]
        if let prior = p.prior { parts.append(L("before: {status}", ["status": statusWord(prior)])) }
        if let since = Agenda.sinceText(p.at, now: Date().timeIntervalSince1970 * 1000) {
            parts.append(L(since.key, ["n": since.n]))
        }
        if let afterwards = p.afterwards, let word = Agenda.upkeepAfterwardsWord[afterwards] { parts.append(L(word)) }
        return parts.joined(separator: " · ")
    }

    /// A status as a word in a sentence (lowercase, like "before: in work").
    private func statusWord(_ status: String) -> String {
        switch status {
        case "in_work": return L("in progress")
        case "done": return L("done")
        default: return L("open")
        }
    }

    private func noteButton(label: String, symbol: String = "text.alignleft", identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// The sheet behind the note symbol: heading, Markdown as in the chat, for the description the state.
    private func noteSheet(_ content: NoteContent) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !content.header.isEmpty {
                        Text(content.header)
                            .font(.headline)
                            .accessibilityIdentifier("chat-agenda-note-header")
                    }
                    if !content.markdown.isEmpty {
                        MarkdownView(source: content.markdown)
                            .font(.subheadline)
                    }
                    if let upkeep = content.upkeep {
                        Label {
                            Text(upkeep)
                        } icon: {
                            Circle()
                                .strokeBorder(.tint, lineWidth: 1.5)
                                .frame(width: 9, height: 9)
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat-agenda-upkeep-text")
                    }
                    if let footnote = content.footnote {
                        Text(footnote)
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(content.id == "description" ? L("Description") : content.markdown.isEmpty ? L("Agenda keeper") : L("Note##memo"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "chat-agenda-note-close") { note = nil } }
        }
    }

    @ViewBuilder
    private func marker(_ status: String) -> some View {
        switch status {
        case "in_work":
            Image(systemName: "circle.inset.filled")
                .foregroundStyle(.tint)
                .accessibilityLabel(L("In progress"))
        case "done":
            Image(systemName: "checkmark.circle")
                .foregroundStyle(.secondary)
                .accessibilityLabel(L("Done"))
        default:
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
                .accessibilityLabel(L("Open##state"))
        }
    }
}
