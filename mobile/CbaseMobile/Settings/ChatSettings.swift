import SwiftUI

// Settings → Chats: archive chats automatically. Counterpart on the web: the page `chats` in
// web/src/components/settings/ — the same route, the same order in the group "Behaviour" after "Browser" (pinned in
// web/test/settings-form.test.mjs).
//
// The setting is GLOBAL and off by default, preset to 30 days, allowed 1–365. The server's tick archives hourly every chat
// in which no message arrived for that many days — every role resets the clock. Pinned chats and chats with open work
// stay; folders never; nothing is deleted.
//
// Modelled on `WorkflowCapSection.swift`: own state, own loading, and an error appears as a row in THIS group — it stays
// until a save succeeds. The PUT ALWAYS sends both fields (a missing field is no statement, the server answers 400
// otherwise), namely those of the state at SENDING time, not at typing time (`change`).

/// `GET`/`PUT /api/chat-auto-archive` → `{ enabled, days }`. BOTH fields are required: a 200 response without fields used to
/// be read as "off, 30 days" — a claim about a setting nobody had read (empty is not unknown). Now that is a decoding error:
/// the page shows the load error and stays inoperable, as with a network error; after a PUT it falls back to the last
/// confirmed state.
struct ChatAutoArchiveDoc: Decodable, Equatable, Sendable {
    let on: Bool
    let days: Int

    init(on: Bool, days: Int) {
        self.on = on
        self.days = days
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = try c.decode(Bool.self, forKey: .on)
        days = try c.decode(Int.self, forKey: .days)
    }

    enum CodingKeys: String, CodingKey { case on = "enabled", days }

    /// The server's limits — ONE place for stepper, field and validation.
    static let daysRange = 1...365
}

/// The PUT body: both fields required — as real values, never omitted.
private struct ChatAutoArchiveBody: Encodable {
    let on: Bool
    let days: Int
    enum CodingKeys: String, CodingKey { case on = "enabled", days }
}

struct ChatSettingsView: View {
    var body: some View {
        CbList {
            ChatAutoArchiveSection()
        }
        .navigationTitle(L("Chats"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ChatAutoArchiveSection: View {
    @EnvironmentObject private var session: SessionStore

    /// `nil` means "not loaded yet" — not "off": a switch at OFF above a setting whose query failed would be a claim (empty is
    /// not unknown). Until the response arrives, "—" is shown.
    @State private var snapshot: ChatAutoArchiveDoc?
    /// The state the server last confirmed — the display falls back to it when a save fails.
    @State private var saved: ChatAutoArchiveDoc?
    /// The number field — own text so half an input ("3" on the way to "30") is not saved immediately. Saved when the field
    /// is left.
    @State private var daysText = ""
    @FocusState private var daysFocus: Bool
    @State private var error = ""
    /// Number of the latest CHANGE (switch, stepper, field) — counted at change time, not at sending time: the response of an
    /// older PUT never overtakes a newer change, the last one always wins.
    @State private var round = 0
    /// The stepper saves throttled (0.6 s after the last tap) — every PUT that changes the days triggers a pass on the
    /// server, and ten taps are one intention, not ten. Every new change cancels the waiting throttle.
    @State private var throttle: Task<Void, Never>?
    /// The PUT currently in flight. It is never cancelled (nobody knows whether it has reached the server), only overtaken:
    /// the next one waits for it so the PUTs arrive in the order of the changes and the last one stays on the server.
    @State private var inFlight: Task<Void, Never>?

    var body: some View {
        CbSettingGroup(title: L("Archive##noun")) {
            CbSettingRow(
                title: L("Archive chats automatically"),
                hint: L("Pinned chats and chats with open work stay. Nothing is deleted.")
            ) {
                if let s = snapshot {
                    Toggle("", isOn: Binding(
                        get: { s.on },
                        set: { value in
                            // Flip synchronously (otherwise the switch snaps back and then jumps again) — the PUT follows
                            // immediately and takes a throttled stepper change along (`change`).
                            guard let current = snapshot else { return }
                            change(ChatAutoArchiveDoc(on: value, days: current.days))
                        }
                    ))
                    .labelsHidden()
                    .accessibilityLabel(L("Archive chats automatically"))
                    .accessibilityIdentifier("chats-auto-archive-toggle")
                } else {
                    Text("—")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(L("Archive chats automatically"))
                        .accessibilityIdentifier("chats-auto-archive-unknown")
                }
            }
            .task {
                guard snapshot == nil else { return }
                await load()
            }

            CbSettingRow(
                title: L("After days without a new message"),
                hint: L("Every message resets the clock — including one from an agent, a channel or a scheduled task. 1 to 365 days are allowed.")
            ) {
                if let s = snapshot {
                    HStack(spacing: 8) {
                        TextField("", text: $daysText)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .monospacedDigit()
                            .frame(width: 52)
                            .focused($daysFocus)
                            .accessibilityLabel(L("Days without a new message"))
                            .accessibilityIdentifier("chats-auto-archive-days")
                        Stepper(
                            "",
                            value: Binding(
                                get: { s.days },
                                set: { fresh in
                                    guard let current = snapshot else { return }
                                    daysText = String(fresh)
                                    change(ChatAutoArchiveDoc(on: current.on, days: fresh), throttled: true)
                                }
                            ),
                            in: ChatAutoArchiveDoc.daysRange
                        )
                        .labelsHidden()
                        .fixedSize()
                        .accessibilityLabel(L("Days without a new message"))
                        .accessibilityValue("\(s.days)")
                        .accessibilityIdentifier("chats-auto-archive-stepper")
                    }
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            .onChange(of: daysFocus) { _, focus in
                if !focus { fieldTakeOver() }
            }

            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("chats-auto-archive-error")
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(L("Done")) { daysFocus = false }
            }
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            let loaded: ChatAutoArchiveDoc = try await client.get("/api/chat-auto-archive")
            snapshot = loaded
            saved = loaded
            daysText = String(loaded.days)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Take over the field on leaving: only a whole number from 1 to 365. Anything else stays UNSAVED, with a sentence —
    /// silently clamping to the limit would mean saving a number nobody typed.
    private func fieldTakeOver() {
        guard let s = snapshot else { return }
        let raw = daysText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let days = Int(raw), ChatAutoArchiveDoc.daysRange.contains(days) else {
            error = L("Please enter a whole number from 1 to 365.")
            return
        }
        guard days != s.days else {
            daysText = String(days)
            return
        }
        change(ChatAutoArchiveDoc(on: s.on, days: days))
    }

    /// Every change (switch, stepper, field) runs through here: shown immediately, counted as a new round, saved — the
    /// stepper throttled. The throttled PUT used to carry the `on` from the time of the tap; if the switch was flipped
    /// within 0.6 s, the later PUT reset it. Now every change cancels the waiting throttle, and the job reads the CURRENT
    /// state at FIRING — both fields (`submit`).
    private func change(_ fresh: ChatAutoArchiveDoc, throttled: Bool = false) {
        snapshot = fresh
        round &+= 1
        throttle?.cancel()
        throttle = nil
        guard throttled else {
            submit()
            return
        }
        throttle = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            submit()
        }
    }

    /// Queue a PUT: it waits for the previous one (the PUTs arrive in the order of the changes) and then sends the state of
    /// NOW. If a newer change came in the meantime, it sends nothing — that one sends itself, immediately or after its
    /// throttle.
    private func submit() {
        let prior = inFlight
        let my = round
        inFlight = Task {
            await prior?.value
            guard my == round, let current = snapshot else { return }
            await save(current, round: my)
        }
    }

    /// PUT with BOTH fields. If it succeeds, the server's response applies; if it fails, the last confirmed state is back and
    /// the error stays visible until a later save succeeds. If the round has been overtaken in the meantime, the response is
    /// silent — only the confirmed state counts (a later failure falls back to it, not to an older one).
    private func save(_ value: ChatAutoArchiveDoc, round my: Int) async {
        guard let client = session.client else {
            guard my == round else { return }
            back()
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        do {
            let response: ChatAutoArchiveDoc = try await client.put(
                "/api/chat-auto-archive", body: ChatAutoArchiveBody(on: value.on, days: value.days)
            )
            saved = response
            guard my == round else { return }
            snapshot = response
            if !daysFocus { daysText = String(response.days) }
            error = ""
        } catch {
            guard my == round else { return }
            back()
            self.error = error.localizedDescription
        }
    }

    private func back() {
        guard let old = saved else { return }
        snapshot = old
        if !daysFocus { daysText = String(old.days) }
    }
}
