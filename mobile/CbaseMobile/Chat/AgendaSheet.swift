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

    init(model: ChatViewModel) {
        self.model = model
        _deviations = State(initialValue: model.agendaDeviations())
    }

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
        }
        // A sheet opened before the first `connected` (or after an error) asks by itself.
        .task { if !model.agendaState.loaded { await model.loadAgenda() } }
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
        let rows = Agenda.visibleRows(agenda.steps, deviations: deviations)
        return CbList {
            Section {
                header(agenda, error: error)
            }
            if !rows.isEmpty {
                Section {
                    ForEach(rows) { row($0, all: agenda.steps) }
                }
            }
        }
        .accessibilityIdentifier("chat-agenda-list")
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
