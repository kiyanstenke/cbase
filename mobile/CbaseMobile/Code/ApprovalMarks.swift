import SwiftUI

// ── Approval marks per workspace ───────────────────────────────────────────────────────────────────────────────────────
// Which built-in cbase tools an agent runs only after the human's approval, per workspace, not per agent (server
// toolchain/approval-marks.js, route GET/PUT /api/workspaces/:id/approval-marks). An outer-loop run omits a marked tool
// (nobody is there to approve). This is the place to change them; the outer-loop editor only reads them
// (`cbaseApproval` in the loaded data).
//
// Each switch is saved immediately: the list goes out as a whole (the server replaces the marks of its slice), and an
// error reverts the switch. Grouped by the outer-loop editor's catalog; what is not in it is collected under "Other cbase
// tools". Web counterpart: components/outerloop/ApprovalMarks.tsx.

/// `GET`/`PUT …/approval-marks`: `tools` = the marks that are set, `markable` = what can carry a mark (catalog order).
struct ApprovalMarksStatus: Decodable, Sendable {
    var tools: [String]
    var markable: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tools = c.strings(.tools)
        markable = c.strings(.markable)
    }
    enum CodingKeys: String, CodingKey { case tools, markable }
}

/// The `PUT` body: `tools` is mandatory (a missing field would be a 400 on the server, not "no marks").
private struct ApprovalMarksBody: Encodable { let tools: [String] }

/// The row on the outer loop's workspace level: number of marks and "Edit"; the sheet carries the switches.
struct ApprovalMarksRow: View {
    let client: APIClient
    let workspaceId: String
    /// The catalog groups of the outer loop (loaded data), only for order and headings.
    let groups: [ToolGroup]
    /// After every saved change: the editor reads the marks from the loaded data.
    var changed: () -> Void = {}

    @State private var snapshot: ApprovalMarksStatus?
    @State private var error = ""
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CbTileHeader(symbol: "lock", title: L("Approval marks"), margin: true)
            CbTileEmpty(
                symbol: "lock",
                text: snapshot.map(ApprovalMarksSheet.count) ?? (error.isEmpty ? L("Loading…") : error),
                identifier: "approval-marks-count",
                button: L("Edit"),
                buttonIdentifier: "approval-marks-open",
                create: snapshot == nil ? nil : { open = true }
            )
            Text(L("An agent runs a marked cbase tool only once you approve, change the parameters or reject in the chat — this applies to every agent of this workspace that selected it. An outer loop run leaves it out."))
                .cbFont(12)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
        }
        .task(id: workspaceId) { await load() }
        .sheet(isPresented: $open) {
            if let snapshot {
                ApprovalMarksSheet(client: client, workspaceId: workspaceId, groups: groups, snapshot: snapshot) { fresh in
                    self.snapshot = fresh
                    changed()
                }
                .cbSheet(.whole)
            }
        }
    }

    private func load() async {
        do {
            snapshot = try await client.get("/api/workspaces/\(workspaceId)/approval-marks", timeout: 20)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The sheet: one switch per markable tool, ordered by the catalog groups.
struct ApprovalMarksSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let groups: [ToolGroup]
    @State var snapshot: ApprovalMarksStatus
    let saved: (ApprovalMarksStatus) -> Void

    @State private var busy: String?
    @State private var error = ""

    static func count(_ s: ApprovalMarksStatus) -> String {
        L("{n} of {m} tools with approval", ["n": "\(s.tools.count)", "m": "\(s.markable.count)"])
    }

    /// The groups in catalog order, each with markable tools only; the rest after them (like on the web).
    private var ordering: [(key: String, label: String, tools: [String])] {
        let markable = Set(snapshot.markable)
        var seen = Set<String>()
        var out: [(key: String, label: String, tools: [String])] = []
        for g in groups {
            let tools = g.tools.filter { markable.contains($0) && !seen.contains($0) }
            tools.forEach { seen.insert($0) }
            if !tools.isEmpty { out.append((g.key, g.label, tools)) }
        }
        let rest = snapshot.markable.filter { !seen.contains($0) }
        if !rest.isEmpty { out.append(("additional", L("More cbase tools"), rest)) }
        return out
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    Text(Self.count(snapshot))
                        .cbFont(12)
                        .foregroundStyle(.secondary)
                }
                ForEach(ordering, id: \.key) { g in
                    Section {
                        ForEach(g.tools, id: \.self) { name in
                            Toggle(isOn: binding(name)) {
                                HStack(spacing: 6) {
                                    Text(name).cbFont(12.5, design: .monospaced).lineLimit(1)
                                    if snapshot.tools.contains(name) { AgentMarker(L("with approval"), tone: .warn) }
                                }
                            }
                            .disabled(busy != nil)
                            .accessibilityIdentifier("approval-marker-\(name)")
                        }
                    } header: {
                        Text(g.label)
                    }
                }
                if ordering.isEmpty {
                    Section { Text(L("No tool can be marked.")).cbFont(12.5).foregroundStyle(.secondary) }
                }
                InlineError(message: error)
            }
            .navigationTitle(L("Approval marks"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Done")) { dismiss() }
            }
        }
    }

    // Optimistic: the switch flips immediately; if the call fails, the previous state comes back.
    private func binding(_ name: String) -> Binding<Bool> {
        Binding(
            get: { snapshot.tools.contains(name) },
            set: { on in
                let prior = snapshot
                var tools = snapshot.tools.filter { $0 != name }
                if on { tools.append(name) }
                snapshot.tools = tools
                busy = name
                error = ""
                Task {
                    defer { busy = nil }
                    do {
                        let fresh: ApprovalMarksStatus = try await client.put(
                            "/api/workspaces/\(workspaceId)/approval-marks", body: ApprovalMarksBody(tools: tools)
                        )
                        snapshot = fresh
                        saved(fresh)
                    } catch {
                        snapshot = prior
                        self.error = error.localizedDescription
                    }
                }
            }
        )
    }
}
