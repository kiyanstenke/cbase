import SwiftUI

// Remove the old containers of renamed stacks — the counterpart of `web/src/components/projects/OldContainerRemove.tsx`.
//
// After a restructuring, the containers of a renamed Compose stack stay behind stopped. The services part of the project sheet
// then shows the field "Old containers (N)" (`Project.superseded`); the sheet reads the inventory (`GET …/superseded`, in the
// project container), names every container and data area with name and size, and confirms exactly what was shown — the state
// when the confirmation opened, including the containers shown as running (`POST …/superseded/remove` with `confirmed`). The
// end is reported by `project/superseded` (`AppState.takeOverSuperseded`); if it is lost in a gap of the stream (app in the
// background, network), polling `GET …/superseded?status=1` every 5 s fetches the report as `last`.

struct OldContainerInventory: Decodable, Equatable {
    struct Container: Decodable, Equatable { let id: String; let name: String; let state: String; let size: Int? }
    struct Volume: Decodable, Equatable { let name: String; let size: Int? }
    struct Network: Decodable, Equatable { let id: String; let name: String }
    struct Image: Decodable, Equatable { let id: String; let name: String; let size: Int? }
    struct Stack: Decodable, Equatable {
        let stackPrior: String
        let stackNow: String
        let container: [Container]
        let volumes: [Volume]
        let networks: [Network]
        let images: [Image]
        /// The same key as on the server (`stackPrior\0stackNow`): a stack name can be superseded twice.
        var key: String { "\(stackPrior)\u{0}\(stackNow)" }
        private enum CodingKeys: String, CodingKey { case stackPrior, stackNow, container, volumes, networks, images }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            stackPrior = try c.decode(String.self, forKey: .stackPrior)
            stackNow = (try? c.decodeIfPresent(String.self, forKey: .stackNow)) ?? ""
            // Read per entry: an unreadable one must not empty the list — what is confirmed is what is shown.
            container = ((try? c.decodeIfPresent([LayoutTolerant<Container>].self, forKey: .container)) ?? nil)?.compactMap(\.value) ?? []
            volumes = ((try? c.decodeIfPresent([LayoutTolerant<Volume>].self, forKey: .volumes)) ?? nil)?.compactMap(\.value) ?? []
            networks = ((try? c.decodeIfPresent([LayoutTolerant<Network>].self, forKey: .networks)) ?? nil)?.compactMap(\.value) ?? []
            images = ((try? c.decodeIfPresent([LayoutTolerant<Image>].self, forKey: .images)) ?? nil)?.compactMap(\.value) ?? []
        }
    }
    struct Stays: Decodable, Equatable { let kind: String; let name: String; let reason: String? }
    struct Total: Decodable, Equatable { let bytes: Int?; let withoutSize: Int? }
    let stacks: [Stack]
    let stays: [Stays]
    let total: Total?
    let running: Bool

    private enum CodingKeys: String, CodingKey { case stacks, stays, total, running }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stacks = try c.decode([Stack].self, forKey: .stacks)
        stays = ((try? c.decodeIfPresent([LayoutTolerant<Stays>].self, forKey: .stays)) ?? nil)?.compactMap(\.value) ?? []
        total = (try? c.decodeIfPresent(Total.self, forKey: .total)) ?? nil
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
    }

    var dataAreas: Int { stacks.reduce(0) { $0 + $1.volumes.count } }
}

/// Like the server's running set: the removal stops these containers first.
let oldContainerRunning: Set<String> = ["running", "restarting", "paused"]

func oldContainerState(_ z: String) -> String {
    switch z {
    case "missing": return L("already gone")
    case "running": return L("running (started by hand)")
    case "restarting": return L("restarting (running)")
    case "paused": return L("paused (running)")
    case "exited": return L("stopped")
    case "created": return L("created")
    case "dead": return L("dead")
    default: return z
    }
}

func oldContainerKind(_ a: String) -> String {
    switch a {
    case "container": return L("container")
    case "volume": return L("Data volume")
    case "network": return L("Network")
    case "image": return L("Image")
    default: return a
    }
}

/// What the confirmation confirms — built the moment it opens.
struct OldContainerConfirmed: Encodable, Equatable {
    let container: [String]
    let running: [String]
    let volumes: [String]
    let networks: [String]
    let images: [String]

    init(_ i: OldContainerInventory) {
        container = i.stacks.flatMap { $0.container.map(\.id) }
        running = i.stacks.flatMap { $0.container.filter { oldContainerRunning.contains($0.state) }.map(\.id) }
        volumes = i.stacks.flatMap { $0.volumes.map(\.name) }
        networks = i.stacks.flatMap { $0.networks.map(\.id) }
        images = i.stacks.flatMap { $0.images.map(\.id) }
    }
}

@MainActor
final class OldContainerModel: ObservableObject {
    @Published var inventory: OldContainerInventory?
    @Published var loading = false
    @Published var running = false
    @Published var sends = false
    @Published var error = ""
    /// `since` of the own POST — a `last` from polling belongs to this run only if it matches.
    var ownRun: Double?

    let state: AppState
    let client: APIClient
    let projectId: String
    private var path: String { "/api/projects/\(projectId)/superseded" }
    /// Counts the ends: if one arrives before the answer to a POST or GET, "running" must not come back on afterwards.
    private var ends: Int { state.supersededEvents[projectId] ?? 0 }

    init(state: AppState, client: APIClient, projectId: String) {
        self.state = state
        self.client = client
        self.projectId = projectId
    }

    func load() async {
        let prior = ends
        loading = true
        error = ""
        // Never an old list under a new error message: what cannot be read right now is unknown.
        inventory = nil
        do {
            // The server computes the inventory without a cap (`inspect --size`, `system df -v`) — longer than the session's 45 s.
            let r: OldContainerInventory = try await client.get(path, timeout: 300)
            inventory = r
            if ends == prior { running = r.running }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func remove(_ b: OldContainerConfirmed) async {
        guard !sends else { return }
        struct Body: Encodable { let confirmed: OldContainerConfirmed }
        struct Response: Decodable { let since: Double? }
        sends = true
        error = ""
        let prior = ends
        do {
            let r: Response = try await client.post("\(path)/remove", body: Body(confirmed: b))
            if ends == prior {
                ownRun = r.since
                running = true
            }
        } catch {
            self.error = error.localizedDescription
        }
        sends = false
    }

    /// While it runs: poll cheaply every 5 s, the end may be missing from the stream.
    func inquiries() async {
        struct Snapshot: Decodable { let running: Bool; let last: JSONValue? }
        while running && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard running, !Task.isCancelled else { return }
            let prior = ends
            guard let s: Snapshot = try? await client.get(path, query: [URLQueryItem(name: "status", value: "1")]) else { continue }
            guard !s.running, ends == prior, running else { continue }
            let l: JSONValue? = (s.last == nil || s.last == .null) ? nil : s.last
            let matches = l.map { ownRun == nil || $0["since"]?.doubleValue == ownRun } ?? false
            state.takeOverSuperseded(projectId, end: matches ? l : nil)
            return
        }
    }
}

/// The field in the project sheet — shown when `superseded > 0`, with the result of a removal in this session and as long as its
/// sheet is open (otherwise the sheet would vanish the moment the count drops to zero).
struct OldContainerField: View {
    let project: Project
    @EnvironmentObject private var state: AppState
    @State private var open = false

    var body: some View {
        let count = project.superseded ?? 0
        let end = state.supersededEnd[project.id]
        if count > 0 || end != nil || open {
            ProjectField(L("Old containers ({n})", ["n": count]), symbol: "archivebox") {
                VStack(alignment: .leading, spacing: 6) {
                    if count > 0 {
                        Text(L("Stopped containers of renamed stacks — their data volumes hold the old state; the new stack started empty."))
                            .cbFont(13)
                            .foregroundStyle(CbColor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let end { OldContainerEnd(end: end) }
                    if count > 0 {
                        Button {
                            // A result from earlier does not belong next to the new old containers.
                            state.supersededEnd[project.id] = nil
                            open = true
                        } label: {
                            Label(L("Remove old containers"), systemImage: "trash")
                                .cbFont(14, weight: .medium)
                                .foregroundStyle(CbColor.text)
                                .padding(.vertical, 6)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("old-container-\(project.id)")
                    }
                }
            }
            .sheet(isPresented: $open) {
                if let client = state.client {
                    NavigationStack { OldContainerSheet(state: state, client: client, projectId: project.id) }
                        .cbSheet(.half)
                }
            }
        }
    }
}

/// The result of a removal (event `project/superseded`): counts per kind with size — also on failure, as soon as something is
/// gone for good —, the error and what stayed.
struct OldContainerEnd: View {
    let end: JSONValue

    var body: some View {
        let removed = end["removed"]
        let count = { (k: String) in removed?[k]?.arrayValue?.count ?? 0 }
        let sum = count("container") + count("volumes") + count("networks") + count("images")
        let failed = end["state"]?.stringValue == "error"
        let stays = end["stays"]?.arrayValue ?? []
        VStack(alignment: .leading, spacing: 4) {
            if !failed || sum > 0 {
                Text(L("Removed: {c} containers, {v} data volumes, {n} networks, {i} images ({size}).", [
                    "c": count("container"), "v": count("volumes"), "n": count("networks"), "i": count("images"),
                    "size": sizeText(removed?["bytes"]?.intValue ?? 0),
                ]))
                .cbFont(13.5).foregroundStyle(!failed && stays.isEmpty ? .green : .orange).fixedSize(horizontal: false, vertical: true)
            }
            if failed {
                Text(L("Removing failed: {reason}", ["reason": end["error"]?.stringValue ?? ""]))
                    .cbFont(13.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(stays.enumerated()), id: \.offset) { _, b in
                Text(L("Kept: {kind} {name} — {reason}", [
                    "kind": oldContainerKind(b["kind"]?.stringValue ?? ""), "name": b["name"]?.stringValue ?? "", "reason": b["reason"]?.stringValue ?? "",
                ]))
                .cbFont(12.5).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct OldContainerSheet: View {
    @StateObject private var model: OldContainerModel
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    /// The state the open confirmation confirms — captured on opening, not on tapping.
    @State private var question: OldContainerConfirmed?
    private let projectId: String

    init(state: AppState, client: APIClient, projectId: String) {
        self.projectId = projectId
        _model = StateObject(wrappedValue: OldContainerModel(state: state, client: client, projectId: projectId))
    }

    var body: some View {
        CbList {
            if !model.error.isEmpty {
                Section { Text(model.error).cbFont(13.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            }
            if let e = state.supersededEnd[projectId] { Section { OldContainerEnd(end: e) } }
            if model.running {
                Section { HStack(spacing: 8) { ProgressView(); Text(L("Removing…")).cbFont(14) } }
            } else if model.loading {
                Section { HStack(spacing: 8) { ProgressView(); Text(L("Reading the containers in the project container…")).cbFont(14).foregroundStyle(CbColor.textSecondary) } }
            } else if let i = model.inventory {
                inventorySections(i)
            }
        }
        .navigationTitle(L("Remove old containers"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { SheetClose(label: L("Done")) { dismiss() } }
        .task { await model.load() }
        .task(id: model.running) { if model.running { await model.inquiries() } }
        .onChange(of: state.supersededEvents[projectId] ?? 0) {
            model.running = false
            model.ownRun = nil
            question = nil
            Task { await model.load() }
        }
        // If the list changes under the open confirmation, it no longer applies.
        .onChange(of: model.inventory) { question = nil }
        .confirmationDialog(questionText, isPresented: Binding(get: { question != nil }, set: { if !$0 { question = nil } }), titleVisibility: .visible, presenting: question) { b in
            Button(buttonText(b.volumes.count), role: .destructive) { Task { await model.remove(b) } }
            Button(L("Cancel"), role: .cancel) {}
        }
    }

    private func buttonText(_ n: Int) -> String {
        n > 0 ? L("Remove, including {n} data volumes", ["n": n]) : L("Remove")
    }
    private var questionText: String { L("Exactly what is listed here is removed — the data volumes too, for good.") }

    private func size(_ n: Int?) -> String { n.map(sizeText) ?? L("Size unknown") }

    @ViewBuilder
    private func inventorySections(_ i: OldContainerInventory) -> some View {
        if i.stacks.isEmpty {
            Section { Text(L("There are no old containers left.")).cbFont(14).foregroundStyle(CbColor.textSecondary) }
        }
        ForEach(i.stacks, id: \.key) { s in
            Section {
                ForEach(s.container, id: \.id) { c in
                    HStack {
                        Text(c.name).cbFont(14).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Text(oldContainerState(c.state))
                            .cbFont(12).foregroundStyle(oldContainerRunning.contains(c.state) ? .orange : CbColor.textMuted)
                        if c.state != "missing" { Text(size(c.size)).cbFont(12).monospacedDigit().foregroundStyle(CbColor.textMuted) }
                    }
                }
                ForEach(s.volumes, id: \.name) { v in
                    HStack {
                        Text(L("Data volume {name}", ["name": v.name])).cbFont(14).foregroundStyle(.red).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Text(size(v.size)).cbFont(12).monospacedDigit().foregroundStyle(.red)
                    }
                }
                ForEach(s.images, id: \.id) { img in
                    HStack {
                        Text(L("Image {name}", ["name": img.name])).cbFont(13.5).foregroundStyle(CbColor.textSecondary).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Text(size(img.size)).cbFont(12).monospacedDigit().foregroundStyle(CbColor.textMuted)
                    }
                }
                if !s.networks.isEmpty {
                    Text(L("Networks: {names}", ["names": s.networks.map(\.name).joined(separator: ", ")])).cbFont(13).foregroundStyle(CbColor.textSecondary)
                }
            } header: {
                Text(L("Stack “{old}” — now called “{fresh}”", ["old": s.stackPrior, "fresh": s.stackNow]))
            }
        }
        if !i.stays.isEmpty {
            Section {
                ForEach(Array(i.stays.enumerated()), id: \.offset) { _, b in
                    Text(L("Kept: {kind} {name} — {reason}", ["kind": oldContainerKind(b.kind), "name": b.name, "reason": b.reason ?? ""]))
                        .cbFont(13).foregroundStyle(CbColor.textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        if !i.stacks.isEmpty {
            Section {
                if i.running { Text(L("A removal is already running.")).cbFont(13.5).foregroundStyle(.orange) }
                Button(buttonText(i.dataAreas), role: .destructive) { question = OldContainerConfirmed(i) }
                    .disabled(model.loading || model.sends || i.running)
                    .accessibilityIdentifier("old-container-remove")
            } footer: {
                let g = i.total
                if let b = g?.bytes {
                    Text((g?.withoutSize ?? 0) > 0
                         ? L("Together {size}, plus {n} of unknown size.", ["size": sizeText(b), "n": g?.withoutSize ?? 0])
                         : L("Together {size}.", ["size": sizeText(b)]))
                }
            }
        }
    }
}
