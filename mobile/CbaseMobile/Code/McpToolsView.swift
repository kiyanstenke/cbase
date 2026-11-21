import SwiftUI

/// The tools of ONE coding MCP server in the server sheet — the counterpart of `web/src/components/McpTools.tsx`: cache state,
/// "Load tools", counter, the "Subagents inherit" switch, ONE row per tool (checkmark = choice, label, "new", card). Every tap
/// saves at once (PATCH with only that one field; a missing field means unchanged) and adopts the response. The computation
/// lives in `Code/McpTools.swift` (bound to the web). `onlyRead`: an adopted workspace server inside a project.
struct McpToolsView: View {
    let client: APIClient
    let onlyRead: Bool
    let changed: (McpServer) -> Void
    @State private var server: McpServer
    @State private var loading = false
    @State private var error = ""

    init(client: APIClient, server: McpServer, onlyRead: Bool, changed: @escaping (McpServer) -> Void) {
        self.client = client
        self.onlyRead = onlyRead
        self.changed = changed
        _server = State(initialValue: server)
    }

    private var rows: [McpToolComputation.Row] {
        McpToolComputation.rows(server.tools, choice: server.choice, markers: server.markers)
    }

    private var counterText: String? {
        guard !server.tools.isEmpty else { return nil }
        let z = McpToolComputation.counter(server.tools, choice: server.choice, markers: server.markers)
        let free = L("{n} of {m} allowed", ["n": z.free, "m": z.total])
        return z.card > 0 ? "\(free) · \(L("{n} with a card", ["n": z.card]))" : free
    }

    private var stateText: String {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let s = McpToolComputation.status(toolsAt: server.toolsAt, error: server.toolsError, now: now)
        switch s.kind {
        case "never": return L("Never loaded")
        case "error": return L("Loading failed: {error}", ["error": server.toolsError])
        default: return s.minutes < 1 ? L("Just loaded") : L("Loaded {n} min ago", ["n": s.minutes])
        }
    }

    var body: some View {
        ProjectField(L("Tools"), symbol: "wrench.and.screwdriver", right: counterText) {
            VStack(alignment: .leading, spacing: 12) {
                Text(onlyRead
                     ? L("Applies everywhere — changed in the workspace.")
                     : L("What the agents of this workspace get from this server. No agent sees a deselected tool; a card asks you before every call. Takes effect immediately."))
                    .cbFont(13)
                    .foregroundStyle(CbColor.textSecondary)
                HStack(spacing: 10) {
                    Text(stateText)
                        .cbFont(13)
                        .foregroundStyle(server.toolsError.isEmpty ? CbColor.textMuted : .red)
                        .accessibilityIdentifier("mcp-tools-status")
                    Spacer(minLength: 0)
                    if !onlyRead {
                        Button(loading ? L("Loading…") : L("Load tools")) { Task { await load() } }
                            .disabled(loading)
                            .cbFont(13, weight: .medium)
                            .accessibilityIdentifier("mcp-tools-load")
                    }
                }
                Toggle(isOn: Binding(get: { server.subagentsInherit }, set: { fresh in Task { await save(InheritBody(subagentsInherit: fresh)) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("Subagents inherit")).cbFont(15)
                        Text(L("On: subagents and workflow agents get this server with the same selection and the same cards. Off: only the main agent — a subagent asks it."))
                            .cbFont(12)
                            .foregroundStyle(CbColor.textMuted)
                    }
                }
                .disabled(onlyRead)
                .accessibilityIdentifier("mcp-subagents-inherit")
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).cbFont(13)
                }
                if rows.isEmpty {
                    Text(L("No tools known yet — “Load tools” asks the server."))
                        .cbFont(13)
                        .foregroundStyle(CbColor.textMuted)
                } else {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            toolRow(row)
                        }
                    }
                }
            }
        }
    }

    private func toolRow(_ z: McpToolComputation.Row) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                Task { await save(ChoiceBody(choice: McpToolComputation.toggleChoice(server.tools, choice: server.choice, name: z.name))) }
            } label: {
                Image(systemName: z.selected ? "checkmark.circle.fill" : "circle")
                    .font(.symbol(20))
                    .foregroundStyle(z.selected ? Color.accentColor : CbColor.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(onlyRead)
            .accessibilityLabel(z.name)
            .accessibilityValue(z.selected ? L("selected") : L("deselected"))
            .accessibilityIdentifier("mcp-choice-\(z.name)")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(z.name)
                        .cbFont(14, design: .monospaced)
                        .foregroundStyle(z.selected ? CbColor.text : CbColor.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(labelWord(z.label))
                        .cbFont(12)
                        .foregroundStyle(z.label == "writes" ? .orange : CbColor.textMuted)
                    if z.fresh {
                        Text(L("new")).cbFont(12).foregroundStyle(Color.accentColor)
                    }
                }
                if !z.description.isEmpty {
                    Text(z.description)
                        .cbFont(12)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            Button(L("Card")) {
                Task { await save(MarkersBody(markers: McpToolComputation.toggleMarker(server.markers, name: z.name))) }
            }
            .buttonStyle(.plain)
            .cbFont(12, weight: .medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(z.card ? Color.orange : CbColor.textMuted)
            .background(Capsule().fill(z.card ? Color.orange.opacity(0.15) : Color.clear))
            .disabled(onlyRead)
            .accessibilityValue(z.card ? L("on") : L("off"))
            .accessibilityIdentifier("mcp-card-\(z.name)")
        }
        .padding(.vertical, 8)
    }

    private func labelWord(_ label: String) -> String {
        switch label {
        case "reads": return L("reads")
        case "writes": return L("writes")
        default: return L("unclear")
        }
    }

    // ── Writing ───────────────────────────────────────────────────────────

    private struct ChoiceBody: Encodable {
        let choice: [String]?
        // `nil` means "all" and must arrive as null — a synthesized Encodable would drop the key (= unchanged).
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            if let choice { try c.encode(choice, forKey: .choice) } else { try c.encodeNil(forKey: .choice) }
        }
        enum CodingKeys: String, CodingKey { case choice }
    }
    private struct MarkersBody: Encodable { let markers: [String] }
    private struct InheritBody: Encodable { let subagentsInherit: Bool }

    private func save<Body: Encodable>(_ body: Body) async {
        error = ""
        do {
            let fresh: McpServer = try await client.patch("/api/mcp-servers/\(server.id)", body: body)
            server = fresh
            changed(fresh)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        loading = true
        error = ""
        defer { loading = false }
        do {
            let fresh: McpServer = try await client.post("/api/mcp-servers/\(server.id)/tools")
            server = fresh
            changed(fresh)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
