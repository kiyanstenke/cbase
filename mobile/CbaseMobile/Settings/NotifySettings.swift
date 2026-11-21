import SwiftUI

// Notifications: a global default per kind plus a three-valued override per chat.
// The vocabulary comes from the server (server/backend/electron/server/notify.js), labels included, because the same label
// appears on the lock screen; two sources drifted apart.

struct NotifyKind: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    let chat: Bool
    let preset: Bool
    let value: Bool
    let label: String
    let hint: String
    var id: String { key }

    enum CodingKeys: String, CodingKey { case key, chat, preset, value, label, hint }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        chat = try c.decodeIfPresent(Bool.self, forKey: .chat) ?? false
        preset = try c.decodeIfPresent(Bool.self, forKey: .preset) ?? false
        value = try c.decodeIfPresent(Bool.self, forKey: .value) ?? false
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        hint = try c.decodeIfPresent(String.self, forKey: .hint) ?? ""
    }
}

struct NotifyDoc: Decodable, Sendable {
    let kinds: [NotifyKind]
    let chatKinds: [String]
    let scheduleKinds: [String]

    enum CodingKeys: String, CodingKey { case kinds, chatKinds, scheduleKinds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kinds = try c.decodeIfPresent([NotifyKind].self, forKey: .kinds) ?? []
        chatKinds = try c.decodeIfPresent([String].self, forKey: .chatKinds) ?? []
        scheduleKinds = try c.decodeIfPresent([String].self, forKey: .scheduleKinds) ?? []
    }
}

struct PushDevice: Decodable, Identifiable, Hashable, Sendable {
    let installationId: String
    let environment: String
    let lastStatus: Int
    let lastReason: String
    let lastPushAt: Double
    var id: String { installationId }

    enum CodingKeys: String, CodingKey { case installationId, environment, lastStatus, lastReason, lastPushAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installationId = try c.decodeIfPresent(String.self, forKey: .installationId) ?? ""
        environment = try c.decodeIfPresent(String.self, forKey: .environment) ?? ""
        lastStatus = try c.decodeIfPresent(Int.self, forKey: .lastStatus) ?? 0
        lastReason = try c.decodeIfPresent(String.self, forKey: .lastReason) ?? ""
        lastPushAt = try c.decodeIfPresent(Double.self, forKey: .lastPushAt) ?? 0
    }
}

struct PushInfo: Decodable, Sendable {
    let sandbox: Bool
    let production: Bool
    let devices: [PushDevice]

    enum CodingKeys: String, CodingKey { case sandbox, production, devices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sandbox = try c.decodeIfPresent(Bool.self, forKey: .sandbox) ?? false
        production = try c.decodeIfPresent(Bool.self, forKey: .production) ?? false
        devices = try c.decodeIfPresent([PushDevice].self, forKey: .devices) ?? []
    }
}

struct PushTestResult: Decodable, Sendable {
    struct Device: Decodable, Sendable {
        let environment: String
        let status: Int
        let reason: String
        let ok: Bool
        enum CodingKeys: String, CodingKey { case environment, status, reason, ok }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            environment = try c.decodeIfPresent(String.self, forKey: .environment) ?? ""
            status = try c.decodeIfPresent(Int.self, forKey: .status) ?? 0
            reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
            ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        }
    }
    let devices: [Device]
    let reason: String
    enum CodingKeys: String, CodingKey { case devices, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = try c.decodeIfPresent([Device].self, forKey: .devices) ?? []
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
}

// "Default" is the absence of an entry; the UI still works with three states, so it translates back and forth here.
enum NotifyPosition: String, CaseIterable, Identifiable {
    case standard, on, off
    var id: String { rawValue }
    var label: String {
        switch self {
        case .standard: return L("Default")
        case .on: return L("On")
        case .off: return L("Off")
        }
    }
}

func notifyPosition(_ choice: [String: String], _ kind: String) -> NotifyPosition {
    switch choice[kind] {
    case "on": return .on
    case "off": return .off
    default: return .standard
    }
}

func notifySet(_ choice: [String: String], _ kind: String, _ value: NotifyPosition) -> [String: String] {
    var next = choice
    if value == .standard { next.removeValue(forKey: kind) } else { next[kind] = value.rawValue }
    return next
}

/// The marker on the chat row. "Off" wins in a mixed state: silence is the surprising state, and the marker must answer
/// "why did nothing arrive here".
func notifyMarker(_ choice: [String: String]) -> String {
    if choice.values.contains("off") { return "bell.slash" }
    if choice.values.contains("on") { return "bell.fill" }
    return ""
}

/// The notification as it appears on the lock screen: app name, time, the kind as title, the text below. The real push
/// carries the chat name as title and the kind as subtitle (`server/gateway/push.js`); this page cannot know the chat name,
/// so it shows the kind. Nothing is invented: both lines come translated from the server.
private struct NotificationCard: View {
    let kind: NotifyKind

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "bell.fill")
                .font(.symbol(14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(Color.primary.opacity(0.75), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: "cbase")
                        .cbFont(12.5, weight: .semibold)
                    Spacer(minLength: 4)
                    Text(L("now"))
                        .cbFont(11)
                        .foregroundStyle(.secondary)
                }
                // Translated by the server (notify.js), the same source as the real push. An own L() here would give two wordings
                // for one notification.
                Text(kind.label)
                    .cbFont(12.5, weight: .medium)
                    .lineLimit(1)
                Text(kind.hint)
                    .cbFont(12)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("notify-preview")
    }
}

// ── Settings: global defaults and device status ──
//
// A PREVIEW sits on top (as on the web): eleven switches only answer "what reaches me" if you read them all. The card
// shows the first enabled kind the way the lock screen shows it, and says so when none is on.
// The explanatory sentences that used to be `Section(footer:)` below the switches moved into their group
// (`CbSettingGroup(hint:)`), same wording and keys. Nobody who needs a footnote under eleven switches reads it before switching.
struct NotificationSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var kinds: [NotifyKind] = []
    @State private var push: PushInfo?
    @State private var loading = true
    @State private var error = ""
    @State private var probe = ""
    @State private var sends = false

    /// The enabled kinds in the SAME order as the switches below; the preview should show the connection, not make you search.
    private var enabled: [NotifyKind] { kinds.filter(\.value) }

    var body: some View {
        CbList {
            if loading {
                Section { CbLoading(label: L("Loading notifications…")) }
            }
            if !error.isEmpty {
                Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
            }
            if !kinds.isEmpty {
                Section {
                    CbPreview {
                        if let first = enabled.first {
                            VStack(alignment: .leading, spacing: 6) {
                                NotificationCard(kind: first)
                                Text(L("{on} of {all} kinds go to your phone.",
                                       ["on": enabled.count, "all": kinds.count]))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .accessibilityIdentifier("notify-preview-count")
                            }
                        } else {
                            Text(L("No kind is switched on — nothing appears on the iPhone. The bell in the header still shows everything."))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("notify-preview-empty")
                        }
                    }
                }
                CbSettingGroup(
                    title: L("From a chat"),
                    hint: L("Default for all chats. Individual chats may deviate.")
                ) {
                    ForEach(kinds.filter(\.chat)) { kind in toggle(kind) }
                }
                CbSettingGroup(
                    title: L("Without a chat"),
                    hint: L("These notifications belong to no conversation — they can only be set here.")
                ) {
                    ForEach(kinds.filter { !$0.chat }) { kind in toggle(kind) }
                }
            }
            if let push {
                CbSettingGroup(
                    title: L("Devices"),
                    hint: !push.sandbox && !push.production
                        ? L("The gateway has no APNs key — nothing can be delivered at all.")
                        : L("What APNs last said about this device. Without this line a silent push is indistinguishable from a disabled one.")
                ) {
                    if push.devices.isEmpty {
                        Text(L("No device registered."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(push.devices) { g in
                        HStack(spacing: 9) {
                            Circle()
                                .fill(g.lastPushAt == 0 ? Color.secondary.opacity(0.5) : (g.lastStatus == 200 ? .green : .red))
                                .frame(width: 8, height: 8)
                            // The environment is shown language-independently in the title ("iPhone · sandbox"); the state below is translated. The
                            // test rig searches for the environment, and the simulator may speak English.
                            CbSettingRow(title: "iPhone · \(g.environment)", hint: devicesStatus(g))
                        }
                    }
                    Button {
                        Task { await sendProbe() }
                    } label: {
                        HStack {
                            Text(sends ? L("Sending…") : L("Send test notification"))
                            if sends { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(sends)
                    .accessibilityIdentifier("notify-test")
                    if !probe.isEmpty {
                        Text(probe).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(L("Notifications"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func devicesStatus(_ g: PushDevice) -> String {
        if g.lastPushAt == 0 { return L("No notification delivered yet.") }
        let d = Date(timeIntervalSince1970: g.lastPushAt / 1000)
        let s = d.formatted(date: .abbreviated, time: .shortened)
        return g.lastStatus == 200 ? "\(L("last delivered")) · \(s)" : "\(g.lastReason.isEmpty ? "HTTP \(g.lastStatus)" : g.lastReason) · \(s)"
    }

    /// One kind: label and hint come TRANSLATED from the server (`notify.js`); they also appear on the lock screen, and two
    /// sources would drift apart. No L().
    @ViewBuilder
    private func toggle(_ kind: NotifyKind) -> some View {
        CbSettingRow(title: kind.label, hint: kind.hint) {
            Toggle("", isOn: Binding(
                get: { kinds.first(where: { $0.key == kind.key })?.value ?? kind.preset },
                set: { fresh in Task { await set(kind.key, fresh) } }
            ))
            .labelsHidden()
            // The label stays on the switch though it no longer sits beside it; without it a screen reader would only say "switch".
            .accessibilityLabel(kind.label)
            // The identifier sits on the switch, not on the row: the test rig looks for a `switch`, and an identifier on the stack
            // propagates to every child.
            .accessibilityIdentifier("notify-kind-\(kind.key)")
        }
    }

    private func load() async {
        guard let client = session.client else { loading = false; return }
        do {
            let doc: NotifyDoc = try await client.get("/api/notify")
            kinds = doc.kinds
            error = ""
        } catch { self.error = error.localizedDescription }
        push = try? await client.get("/gw/push")
        loading = false
    }

    private func set(_ key: String, _ value: Bool) async {
        guard let client = session.client else { return }
        // Visible immediately, like the color scheme; a failure restores the state.
        kinds = kinds.map { $0.key == key ? NotifyKind(copy: $0, value: value) : $0 }
        struct Response: Decodable { let ok: Bool? }
        do { let _: Response = try await client.put("/api/notify", body: [key: value]) }
        catch { self.error = error.localizedDescription; await load() }
    }

    private func sendProbe() async {
        guard let client = session.client else { return }
        sends = true; probe = ""
        defer { sends = false }
        do {
            let r: PushTestResult = try await client.post("/gw/push/test")
            if r.devices.isEmpty {
                probe = L("No device registered — allow notifications in the iOS settings.")
            } else {
                probe = r.devices.map { "\($0.environment): \($0.ok ? L("delivered") : ($0.reason.isEmpty ? "HTTP \($0.status)" : $0.reason))" }
                    .joined(separator: " · ")
            }
            await load()
        } catch { probe = error.localizedDescription }
    }
}

extension NotifyKind {
    // A value type without mutable fields needs a copy for the optimistic display.
    init(copy: NotifyKind, value: Bool) {
        self.key = copy.key
        self.chat = copy.chat
        self.preset = copy.preset
        self.value = value
        self.label = copy.label
        self.hint = copy.hint
    }
}

// ── Sheet "Notifications" of a chat ──
struct NotifyChatSheet: View {
    let chatId: String
    let title: String
    /// A job chat carries the kinds of a chat AND those of a schedule (server `scheduled/chat-field.js` JOB_NOTIFICATIONS).
    var job: Bool = false
    @State var choice: [String: String]
    let onSaved: ([String: String]) -> Void

    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var kinds: [NotifyKind] = []
    @State private var key: [String] = []
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbList {
                Section {
                    ForEach(kinds.filter { key.contains($0.key) }) { kind in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(kind.label).font(.subheadline.weight(.medium))
                            Text("\(kind.hint) \(L("Default:")) \(kind.value ? L("on") : L("off"))")
                                .font(.caption).foregroundStyle(.secondary)
                            Picker(kind.label, selection: Binding(
                                get: { notifyPosition(choice, kind.key) },
                                set: { fresh in Task { await save(notifySet(choice, kind.key, fresh)) } }
                            )) {
                                ForEach(NotifyPosition.allCases) { s in Text(s.label).tag(s) }
                            }
                            .pickerStyle(.segmented)
                            .accessibilityIdentifier("notify-chat-\(kind.key)")
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text(L("Notifications"))
                } footer: {
                    Text(L("Applies to iPhone notifications only. The bell still shows everything."))
                }
                if !choice.isEmpty {
                    Section {
                        Button(L("Reset all to default")) { Task { await save([:]) } }
                            .accessibilityIdentifier("notify-chat-reset")
                    }
                }
                if !error.isEmpty {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Done")) { dismiss() }
            }
        }
        .task {
            guard let client = session.client else { return }
            do {
                let doc: NotifyDoc = try await client.get("/api/notify")
                kinds = doc.kinds
                key = job ? doc.chatKinds + doc.scheduleKinds.filter { !doc.chatKinds.contains($0) } : doc.chatKinds
            } catch { self.error = error.localizedDescription }
        }
    }

    // The WHOLE set is written: "default" is the absence of an entry, and a partial patch could never reset a set value to default.
    private func save(_ next: [String: String]) async {
        guard let client = session.client else { return }
        choice = next
        struct Body: Encodable { let notify: [String: String] }
        do {
            let updated: Chat = try await client.patch("/api/chats/\(chatId)", body: Body(notify: next))
            onSaved(updated.notify)
            error = ""
        } catch { self.error = error.localizedDescription }
    }
}
