import SwiftUI

// The size guideline of the dynamic workflows: small · medium · large · unrestricted, default medium. It is passed to the
// model as a hint when it plans workflows (description of cbase_dynamic_workflow). Web counterpart: `WorkflowSizeRow` in
// web/src/components/settings/WorkflowsSettings.tsx, same wording, same route. Sits under the cap (`WorkflowCapSection`).
//
// Own row with own state and own loading like the cap above. The levels come from the SERVER (`stages`); only their labels are
// here.

/// Answer of `GET /api/dyn-workflow-size` (and, without `stages`, of `PUT`).
struct WorkflowSizeDoc: Decodable, Sendable {
    let size: String
    let preset: String
    let stages: [String]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        size = c.str(.size, "medium")
        preset = c.str(.preset, "medium")
        stages = (try? c.decodeIfPresent([String].self, forKey: .stages)) ?? []
    }

    init(size: String, preset: String, stages: [String]) {
        self.size = size
        self.preset = preset
        self.stages = stages
    }

    enum CodingKeys: String, CodingKey { case size, preset, stages }
}

struct WorkflowSizeRow: View {
    @EnvironmentObject private var session: SessionStore

    /// `nil` means "not loaded yet": do not claim a level the server does not keep.
    @State private var snapshot: WorkflowSizeDoc?
    @State private var error = ""
    /// Number of the latest save: a later answer overtakes an earlier one, never the reverse.
    @State private var round = 0

    static func label(_ stage: String) -> String {
        switch stage {
        case "small": return L("Small (under 5 agents)")
        case "medium": return L("Medium (under 10 agents)")
        case "large": return L("Large (under 50 agents)")
        case "unrestricted": return L("Unrestricted")
        default: return stage
        }
    }

    var body: some View {
        CbSettingRow(
            title: L("Dynamic workflow size"),
            hint: L("How large the agent plans dynamic workflows — a hint to the model, not a hard limit. Independently, a run with more than 25 agents or 1.5M tokens gets a warning (not in Ultracode mode). A hard ceiling is set by “+500k” in the message.")
        ) {
            if let s = snapshot {
                Picker(L("Dynamic workflow size"), selection: Binding(
                    get: { s.size },
                    set: { fresh in Task { await save(fresh) } }
                )) {
                    ForEach(s.stages, id: \.self) { stage in
                        Text(Self.label(stage)).tag(stage)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .accessibilityIdentifier("usage-dynwf-size")
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
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            snapshot = try await client.get("/api/dyn-workflow-size")
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ fresh: String) async {
        guard let client = session.client, let old = snapshot else {
            error = L("No connection to the server — the setting was not saved.")
            return
        }
        guard fresh != old.size else { return }
        // The server requires the field (without `size` ⇒ 400): the body always carries it.
        struct Body: Encodable { let size: String }
        round += 1
        let my = round
        do {
            let response: WorkflowSizeDoc = try await client.put("/api/dyn-workflow-size", body: Body(size: fresh))
            guard my == round else { return }
            // `stages` are not part of the PUT response, the loaded ones stay.
            snapshot = WorkflowSizeDoc(size: response.size, preset: response.preset, stages: old.stages)
            error = ""
        } catch {
            guard my == round else { return }
            self.error = error.localizedDescription
        }
    }
}
