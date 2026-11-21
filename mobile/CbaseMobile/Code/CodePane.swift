import PhotosUI
import SwiftUI
import UIKit

// Code tab: file tree (left drawer), editor in the content area, full-text search and
// the git view — all on the same scope (workspace folder or project folder).
//
// Built into the page background: ONLY surfaces and colors — the editor's header, the editor itself (with line numbers), the
// bar under the image preview and the search hits sit directly on `CbColor.ground`, no surface of their own (`surface`), no card
// (`PaneCard`); the `TextEditor` draws no system background (`scrollContentBackground(.hidden)`). Where two areas meet
// (header | editor, image | bar, hit | hit), a `CbHairline` separates them — as an overlay, so no dimension shifts.
// Controls (save, discard, search field, download) are unchanged.
@MainActor
final class CodeBrowserModel: ObservableObject {
    @Published var listings: [String: [FileEntry]] = [:]
    @Published var expanded: Set<String> = []
    @Published var loadingPaths: Set<String> = []
    @Published var openPath: String?
    /// A taken-over layout deleted the open file — the content stays visible, saving is blocked
    /// (otherwise `files/write` would silently recreate the old location).
    @Published var deleted = false
    @Published var content = ""
    @Published var originalContent = ""
    @Published var fileState: FileLoadState = .none
    @Published var saving = false
    @Published var error = ""
    @Published var searchQuery = ""
    @Published var searchResults: [FileSearchResult] = []
    @Published var searching = false
    @Published var searchTruncated = false
    @Published var uploading = false
    @Published var uploadDone = 0
    @Published var uploadTotal = 0
    /// Image preview of the open file (instead of "Binary file").
    @Published var image: UIImage?
    @Published var imageBytes = 0
    /// Path currently being downloaded — the tree row shows a spinner for it.
    @Published var downloading: String?
    /// Finished download → share sheet ("Save to Files").
    @Published var downloaded: DownloadedFile?

    struct DownloadedFile: Identifiable {
        let id = UUID()
        let url: URL
    }

    enum FileLoadState: Equatable {
        case none
        case loading
        case text
        case tooLarge
        case binary
        case image
    }

    let client: APIClient
    let apiBase: String
    /// The Code tab's chosen COPY (`instance=<identifier>`, Code/CodeInstance.swift) — nil is the main, every address unchanged.
    /// EVERY call of this model carries `instanceQuery`; a call bypassing it would run from the copy into the main.
    let instance: String?
    /// The copy's name ("k1") — the view names it (the language service exists there too).
    let copy: String?
    /// Every route error goes here: on 404 `UNKNOWN_INSTANCE` the instance choice visibly falls back to the main.
    var onError: ((Error) -> Void)?
    private var instanceQuery: [URLQueryItem] { CodeInstance.query(instance) }

    var dirty: Bool { fileState == .text && content != originalContent }

    init(client: APIClient, apiBase: String, instance: String? = nil, copy: String? = nil) {
        self.client = client
        self.apiBase = apiBase
        self.instance = instance
        self.copy = copy
    }

    private func error(_ error: Error) {
        self.error = error.localizedDescription
        onError?(error)
    }

    func loadRootIfNeeded() async {
        guard listings[""] == nil else { return }
        await load(path: "")
    }

    func load(path: String) async {
        loadingPaths.insert(path)
        defer { loadingPaths.remove(path) }
        do {
            let listing: DirListing = try await client.get(
                "\(apiBase)/files/tree",
                query: [URLQueryItem(name: "path", value: path)] + instanceQuery
            )
            listings[path] = listing.entries
            error = ""
        } catch {
            self.error(error)
        }
    }

    func toggle(_ entry: FileEntry) async {
        if expanded.contains(entry.path) {
            expanded.remove(entry.path)
        } else {
            expanded.insert(entry.path)
            if listings[entry.path] == nil { await load(path: entry.path) }
        }
    }

    func open(_ path: String) async {
        openPath = path
        deleted = false
        fileState = .loading
        content = ""
        originalContent = ""
        image = nil
        imageBytes = 0
        do {
            let file: FileContent = try await client.get(
                "\(apiBase)/files/read",
                query: [URLQueryItem(name: "path", value: path)] + instanceQuery
            )
            if file.tooLarge {
                fileState = .tooLarge
            } else if file.image {
                fileState = .image
                imageBytes = file.size
                await loadImage(path)
            } else if file.binary {
                fileState = .binary
            } else {
                content = file.content ?? ""
                originalContent = content
                fileState = .text
            }
            error = ""
        } catch {
            fileState = .none
            self.error(error)
        }
    }

    /// Fetch image bytes via the inline route. If nothing decodable comes back (e.g. HEIC
    /// without system support), the binary display stays instead of an empty surface.
    private func loadImage(_ path: String) async {
        do {
            let data = try await client.data(
                "\(apiBase)/files/download",
                query: [URLQueryItem(name: "path", value: path), URLQueryItem(name: "inline", value: "1")] + instanceQuery
            )
            guard openPath == path else { return } // meanwhile moved on
            if let decoded = UIImage(data: data) {
                image = decoded
            } else {
                fileState = .binary
            }
        } catch {
            guard openPath == path else { return }
            fileState = .binary
            self.error(error)
        }
    }

    /// Download a file or folder (as ZIP) and hand it to the share sheet, so iOS
    /// can put it into Files, iCloud or another app.
    func download(path: String, name: String, isDirectory: Bool) async {
        guard downloading == nil else { return }
        downloading = path
        defer { downloading = nil }
        do {
            let url = try await client.downloadToTemporaryFile(
                "\(apiBase)/files/download",
                query: [URLQueryItem(name: "path", value: path)] + instanceQuery,
                fallbackName: isDirectory ? "\(name).zip" : name
            )
            downloaded = DownloadedFile(url: url)
            error = ""
        } catch {
            self.error(error)
        }
    }

    /// Download the open file (button in the image/binary display).
    func downloadOpenFile() async {
        guard let path = openPath else { return }
        await download(path: path, name: path.split(separator: "/").last.map(String.init) ?? path, isDirectory: false)
    }

    func save() async {
        guard let path = openPath, fileState == .text, !deleted else { return }
        struct Body: Encodable { let path: String; let content: String }
        saving = true
        defer { saving = false }
        do {
            try await client.send("\(apiBase)/files/write", method: .put, query: instanceQuery, body: Body(path: path, content: content))
            originalContent = content
            error = ""
        } catch {
            self.error(error)
        }
    }

    func revert() {
        content = originalContent
    }

    /// After a taken-over layout (AppState.applyLayout — the caller knows whether this area shows the project and under which
    /// folder): the open file moves or shows as "deleted", expanded folders move along. At workspace level the project's location
    /// is missing — there only reload.
    func afterLayout(_ end: LayoutEnd, prefix: String) {
        guard instance == nil else { return }
        if let p = openPath {
            if let fresh = LayoutPaths.newPath(p, end, prefix: prefix) { openPath = fresh } else { deleted = true }
        }
        expanded = Set(expanded.compactMap { LayoutPaths.newPath($0, end, prefix: prefix) })
        listings = [:]
        let open = expanded
        Task {
            await load(path: "")
            for d in open where !d.isEmpty { await load(path: d) }
        }
    }

    /// "Open in the Code tab": expand and load the folders down to `path`.
    func show(_ path: String) {
        let parts = path.split(separator: "/").map(String.init)
        var targets: [String] = []
        for i in parts.indices { targets.append(parts[0...i].joined(separator: "/")) }
        for z in targets { expanded.insert(z) }
        Task {
            if listings[""] == nil { await load(path: "") }
            for z in targets where listings[z] == nil { await load(path: z) }
        }
    }

    func create(path: String, isDirectory: Bool) async {
        struct Body: Encodable { let path: String; let type: String }
        do {
            try await client.send("\(apiBase)/files/create", query: instanceQuery, body: Body(path: path, type: isDirectory ? "dir" : "file"))
            await refreshParent(of: path)
            if !isDirectory { await open(path) }
        } catch {
            self.error(error)
        }
    }

    /// Upload files and folders — `into` is the TARGET FOLDER (empty = scope root).
    /// In chunks of ~3 MB as in the desktop client, so a whole large file is never in
    /// memory. Applies to workspace AND project (the server knows both routes).
    func upload(_ urls: [URL], into dir: String = "") async {
        struct Item: Encodable { let path: String; let dataB64: String; let append: Bool? }
        struct Body: Encodable { let dir: String; let files: [Item] }
        let chunk = 3 * 1024 * 1024

        uploading = true
        uploadDone = 0
        uploadTotal = 0
        defer { uploading = false }

        var jobs: [(url: URL, relative: String)] = []
        var scoped: [URL] = []
        defer { for url in scoped { url.stopAccessingSecurityScopedResource() } }
        for url in urls {
            if url.startAccessingSecurityScopedResource() { scoped.append(url) }
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDirectory {
                let folder = url.lastPathComponent
                let keys: [URLResourceKey] = [.isRegularFileKey]
                // `allObjects` instead of iterating the enumerator directly: its
                // `makeIterator` is not allowed in an asynchronous context
                // (an error in Swift 6).
                let walker = FileManager.default
                    .enumerator(at: url, includingPropertiesForKeys: keys)?
                    .allObjects ?? []
                for case let child as URL in walker {
                    guard (try? child.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                    let relative = child.path.replacingOccurrences(of: url.path, with: "")
                        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    jobs.append((child, folder + "/" + relative))
                }
            } else {
                jobs.append((url, url.lastPathComponent))
            }
        }
        uploadTotal = jobs.count
        guard !jobs.isEmpty else { return }

        var batch: [Item] = []
        var batchBytes = 0
        func flush() async throws {
            guard !batch.isEmpty else { return }
            let payload = batch
            batch = []
            batchBytes = 0
            try await client.send("\(apiBase)/upload", query: instanceQuery, body: Body(dir: dir, files: payload))
        }

        do {
            for job in jobs {
                guard let handle = try? FileHandle(forReadingFrom: job.url) else { continue }
                defer { try? handle.close() }
                var first = true
                while let data = try handle.read(upToCount: chunk), !data.isEmpty {
                    if data.count >= chunk || batchBytes + data.count > chunk {
                        try await flush()
                    }
                    batch.append(Item(path: job.relative, dataB64: data.base64EncodedString(), append: first ? nil : true))
                    batchBytes += data.count
                    first = false
                    if batchBytes >= chunk { try await flush() }
                }
                // Empty file: create it anyway.
                if first {
                    batch.append(Item(path: job.relative, dataB64: "", append: nil))
                }
                uploadDone += 1
            }
            try await flush()
            await reloadUploadTarget(dir)
        } catch {
            self.error(error)
        }
    }

    /// Put photos from the system picker into a folder. They arrive as bytes (no file URL),
    /// but are chunked the same way — a camera photo easily has 10 MB.
    func uploadPhotos(_ items: [(name: String, data: Data)], into dir: String) async {
        struct Item: Encodable { let path: String; let dataB64: String; let append: Bool? }
        struct Body: Encodable { let dir: String; let files: [Item] }
        guard !items.isEmpty else { return }
        let chunk = 3 * 1024 * 1024
        uploading = true
        uploadDone = 0
        uploadTotal = items.count
        defer { uploading = false }
        do {
            for item in items {
                var offset = 0
                var first = true
                repeat {
                    let end = min(offset + chunk, item.data.count)
                    let slice = item.data.subdata(in: offset..<end)
                    try await client.send(
                        "\(apiBase)/upload",
                        query: instanceQuery,
                        body: Body(dir: dir, files: [Item(path: item.name, dataB64: slice.base64EncodedString(), append: first ? nil : true)])
                    )
                    offset = end
                    first = false
                } while offset < item.data.count
                uploadDone += 1
            }
            await reloadUploadTarget(dir)
        } catch {
            self.error(error)
        }
    }

    /// After an upload, reload and expand exactly the target folder — otherwise the
    /// user does not see the result.
    private func reloadUploadTarget(_ dir: String) async {
        await load(path: dir)
        if !dir.isEmpty { expanded.insert(dir) }
    }

    func rename(from: String, to: String) async {
        struct Body: Encodable { let from: String; let to: String }
        do {
            try await client.send("\(apiBase)/files/rename", query: instanceQuery, body: Body(from: from, to: to))
            await refreshParent(of: from)
            await refreshParent(of: to)
            if openPath == from { await open(to) }
        } catch {
            self.error(error)
        }
    }

    func delete(path: String) async {
        do {
            let _: OKResponse = try await client.delete(
                "\(apiBase)/files",
                query: [URLQueryItem(name: "path", value: path)] + instanceQuery
            )
            await refreshParent(of: path)
            if openPath == path {
                openPath = nil
                fileState = .none
                content = ""
                originalContent = ""
            }
        } catch {
            self.error(error)
        }
    }

    func search() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else {
            searchResults = []
            return
        }
        struct Body: Encodable { let query: String; let regex: Bool; let caseSensitive: Bool; let includeHeavy: Bool }
        searching = true
        defer { searching = false }
        do {
            let response: FileGrepResponse = try await client.post(
                "\(apiBase)/files/search",
                query: instanceQuery,
                body: Body(query: query, regex: false, caseSensitive: false, includeHeavy: false)
            )
            searchResults = response.results
            searchTruncated = response.truncated
            error = ""
        } catch {
            self.error(error)
        }
    }

    private func refreshParent(of path: String) async {
        let parts = path.split(separator: "/")
        let parent = parts.count <= 1 ? "" : parts.dropLast().joined(separator: "/")
        await load(path: parent)
    }

    // ── Flat tree for the drawer ──
    // SwiftUI views cannot build themselves recursively (opaque return type),
    // so the expanded tree is unrolled here into a flat list with depth.
    struct TreeRow: Identifiable {
        var id: String { entry.path }
        let entry: FileEntry
        let depth: Int
        let childrenLoading: Bool
    }

    var flatTree: [TreeRow] {
        var rows: [TreeRow] = []
        appendRows(of: "", depth: 0, into: &rows)
        return rows
    }

    private func appendRows(of path: String, depth: Int, into rows: inout [TreeRow]) {
        guard depth < 12 else { return }
        for entry in listings[path] ?? [] {
            let open = entry.isDirectory && expanded.contains(entry.path)
            rows.append(TreeRow(
                entry: entry,
                depth: depth,
                childrenLoading: open && loadingPaths.contains(entry.path)
            ))
            if open { appendRows(of: entry.path, depth: depth + 1, into: &rows) }
        }
    }
}

struct CodePane: View {
    @ObservedObject var model: CodeBrowserModel
    @ObservedObject var git: GitModel
    @ObservedObject var debug: DebugModel
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
        // The instance choice "Main | Copy k1" above every subview (only with a ready copy or a fallback hint).
        if let choice = state.codeInstance {
            CodeInstanceBar(model: choice, unsaved: model.dirty)
        }
        Group {
            switch state.codeSub {
            case .files:
                editor
            case .search:
                searchView
            case .git:
                GitPane(model: git)
            case .problems:
                ProblemsPane(model: model)
                    .id(model.openPath ?? "none")
            case .debug:
                DebugPane(model: debug, openFile: model.openPath)
            }
        }
        }
        .task(id: ObjectIdentifier(model)) { await model.loadRootIfNeeded() }
        // A held copy (fallback with an unsaved file) releases the choice as soon as the file is no longer changed
        // (discarded, saved, another one opened).
        .onChange(of: model.dirty) { if !model.dirty { state.codeInstance?.apply() } }
    }

    // ── Editor ──
    private var editor: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.symbol(12))
                    .foregroundStyle(.secondary)
                Text(model.openPath ?? L("No file open"))
                    .cbFont(12, weight: .medium, design: .monospaced)
                    .lineLimit(1)
                    .truncationMode(.head)
                if model.dirty {
                    Circle().fill(Color.orange).frame(width: 7, height: 7)
                }
                if model.deleted {
                    Text(L("deleted")).cbFont(11, weight: .medium).foregroundStyle(.red)
                }
                Spacer()
                if model.dirty {
                    PillButton(title: L("Dismiss")) { model.revert() }
                }
                PillButton(
                    title: model.saving ? "…" : L("Save"),
                    systemImage: "arrow.down.doc",
                    prominent: true,
                    disabled: !model.dirty || model.saving || model.deleted
                ) {
                    Task { await model.save() }
                }
                .accessibilityIdentifier("code-save")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // On the page ground, below it only a hairline — no surface of its own.
            .overlay(alignment: .bottom) { CbHairline() }

            InlineError(message: model.error)

            switch model.fileState {
            case .none:
                EmptyPaneState(
                    title: L("No file open"),
                    message: L("Swipe right and pick a file from the tree."),
                    systemImage: "folder"
                )
                Spacer()
            case .loading:
                CbLoading(label: L("Loading…"))
                Spacer()
            case .tooLarge:
                EmptyPaneState(title: L("File is too large to edit."), systemImage: "exclamationmark.triangle")
                Spacer()
            case .binary:
                VStack(spacing: 14) {
                    EmptyPaneState(title: L("Binary file"), systemImage: "doc.zipper")
                    PillButton(title: L("Download"), systemImage: "arrow.down.circle", prominent: true) {
                        Task { await model.downloadOpenFile() }
                    }
                    .disabled(model.downloading != nil)
                    .accessibilityIdentifier("code-download-open")
                }
                Spacer()
            case .image:
                if let image = model.image {
                    ImageFileView(image: image, bytes: model.imageBytes, downloading: model.downloading != nil) {
                        Task { await model.downloadOpenFile() }
                    }
                } else {
                    CbLoading(label: L("Loading…"))
                    Spacer()
                }
            case .text:
                CodeTextEditor(text: $model.content)
            }
        }
        .background(CbColor.ground)
        // The share sheet is deliberately attached ONLY here and not also to the drawer: both are
        // mounted at the same time, two .sheet on the same state would block each other.
        .sheet(item: $model.downloaded) { file in
            ShareSheet(items: [file.url])
        }
    }

    // ── Full-text search ──
    private var searchView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.caption).foregroundStyle(.secondary)
                    TextField(L("Search in project…"), text: $model.searchQuery)
                        .cbFont(13, design: .monospaced)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit { Task { await model.search() } }
                        .accessibilityIdentifier("code-search-field")
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(CbColor.surface, in: Capsule())
                PillButton(title: model.searching ? "…" : L("Search"), prominent: true) {
                    Task { await model.search() }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.searching { CbLoading(compact: true) }
                    if model.searchResults.isEmpty && !model.searching {
                        EmptyPaneState(title: L("No matches"), systemImage: "magnifyingglass")
                    }
                    if model.searchTruncated {
                        Text(L("Result truncated — please narrow the search term."))
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    // One block per file directly on the ground (no card), a hairline
                    // between two blocks.
                    ForEach(Array(model.searchResults.enumerated()), id: \.element.id) { i, result in
                        VStack(alignment: .leading, spacing: 8) {
                            Button {
                                state.codeSub = .files
                                Task { await model.open(result.path) }
                            } label: {
                                Text(result.path)
                                    .cbFont(12, weight: .semibold, design: .monospaced)
                                    .foregroundStyle(.tint)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                            .buttonStyle(.plain)
                            ForEach(result.matches.prefix(6)) { match in
                                HStack(alignment: .top, spacing: 6) {
                                    Text(verbatim: "\(match.line)")
                                        .cbFont(10, design: .monospaced)
                                        .foregroundStyle(.secondary)
                                        .frame(width: 34, alignment: .trailing)
                                    Text(match.text.trimmingCharacters(in: .whitespaces))
                                        .cbFont(11, design: .monospaced)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                        .overlay(alignment: .top) { if i > 0 { CbHairline() } }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        }
        .background(CbColor.ground)
    }
}

/// Image preview in the Code tab. Fits itself (small icons are NOT blown up),
/// two fingers zoom, double tap resets. Zoomed, the surface scrolls in both
/// directions — the same pattern as wide tables, the wrapper's swipe recognizer
/// freezes the scroll view for that.
struct ImageFileView: View {
    let image: UIImage
    let bytes: Int
    let downloading: Bool
    let onDownload: () -> Void

    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private var scale: CGFloat { min(max(zoom * pinch, 1), 8) }

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                let size = fitted(into: geo.size)
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        // Strongly zoomed icons should be pixel-sharp, not blurred.
                        .interpolation(scale > 2 ? .none : .high)
                        .frame(width: size.width * scale, height: size.height * scale)
                        .frame(minWidth: geo.size.width, minHeight: geo.size.height)
                }
                .background(CheckerBoard())
                .gesture(
                    MagnificationGesture()
                        .updating($pinch) { value, state, _ in state = value }
                        .onEnded { value in zoom = min(max(zoom * value, 1), 8) }
                )
                .onTapGesture(count: 2) { withAnimation(.easeOut(duration: 0.2)) { zoom = zoom > 1 ? 1 : 2 } }
                .accessibilityIdentifier("code-image")
            }

            HStack(spacing: 10) {
                Text(verbatim: "\(Int(image.size.width * image.scale)) × \(Int(image.size.height * image.scale))")
                    .cbFont(11, design: .monospaced)
                    .foregroundStyle(.secondary)
                if bytes > 0 {
                    Text(formatBytes(Double(bytes)))
                        .cbFont(11, design: .monospaced)
                        .foregroundStyle(.secondary)
                }
                if scale > 1 {
                    Text(verbatim: "\(Int(scale * 100)) %")
                        .cbFont(11, design: .monospaced)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                PillButton(title: L("Download"), systemImage: "arrow.down.circle") { onDownload() }
                    .disabled(downloading)
                    .accessibilityIdentifier("code-download-open")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // On the page ground, above it only a hairline — no surface of its own.
            .overlay(alignment: .top) { CbHairline() }
        }
    }

    /// Fit, but never scale up — a 16×16 favicon stays 16×16.
    private func fitted(into box: CGSize) -> CGSize {
        let w = max(image.size.width * image.scale, 1)
        let h = max(image.size.height * image.scale, 1)
        guard box.width > 0, box.height > 0 else { return CGSize(width: w, height: h) }
        let factor = min(box.width / w, box.height / h, 1)
        return CGSize(width: w * factor, height: h * factor)
    }
}

/// Checkerboard behind the preview, so transparency is visible.
private struct CheckerBoard: View {
    var body: some View {
        Canvas { context, size in
            let step: CGFloat = 12
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(CbColor.ground))
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = row.isMultiple(of: 2) ? 0 : step
                while x < size.width {
                    context.fill(
                        Path(CGRect(x: x, y: y, width: step, height: step)),
                        with: .color(Color(.systemFill).opacity(0.35))
                    )
                    x += step * 2
                }
                y += step
                row += 1
            }
        }
        .drawingGroup()
    }
}

/// Monospaced editor with a line-number column — in the page ground's color (`CbColor.grund`),
/// without a box of its own: the `TextEditor` draws no system background.
struct CodeTextEditor: View {
    @Binding var text: String
    /// Line height of the number column = the editor's line height (12.5 pt, `.footnote` curve): both follow the
    /// text size (Kit/TextSize.swift) on the same curve, otherwise number and line would drift apart.
    @CbMetric(relativeTo: .footnote) private var rowHeight: CGFloat = 17
    /// Width of the number column — grows with its digits (11 pt, `.caption2` curve).
    @CbMetric(relativeTo: .caption2) private var numbersWidth: CGFloat = 36

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .trailing, spacing: 0) {
                    ForEach(1...max(1, text.components(separatedBy: "\n").count), id: \.self) { line in
                        Text(verbatim: "\(line)")
                            .cbFont(11, design: .monospaced)
                            .foregroundStyle(.secondary.opacity(0.6))
                            .frame(height: rowHeight)
                    }
                }
                .frame(width: numbersWidth)
                TextEditor(text: $text)
                    .cbFont(12.5, design: .monospaced)
                    .scrollContentBackground(.hidden)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .frame(minHeight: 400, alignment: .topLeading)
                    .frame(width: 700, alignment: .leading)
                    .scrollDisabled(true)
                    .accessibilityIdentifier("code-editor")
            }
            .padding(.vertical, 6)
        }
        .background(CbColor.ground)
    }
}

// ── Left drawer: file tree / search / git ────────────────────────────────
struct CodeSidebar: View {
    @ObservedObject var model: CodeBrowserModel
    @ObservedObject var git: GitModel
    @EnvironmentObject private var state: AppState
    @State private var creating: CreateEntryDraft?
    @State private var renaming: FileEntry?
    @State private var importing = false
    /// Target folder of the next upload (empty = root) — set by the button or context menu.
    @State private var uploadDir = ""
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(CodeSubView.allCases, id: \.rawValue) { sub in
                    Button {
                        state.codeSub = sub
                    } label: {
                        VStack(spacing: 2) {
                            Image(systemName: sub.symbol).font(.symbol(13))
                            Text(L(sub.displayLabel))
                                .cbFont(8.5, weight: .medium)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        // Selected neutrally like every drawer row (`LeftDrawerBody.row`): primary text on
                        // `CbColor.markiert`, the rest muted.
                        .foregroundStyle(state.codeSub == sub ? Color.primary : CbColor.textMuted)
                        .cbSelection(state.codeSub == sub, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("code-sub-\(sub.rawValue)")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .accessibilityIdentifier("code-sub-switch")

            if state.codeSub == .git {
                GitSidebarList(model: git)
            } else {
                // The row uses the WHOLE width of the drawer and divides it evenly
                // — the labels thus stay on one line (PillButton(fill:)).
                HStack(spacing: 6) {
                    PillButton(title: L("New file"), systemImage: "doc.badge.plus", fill: true) {
                        creating = CreateEntryDraft(isDirectory: false, parent: "")
                    }
                    PillButton(title: L("Folder"), systemImage: "folder.badge.plus", fill: true) {
                        creating = CreateEntryDraft(isDirectory: true, parent: "")
                    }
                    // Without a chosen folder it goes to the root; for a specific folder
                    // there is the entry in the row's context menu.
                    PillButton(
                        title: model.uploading
                            ? L("{done}/{total}", ["done": model.uploadDone, "total": model.uploadTotal])
                            : L("Upload"),
                        systemImage: model.uploading ? "hourglass" : "arrow.up.doc",
                        fill: true
                    ) {
                        uploadDir = ""
                        importing = true
                    }
                    .disabled(model.uploading)
                    .accessibilityIdentifier("code-upload")
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.flatTree) { row in
                            treeRow(row)
                            if row.childrenLoading {
                                CbLoading(compact: true)
                                    .padding(.leading, CGFloat(row.depth + 1) * 12)
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 12)
                }
            }
        }
        .task { await model.loadRootIfNeeded() }
        .sheet(item: $creating) { draft in
            CreateEntrySheet(draft: draft) { path, isDirectory in
                await model.create(path: path, isDirectory: isDirectory)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $renaming) { entry in
            RenameEntrySheet(entry: entry) { newPath in
                await model.rename(from: entry.path, to: newPath)
            }
            .cbSheet(.whole)
        }
        // Put files OR whole folders into the project — the counterpart of
        // dropping a folder in the desktop client.
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.item, .folder],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            let target = uploadDir
            Task { await model.upload(urls, into: target) }
        }
        // NO PhotosPicker in the context menu: SwiftUI does not present it there (the same
        // bug as in the chat) — the menu entry only sets the flag.
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
        .onChange(of: photoItems) {
            let selected = photoItems
            photoItems = []
            let target = uploadDir
            guard !selected.isEmpty else { return }
            Task {
                var items: [(name: String, data: Data)] = []
                for (index, item) in selected.enumerated() {
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        model.error = L("Could not load photo (is it only in iCloud?).")
                        continue
                    }
                    let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    items.append(("Photo-\(Int(Date().timeIntervalSince1970))-\(index + 1).\(ext)", data))
                }
                await model.uploadPhotos(items, into: target)
            }
        }
    }

    @ViewBuilder
    private func treeRow(_ row: CodeBrowserModel.TreeRow) -> some View {
        let entry = row.entry
        let depth = row.depth
        Group {
            Button {
                Task {
                    if entry.isDirectory {
                        await model.toggle(entry)
                    } else {
                        state.codeSub = .files
                        await model.open(entry.path)
                        state.closeDrawersAfterChoice()
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if entry.isDirectory {
                        Image(systemName: model.expanded.contains(entry.path) ? "chevron.down" : "chevron.right")
                            .font(.symbol(9, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 11)
                        Image(systemName: "folder.fill")
                            .font(.symbol(11))
                            .foregroundStyle(entry.heavy ? Color.secondary.opacity(0.5) : Color.accentColor.opacity(0.8))
                    } else {
                        Spacer().frame(width: 11)
                        Image(systemName: "doc")
                            .font(.symbol(11))
                            .foregroundStyle(.secondary)
                    }
                    Text(entry.name)
                        .cbFont(12.5, weight: model.openPath == entry.path ? .semibold : .regular)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if model.downloading == entry.path {
                        ProgressView().controlSize(.mini)
                    }
                }
                .padding(.leading, CGFloat(depth) * 12)
                .padding(.vertical, 5)
                .padding(.horizontal, 6)
                // The open file marked neutrally like every selected drawer row.
                .cbSelection(model.openPath == entry.path, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file-\(entry.path)")
            .contextMenu {
                if entry.isDirectory {
                    Button(L("New file"), systemImage: "doc.badge.plus") {
                        creating = CreateEntryDraft(isDirectory: false, parent: entry.path)
                    }
                    Button(L("New folder"), systemImage: "folder.badge.plus") {
                        creating = CreateEntryDraft(isDirectory: true, parent: entry.path)
                    }
                    Button(L("Upload files"), systemImage: "arrow.up.doc") {
                        uploadDir = entry.path
                        importing = true
                    }
                    Button(L("Upload photos"), systemImage: "photo") {
                        uploadDir = entry.path
                        pickingPhotos = true
                    }
                }
                // Folders come as ZIP; then the share sheet opens for saving to Files.
                Button(
                    entry.isDirectory ? L("Download as ZIP") : L("Download"),
                    systemImage: "arrow.down.circle"
                ) {
                    Task { await model.download(path: entry.path, name: entry.name, isDirectory: entry.isDirectory) }
                }
                .disabled(model.downloading != nil)
                Button(L("Rename"), systemImage: "pencil") { renaming = entry }
                Button(L("Delete"), systemImage: "trash", role: .destructive) {
                    Task { await model.delete(path: entry.path) }
                }
            }
        }
    }
}

struct CreateEntryDraft: Identifiable {
    let id = UUID()
    let isDirectory: Bool
    let parent: String
}

private struct CreateEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let draft: CreateEntryDraft
    let create: (String, Bool) async -> Void
    @State private var name = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(draft.isDirectory ? L("Folder name") : L("File name"), text: $name)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text(draft.parent.isEmpty ? "/" : "/\(draft.parent)/")
                        .cbFont(11, design: .monospaced)
                }
            }
            .navigationTitle(draft.isDirectory ? L("New folder") : L("New file"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Create")) {
                        let clean = name.trimmingCharacters(in: .whitespaces)
                        let path = draft.parent.isEmpty ? clean : "\(draft.parent)/\(clean)"
                        dismiss()
                        Task { await create(path, draft.isDirectory) }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

private struct RenameEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let entry: FileEntry
    let rename: (String) async -> Void
    @State private var path = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("New path")) {
                    TextField("path/to/file", text: $path)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle(L("Rename"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) {
                        let value = path.trimmingCharacters(in: .whitespaces)
                        dismiss()
                        Task { await rename(value) }
                    }
                    .disabled(path.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { if path.isEmpty { path = entry.path } }
        }
    }
}
