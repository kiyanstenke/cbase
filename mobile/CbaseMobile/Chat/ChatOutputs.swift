// Outputs visible: the output location of a chat in the artifacts sheet — the "Outputs" row at the
// very top, behind it one level per folder (navigation, not sheets) — read only. Newest first (a
// folder by its most recent file), `agents/` and `workflows/` at the very bottom under "Internal"
// (the `internal` field comes from the server). Image and Markdown as preview, other text up to
// 1 MiB as source, everything else download + share. Routes as on the web: `GET /api/chats/:id/outputs`,
// `GET /api/chats/:id/outputs/file?path=…[&inline=1]` and a folder as ZIP `GET /api/chats/:id/outputs/folder?path=…`
// (server chats/outputs-routes.js).
// Open: paths in chat text clickable (the own Markdown rendering Kit/Markdown.swift has no link hook for code/text).
import SwiftUI
import UIKit

struct OutputEntry: Codable, Hashable, Identifiable, Sendable {
    enum CodingKeys: String, CodingKey { case path, size, changed, isInternal = "internal" }
    let path: String
    let size: Int
    let changed: Double
    /// `internal` on the wire (a reserved word in Swift).
    let isInternal: Bool
    var id: String { path }
    var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

struct OutputsList: Codable, Sendable {
    let roots: [String]
    let entries: [OutputEntry]
    let total: Int
    let clipped: Bool
    let max: Int
}

/// German "Ausgaben" already stands for COSTS ("Spend") — the context suffix keeps the files meaning apart.
private var outputsName: String { L("Outputs##files") }
private let previewMax = 1 << 20

/// The kind of a file by its extension — same table as server and web (lib/outputs.ts outputMime).
private func outputKind(_ name: String) -> (image: Bool, markdown: Bool, text: Bool) {
    let ext = (name as NSString).pathExtension.lowercased()
    let image = ["png", "jpg", "jpeg", "gif", "webp"].contains(ext)
    let markdown = ["md", "markdown"].contains(ext)
    let text = markdown || ["txt", "log", "output", "json", "csv", "yaml", "yml", "html", "htm", "js", "mjs", "ts", "svg"].contains(ext)
    return (image, markdown, text)
}

extension ChatViewModel {
    func loadOutputs() async throws -> OutputsList {
        try await client.get("/api/chats/\(chat.id)/outputs")
    }

    func outputData(_ entry: OutputEntry) async throws -> Data {
        try await client.data(
            "/api/chats/\(chat.id)/outputs/file",
            query: [URLQueryItem(name: "path", value: entry.path), URLQueryItem(name: "inline", value: "1")]
        )
    }

    func loadOutputDown(_ entry: OutputEntry) async throws -> URL {
        try await client.downloadToTemporaryFile(
            "/api/chats/\(chat.id)/outputs/file",
            query: [URLQueryItem(name: "path", value: entry.path)],
            fallbackName: entry.name
        )
    }

    /// A folder as ZIP into a temporary file (for ShareLink); `path` "" = the whole output location.
    func loadOutputFolderZip(_ path: String) async throws -> URL {
        try await client.downloadToTemporaryFile(
            "/api/chats/\(chat.id)/outputs/folder",
            query: [URLQueryItem(name: "path", value: path)],
            fallbackName: "\(path.isEmpty ? "outputs" : (path.split(separator: "/").last.map(String.init) ?? "outputs")).zip"
        )
    }
}

/// One level of the tree: folders (with count and latest state) and files, newest first.
private enum OutputsNode: Identifiable {
    case folder(name: String, path: String, entries: [OutputEntry])
    case file(OutputEntry)
    case internalFiles([OutputEntry])

    var id: String {
        switch self {
        case .folder(_, let path, _): return "o:\(path)"
        case .file(let e): return "d:\(e.path)"
        case .internalFiles: return "internal"
        }
    }
    var lastChanged: Double {
        switch self {
        case .folder(_, _, let es), .internalFiles(let es): return es.map(\.changed).max() ?? 0
        case .file(let e): return e.changed
        }
    }
}

/// The nodes under `front` (path ending in `/`, "" = top). `withInternal`: at the top the internal entries under ONE node.
private func outputsLevel(_ entries: [OutputEntry], front: String, withInternal: Bool) -> [OutputsNode] {
    let visible = withInternal ? entries.filter { !$0.isInternal } : entries
    var folder: [String: [OutputEntry]] = [:]
    var node: [OutputsNode] = []
    for e in visible where e.path.hasPrefix(front) {
        let rest = String(e.path.dropFirst(front.count))
        if let i = rest.firstIndex(of: "/") {
            folder[String(rest[..<i]), default: []].append(e)
        } else {
            node.append(.file(e))
        }
    }
    for (name, es) in folder { node.append(.folder(name: name, path: front + name + "/", entries: es)) }
    node.sort { $0.lastChanged != $1.lastChanged ? $0.lastChanged > $1.lastChanged : $0.id < $1.id }
    let internalEntries = entries.filter(\.isInternal)
    if withInternal && !internalEntries.isEmpty { node.append(.internalFiles(internalEntries)) }
    return node
}

/// The "Outputs" row in the artifacts sheet.
struct OutputsEntryPoint: View {
    @ObservedObject var model: ChatViewModel

    var body: some View {
        NavigationLink {
            OutputsRoot(model: model)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "tray.and.arrow.down.fill")
                    .font(.symbol(13, weight: .semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(outputsName).cbFont(15, weight: .semibold)
                    Text(L("What this chat's agents left for you — reports, screenshots, files. Read only."))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .disabled(model.isDraft)
        .accessibilityIdentifier("outputs-entry-point")
    }
}

/// The top level: loads the list (on open and every 10 s while visible; pulling reloads).
private struct OutputsRoot: View {
    @ObservedObject var model: ChatViewModel
    @State private var list: OutputsList?
    @State private var error = ""

    var body: some View {
        Group {
            if let list {
                OutputsLevelView(model: model, title: outputsName, entries: list.entries, front: "", withInternal: true, zipPath: "",
                                  hint: list.clipped ? L("Newest {n} of {total} files — older ones are not listed.", ["n": list.entries.count, "total": list.total]) : nil)
                    .cbRefreshable { await load() }
            } else if !error.isEmpty {
                ContentUnavailableView(outputsName, systemImage: "exclamationmark.triangle",
                                       description: Text(L("Outputs could not be loaded: {error}", ["error": error])))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(outputsName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // LIVE: reload every 10 s while the level stands (the task ends with it).
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }

    private func load() async {
        do {
            list = try await model.loadOutputs()
            error = ""
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }
}

private struct OutputsLevelView: View {
    @ObservedObject var model: ChatViewModel
    let title: String
    let entries: [OutputEntry]
    let front: String
    let withInternal: Bool
    /// The folder this level shows, for the ZIP download ("" = the whole location); `nil` for the virtual "Internal" level.
    var zipPath: String?
    var hint: String?
    @State private var zip: URL?
    @State private var zipLoading = false
    @State private var zipError = ""

    var body: some View {
        let node = outputsLevel(entries, front: front, withInternal: withInternal)
        CbList {
            if node.isEmpty {
                Text(L("Nothing here yet.")).foregroundStyle(.secondary)
            }
            ForEach(node) { k in
                switch k {
                case .folder(let name, let path, let es):
                    NavigationLink {
                        OutputsLevelView(model: model, title: name, entries: es, front: path, withInternal: false,
                                         zipPath: String(path.dropLast()))
                    } label: { folderRow(name: name, count: es.count, isInternal: false) }
                    .accessibilityIdentifier("outputs-folder-\(name)")
                case .internalFiles(let es):
                    NavigationLink {
                        OutputsLevelView(model: model, title: L("Internal"), entries: es, front: "", withInternal: false)
                    } label: { folderRow(name: L("Internal"), count: es.count, isInternal: true) }
                    .accessibilityIdentifier("outputs-internal")
                case .file(let e):
                    NavigationLink {
                        OutputFileView(model: model, entry: e)
                    } label: {
                        HStack(spacing: 9) {
                            Image(systemName: outputKind(e.name).image ? "photo" : "doc.text")
                                .foregroundStyle(.secondary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.name)
                                    .font(.system(.subheadline, design: .monospaced, weight: .medium))
                                    .lineLimit(1)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(e.size), countStyle: .file) + " · "
                                     + Date(timeIntervalSince1970: e.changed / 1000).formatted(.dateTime.locale(Loc.locale)))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("outputs-file-\(e.name)")
                }
            }
            if let hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
            }
            if !zipError.isEmpty {
                Text(zipError).font(.caption).foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        // The list is live: a ZIP fetched before new files arrived would share an old state.
        .onChange(of: entries) { zip = nil }
        .toolbar {
            if let zipPath, !entries.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    if let zip {
                        ShareLink(item: zip) { Label(L("Split"), systemImage: "square.and.arrow.up") }
                            .accessibilityIdentifier("outputs-zip-share")
                    } else if zipLoading {
                        ProgressView()
                    } else {
                        Button {
                            Task {
                                zipLoading = true
                                defer { zipLoading = false }
                                do { zip = try await model.loadOutputFolderZip(zipPath); zipError = "" } catch { zipError = error.localizedDescription }
                            }
                        } label: { Label(L("Download as ZIP"), systemImage: "arrow.down.circle") }
                        .accessibilityIdentifier("outputs-zip-download")
                    }
                }
            }
        }
    }

    private func folderRow(name: String, count: Int, isInternal: Bool) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "folder.fill")
                .font(.symbol(13, weight: .semibold))
                .foregroundStyle(isInternal ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
                .frame(width: 22)
            Text(name)
                .cbFont(15, weight: isInternal ? .regular : .semibold)
                .foregroundStyle(isInternal ? .secondary : .primary)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text("\(count)")
                .cbFont(11, weight: .medium)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }
}

/// One file: image, Markdown/plain text, other text as source (up to 1 MiB) — otherwise download + share.
/// The log file of a monitor also opens here (Chat/ChatMonitors.swift, card under Background Tasks).
struct OutputFileView: View {
    @ObservedObject var model: ChatViewModel
    let entry: OutputEntry
    @State private var image: UIImage?
    @State private var text: String?
    @State private var file: URL?
    @State private var loading = true
    @State private var error = ""

    var body: some View {
        let kind = outputKind(entry.name)
        Group {
            if loading {
                ProgressView()
            } else if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image).resizable().scaledToFit().padding()
                }
            } else if let text {
                ScrollView {
                    if kind.markdown {
                        MarkdownView(source: text).padding()
                    } else {
                        Text(text)
                            .cbFont(13, design: .monospaced)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding()
                    }
                }
            } else {
                ContentUnavailableView(
                    L("No preview"),
                    systemImage: "doc",
                    description: Text(error.isEmpty ? L("This file can be downloaded and shared.") : error)
                )
            }
        }
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let file {
                    ShareLink(item: file) { Label(L("Split"), systemImage: "square.and.arrow.up") }
                } else {
                    Button {
                        Task {
                            do { file = try await model.loadOutputDown(entry) } catch { self.error = error.localizedDescription }
                        }
                    } label: { Label(L("Download"), systemImage: "arrow.down.circle") }
                }
            }
        }
        .task(id: entry) { await load(kind) }
    }

    private func load(_ kind: (image: Bool, markdown: Bool, text: Bool)) async {
        loading = true
        defer { loading = false }
        guard kind.image || (kind.text && entry.size <= previewMax) else { return }
        do {
            let data = try await model.outputData(entry)
            if kind.image { image = UIImage(data: data) } else { text = String(decoding: data, as: UTF8.self) }
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }
}
