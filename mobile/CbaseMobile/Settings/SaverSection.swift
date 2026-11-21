import SwiftUI

// "Spare computing power": ONE toggle, off by default. Background work (subagents, workflow and outer-loop agents, monitors)
// runs at lower CPU priority, and under full load a new command of theirs waits up to two minutes; a chat's main agent never
// does. Web counterpart: `SaverGroup` in web/src/components/settings/WorkflowsSettings.tsx, same route, same wording, same
// "Workflows" page. The PUT always carries `on` as a real boolean (without it ⇒ 400: a missing field is not a statement).

/// `GET`/`PUT /api/cpu-saver` → `{ enabled }`; the field is required: an answer without it is a decoding error, not "off".
struct SaverDoc: Decodable, Sendable {
    let on: Bool
    enum CodingKeys: String, CodingKey { case on = "enabled" }
}

struct SaverSection: View {
    @EnvironmentObject private var session: SessionStore

    /// `nil` means "not loaded yet", not "off".
    @State private var on: Bool?
    @State private var error = ""
    /// Number of the latest change: an older answer never overtakes a newer one.
    @State private var round = 0

    var body: some View {
        CbSettingGroup(title: L("Computing power")) {
            CbSettingRow(
                title: L("Spare computing power"),
                hint: L("Commands of subagents, workflow and outer-loop agents and monitors run at lower CPU priority, and under full load a new command of theirs waits up to two minutes — a chat's main agent never does.")
            ) {
                if let value = on {
                    Toggle("", isOn: Binding(get: { value }, set: { fresh in Task { await save(fresh) } }))
                        .labelsHidden()
                        .accessibilityLabel(L("Spare computing power"))
                        .accessibilityIdentifier("cpu-saver-toggle")
                } else {
                    Text("—")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("cpu-saver-unknown")
                }
            }
            .task {
                guard on == nil else { return }
                await load()
            }
            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.footnote)
            }
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            let d: SaverDoc = try await client.get("/api/cpu-saver")
            on = d.on
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ fresh: Bool) async {
        guard let client = session.client, let old = on else {
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        struct Body: Encodable { let on: Bool; enum CodingKeys: String, CodingKey { case on = "enabled" } }
        round += 1
        let my = round
        on = fresh // flip immediately, otherwise the toggle snaps back
        do {
            let d: SaverDoc = try await client.put("/api/cpu-saver", body: Body(on: fresh))
            guard my == round else { return }
            on = d.on
            error = ""
        } catch {
            guard my == round else { return }
            on = old
            self.error = error.localizedDescription
        }
    }
}
