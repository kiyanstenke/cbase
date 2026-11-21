import SwiftUI

// ── Channels ──────────────────────────────────────────────────────────────────────
// A channel is a conversation between two chats — two coding chats whose agents write to each other: the counterpart is then the
// title of the other chat, and the cap defaults to 0 ("no cap"). No line here assumes that one side is a manager. The data
// shapes mirror the server's `publicChannel` and `channelCard`; the view follows the web sidebar in the phone's language: a sheet
// from below (like git and settings), CbPane surfaces, no glass. Every channel message also appears as a card in the timeline of
// BOTH conversations (role `.channel`).

struct ChannelParticipant: Decodable, Identifiable, Hashable, Sendable {
    var id: String { chatId }
    var chatId = ""
    var participantKind = ""
    var name = ""
    /// normal (coding chat) | manager (legacy data)
    var kind = ""
    /// Messages not yet DELIVERED to this participant (agent cursor) — "{n} waiting".
    var unread = 0
    var running = false
    /// Archived (delivery holds) or an open question card. `nil` = the server does not write the field (older) — then the
    /// reason for waiting is unknown, not "neither" (empty is not unknown).
    var archived: Bool?
    var questionOpen: Bool?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        participantKind = c.str(.participantKind)
        name = c.str(.name)
        kind = c.str(.kind)
        unread = c.int(.unread)
        running = c.bool(.running)
        archived = c.boolOpt(.archived)
        questionOpen = c.boolOpt(.questionOpen)
    }

    enum CodingKeys: String, CodingKey { case chatId, participantKind, name, kind, unread, running, archived, questionOpen }

    /// Why messages to this participant are not yet delivered (untranslated) — twin of `channelWaitReason` in
    /// web/src/lib/channel-card.ts, bound in web/test/list-binding.test.mjs.
    var waitReason: String {
        if running { return "Delivered after its turn" }
        if archived == true { return "Chat archived — delivered when you restore it" }
        if questionOpen == true { return "Waiting for your answer in the chat" }
        if archived == false && questionOpen == false { return "Waiting for a workflow gate" }
        return "Not delivered yet — the run is still going"
    }
}

struct ChannelFile: Hashable, Sendable {
    var name: String
    var size: Int?
    var origin: String
    /// Name under channel-files/<channel>/ — the download goes through the channel.
    var file: String

    init(json: JSONValue) {
        name = json["name"]?.stringValue ?? json["path"]?.stringValue ?? json["file"]?.stringValue ?? ""
        size = json["size"]?.intValue
        origin = json["origin"]?.stringValue ?? ""
        file = json["file"]?.stringValue ?? ""
    }
}

/// A channel message as it stands in the timeline (role `.channel`) and in the sheet's log.
struct ChannelCard: Decodable, Hashable, Sendable {
    var channelId = ""
    var channelName = ""
    /// 0 if the card is no channel message (`messageId: null`, the archive note at the sender) — then it carries `noteId`.
    var messageId = 0
    /// Identifier of a note without a message, e.g. `archiv:<targetChatId>:<last>`.
    var noteId = ""
    var seq = 0
    /// in (received) | out (sent) | log (sheet)
    var direction = "log"
    var senderKind = "chat"
    var senderChatId = ""
    var senderName = ""
    /// The counterpart at the sender (optional, like `recipient` in web/src/lib/channel-card.ts) — without it "sent" shows.
    var recipientName = ""
    /// hook_ask | hook_end | cap | pause | resumed | closed | rejected | archived | opened | expired — only for system; every
    /// kind needs a line in `systemMarker` (guard: web/test/list-binding.test.mjs).
    var systemKind = ""
    var text = ""
    var files: [ChannelFile] = []
    /// Milliseconds.
    var at: Double = 0

    var isSystem: Bool { senderKind == "system" }

    /// What the live stream recognises "the same card" by — like `channelCardsKey` in web/src/lib/channel-card.ts: a message by
    /// `messageId`, a note without a message by `noteId` (never by 0 — otherwise a channel's first archive note would swallow
    /// every further one), an older server with neither by seq + direction + systemKind.
    var key: String {
        if messageId > 0 { return "n:\(channelId):\(messageId)" }
        if !noteId.isEmpty { return "z:\(channelId):\(noteId)" }
        return "s:\(channelId):\(seq):\(direction):\(systemKind)"
    }

    init(json: JSONValue) {
        channelId = json["channelId"]?.stringValue ?? ""
        channelName = json["channelName"]?.stringValue ?? ""
        messageId = json["messageId"]?.intValue ?? 0
        noteId = json["noteId"]?.stringValue ?? ""
        seq = json["seq"]?.intValue ?? 0
        direction = json["direction"]?.stringValue ?? "log"
        let sender = json["sender"]
        senderKind = sender?["kind"]?.stringValue ?? "chat"
        senderChatId = sender?["chatId"]?.stringValue ?? ""
        senderName = sender?["name"]?.stringValue ?? ""
        recipientName = json["recipient"]?["name"]?.stringValue ?? ""
        systemKind = json["systemKind"]?.stringValue ?? ""
        text = json["text"]?.stringValue ?? ""
        files = (json["files"]?.arrayValue ?? []).map { ChannelFile(json: $0) }
        at = json["at"]?.doubleValue ?? 0
    }

    init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    /// The system marker in words (untranslated — the caller sends it through L()).
    static func systemMarker(_ kind: String) -> String {
        switch kind {
        case "hook_ask": return "Question in the observed chat"
        case "hook_end": return "Run finished"
        case "cap": return "Cap reached"
        case "pause": return "Paused"
        case "resumed": return "Resumed"
        case "closed": return "Closed"
        case "rejected": return "Rejected"
        case "archived": return "Target archived"
        case "opened": return "Reopened"
        case "expired": return "Expired"
        default: return "System message"
        }
    }
}

/// A channel from the user's point of view (`publicChannel`): state, cap, participants, unread.
struct ChannelEntry: Decodable, Identifiable, Hashable, Sendable {
    var id = ""
    var workspaceId = ""
    var name = ""
    /// waiting | open | paused | closed | rejected
    var status = "open"
    var cap = 0
    var agentsSinceHuman = 0
    var lastSeq = 0
    var readSeq = 0
    /// Messages the USER has not yet seen (against the read mark).
    var unreadUser = 0
    var creatorChatId = ""
    var participants: [ChannelParticipant] = []
    /// Filled only in the detail view.
    var messages: [ChannelCard] = []

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        workspaceId = c.str(.workspaceId)
        name = c.str(.name)
        status = c.str(.status, "open")
        cap = c.int(.cap)
        agentsSinceHuman = c.int(.agentsSinceHuman)
        lastSeq = c.int(.lastSeq)
        readSeq = c.int(.readSeq)
        unreadUser = c.int(.unreadUser)
        creatorChatId = c.str(.creatorChatId)
        participants = c.list(.participants, ChannelParticipant.self)
        messages = c.list(.messages, ChannelCard.self)
    }

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, name, status, cap, agentsSinceHuman, lastSeq, readSeq, unreadUser, creatorChatId, participants, messages
    }

    /// The state label (untranslated).
    var statusText: String {
        switch status {
        case "open": return "Open##state"
        case "paused": return "Paused"
        case "waiting": return "Awaiting approval"
        case "closed": return "Closed"
        case "rejected": return "Rejected"
        default: return status
        }
    }

    func opposite(from chatId: String) -> [ChannelParticipant] { participants.filter { $0.chatId != chatId } }
}

private struct ChannelChatList: Decodable {
    var channels: [ChannelEntry] = []
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channels = c.list(.channels, ChannelEntry.self)
    }
    enum CodingKeys: String, CodingKey { case channels }
}

private struct ChannelWorkspaceList: Decodable {
    var items: [ChannelEntry] = []
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, ChannelEntry.self)
    }
    enum CodingKeys: String, CodingKey { case items }
}

// ── Model ────────────────────────────────────────────────────────────────────────
@MainActor
final class ChannelModel: ObservableObject {
    let client: APIClient
    let workspaceId: String
    let chatId: String

    /// Channels this chat takes part in — first; then the rest of the workspace.
    @Published var own: [ChannelEntry] = []
    @Published var other: [ChannelEntry] = []
    @Published var loaded = false
    @Published var error = ""

    init(client: APIClient, workspaceId: String, chatId: String) {
        self.client = client
        self.workspaceId = workspaceId
        self.chatId = chatId
    }

    /// Unread messages of the user across the own channels — the number on the button.
    var unread: Int { own.reduce(0) { $0 + $1.unreadUser } }

    func load() async {
        guard !chatId.isEmpty else { return }
        do {
            async let mine: ChannelChatList = client.get("/api/chats/\(chatId)/channels")
            async let all: ChannelWorkspaceList = client.get("/api/workspaces/\(workspaceId)/channels")
            let ownList = try await mine.channels
            let ownIds = Set(ownList.map(\.id))
            own = ownList
            other = try await all.items.filter { !ownIds.contains($0.id) }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    func load(_ id: String) async throws -> ChannelEntry {
        let k: ChannelEntry = try await client.get("/api/channels/\(id)")
        // Seen means read: the user's mark moves to the end — as in the web sidebar.
        if k.unreadUser > 0 {
            _ = try? await client.send("/api/channels/\(id)/read", method: .post, body: ["seq": k.lastSeq])
        }
        return k
    }

    func pause(_ id: String) async throws -> ChannelEntry { try await client.post("/api/channels/\(id)/pause") }

    func resume(_ id: String, rounds: Int? = nil) async throws -> ChannelEntry {
        if let rounds {
            let data = try await client.send("/api/channels/\(id)/resume", method: .post, body: ["rounds": rounds])
            return try JSONDecoder().decode(ChannelEntry.self, from: data)
        }
        return try await client.post("/api/channels/\(id)/resume")
    }

    func close(_ id: String) async throws -> ChannelEntry { try await client.post("/api/channels/\(id)/close") }

    /// The only way back from "closed" (reopening is for the human only, in the channel bar); a rejected channel stays closed
    /// (409).
    func open(_ id: String) async throws -> ChannelEntry { try await client.post("/api/channels/\(id)/open") }

    func cap(_ id: String, _ n: Int) async throws -> ChannelEntry { try await client.patch("/api/channels/\(id)", body: ["cap": n]) }
}

// ── Channels in the header's ⋯ ───────────────────────────────────────────────────
/// The entry "Channels" in the ⋯ (`chat-channels`) opens the channels. This host carries what used to hang on a button: the
/// model, the reload after every run and the sheet. It draws nothing; it hands the number of unread messages outward
/// (`unread`) — it appears on the ⋯ and in the entry.
struct ChatChannelsSheet: View {
    @StateObject private var model: ChannelModel
    @Binding var open: Bool
    @Binding var unread: Int
    /// A counter from outside (finished runs) — afterwards the state is re-read.
    var refresh = 0
    /// Archived chat (like `onlyRead` of the web bar): reading yes, actions on the channel no.
    var onlyRead = false

    init(client: APIClient, workspaceId: String, chatId: String, open: Binding<Bool>, unread: Binding<Int>,
         refresh: Int = 0, onlyRead: Bool = false) {
        _model = StateObject(wrappedValue: ChannelModel(client: client, workspaceId: workspaceId, chatId: chatId))
        _open = open
        _unread = unread
        self.refresh = refresh
        self.onlyRead = onlyRead
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: refresh) { await model.load() }
            .onChange(of: open) { _, now in
                if !now { Task { await model.load() } }
            }
            .onChange(of: model.unread, initial: true) { _, n in unread = n }
            .sheet(isPresented: $open) {
                // No identifier on the sheet itself (a container passes it to every child) — the test harness recognises the open
                // sheet by the ✕ (`channels-close`).
                ChannelsSheet(model: model, onlyRead: onlyRead)
                    .cbSheet(.half)
            }
    }
}

// ── The sheet: list → log ────────────────────────────────────────────────────────
struct ChannelsSheet: View {
    @ObservedObject var model: ChannelModel
    var onlyRead = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !model.error.isEmpty {
                        Text(model.error).font(.footnote).foregroundStyle(.red)
                    }
                    if model.loaded && model.own.isEmpty && model.other.isEmpty {
                        EmptyPaneState(
                            title: L("No channel yet"),
                            message: L("A channel is created when an agent writes to this chat or this chat writes to another coding chat."),
                            systemImage: "arrow.left.arrow.right"
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 24)
                    }
                    if !model.own.isEmpty {
                        CbPane(marker: L("Channels of this chat"), count: model.own.count) { list(model.own) }
                    }
                    if !model.other.isEmpty {
                        CbPane(marker: model.own.isEmpty ? L("Channels of the workspace") : L("Other channels of the workspace"), count: model.other.count) { list(model.other) }
                    }
                }
                .padding(16)
            }
            .cbSheetBase()
            .navigationTitle(L("Channels"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "channels-close") { dismiss() } }
            .navigationDestination(for: String.self) { id in
                ChannelLogView(model: model, channelId: id, onlyRead: onlyRead, closeSheet: { dismiss() })
            }
            .cbRefreshable { await model.load() }
        }
    }

    @ViewBuilder
    private func list(_ channels: [ChannelEntry]) -> some View {
        ForEach(Array(channels.enumerated()), id: \.element.id) { index, k in
            if index > 0 { CbSeparator() }
            NavigationLink(value: k.id) {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(k.name)
                            .cbFont(14, weight: .semibold)
                            .lineLimit(1)
                        Text(oppositeText(k))
                            .cbFont(12)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    if k.unreadUser > 0 {
                        Text("\(k.unreadUser)")
                            .cbFont(11, weight: .bold)
                            .foregroundStyle(Color.white)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Color.accentColor, in: Capsule())
                    }
                    ChannelStatusChip(channel: k)
                    Image(systemName: "chevron.right")
                        .font(.symbol(12, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .cbRow()
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("channel-row-\(k.id)")
        }
    }

    private func oppositeText(_ k: ChannelEntry) -> String {
        let other = k.opposite(from: model.chatId)
        if other.isEmpty {
            return k.status == "waiting" ? L("Chat is created on approval") : L("No counterpart")
        }
        let names = other.map { $0.name.isEmpty ? L("Chat") : $0.name }.joined(separator: " · ")
        return k.participants.contains { $0.chatId == model.chatId } ? L("with {name}", ["name": names]) : names
    }
}

struct ChannelStatusChip: View {
    let channel: ChannelEntry
    var identifier: String? = nil

    var body: some View {
        Text(L(channel.statusText))
            .cbFont(10.5, weight: .semibold)
            .foregroundStyle(channel.status == "open" ? Color.accentColor : channel.status == "paused" ? Color.orange : Color.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background((channel.status == "open" ? Color.accentColor : channel.status == "paused" ? Color.orange : Color.secondary).opacity(0.12), in: Capsule())
            .accessibilityIdentifier(identifier ?? "channel-status-\(channel.id)")
    }
}

// ── A channel's log ──────────────────────────────────────────────────────────────
struct ChannelLogView: View {
    @ObservedObject var model: ChannelModel
    let channelId: String
    var onlyRead = false
    let closeSheet: () -> Void

    @EnvironmentObject private var state: AppState
    @State private var channel: ChannelEntry?
    @State private var error = ""
    @State private var busy = false
    @State private var roundsQuestion = false
    @State private var roundsText = "3"
    @State private var capQuestion = false
    @State private var capText = ""
    @State private var closeQuestion = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                if let channel {
                    header(channel)
                    participants(channel)
                    history(channel)
                } else if error.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(16)
        }
        .cbSheetBase()
        .navigationTitle(channel?.name ?? L("Channel"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // "closed" has ONE entry: reopen (the only way back); "rejected" and an archived chat (onlyRead) have none.
                if let channel, channel.status == "closed", !onlyRead {
                    Menu {
                        Button { Task { await handle { try await model.open(channelId) } } } label: {
                            Text(L("Reopen"))
                            Text(L("The chats can write to each other again"))
                            Image(systemName: "arrow.uturn.backward.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("channel-menu")
                } else if let channel, channel.status != "closed", channel.status != "rejected", !onlyRead {
                    Menu {
                        if channel.status == "open" {
                            Button { Task { await handle { try await model.pause(channelId) } } } label: {
                                Text(L("Pause"))
                                Text(L("Nothing is delivered until you resume — messages are kept"))
                                Image(systemName: "pause.circle")
                            }
                        }
                        if channel.status == "paused" {
                            Button { Task { await handle { try await model.resume(channelId) } } } label: {
                                Label(L("Resume"), systemImage: "play.circle")
                            }
                            Button { roundsText = "3"; roundsQuestion = true } label: {
                                Label(L("More rounds…"), systemImage: "goforward.plus")
                            }
                        }
                        Button { capText = "\(channel.cap)"; capQuestion = true } label: {
                            Label(L("Change cap…"), systemImage: "slider.horizontal.3")
                        }
                        Divider()
                        Button(role: .destructive) { closeQuestion = true } label: {
                            Label(L("Close"), systemImage: "xmark.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("channel-menu")
                }
            }
        }
        .task(id: channelId) { await load() }
        .cbRefreshable { await load() }
        .alert(L("More rounds"), isPresented: $roundsQuestion) {
            TextField(L("Rounds"), text: $roundsText)
                .keyboardType(.numberPad)
            Button(L("Resume")) {
                let n = min(1000, max(1, Int(roundsText.trimmingCharacters(in: .whitespaces)) ?? 3))
                Task { await handle { try await model.resume(channelId, rounds: n) } }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("How many agent rounds may run without you before the channel pauses again?"))
        }
        .alert(L("Change cap"), isPresented: $capQuestion) {
            TextField(L("Cap (0 = none)"), text: $capText)
                .keyboardType(.numberPad)
            Button(L("Save")) {
                let n = min(1000, max(0, Int(capText.trimmingCharacters(in: .whitespaces)) ?? 0))
                Task { await handle { try await model.cap(channelId, n) } }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("This many agent rounds run without you; then the channel pauses (0 = no cap)."))
        }
        .confirmationDialog(L("Close channel?"), isPresented: $closeQuestion, titleVisibility: .visible) {
            Button(L("Close"), role: .destructive) {
                Task { await handle { try await model.close(channelId) } }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("It delivers nothing afterwards until you reopen it here in the ⋯ menu; the log stays readable."))
        }
    }

    // MARK: Sections

    private func header(_ k: ChannelEntry) -> some View {
        CbPane {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    ChannelStatusChip(channel: k, identifier: "channel-log-status")
                    Spacer(minLength: 6)
                    Text(k.cap > 0
                         ? L("{n} of {m} agent rounds since your last message", ["n": k.agentsSinceHuman, "m": k.cap])
                         : L("No cap"))
                        .cbFont(11)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("channel-log-cap")
                }
                Text(k.name)
                    .cbFont(15, weight: .semibold)
                    .accessibilityIdentifier("channel-log-name")
            }
            .cbRow()
        }
    }

    /// Only a coding chat can be jumped to (kind "normal"; an older server without a kind counts as one). A manager conversation
    /// is in no chat list any more until the migration deletes it together with its channel — its participant row stays
    /// readable, but without a jump. Web counterpart: `jumpable` in ChannelSidebar.tsx.
    private func jumpable(_ t: ChannelParticipant) -> Bool { t.kind.isEmpty || t.kind == "normal" }

    private func participants(_ k: ChannelEntry) -> some View {
        CbPane(marker: L("Participants")) {
            ForEach(Array(k.participants.enumerated()), id: \.element.chatId) { index, t in
                if index > 0 { CbSeparator() }
                HStack(spacing: 10) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.symbol(13))
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.name.isEmpty ? L("Chat") : t.name)
                            .cbFont(13.5, weight: .medium)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            if jumpable(t) { Text(L("Coding chat")) }
                            if t.running { Text(L("running")).foregroundStyle(Color.accentColor) }
                            if t.unread > 0 { Text(L("{n} pending", ["n": t.unread])).foregroundStyle(.orange) }
                        }
                        .cbFont(11)
                        .foregroundStyle(.secondary)
                        // Why it waits — on the web the title on "{n} waiting"; a phone has no title.
                        if t.unread > 0 {
                            Text(L(t.waitReason))
                                .cbFont(11)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("channel-wait-reason-\(t.chatId)")
                        }
                    }
                    Spacer(minLength: 6)
                    if t.chatId == model.chatId {
                        Text(L("this chat"))
                            .cbFont(11.5)
                            .foregroundStyle(.tertiary)
                    } else if jumpable(t) {
                        CbTextButton(title: L("Back to chat")) { jump(t) }
                            .accessibilityIdentifier("channel-jump-\(t.chatId)")
                    }
                }
                .cbRow()
            }
        }
    }

    private func history(_ k: ChannelEntry) -> some View {
        CbPane(marker: L("History"), count: k.messages.count) {
            if k.messages.isEmpty {
                Text(L("No message yet."))
                    .cbFont(13)
                    .foregroundStyle(.secondary)
                    .cbRow()
            }
            ForEach(Array(k.messages.enumerated()), id: \.element.seq) { index, n in
                if index > 0 { CbSeparator() }
                ChannelCardView(card: n, ownChatId: model.chatId, embedded: true)
                    .cbRow()
            }
        }
    }

    // MARK: Actions

    private func load() async {
        do {
            channel = try await model.load(channelId)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func handle(_ action: () async throws -> ChannelEntry) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await action()
            // The state comes with the response, the timeline (system row) via the reload.
            channel = try await model.load(channelId)
            await model.load()
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Jump to the participant's coding chat (including the chat's project, otherwise the list would not find it). Only for
    /// `jumpable` participants.
    private func jump(_ t: ChannelParticipant) {
        guard jumpable(t) else { return }
        let workspaceId = model.workspaceId
        closeSheet()
        Task {
            var projectId = ""
            if let chat: Chat = try? await model.client.get("/api/chats/\(t.chatId)") {
                projectId = chat.projectId ?? ""
            }
            await state.openPushPayload(["workspaceId": workspaceId, "projectId": projectId, "chatId": t.chatId])
        }
    }
}

// ── The card in the timeline ─────────────────────────────────────────────────────
/// A channel message as a row in the timeline (role `.channel`) and as an entry in the log. At the sender "sent", at the
/// receiver "from ‹sender›"; a system message carries its marker. The card itself jumps nowhere — a card whose channel the
/// migration has deleted (a channel to a manager conversation) stays as history in the timeline and reads like any other.
struct ChannelCardView: View {
    let card: ChannelCard
    var ownChatId: String = ""
    /// In the log the card already lies on a surface — then without a background of its own.
    var embedded = false

    private var who: String? {
        if card.isSystem { return nil }
        if card.direction == "out" || (!ownChatId.isEmpty && card.senderChatId == ownChatId) {
            return card.recipientName.isEmpty ? L("sent") : L("to {name}", ["name": card.recipientName])
        }
        return L("from {name}", ["name": card.senderName.isEmpty ? L("Chat") : card.senderName])
    }

    private var time: String {
        guard card.at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: card.at / 1000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: card.isSystem ? "info.circle" : "arrow.left.arrow.right")
                    .chatFont(.fixed(11), weight: .medium)
                    .foregroundStyle(CbColor.textMuted)
                Text(L("Channel “{name}”", ["name": card.channelName]))
                    .chatFont(.fixed(12.5), weight: .medium)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                    .accessibilityIdentifier("chat-channel-card")
                if let who {
                    Text(who)
                        .chatFont(.fixed(11.5))
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
                if card.isSystem {
                    Text(L(ChannelCard.systemMarker(card.systemKind)))
                        .chatFont(.fixed(10), weight: .medium)
                        .foregroundStyle(CbColor.textMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                }
                Spacer(minLength: 4)
                if !time.isEmpty {
                    Text(time)
                        .chatFont(.fixed(11))
                        .foregroundStyle(CbColor.textMuted)
                }
            }
            MarkdownView(source: card.text)
                // TWO specs with the same size, and that is mandatory — the same pairing as for the info row in the timeline
                // (`ChatComponents.swift`, where the full rationale is). In short: the first picks the card's font, everything
                // without its own follows it (bullet, table cell); the second reaches the PARAGRAPH, which is drawn as UIKit text
                // and cannot inherit a SwiftUI font. Changing only one of them puts paragraph and bullet at different sizes.
                .chatFont(.subheadline)
                .environment(\.chatMarkdownBaseSize, 15)
            if !card.files.isEmpty {
                ChipFlow(spacing: 6) {
                    ForEach(Array(card.files.enumerated()), id: \.offset) { _, d in
                        HStack(spacing: 4) {
                            Image(systemName: "doc")
                                .chatFont(.fixed(10))
                            Text(d.name)
                                .chatFont(.fixed(11.5))
                                .lineLimit(1)
                            if let size = d.size {
                                Text(ChannelCardView.size(size))
                                    .chatFont(.fixed(10.5))
                                    .foregroundStyle(CbColor.textMuted)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                    }
                }
            }
        }
        .padding(embedded ? 0 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            embedded ? AnyShapeStyle(Color.clear) : AnyShapeStyle(.cbElevated),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    static func size(_ n: Int) -> String {
        if n >= 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
        if n >= 1024 { return "\(n / 1024) KB" }
        return "\(n) B"
    }
}
