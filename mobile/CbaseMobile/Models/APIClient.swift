import Foundation

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
    case put = "PUT"
}

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String
    /// `code` of the error body (e.g. "UNKNOWN_INSTANCE" for the code tab's instance choice) and the named `identifier` — nil if
    /// the server names none.
    var code: String? = nil
    var identifier: String? = nil
    /// Numbers of the error body that let a view continue: `size` (409 on a project upload — resume from here), `free`/`needed`
    /// (409, not enough space).
    var size: Int? = nil
    var free: Int? = nil
    var needed: Int? = nil
    /// 409 conflict of a later upload: how many target files already exist, and up to five of them.
    var existing: Int? = nil
    var examples: [String]? = nil
    /// The whole error body: 409 INSTANCE_WORKING names `chats` and `open`, 409 OPEN_CHANGES `files` and `count` — the sheets of
    /// the "Instances" tab show them as a list. nil without a readable body.
    var body: [String: JSONValue]? = nil

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
}

final class APIClient: @unchecked Sendable {
    let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        // This session runs ordinary calls AND the permanently open SSE streams. A stream occupies its connection as long as the
        // view stands: /api/events always, plus the open chat's stream and one each for terminal, browser and debugger. On iOS
        // HTTP/1.1 allows by default only FOUR connections per host — with two open tabs the window is full, and the next ordinary
        // request waits indefinitely for a free slot instead of failing. The web client's chat switch hung on exactly this (six
        // connections there, eaten by four own /api/events streams). Eight leaves room for all streams at once; over HTTP/2 the
        // setting is meaningless anyway.
        configuration.httpMaximumConnectionsPerHost = 8
        session = URLSession(configuration: configuration)
        decoder = JSONDecoder()
        encoder = JSONEncoder()
    }

    /// `timeout` overrides the session default (45 s) for single calls. Lists a view hangs on should fail fast and show a retry
    /// button instead of loading for minutes.
    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, method: .get, query: query, timeout: timeout)
    }

    /// `timeout` like for `get`, but upward here: an upload of several PDFs is read on the server while being accepted, and the
    /// session's 45 s do not suffice. `query`: the git view of a chat appends `chat=<id>` to every call — also to a POST. Encoding
    /// happens in `makeURL`, never before.
    func post<T: Decodable, Body: Encodable>(_ path: String, query: [URLQueryItem] = [], body: Body, timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, method: .post, query: query, body: body, timeout: timeout)
    }

    /// `timeout` upward: a restart of the user container waits until the backend is healthy — the session's 45 s reported it as
    /// failed while the gateway kept working.
    func post<T: Decodable>(_ path: String, timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, method: .post, bodyData: Data("{}".utf8), timeout: timeout)
    }

    func patch<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        try await request(path, method: .patch, body: body)
    }

    func put<T: Decodable, Body: Encodable>(_ path: String, body: Body, timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, method: .put, body: body, timeout: timeout)
    }

    func delete<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await request(path, method: .delete, query: query)
    }

    /// Fire-and-forget calls (terminal input, browser events): the response body does not matter, but the status code is checked.
    /// `timeout` like for `post` (deleting a user tears down containers and volumes).
    @discardableResult
    func send<Body: Encodable>(
        _ path: String,
        method: HTTPMethod = .post,
        query: [URLQueryItem] = [],
        body: Body,
        timeout: TimeInterval? = nil
    ) async throws -> Data {
        var request = try makeRequest(path, method: method, query: query)
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        let (data, response) = try await abortAsCancellation { try await self.session.data(for: request) }
        try validate(response: response, data: data)
        return data
    }

    @discardableResult
    func send(_ path: String, method: HTTPMethod = .post, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) async throws -> Data {
        try await send(path, method: method, query: query, body: EmptyBody(), timeout: timeout)
    }

    /// Upload an attachment. The server also puts every uploaded FILE into the chat's artifacts (folder "uploads/"). Pasted TEXT is
    /// technically the same attachment but no file anybody uploaded — `asArtifact: false` excludes the copy, otherwise every long
    /// paste would land permanently in the artifacts.
    func upload(_ path: String, name: String, data: Data, asArtifact: Bool = true) async throws -> Attachment {
        var query = [URLQueryItem(name: "name", value: name)]
        if !asArtifact { query.append(URLQueryItem(name: "artifact", value: "0")) }
        var request = try makeRequest(path, method: .post, query: query)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return try await execute(request)
    }

    /// Upload an artifact by hand: raw body, target as `?path=`. If the file already lies in the chat, the server answers 409
    /// instead of overwriting — the view asks and repeats with `overwrite: true`.
    func uploadArtifact(chatId: String, path: String, data: Data, overwrite: Bool = false) async throws -> ChatArtifact {
        var query = [URLQueryItem(name: "path", value: path)]
        if overwrite { query.append(URLQueryItem(name: "overwrite", value: "1")) }
        var request = try makeRequest("/api/chats/\(chatId)/artifacts/upload", method: .post, query: query)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return try await execute(request)
    }

    /// Upload a context file of a CHAT FOLDER. Context belongs to the folder, not to a chat: every chat in it may read it, no agent
    /// may change it. As with the artifact upload the server answers an existing file with 409 instead of overwriting.
    func uploadFolderContext(folderId: String, path: String, data: Data, overwrite: Bool = false) async throws -> ChatArtifact {
        var query = [URLQueryItem(name: "path", value: path)]
        if overwrite { query.append(URLQueryItem(name: "overwrite", value: "1")) }
        var request = try makeRequest("/api/chat-folders/\(folderId)/context/upload", method: .post, query: query)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return try await execute(request)
    }

    func data(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
        let request = try makeRequest(path, method: .get, query: query)
        let (data, response) = try await abortAsCancellation { try await self.session.data(for: request) }
        try validate(response: response, data: data)
        return data
    }

    /// File/folder download: streams into a temporary file instead of holding everything in memory — a folder ZIP can be hundreds
    /// of MB. The file name comes from `Content-Disposition` (folders become "<name>.zip" on the server), `fallbackName` applies
    /// only if the header is missing.
    func downloadToTemporaryFile(
        _ path: String,
        query: [URLQueryItem] = [],
        fallbackName: String
    ) async throws -> URL {
        var request = try makeRequest(path, method: .get, query: query)
        // The server packs the whole tree before the first bytes flow. 45 s (the session default) would be too tight for large
        // folders.
        request.timeoutInterval = 600
        let (tempURL, response) = try await abortAsCancellation { try await self.session.download(for: request) }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            // The error body is JSON and small — read it for the message, then discard.
            let body = (try? Data(contentsOf: tempURL)) ?? Data()
            try? FileManager.default.removeItem(at: tempURL)
            try validate(response: response, data: body)
        }
        let name = Self.filename(from: response) ?? fallbackName
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("cbase-download-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(name)
        try FileManager.default.moveItem(at: tempURL, to: destination)
        return destination
    }

    /// File name from `Content-Disposition`. `filename*` (UTF-8) wins so that umlauts are preserved; path separators are
    /// neutralized — the name lands in the file system.
    private static func filename(from response: URLResponse) -> String? {
        guard let http = response as? HTTPURLResponse,
              let header = http.value(forHTTPHeaderField: "Content-Disposition") else { return nil }
        var candidate: String?
        if let marker = header.range(of: "filename*=UTF-8''") {
            let raw = header[marker.upperBound...].split(separator: ";").first.map(String.init) ?? ""
            candidate = raw.trimmingCharacters(in: .whitespaces).removingPercentEncoding
        }
        if candidate == nil, let marker = header.range(of: "filename=\"") {
            let rest = header[marker.upperBound...]
            if let end = rest.firstIndex(of: "\"") { candidate = String(rest[rest.startIndex..<end]) }
        }
        guard let name = candidate?.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, name != "." , name != ".." else { return nil }
        return name
    }

    func stream(_ path: String, query: [URLQueryItem] = []) -> AsyncThrowingStream<JSONValue, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try makeRequest(path, method: .get, query: query)
                    let (bytes, response) = try await session.bytes(for: request)
                    try validate(response: response, data: Data())
                    // `sseLines`, not `.lines`: that also split at U+2028/U+2029/U+0085 in the JSON (SSERows.swift).
                    for try await line in bytes.sseLines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard !payload.isEmpty, let data = payload.data(using: .utf8) else { continue }
                        continuation.yield(try decoder.decode(JSONValue.self, from: data))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// SSE stream with named events (`event: frame`) — the browser screencast and the terminal use `event:` lines, not only `data:`.
    func namedStream(_ path: String, query: [URLQueryItem] = []) -> AsyncThrowingStream<(String, JSONValue), Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try makeRequest(path, method: .get, query: query)
                    let (bytes, response) = try await session.bytes(for: request)
                    try validate(response: response, data: Data())
                    var event = "message"
                    // `sseLines`, not `.lines` (SSERows.swift) — empty lines now come along and reset `event`.
                    for try await line in bytes.sseLines {
                        try Task.checkCancellation()
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                            continue
                        }
                        if line.isEmpty {
                            event = "message"
                            continue
                        }
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        let name = event
                        event = "message"
                        guard !payload.isEmpty, let data = payload.data(using: .utf8) else { continue }
                        guard let value = try? decoder.decode(JSONValue.self, from: data) else { continue }
                        continuation.yield((name, value))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    func captureFileURL(chatId: String, captureId: String, name: String) -> URL? {
        try? makeURL("/api/chats/\(chatId)/captures/\(captureId)/file/\(name)")
    }

    private func request<T: Decodable>(
        _ path: String,
        method: HTTPMethod,
        query: [URLQueryItem] = [],
        bodyData: Data? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        var request = try makeRequest(path, method: method, query: query)
        if let timeout { request.timeoutInterval = timeout }
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }
        return try await execute(request)
    }

    private func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: HTTPMethod,
        query: [URLQueryItem] = [],
        body: Body,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        try await request(path, method: method, query: query, bodyData: try encoder.encode(body), timeout: timeout)
    }

    /// A cancelled job is no error. When Swift cancels the task (SwiftUI `.task(id:)` on change, `Task.cancel()`), `URLSession` does
    /// not throw `CancellationError` but `URLError(.cancelled)` — and every caller's `catch is CancellationError { return }` missed
    /// it: Usage → Claude showed a red "cancelled" after a quick window switch instead of loading. Here, in ONE place, it becomes
    /// `CancellationError` — only if the task is really cancelled; a `.cancelled` for another reason (rejected login …) stays an error.
    private func abortAsCancellation<T>(_ job: () async throws -> T) async throws -> T {
        do {
            return try await job()
        } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
            throw CancellationError()
        }
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await abortAsCancellation { try await self.session.data(for: request) }
        try validate(response: response, data: data)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: L("Could not read the server response: {error}", ["error": error.localizedDescription]))
        }
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: L("Invalid server response"))
        }
        guard (200..<300).contains(http.statusCode) else {
            let decoded = try? decoder.decode([String: JSONValue].self, from: data)
            // Behind the tunnel a long request ends with 524 and an HTML page — without text from the body the status code stands
            // there (never an empty message).
            let fromBody = (decoded?["error"]?.stringValue ?? decoded?["detail"]?.stringValue)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let message = (fromBody?.isEmpty == false ? fromBody : nil)
                ?? "\(HTTPURLResponse.localizedString(forStatusCode: http.statusCode)) (HTTP \(http.statusCode))"
            throw APIError(
                status: http.statusCode, message: message, code: decoded?["code"]?.stringValue, identifier: decoded?["identifier"]?.stringValue,
                size: decoded?["size"]?.intValue, free: decoded?["free"]?.intValue, needed: decoded?["needed"]?.intValue,
                existing: decoded?["existing"]?.intValue, examples: decoded?["examples"]?.arrayValue?.compactMap(\.stringValue),
                body: decoded
            )
        }
    }

    private func makeRequest(
        _ path: String,
        method: HTTPMethod,
        query: [URLQueryItem] = []
    ) throws -> URLRequest {
        var request = URLRequest(url: try makeURL(path, query: query))
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // The app names itself on EVERY request (Models/ApiContract.swift); the server counts a request without the header as API level 1.
        request.setValue(ApiContract.currentUserAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(ApiContract.currentClientHeader, forHTTPHeaderField: "X-Cbase-Client")
        return request
    }

    private func makeURL(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError(status: 0, message: L("Invalid server address"))
        }
        components.path = path.hasPrefix("/") ? path : "/\(path)"
        if !query.isEmpty {
            components.queryItems = query
            // `URLComponents` leaves "+" in the query; the server (URLSearchParams) reads it as a space — a folder "a+b" never opened. A
            // real "+" therefore goes as %2B.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else {
            throw APIError(status: 0, message: L("Invalid server address"))
        }
        return url
    }
}

struct EmptyBody: Codable {}
struct OKResponse: Codable, Sendable {
    let ok: Bool?
    let note: String?
}
