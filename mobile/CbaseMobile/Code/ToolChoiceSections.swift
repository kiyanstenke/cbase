import SwiftUI

/// Tool choice shared by the outer-loop agent editor. The sections are `Section`s, not a framed view of their own:
/// they belong inside ONE `Form` of the caller, otherwise a list would sit inside a list.

/// The built-in tools, by area and group, with a read level where it separates something.
struct ToolCatalogSections: View {
    let areas: [ToolArea]
    let catalog: [ToolGroup]
    /// Approval marks of the cbase tools: only DISPLAYED here, set on the MCP page.
    var cbaseApproval: [String] = []
    /// Groups whose tools are ALL dropped by the fence in project chats: shown as a marker only, they stay selectable.
    /// Other callers leave it out (counterpart: `fenceDropped` in outerloop/ToolChoice.tsx).
    var fenceDropped: [String] = []
    @Binding var tools: Set<String>
    /// Prefix of the accessibility identifiers. Must be UNIQUE per place: copies blinded the test bench.
    var identifier: String

    var body: some View {
        toolSections
    }

    /// Does one of the group's tools carry an approval mark (MCP page)? Display only, not
    /// toggleable: the mark applies to the workspace, not to this agent.
    private func approvalMarked(_ group: ToolGroup) -> Bool {
        group.tools.contains { cbaseApproval.contains($0) }
    }

    // The catalog by AREA (knowledge, acting), one section per area.
    @ViewBuilder
    private var toolSections: some View {
        ForEach(areas) { area in
            Section {
                ForEach(catalog.filter { $0.area == area.key }) { group in
                    if group.hasStages {
                        // Three stages: Off, Read, Maintain (Maintain includes Read).
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Text(group.label).cbFont(14)
                                if approvalMarked(group) { AgentMarker(L("Approve##noun"), tone: .warn) }
                                if fenceDropped.contains(group.key) { AgentMarker(L("dropped in project chats")) }
                            }
                            Text(group.description)
                                .cbFont(11.5)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Picker(group.label, selection: stagesBinding(group)) {
                                Text(L("Off")).tag("off")
                                Text(L("Read")).tag("read")
                                Text(L("Maintain")).tag("maintain")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            .accessibilityIdentifier("\(identifier)-tools-\(group.key)")
                        }
                    } else {
                        Toggle(isOn: groupsBinding(group)) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(group.label).cbFont(14)
                                    if approvalMarked(group) { AgentMarker(L("Approve##noun"), tone: .warn) }
                                    if fenceDropped.contains(group.key) { AgentMarker(L("dropped in project chats")) }
                                }
                                Text(group.description)
                                    .cbFont(11.5)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityIdentifier("\(identifier)-tools-\(group.key)")
                    }
                }
            } header: {
                if area.key == areas.first?.key {
                    Text(L("Tools ({n} selected) · {area}", ["n": "\(tools.count)", "area": area.label]))
                } else {
                    Text(area.label)
                }
            } footer: {
                Text(area.description)
            }
        }
    }

    private func groupsBinding(_ g: ToolGroup) -> Binding<Bool> {
        Binding(
            get: { g.tools.allSatisfy { tools.contains($0) } },
            set: { on in
                if on { tools.formUnion(g.tools) } else { tools.subtract(g.tools) }
            }
        )
    }

    /// Off / Read / Maintain: one maintaining tool is enough for "Maintain", otherwise it counts whether a
    /// reading one is present. Setting clears the group and rewrites the stage completely.
    private func stagesBinding(_ g: ToolGroup) -> Binding<String> {
        Binding(
            get: {
                if g.maintain.contains(where: { tools.contains($0) }) { return "maintain" }
                if g.read.contains(where: { tools.contains($0) }) { return "read" }
                return "off"
            },
            set: { stage in
                tools.subtract(g.tools)
                if stage == "maintain" { tools.formUnion(g.tools) } else if stage == "read" { tools.formUnion(g.read) }
            }
        )
    }
}

/// The external MCP servers and their tools; the inventory lives on the "MCP" page.
struct McpChoiceSections: View {
    let server: [ManagerMcpServer]
    @Binding var mcp: [String: [String]]
    /// Footer text, overridable by the caller.
    var mcpFootnote: String? = nil
    /// As above: no default.
    var identifier: String

    var body: some View {
        mcpSections
    }

    // External MCP servers: one section per server with its tools as toggles; inventory (address, token,
    // reload, remove) in the sheet behind "Edit".
    @ViewBuilder
    private var mcpSections: some View {
        ForEach(server) { srv in
            let choice = mcp[srv.id] ?? []
            Section {
                if !srv.error.isEmpty {
                    Text(srv.error).cbFont(12).foregroundStyle(.orange)
                }
                if srv.tools.isEmpty && srv.error.isEmpty {
                    Text(L("No tool list yet — use “Reload tools” in the server."))
                        .cbFont(12).foregroundStyle(.secondary)
                }
                ForEach(srv.tools) { w in
                    Toggle(isOn: mcpBinding(srv.id, w.name)) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(w.name).cbFont(12.5, design: .monospaced)
                                if w.writing == true { AgentMarker(L("writes"), tone: .warn) }
                                else if w.writing == nil { AgentMarker(L("unclear")) }
                                // Approval is set on the MCP page and only shown here; the mark applies to the
                                // server, not to this agent.
                                if srv.approval.contains(w.name) { AgentMarker(L("Approve##noun"), tone: .warn) }
                            }
                            if !w.description.isEmpty {
                                Text(w.description)
                                    .cbFont(11.5)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .accessibilityIdentifier("\(identifier)-mcp-\(srv.key)-\(w.name)")
                }
                // Selected but no longer in the list: stays visible and can be deselected.
                ForEach(choice.filter { n in !srv.tools.contains { $0.name == n } }, id: \.self) { n in
                    Toggle(isOn: mcpBinding(srv.id, n)) {
                        HStack(spacing: 6) {
                            Text(n).cbFont(12.5, design: .monospaced)
                            AgentMarker(L("not in the list"))
                        }
                    }
                }
                HStack(spacing: 14) {
                    Button(L("All")) { mcp[srv.id] = srv.tools.map(\.name) }
                        .disabled(srv.tools.isEmpty)
                    // Only what the server POSITIVELY reports as read-only; unclear ones stay out.
                    Button(L("Read-only")) { mcp[srv.id] = srv.tools.filter { $0.writing == false }.map(\.name) }
                        .disabled(!srv.tools.contains { $0.writing == false })
                        .accessibilityIdentifier("\(identifier)-mcp-read-only-\(srv.key)")
                    Button(L("None")) { mcp[srv.id] = nil }
                        .disabled(choice.isEmpty)
                }
                .cbFont(13)
                .buttonStyle(.borderless)
            } header: {
                Text(L("{name} · {n} of {m} selected", ["name": srv.name, "n": "\(choice.count)", "m": "\(srv.tools.count)"]))
            } footer: {
                Text(L("Calls are named mcp__{key}__<tool>.", ["key": srv.key]))
            }
        }
        Section {
            // Management lives on the MCP page (create servers, load tool lists, set approval marks).
            // Only the per-agent CHOICE remains here.
            Text(L("Servers, tool lists and approval marks are managed under Agents → MCP."))
                .cbFont(12)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("\(identifier)-mcp-hint")
        } header: {
            if server.isEmpty { Text(L("External MCP servers")) }
        } footer: {
            Text(mcpFootnote ?? L("Tools from external systems via an MCP server (Streamable HTTP with a bearer token) — such as an issue tracker or a document archive. The server belongs to the workspace; which of its tools this agent gets is chosen above per server."))
        }
    }

    private func mcpBinding(_ serverId: String, _ tool: String) -> Binding<Bool> {
        Binding(
            get: { (mcp[serverId] ?? []).contains(tool) },
            set: { on in
                var list = mcp[serverId] ?? []
                if on { if !list.contains(tool) { list.append(tool) } } else { list.removeAll { $0 == tool } }
                mcp[serverId] = list.isEmpty ? nil : list
            }
        )
    }
}
