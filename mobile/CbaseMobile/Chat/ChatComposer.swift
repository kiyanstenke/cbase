import PhotosUI
import SwiftUI
import UIKit

// ── Composer ────────────────────────────────────────────────────────────────

// The coding chat's composer: prefix "chat" for identifiers, workflow and mention, always an input.

struct ChatComposer: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: ChatViewModel
    @Binding var showingFiles: Bool
    /// Opens "Chat settings" (model, effort, Ultracode) — the model button to the right of the context bar.
    @Binding var showingSettings: Bool
    @State private var stripOn = false // "+n more" expanded — stays open until clicked again
    /// Goal row expanded: closed = goal text on one line, open = full text wrapped. A new or
    /// deleted goal folds it shut again.
    @State private var targetOpen = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingPhotos = false
    @State private var showingActions = false
    /// Counter instead of a flag: every send tap restarts the arrow's takeoff keyframes.
    @State private var sendFlight = 0
    /// Measured natural height of the action panel — target value of the extend mask.
    @State private var actionsHeight: CGFloat = 0
    /// The same for the slash panel. Two values because both panels open and close independently —
    /// a shared height would drag one along when the other changes.
    @State private var slashHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Is typing allowed? Only the archive decides: an archived chat is read-only, and the `ArchiveBar`
    /// replaces the input. Input field, attachments and queue read only this one value. The state comes
    /// from `model.chat`, never from a mark of the view's own.
    private var inputActive: Bool { model.chat.archivedAt == nil }

    /// Is the slash panel showing? DERIVED from the model, not mirrored alongside: a second
    /// state here would drift apart on chat switch, and the panel would stay above an empty
    /// field.
    private var slashOpen: Bool { model.slashQuery != nil }

    /// Close by hand (choice made). Inserting clears the search anyway — the call is here
    /// so the panel also closes when the text already matched.
    private func slashClose() { model.slashQuery = nil }

    /// The panel rising from the collect button — rounded all around (it used to be rounded only at the top and met the
    /// input row at a hard corner).
    private var composerActions: some View {
        VStack(spacing: 0) {
            actionRow(id: "photos", icon: "photo", title: L("Photos")) { showingPhotos = true }
            Divider().padding(.leading, 44)
            actionRow(id: "files", icon: "doc", title: L("Files")) { showingFiles = true }
        }
        .background(
            // One step off the island (translucent on glass, `CbGlass.inside`).
            CbGlass.inside,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .padding(.horizontal, 10)
        // `children: .contain` is mandatory: an identifier on the container REPLACES those of the
        // child buttons — all rows would then be called "chat-actions-panel".
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-actions-panel")
    }

    private func actionRow(
        id: String,
        icon: String,
        title: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
            withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { showingActions = false }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.symbol(15))
                    .frame(width: 22)
                    .foregroundStyle(Color.primary)
                Text(title)
                    .cbFont(15)
                    .foregroundStyle(Color.primary)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-action-\(id)")
    }

    /// What stands in the empty field — short and fixed, also during a turn (no explanatory text in the field). What
    /// happens with the next message is told by the queue rows above it.
    private var placeholder: String {
        L("Message to cbase")
    }

    /// Radius of the composer island. Large enough for the island to lie as a surface of its own above the
    /// keyboard, round enough to fit the input field inside.
    private static let islandRadius: CGFloat = 28

    /// Height of the padding above the island — the drag zone (`KeyboardDismissGrip`).
    static let gripHeight: CGFloat = 30

    /// Visible message strips; the rest stands behind "+n more". They are the
    /// OLDEST — the ones that come next.
    static let stripVisible = 2

    /// How far the bottom strip is pushed under the island — the same number as
    /// `--strip-deep` on the web. It is also the BOTTOM padding of the last row: the
    /// stack slides under the island with its SURFACE, never with its CONTENT (see
    /// `strip`).
    static let stripDeep: CGFloat = 16

    /// How far the stack stands sideways BEHIND the island (web: `--strip-inset`).
    /// Measured from the island's edge inwards — without it the stack is as wide as the
    /// island and reads as a card of its own above it instead of something peeking out
    /// from behind.
    ///
    /// Slightly INSIDE the curve, as in ChatGPT: the strip touches the input field "not
    /// right where the rounded corner ends, but a little earlier". Measured on a ChatGPT screenshot (radius 18, inset 13):
    /// the strip's sides meet the (circular) curve 0.71 pt below the top edge. The same depth at OUR corner
    /// (`RoundedRectangle(cornerRadius: 28, style: .continuous)`, path sampled with `xcrun swift`): depth 0.70 at x = 23.8,
    /// at x = 24 it is 0.68 — so 24. The continuous curve runs to x ≈ 40, which is why the value lies above that of a circle
    /// (21.8). The rule "at least the radius" (35 pt) would only start the strip where the island is already straight.
    static let stripInset: CGFloat = 24

    /// The island's own side padding. The stack counts with it, so the number lives
    /// here and not only as a literal at `island`.
    static let islandInset: CGFloat = 9

    var body: some View {
        VStack(spacing: 0) {
            // Drag zone for retracting the keyboard (see `KeyboardDismissGrip`) — deliberately
            // ABOVE everything and thumb-sized: here island and keyboard follow the finger without
            // the timeline scrolling along.
            KeyboardDismissGrip()
                .frame(height: Self.gripHeight)
            // The agent's task list (CLI-own Task* tools) — the technical step sequence
            // of the running job. It stays as it is and, as on the web, stands ABOVE the
            // strips: it is multi-line and has a shape of its own.
            NativeTaskBar(tasks: model.nativeTasks)
                .padding(.horizontal, 10)
            // With glass (iOS 26) ONE glass body: the stack slides under the island by `stripDeep`, and
            // two glasses on top of each other would sample each other and turn murky — in a group they flow together.
            CbGlassGroup {
                VStack(spacing: 0) {
                    strip
                    island
                }
            }
        }
    }

    /// Time-of-day greeting of the empty chat — without a name. It stands in the free
    /// area above the island (`MobileChatView.emptyGreeting`), not in the composer.
    static func greeting() -> String {
        let h = Calendar.current.component(.hour, from: Date())
        if h >= 5 && h < 11 { return L("Good morning") }
        if h >= 11 && h < 18 { return L("Good afternoon") }
        return L("Good evening")
    }

    /// No message yet, nothing loading, nothing running, not archived — only then does the stack carry the project choice.
    private var isEmptyChat: Bool {
        model.timeline.isEmpty && !model.busy && !model.loadingLog && !model.archived
    }

    /// The project choice of the empty chat (web: `.cb-strip-bottom`, modelled on "Choose project" in ChatGPT) — as a
    /// ROW of the strip stack above the island, so the island stays at the bottom. A draft takes the
    /// project along into creation (`ensureServerChat` reads `chat.projectId`), a created empty chat is moved.
    private var projectRow: some View {
        // Next to it the instance choice — in every converted project, with "Create copy …" (`ChatInstanceChoice`).
        HStack(spacing: 14) {
            projectMenu
            ChatInstanceChoice(model: model, inHeader: false)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // If the copy chosen in the draft drops out of the live options (deleted, removed, error), main applies
        // again — otherwise the draft carried it on invisibly, and the first send failed with 409 UNKNOWN_INSTANCE. Here at the
        // ROW, not at the choice: that is not there at all without options, and on an empty view no `onChange` fires.
        .onChange(of: model.instanceOptions(in: state).map(\.name), initial: true) { _, live in
            model.holdDraftInstance(live)
        }
    }

    @ViewBuilder private var projectMenu: some View {
        // The LIVE project list (`ChatViewModel.projects(in:)`), like the instance choice next to it — not the snapshot `workspace`.
        let projects = model.projects(in: state)
        let project = projects.first(where: { $0.id == model.chat.projectId })
        if let focus = state.enteredProject {
            // In an entered project the project is fixed (as on the web: `ChatStage` shows only "Focus · Name") — the list shows there
            // only its chats (`AppState.visibleChats`), another project would immediately take the new chat out of it.
            HStack(spacing: 6) {
                Image(systemName: "folder")
                Text(L("Focus · {name}", ["name": project?.name ?? focus.name]))
                    .lineLimit(1)
                if project?.setup != nil {
                    Text("· " + L("being set up")).lineLimit(1)
                }
            }
            .font(CbStripMass.font)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chat-empty-project")
        } else {
            projectChoice(projects: projects, project: project)
        }
    }

    private func projectChoice(projects: [Project], project: Project?) -> some View {
        Menu {
            Button {
                selectProject(nil)
            } label: {
                if project == nil { Label(L("Entire workspace"), systemImage: "checkmark") } else { Text(L("Entire workspace")) }
            }
            ForEach(projects) { p in
                Button {
                    selectProject(p.id)
                } label: {
            // "Chats wait": selectable in every state, with the hint, as long as the setup is open.
                    let title = p.setup == nil ? p.name : "\(p.name) · \(L("being set up"))"
                    if p.id == project?.id { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                Text(project?.name ?? L("Entire workspace"))
                    .lineLimit(1)
                if project?.setup != nil {
                    Text("· " + L("being set up")).lineLimit(1)
                }
                Image(systemName: "chevron.down")
                    .font(.symbol(10, weight: .semibold))
            }
            // The font of all stack rows — explicit, because a menu's label does not inherit everywhere.
            .font(CbStripMass.font)
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
        }
        // Without it the menu tints its label in the accent colour — the row should be as quiet as the others.
        .tint(.secondary)
        .accessibilityIdentifier("chat-empty-project")
    }

    private func selectProject(_ id: String?) {
        if model.isDraft {
            model.chat.projectId = id
            // The instance belongs to the project — another project starts in the main.
            model.chat.instance = nil
        } else {
            Task {
                do { try await model.move(to: id) } catch { model.error = error.localizedDescription }
                await state.chatList?.load()
            }
        }
    }

    /// A row of the strip stack — with a stable identifier so its sliding in and out
    /// can be animated, and as `AnyView` because the rows are of different kinds.
    private struct StripRow: Identifiable {
        let id: String
        let content: AnyView
    }

    /// The docked strip stack: the running compaction, the set goal and the
    /// queued messages — in the order of the web socket, as ONE element
    /// (`CbStrip`), rows separated by hairlines.
    ///
    /// The island is drawn AFTER it and so lies above; the negative bottom spacing
    /// pushes the stack a little under it. A new row lets the stack grow upwards
    /// (the height follows the animation on the container), the row itself slides in
    /// from below — without clipping, since what moves down is covered by the island by itself.
    ///
    /// What is pushed under the island is the SURFACE, not the CONTENT: the last
    /// row carries `stripDeep` as bottom padding, otherwise the island's edge cuts its
    /// word through horizontally — exactly what `cb-strip-last` catches on the web. And sideways the stack stands
    /// `stripInset` INSIDE the island: equally wide it would be a second card, not one
    /// peeking out from behind.
    @ViewBuilder
    private var strip: some View {
        let rows = stripRows
        // An EMPTY stack must not merely be invisible, it must weigh nothing: the
        // negative baseline pulls the island up by `stripDeep` even when no
        // strip lies below — on the web `if (!parts.length) return null` catches this. That is why
        // there is no container without rows either: an empty surface would be a frame without content.
        let empty = rows.isEmpty

        VStack(spacing: 0) {
            if !empty {
                CbStrip {
                    // The rows are built conditionally — the divider therefore belongs on every row
                    // EXCEPT the first, counted over the finished field, not guessed per `if` branch
                    // (otherwise a line would stand above a row that is the first).
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        VStack(spacing: 0) {
                            if index > 0 { CbStripSeparator() }
                            CbStripRow { row.content }
                        }
                        // Only the BOTTOM row: it alone lies above the covered zone.
                        .padding(.bottom, index == rows.count - 1 ? Self.stripDeep : 0)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("composer-strip")
            }
        }
        .padding(.horizontal, Self.islandInset + Self.stripInset)
        .padding(.bottom, empty ? 0 : -Self.stripDeep)
        .animation(.easeOut(duration: 0.18), value: model.queued)
        .animation(.easeOut(duration: 0.18), value: model.chat.goal)
        .animation(.easeOut(duration: 0.18), value: model.chat.goalPaused)
        .animation(.easeOut(duration: 0.18), value: model.graphStartRow)
        // The compaction row slides in and out like every other.
        .animation(.easeOut(duration: 0.18), value: model.compacting)
        .onChange(of: model.queued.count) { _, fresh in
            // If nothing remains hidden, the stack closes: an expanded state without
            // anything to expand would leave the button mislabelled next time.
            if fresh <= Self.stripVisible { stripOn = false }
        }
        // A new or deleted goal starts collapsed — also on switching to another chat.
        .onChange(of: model.chat.goal) { targetOpen = false }
        .onChange(of: model.chat.id) { targetOpen = false }
    }

    /// Identifier of a stack row: without a prefix (the test harness hangs on it).
    private func stripIdentifier(_ name: String) -> String { name }

    /// "Compacting context …" as the FIRST row of the stack — the compaction display belongs
    /// in the strip above the input field, like goal and queued messages. The trailer shows only where one can type: in the
    /// archived chat (`inputActive`) nobody queues anything.
    private var compressRow: some View {
        HStack(spacing: 8) {
            CbStripPulseDot()
                .frame(width: CbStripMass.symbolColumn)
            Text(L("Compacting the context…"))
                .fontWeight(.medium)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .layoutPriority(1)
            if inputActive {
                Text(L("Messages are queued and start right after."))
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(stripIdentifier("composer-strip-compress"))
    }

    /// The goal row modelled on ChatGPT: goal symbol dimmed, "Goal pursued" or "Goal paused", the goal text dimmed, behind it
    /// " • 3s" — the running time of the RUNNING turn as on the web (`goalSeconds`: only while a turn runs, otherwise nothing;
    /// never when paused). On the right three symbol buttons: delete, pause/resume, expand/collapse.
    ///
    /// Delete and pause only where one types (`inputActive`): in the ARCHIVED chat the pause ended
    /// with 409 and the trash failed silently — there only expanding remains (the goal may be read).
    ///
    /// Space on the iPhone (393 pt, text size L): stack 393 − 2 × 33 (island + strip inset) = 327, row
    /// 327 − 2 × 12 padding = 303. Of that symbol column 20, two gaps 16, buttons 3 × 28 − 6.5 (the last symbol sits at
    /// the content edge) = 77.5 ⇒ 189.5 pt for title + goal text.
    /// "Goal pursued" (`.callout` medium, measured 125 pt) would leave the goal text 58 pt, with a running time "• 3s"
    /// 23 pt — too little. Hence the short version as soon as the goal text next to the long title would get less than `targetAtLeast` pt
    /// (`targetText`): "Goal" (27 pt ⇒ 156 pt goal text). When paused there is only "Goal paused" (92 pt ⇒ 91 pt).
    private var targetRow: some View {
        let paused = model.chat.goalPaused
        let start = paused || !model.busy ? nil : model.runStartedAt
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "scope")
                .font(.symbol(CbStripMass.symbol, weight: .medium))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: CbStripMass.symbolColumn)
                .accessibilityHidden(true)
            Group {
                // The seconds run only while there is something to count — a standing goal triggers no redraw.
                if let start {
                    TimelineView(.periodic(from: start, by: 1)) { context in
                        targetText(paused: paused, seconds: max(1, Int(context.date.timeIntervalSince(start))))
                    }
                } else {
                    targetText(paused: paused, seconds: nil)
                }
            }
            // Instead of a spacer: a gap 8 pt smaller, which benefits the goal text.
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(stripIdentifier("composer-target-text"))
            HStack(spacing: 0) {
                if inputActive {
                    CbStripSymbolButton(
                        systemImage: "trash",
                        label: L("Delete goal"),
                        identifier: stripIdentifier("composer-target-end"),
                        front: CbStripMass.hitMargin
                    ) {
                        Task { await model.deleteTarget() }
                    }
                    CbStripSymbolButton(
                        systemImage: paused ? "play.circle" : "pause.circle",
                        label: paused ? L("Resume goal") : L("Pause goal"),
                        identifier: stripIdentifier("composer-target-pause")
                    ) {
                        Task { await model.setGoalPaused(!paused) }
                    }
                }
                CbStripSymbolButton(
                    systemImage: targetOpen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                    label: targetOpen ? L("Collapse goal") : L("Expand goal"),
                    identifier: stripIdentifier("composer-target-expand"),
                    front: inputActive ? 0 : CbStripMass.hitMargin,
                    rear: CbStripMass.hitMargin
                ) {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { targetOpen.toggle() }
                }
            }
            // The last symbol sits at the content edge like the trash of the message rows; its frame and its
            // hit area reach into the row's side padding for that.
            .padding(.trailing, -(CbStripMass.button - CbStripMass.symbol) / 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(stripIdentifier("composer-target"))
    }

    /// The width the goal text should at least get next to the LONG title, otherwise the short version shows.
    private static let targetAtLeast: CGFloat = 80

    /// Title, goal text and running time of the goal row. Collapsed ONE line — the goal text yields first (title and
    /// running time stay whole); expanded a wrapped paragraph with the full text and always the long title.
    ///
    /// Collapsed, `ViewThatFits` decides by the width really available (device, rotation, text size, running time),
    /// not by size class: the first version (long title) fits only if `targetAtLeast` pt of goal text have room
    /// next to it — its ideal width counts the goal text with exactly this value. VoiceOver always reads the long title.
    @ViewBuilder
    private func targetText(paused: Bool, seconds: Int?) -> some View {
        let title = paused ? L("Goal paused") : L("Pursuing goal")
        let duration = seconds.map { "• " + ChatViewModel.formatDuration($0) }
        if targetOpen {
            (Text(title).fontWeight(.medium).foregroundStyle(CbColor.text)
                + Text("  " + model.chat.goal).foregroundStyle(CbColor.textMuted)
                + Text(duration.map { " " + $0 } ?? "").foregroundStyle(CbColor.textMuted))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ViewThatFits(in: .horizontal) {
                targetSingleLine(title: title, spokenTitle: title, duration: duration, targetIdeal: Self.targetAtLeast)
                // Short: "Goal" while it is pursued; when paused "Goal paused" stays — the exception keeps its word.
                targetSingleLine(title: paused ? title : L("Goal"), spokenTitle: title, duration: duration, targetIdeal: nil)
            }
        }
    }

    /// A collapsed version of the goal row. `targetIdeal`: ideal width of the goal text for `ViewThatFits` (nil = its
    /// own) — the text itself then takes any width that is left and truncates at the end.
    private func targetSingleLine(title: String, spokenTitle: String, duration: String?, targetIdeal: CGFloat?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .fontWeight(.medium)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .layoutPriority(2)
                .accessibilityLabel(spokenTitle)
            Text(model.chat.goal.replacingOccurrences(of: "\n", with: " "))
                .foregroundStyle(CbColor.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(idealWidth: targetIdeal, maxWidth: .infinity, alignment: .leading)
            if let duration {
                Text(duration)
                    .monospacedDigit()
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(2)
            }
        }
    }

    /// The built rows of the stack, in the order of the web socket: compaction ·
    /// project choice (empty chat) · goal · graph start · queued messages · "+n more". Surface and frame belong
    /// to the container, the row's font (`CbStripMass.font`). What runs on the side is told by
    /// the pill "N running tasks" in the timeline's run row (`RunIndicator`).
    private var stripRows: [StripRow] {
        // The queue belongs to the WRITING conversation: the archived chat does not show
        // it — the same boundary as for input field and attachments (`inputActive`).
        // The task list stays: it says something about the RUN, and that is what the page is for.
        let queue = inputActive ? model.queued : []
        let visible = stripOn ? queue : Array(queue.prefix(Self.stripVisible))
        let hidden = max(0, queue.count - visible.count)
        let controllable = queue.filter { $0.controllable ?? true }.count
        var rows: [StripRow] = []

        // At the very top while compacting: it explains why "Steer" is locked and the messages below wait.
        if model.compacting {
            rows.append(StripRow(id: "compress", content: AnyView(compressRow)))
        }
        if inputActive && isEmptyChat {
            rows.append(StripRow(id: "project", content: AnyView(projectRow)))
        }
        if !model.chat.goal.isEmpty {
            rows.append(StripRow(id: "target", content: AnyView(targetRow)))
        }
        if let graph = model.graphStartRow {
            rows.append(StripRow(id: "graph-start-\(graph.startId)", content: AnyView(graphStartRow(graph))))
        }
        for (index, item) in visible.enumerated() {
            // Two kinds in one list: a subagent's completion notice shows name and state and
            // carries no trash (the server rejects a discard with 409).
            let systemLine = CompletionNotice.queue(text: item.text, systemNotice: item.systemNotice)
            rows.append(StripRow(id: "message-\(item.id)", content: AnyView(
                StripMessage(
                    text: systemLine ?? item.text,
                    controlTitle: index == 0 && controllable > 0
                        ? (controllable > 1 ? L("Steer ({n})", ["n": controllable]) : L("Steer"))
                        : nil,
                    // Locked during compaction: there is no running turn to
                    // cancel, and the messages start by themselves after the summary —
                    // the server rejects it with 409.
                    controlLocked: model.controlRunning || model.compacting,
                    onControl: { Task { await model.control() } },
                    onDismiss: systemLine == nil ? { Task { await model.cancelQueued(item) } } : nil
                )
            )))
        }
        if hidden > 0 {
            rows.append(StripRow(id: "more", content: AnyView(
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { stripOn.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: stripOn ? "chevron.up" : "chevron.down")
                            .font(.symbol(11, weight: .semibold))
                            .frame(width: CbStripMass.symbolColumn)
                        Text(stripOn ? L("Show less") : L("+{n} more", ["n": hidden]))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("composer-strip-more")
            )))
        }
        return rows
    }

    /// The row of the queued graph workflow start (web: `data-strip="graph-start"`):
    /// "starts when the turn ends" or "waiting — {reason}" with "Cancel", after the run "Worktree with
    /// changes remains" with "Dismiss". `GraphRuns.foregroundRow` computes which row shows — from "running"
    /// the workflow strip takes over. The identifier sits on the row with `children: .contain`, otherwise it would hide the
    /// button's identifier.
    private func graphStartRow(_ graph: GraphRuns.Row) -> some View {
        let text: String
        switch graph.kind {
        case .earmarked:
            text = L("Workflow “{name}” starts when the turn ends", ["name": graph.name])
        case .waitingLock:
            text = graph.reason.isEmpty
                ? L("Workflow “{name}” is waiting for a lock", ["name": graph.name])
                : L("Workflow “{name}” is waiting — {reason}", ["name": graph.name, "reason": graph.reason])
        case .worktreeStays:
            text = L("Worktree with changes remains: {path}", ["path": graph.path])
        }
        return HStack(spacing: 8) {
            Image(systemName: graph.kind == .worktreeStays ? "folder" : "arrow.triangle.branch")
                .font(.symbol(CbStripMass.symbol, weight: .medium))
                .foregroundStyle(.tint)
                .frame(width: CbStripMass.symbolColumn)
            Text(text)
                .lineLimit(2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            if graph.kind == .worktreeStays {
                Button(L("Dismiss##hide")) { model.fadeGraphStartOut(graph.startId) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat-graph-start-hide")
            } else {
                Button(L("Cancel")) { Task { _ = await model.stopGraphStart(graph.startId) } }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(model.graphStopRunning)
                    .accessibilityIdentifier("chat-graph-start-cancel")
            }
        }
        // No font of its own: `CbStripRow` sets it equally for all stack rows.
        .accessibilityElement(children: .contain)
        .accessibilityValue(L(GraphRuns.stateWord[graph.state] ?? graph.state))
        .accessibilityIdentifier("chat-graph-start-strip")
    }

    /// Everything that belongs to typing, on one rounded surface — with air at the
    /// sides and below so the island does not touch the keyboard.
    private var island: some View {
        VStack(spacing: 7) {

            if !model.mentionResults.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.mentionResults, id: \.self) { path in
                            Button {
                                model.insertMention(path)
                            } label: {
                                Label(path, systemImage: "doc.text")
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 10)
                }
            }

            // Quotes from the timeline ("Reply" at the text marker): card and "1 note" mark above the
            // input row — like the attachments IN the island, not in the strip stack above.
            if inputActive, !model.quotes.isEmpty {
                QuoteAnnotations(model: model, prefix: "chat")
            }

            if inputActive, !model.attachments.isEmpty || model.uploading {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        ForEach(model.attachments) { attachment in
                            if attachment.isPastedText {
                                // Pasted text gets a card instead of a capsule: the
                                // file name says nothing, the excerpt shows WHAT was pasted.
                                PastedTextCard(
                                    preview: model.pastedPreviews[attachment.file] ?? "",
                                    size: attachment.size,
                                    width: 156,
                                    onRemove: { model.removeAttachment(attachment) }
                                )
                            } else {
                                HStack(spacing: 5) {
                                    Image(systemName: attachment.mime.hasPrefix("image/") ? "photo" : "doc")
                                    Text(attachment.name)
                                        .lineLimit(1)
                                        // Identifier on the TEXT, not on the capsule (an identifier on the stack would overwrite the button).
                                        .accessibilityIdentifier("chat-attachment-name")
                                    Button {
                                        model.removeAttachment(attachment)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                    }
                                    .buttonStyle(.plain)
                                }
                                .font(.caption)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 6)
                                .background(CbGlass.inside, in: Capsule())
                            }
                        }
                        if model.uploading {
                            ProgressView()
                                .padding(.horizontal, 8)
                        }
                    }
                    .padding(.horizontal, 10)
                }
            }

            // Attachments live in ONE button: several circles
            // side by side would leave the input field too little room on the phone. The button extends a
            // panel rounded at the top that sits exactly above it.
            // The panel stays MOUNTED for that and extends via an animated height mask
            // (anchored at the bottom, clipped): a structural insert with .transition
            // made the input field visibly travel along, because the hosting frame jumps at once
            // to the final height while SwiftUI animates positions from the top edge
            // (see ChatComposerRoot). Mask and input row form ONE
            // VStack child, so the collapsed 0 height does not produce a double row spacing
            // of the island.
            if inputActive {
                VStack(spacing: 0) {
                    // Slash picker: commands and skills. It stands ABOVE the action panel because it
                    // belongs to what is typed — the panel belongs to the button below.
                    //
                    // Height mask instead of structural insertion: an `if` with `.transition` would make
                    // the input field visibly travel along, because the hosting frame jumps at once to the
                    // final height while SwiftUI animates positions from the top edge
                    // (same rationale as for `composerActions`).
                    SlashPicker(
                        commands: model.slashHits.commands,
                        skills: model.slashHits.skills,
                        workflows: model.slashHits.workflows,
                        prefix: "chat",
                        onChoice: { name in
                            model.insertSlash(name)
                            slashClose()
                        }
                    )
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { height in
                        slashHeight = height
                    }
                    .padding(.bottom, 7)
                    .modifier(AnimatedHeightMask(height: slashOpen ? slashHeight + 7 : 0))
                    .opacity(slashOpen ? 1 : 0)
                    .allowsHitTesting(slashOpen)
                    .accessibilityHidden(!slashOpen)
                    // Only on the OPEN/CLOSED, not on the height: the filtered list shrinks with every
                    // keystroke, and a running animation would make the panel jitter under the
                    // typing finger.
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: slashOpen)

                    composerActions
                        // Keep the natural height even if the mask proposes 0 —
                        // otherwise the rows would be squashed instead of uncovered.
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { proxy in
                            proxy.size.height
                        } action: { height in
                            actionsHeight = height
                        }
                        // The gap to the input row belongs in the mask, otherwise it
                        // would stay as a hole in the collapsed state.
                        .padding(.bottom, 7)
                        // Animatable modifier instead of .frame(height:): during animations SwiftUI
                        // otherwise computes only the TARGET layout and interpolates render-
                        // side — the height report to UIKit (ChatComposerRoot) would see only
                        // the end value in one jump. animatableData
                        // forces real layout per frame.
                        .modifier(AnimatedHeightMask(height: showingActions ? actionsHeight + 7 : 0))
                        .opacity(showingActions ? 1 : 0)
                        .allowsHitTesting(showingActions)
                        .accessibilityHidden(!showingActions)

                    HStack(alignment: .bottom, spacing: 8) {
                        Button {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
                                showingActions.toggle()
                            }
                        } label: {
                            Image(systemName: "plus")
                                .font(.headline)
                                .rotationEffect(.degrees(showingActions ? 45 : 0))
                                .foregroundStyle(Color.primary)
                                .frame(width: 34, height: 34)
                                // One step above the island (`CbColor.elevated` on `surface`, on glass `CbGlass.inside`).
                                .background(CbGlass.inside, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(model.uploading)
                        .accessibilityIdentifier("chat-attach")
                        .accessibilityLabel(L("Attach"))

                        // UITextView instead of SwiftUI TextField: only so the field carries the
                        // invisible `KeyboardGripAccessory`, with which the interactive
                        // retracting hangs on the finger already at the island's top edge.
                        ChatInputTextView(
                            text: $model.input,
                            identifier: "chat-composer",
                            placeholder: placeholder,
                            onLargePaste: { pasted in
                                // Large pastes become an attachment instead of a wall of prompt — as in the
                                // web client (see `PastedText` and ChatPane.tsx).
                                guard PastedText.isLarge(pasted) else { return false }
                                Task { await model.uploadPastedText(pasted) }
                                return true
                            },
                            // Images from the clipboard: long press → "Paste" takes them as an attachment,
                            // via the same path as the photos picker below (`uploadImage`).
                            onImagePaste: { images in
                                Task { await model.uploadClipboard(images) }
                            }
                        )
                            // No field of its own any more: the text
                            // stands directly on the island. The padding STAYS — frame and height of the
                            // field are the same as before (the UI tests measure at the field).
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .onChange(of: model.input) {
                                model.updateSlash(for: model.input)
                                model.updateMention(for: model.input)
                            }

                        Button {
                            if model.busy && !model.canSend {
                                Task { await model.stopRun() }
                            } else {
                                // Takeoff trigger BEFORE sending: the keyframes run at once with the
                                // tap, not only when the request is under way.
                                sendFlight += 1
                                Task { await model.send() }
                            }
                        } label: {
                            SendStopFace(
                                isStop: model.busy && !model.canSend,
                                stopping: model.stopping,
                                queue: model.busy && model.canSend,
                                enabled: (model.busy || model.canSend) && !model.uploading,
                                flight: reduceMotion ? 0 : sendFlight
                            )
                        }
                        .buttonStyle(SendSpringPressStyle())
                        .disabled((!model.busy && !model.canSend) || model.stopping || model.uploading)
                        .sensoryFeedback(.impact(flexibility: .solid), trigger: sendFlight)
                        .sensoryFeedback(trigger: model.stopping) { _, active in active ? .warning : nil }
                        .accessibilityIdentifier("chat-send")
                        .accessibilityLabel(
                            model.busy && !model.canSend
                                ? L("Stop answering")
                                : model.busy ? L("Queue message") : L("Send")
                        )
                    }
                    .padding(.horizontal, 10)
                }
            } else {
                // Archived: the bar in place of the input stack, INSIDE the island — it is also
                // the undo.
                ArchiveBar(archivedAt: model.chat.archivedAt) {
                    try await model.restore()
                    state.reportArchive([model.chat.id])
                }
            }

            // Context bar and, to its right, the chosen model with effort. Tapping opens the chat settings.
            HStack(spacing: 10) {
                ContextBar(model: model)
                if !model.archived {
                    ModelButton(model: model) { showingSettings = true }
                }
            }
            .padding(.horizontal, 11)
        }
        .padding(.vertical, 9)
        // Glass (iOS 26, Kit/CbGlass.swift): the timeline shimmers through the island, as in the
        // Claude app. Below that opaque like the template: the island is a
        // surface (`CbColor.surface`) with a hairline edge, one step above the chat's ground; no drop shadow, the
        // edge separates it from the timeline.
        .cbGlass(RoundedRectangle(cornerRadius: Self.islandRadius, style: .continuous)) {
            RoundedRectangle(cornerRadius: Self.islandRadius, style: .continuous)
                .fill(CbColor.surface)
                .overlay {
                    RoundedRectangle(cornerRadius: Self.islandRadius, style: .continuous)
                        .strokeBorder(CbColor.edge, lineWidth: 1)
                }
        }
        .cbSurfaceFrame()
        .padding(.horizontal, Self.islandInset)
        .padding(.bottom, 9)
        .accessibilityElement(children: .contain)
        // The working chat has always been called simply "composer-island" (the test harness hangs
        // on it), the others carry their prefix.
        .accessibilityIdentifier("composer-island")
        // When archiving with the keyboard open: it closes, and the draft is written at once — it
        // belongs to the chat and is back in the field after restoring.
        .onChange(of: model.chat.archivedAt != nil) { wasArchived, isArchived in
            guard !wasArchived, isArchived else { return }
            hideKeyboard()
            showingActions = false
            slashClose()
            model.flushDraft()
        }
        // Event `chat_archive` of another client (or archiving the folder): if it names THIS chat,
        // the model re-reads its state. The composer stands in every conversation view.
        // The ask uses the OLD counter value: if two notices arrived before this render, the first counts too
        // (the replaced id set lost it, and the conversation stayed in its old state).
        .onChange(of: state.archiveChanged) { old, _ in
            guard state.archiveNamed(model.chat.id, since: old) else { return }
            Task { await model.reloadArchiveStatus() }
        }
        .task(id: model.chat.id) {
            // The waiting strip belongs to every kind: the credit gate parks
            // chats alike, and
            // `ChatLimitStrip` stood in all of them — but it was loaded only behind the
            // workflow guard, so only in the working chat. A parked chat showed after
            // reopening neither strip nor "Start anyway"; only the SSE event of the moment
            // brought it. That is why this call stands BEFORE the guard, not behind it.
            await model.loadLimitWait()
            await model.loadWorkflows()
        }
        .photosPicker(isPresented: $showingPhotos, selection: $photoItems, maxSelectionCount: 8, matching: .images)
        .onChange(of: photoItems) {
            let selected = photoItems
            photoItems = []
            Task {
                for (index, item) in selected.enumerated() {
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        model.addError(L("Could not load photo (is it only in iCloud?)."))
                        continue
                    }
                    let image = await ClipboardImages.webSuitable(data: data, type: item.supportedContentTypes.first)
                    await model.uploadImage(data: image.data, type: image.type, source: "Foto", number: index + 1)
                }
            }
        }
    }

}

/// Face of the send/stop button. Send: rounded hexagon in the accent, flat. Stop: the
/// shape morphs into a red stop-sign octagon — both outlines are ONE
/// animatable path with the same point count (like the `d` morph on the web) — and turns
/// slowly around itself while the answer runs: the rotation IS the
/// run indicator, there is no ring of its own. The arrow lifts off on sending via
/// keyframes and springs back in from below; during cancelling the
/// ellipsis dots pulse through (variableColor).
private struct SendStopFace: View {
    var isStop: Bool
    var stopping: Bool
    /// Run active, but content typed → the message is QUEUED. A colour state of its own
    /// (the neutral primary button) into which the surface softly morphs.
    var queue: Bool
    var enabled: Bool
    var flight: Int

    /// Continuous rotation of the stop sign — pure transform (Core Animation) and only
    /// while the stop state stands; in the send resting state nothing animates here.
    @State private var spinning = false
    /// Pulse of the whole surface: kick on sending, settle on morphing back.
    @State private var shapePulse = 0
    /// Waking up (locked → ready to send): makes the arrow symbol hop once.
    @State private var wakePulse = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Takeoff pose of the symbol — the resting value is the visible centre.
    private struct FlightPose {
        var y: CGFloat = 0
        var opacity: Double = 1
    }

    private var symbol: String {
        if isStop { return stopping ? "ellipsis" : "stop.fill" }
        return "arrow.up"
    }

    var body: some View {
        let shape = MorphingHexStop(morph: isStop ? 1 : 0)
        ZStack {
            // One flat layer per state with a crossfade: accent (send), the neutral
            // primary button (queue), red (stop) — without gradient, highlight and coloured
            // shadow.
            shape
                .fill(Color.accentColor)
                .opacity(isStop || queue ? 0 : 1)
            shape
                .fill(CbColor.primaryButton)
                .opacity(queue && !isStop ? 1 : 0)
            shape
                .fill(Color.red)
                .opacity(isStop ? 1 : 0)
        }
        .frame(width: 37, height: 41)
        .rotationEffect(.degrees(spinning ? 360 : 0))
        // Symbol overlaid AFTER the rotation — it does not turn with the surface.
        .overlay { symbolView }
        // Pulse of the WHOLE surface (incl. symbol): duck briefly, overshoot, settle.
        // One mechanism for two moments — kick on sending, settle after the run ends.
        .keyframeAnimator(initialValue: 1.0, trigger: shapePulse) { view, scale in
            view.scaleEffect(scale)
        } keyframes: { _ in
            KeyframeTrack(\.self) {
                CubicKeyframe(0.93, duration: 0.1)
                SpringKeyframe(1.07, duration: 0.18, spring: .bouncy)
                SpringKeyframe(1.0, duration: 0.3, spring: .smooth)
            }
        }
        // Greyed out without text: desaturated and slightly shrunk; the first typed
        // letter makes the button springily "wake up" into the accent.
        .saturation(enabled ? 1 : 0)
        .opacity(enabled ? 1 : 0.45)
        .scaleEffect(enabled ? 1 : 0.9)
        .animation(.spring(response: 0.38, dampingFraction: 0.72), value: isStop)
        .animation(.spring(response: 0.38, dampingFraction: 0.72), value: queue)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: enabled)
        .onChange(of: isStop) { what, now in
            setSpin(now)
            // Run end or morphing back: the shape settles with a small bounce.
            if what && !now && !reduceMotion { shapePulse += 1 }
        }
        .onChange(of: flight) { _, _ in
            if !reduceMotion { shapePulse += 1 }
        }
        .onChange(of: enabled) { _, now in
            // Waking up: first character typed → arrow hops once.
            if now && !isStop && !reduceMotion { wakePulse += 1 }
        }
        // If the composer is built during a running turn (chat newly
        // opened), the rotation must run along at once.
        .onAppear { setSpin(isStop) }
    }

    /// Start/ease out the rotation. Rotating back springs to the resting position —
    /// with the hexagon the shortest way is never visible as a jump thanks to the 60° symmetry.
    private func setSpin(_ active: Bool) {
        if active && !reduceMotion {
            withAnimation(.linear(duration: 3.2).repeatForever(autoreverses: false)) { spinning = true }
        } else {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.85)) { spinning = false }
        }
    }

    private var symbolView: some View {
        Image(systemName: symbol)
            .font(.symbol(15, weight: .bold))
            .foregroundStyle(queue && !isStop ? CbColor.primaryButtonText : Color.white)
            .contentTransition(.symbolEffect(.replace))
            .symbolEffect(.variableColor.iterative, isActive: stopping)
            // Wake-up hop of the arrow on the transition locked → ready to send.
            .symbolEffect(.bounce.up, value: wakePulse)
            // Takeoff on sending: up and out, restart invisibly at the bottom,
            // then spring back to the centre. If the symbol switches to
            // stop meanwhile (busy is set synchronously), the tile glides the way back along —
            // intended: the message flies off, the stop button follows.
            .keyframeAnimator(initialValue: FlightPose(), trigger: flight) { view, pose in
                view.offset(y: pose.y).opacity(pose.opacity)
            } keyframes: { _ in
                KeyframeTrack(\FlightPose.y) {
                    CubicKeyframe(-26, duration: 0.16)
                    MoveKeyframe(22)
                    SpringKeyframe(0, duration: 0.42, spring: .bouncy)
                }
                KeyframeTrack(\FlightPose.opacity) {
                    CubicKeyframe(0, duration: 0.14)
                    MoveKeyframe(0)
                    CubicKeyframe(1, duration: 0.3)
                }
            }
            .animation(.spring(response: 0.32, dampingFraction: 0.75), value: symbol)
    }
}

/// Height mask of the action panel, whose height runs as `animatableData`: SwiftUI
/// thereby evaluates the modifier frame by frame in the MODEL tree during animations
/// (instead of only interpolating target layouts render-side). Only that lets the
/// composer's height report (onGeometryChange → hosting's height constraint)
/// see the intermediate values — frame and content grow in step, the
/// input row stays put. Content anchored at the bottom and clipped: the panel is
/// uncovered from behind the input row.
private struct AnimatedHeightMask: ViewModifier, Animatable {
    var height: CGFloat

    var animatableData: CGFloat {
        get { height }
        set { height = newValue }
    }

    func body(content: Content) -> some View {
        content
            .frame(height: max(0, height), alignment: .bottom)
            .clipped()
    }
}

/// Hexagon ↔ stop-sign octagon as ONE animatable shape — the same principle as
/// the `d` morph of the web button. What is interpolated are not raw polygon points
/// but FINISHED rounded-polygon paths with the same element count: the hexagon is exactly
/// regular (all six sides equally long), and its tip arcs at the top/bottom
/// are split via De Casteljau into two quad halves so that eight corners fall on the eight
/// corners of the octagon. `morph` (0 = hexagon, 1 = stop sign) is
/// `animatableData`; drawing is scaled uniformly (no distortion by the
/// frame's aspect ratio).
///
/// Internal rather than private: the accent colour preview (`Settings/AccentColorSection`) draws
/// the send surface with THIS shape, not with a replica.
struct MorphingHexStop: Shape {
    var morph: CGFloat

    var animatableData: CGFloat {
        get { morph }
        set { morph = newValue }
    }

    /// A rounded corner as a quad arc: entry → apex control → exit.
    private struct Corner {
        var entry: CGPoint
        var control: CGPoint
        var exit: CGPoint
    }

    /// Corner radius and widening in the 36×40 base space of the web button.
    private static let radius: CGFloat = 4.2
    private static let grow: CGFloat = 1.18

    private static func corner(_ prev: CGPoint, _ vertex: CGPoint, _ next: CGPoint) -> Corner {
        func toward(_ from: CGPoint, _ to: CGPoint) -> CGPoint {
            let dx = to.x - from.x, dy = to.y - from.y
            let len = max(0.001, (dx * dx + dy * dy).squareRoot())
            return CGPoint(x: from.x + dx / len * radius, y: from.y + dy / len * radius)
        }
        return Corner(entry: toward(vertex, prev), control: vertex, exit: toward(vertex, next))
    }

    /// Splits a corner's arc into two equal halves (De Casteljau at
    /// t = 0.5) — together they give EXACTLY the same arc, but count as two
    /// corners and so keep the element count congruent with the octagon.
    private static func split(_ c: Corner) -> (Corner, Corner) {
        let mid = CGPoint(
            x: (c.entry.x + 2 * c.control.x + c.exit.x) / 4,
            y: (c.entry.y + 2 * c.control.y + c.exit.y) / 4)
        let first = Corner(
            entry: c.entry,
            control: CGPoint(x: (c.entry.x + c.control.x) / 2, y: (c.entry.y + c.control.y) / 2),
            exit: mid)
        let second = Corner(
            entry: mid,
            control: CGPoint(x: (c.control.x + c.exit.x) / 2, y: (c.control.y + c.exit.y) / 2),
            exit: c.exit)
        return (first, second)
    }

    private static func grown(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: 18 + (x - 18) * grow, y: 20 + (y - 20) * grow)
    }

    /// Regular hexagon, tip at the top (radius 16 around (18|20)) — tip arcs split.
    private static let hexCorners: [Corner] = {
        let v = [
            grown(18, 4), grown(31.856, 12), grown(31.856, 28),
            grown(18, 36), grown(4.144, 28), grown(4.144, 12),
        ]
        func c(_ i: Int) -> Corner { corner(v[(i + 5) % 6], v[i], v[(i + 1) % 6]) }
        let (topLeft, topRight) = split(c(0))
        let (bottomRight, bottomLeft) = split(c(3))
        return [topLeft, topRight, c(1), c(2), bottomRight, bottomLeft, c(4), c(5)]
    }()

    /// Regular octagon (stop sign, radius 15 around (18|20)) in the same winding order.
    private static let octCorners: [Corner] = {
        let v = [
            grown(11.26, 6.14), grown(24.74, 6.14), grown(31.86, 14.26), grown(31.86, 25.74),
            grown(24.74, 33.86), grown(11.26, 33.86), grown(4.14, 25.74), grown(4.14, 14.26),
        ]
        return (0..<8).map { corner(v[($0 + 7) % 8], v[$0], v[($0 + 1) % 8]) }
    }()

    func path(in rect: CGRect) -> Path {
        let t = max(0, min(1, morph))
        // Scale uniformly and centre in the frame — 37×41 instead of 36×40 would
        // otherwise distort the sides unevenly.
        let scale = min(rect.width / 36, rect.height / 40)
        let ox = rect.minX + (rect.width - 36 * scale) / 2
        let oy = rect.minY + (rect.height - 40 * scale) / 2
        func lerp(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
            CGPoint(x: ox + (a.x + (b.x - a.x) * t) * scale, y: oy + (a.y + (b.y - a.y) * t) * scale)
        }
        var path = Path()
        for (i, pair) in zip(Self.hexCorners, Self.octCorners).enumerated() {
            let entry = lerp(pair.0.entry, pair.1.entry)
            if i == 0 {
                path.move(to: entry)
            } else {
                path.addLine(to: entry)
            }
            path.addQuadCurve(to: lerp(pair.0.exit, pair.1.exit), control: lerp(pair.0.control, pair.1.control))
        }
        path.closeSubpath()
        return path
    }
}

/// Press feedback of the send/stop button: shrink springily instead of the
/// standard dimming — the surface should feel like a physical button.
private struct SendSpringPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.55), value: configuration.isPressed)
    }
}

/// The model button to the right of the context bar: "Opus 5.5 · Medium" (· Ultracode), as in the Claude app.
/// A model without efforts (Haiku 4.5) shows only the name. An empty `chat.model` = the provider's default, resolved via
/// `defaultModel` — the same rule as `contextWindow`.
private struct ModelButton: View {
    @ObservedObject var model: ChatViewModel
    let open: () -> Void

    private var providerId: String { EffortLevels.effectiveProvider(model.chat.provider, active: model.activeProvider) }

    private var modelName: String {
        let provider = model.providers.first(where: { $0.id == providerId })
        let id = model.chat.model.isEmpty ? (provider?.defaultModel ?? "") : model.chat.model
        return provider?.models.first(where: { $0.id == id })?.label ?? (id.isEmpty ? L("Model") : id)
    }

    private var levelText: String? {
        let id = model.chat.model
        if EffortLevels.noLevels(model.providers, provider: providerId, model: id) { return nil }
        return model.chat.effort.isEmpty ? nil : EffortLevels.label(model.chat.effort)
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 4) {
                Text(modelName)
                    .foregroundStyle(.primary)
                if let levelText {
                    Text(levelText).foregroundStyle(.secondary)
                }
                if model.chat.ultracode {
                    Text("Ultracode").foregroundStyle(.secondary)
                }
            }
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(CbGlass.inside, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-model-button")
        .accessibilityLabel(L("Chat settings"))
        .accessibilityValue([modelName, levelText, model.chat.ultracode ? "Ultracode" : nil].compactMap { $0 }.joined(separator: ", "))
    }
}
