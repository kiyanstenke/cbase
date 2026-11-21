import SwiftUI

// Concurrency of the dynamic workflows: the per-user cap, i.e. how many workflow agents run at the same time across ALL
// workflows together (in server operation, the user container). Default 8. Surplus agents wait in the journal as "waiting"
// (reason: cap) and start as soon as a slot frees up. Web counterpart: `WorkflowCapGroup` in
// web/src/components/settings/WorkflowsSettings.tsx, same wording, same route.
//
// Own file with own state and own loading, like `AutoContinueSection`: if the route fails, the rest of the page stays. The
// second cap (per run, fixed at 8) is not adjustable; its number comes from the SERVER so the label does not recompute it.

/// Answer of `GET /api/dyn-workflow-cap` (and, without `max`, of `PUT`).
struct WorkflowCapDoc: Decodable, Sendable {
    let cap: Int
    let preset: Int
    let max: Int
    let runCap: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cap = c.int(.cap, 8)
        preset = c.int(.preset, 8)
        max = c.int(.max, 64)
        runCap = c.int(.runCap, 0)
    }

    enum CodingKeys: String, CodingKey { case cap, preset, max, runCap }
}

struct WorkflowCapSection: View {
    @EnvironmentObject private var session: SessionStore

    /// `nil` means "not loaded yet", not "8": a number the server does not keep would be a claim.
    @State private var snapshot: WorkflowCapDoc?
    @State private var error = ""
    /// Number of the latest save: a later answer overtakes an earlier one, never the reverse.
    @State private var round = 0

    private var hint: String {
        L("At most this many agents run at the same time, across all workflows together (default {n}). The rest wait and start as soon as a slot frees up. A single run is additionally limited to {run}.",
          ["n": String(snapshot?.preset ?? 8), "run": snapshot.map { String($0.runCap) } ?? "—"])
    }

    var body: some View {
        CbSettingGroup(title: L("Dynamic workflows")) {
            CbSettingRow(title: L("Concurrent workflow agents"), hint: hint) {
                if let s = snapshot {
                    Stepper(value: Binding(get: { s.cap }, set: { fresh in Task { await save(fresh) } }), in: 1...s.max) {
                        Text("\(s.cap)").monospacedDigit()
                    }
                    .fixedSize()
                    .accessibilityLabel(L("Concurrent workflow agents"))
                    .accessibilityValue("\(s.cap)")
                    .accessibilityIdentifier("usage-dynwf-cap")
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }
            .task {
                guard snapshot == nil else { return }
                await load()
            }
            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.footnote)
            }
            // The size guideline: own row with own loading (Settings/WorkflowSizeSection.swift).
            WorkflowSizeRow()
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            snapshot = try await client.get("/api/dyn-workflow-cap")
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ fresh: Int) async {
        guard let client = session.client, let old = snapshot else {
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        // The server requires the field (without `cap` ⇒ 400): the body always carries it as a real number.
        struct Body: Encodable { let cap: Int }
        round += 1
        let my = round
        do {
            let response: WorkflowCapDoc = try await client.put("/api/dyn-workflow-cap", body: Body(cap: fresh))
            guard my == round else { return }
            // `max` is not part of the PUT response; the loaded one stays.
            snapshot = WorkflowCapDoc(cap: response.cap, preset: response.preset, max: old.max, runCap: response.runCap)
            error = ""
        } catch {
            guard my == round else { return }
            self.error = error.localizedDescription
        }
    }
}

extension WorkflowCapDoc {
    init(cap: Int, preset: Int, max: Int, runCap: Int) {
        self.cap = cap
        self.preset = preset
        self.max = max
        self.runCap = runCap
    }
}
