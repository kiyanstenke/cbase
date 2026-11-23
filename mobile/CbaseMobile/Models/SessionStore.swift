import Foundation

@MainActor
final class SessionStore: ObservableObject {
    enum Phase: Equatable {
        case connecting
        case needsLogin(setup: Bool)
        case startingEnvironment
        case ready
        case connectionFailed(String)
        /// The server no longer accepts this app's API level (`GatewayInfo.compatibility == .needsNewerApp`): RootView blocks with
        /// `NeedsNewerAppView` instead of signing in.
        case needsNewerApp
    }

    @Published var phase: Phase = .connecting
    @Published var serverAddress: String
    @Published var user: GatewayUser?
    @Published private(set) var client: APIClient?
    /// The last `GET /gw/info` of the connected server (version, build, API range); `nil` before the first answer.
    @Published private(set) var gatewayInfo: GatewayInfo?

    private let defaults = UserDefaults.standard
    private var pendingPushToken: String?

    init() {
        serverAddress = UserDefaults.standard.string(forKey: "cbase.mobile.server") ?? ""
    }

    func bootstrap() async {
        guard phase == .connecting else { return }
        guard !serverAddress.isEmpty else {
            phase = .connectionFailed("")
            return
        }
        await connect()
    }

    func connect() async {
        phase = .connecting
        do {
            let url = try normalizedURL(serverAddress)
            let nextClient = APIClient(baseURL: url)
            let info: GatewayInfo = try await nextClient.get("/gw/info")
            guard info.gateway else { throw APIError(status: 0, message: L("No cbase gateway is running at this address.")) }
            serverAddress = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            defaults.set(serverAddress, forKey: "cbase.mobile.server")
            client = nextClient
            user = info.user
            // Before signing in: a server that no longer speaks this app's level would fail at every later route.
            guard apply(info) else { return }
            if info.authenticated {
                await ensureEnvironment()
            } else {
                phase = .needsLogin(setup: info.setup)
            }
        } catch {
            client = nil
            user = nil
            gatewayInfo = nil
            phase = .connectionFailed(error.localizedDescription)
        }
    }

    /// Reads `GET /gw/info` again (Settings → About shows the server's build; the server may have been updated since connecting —
    /// to one that needs a newer app, too). A failed read keeps the last answer.
    func refreshGatewayInfo() async {
        guard let client else { return }
        if let info: GatewayInfo = try? await client.get("/gw/info") { apply(info) }
    }

    /// THE place a fresh `/gw/info` lands: it becomes `gatewayInfo`, and its API range is judged for this app. A server that no
    /// longer speaks the app's level switches the phase to `.needsNewerApp` (RootView then blocks) and the answer is false — the
    /// caller goes no further. Every read of `/gw/info` goes through here, so no path can keep working past an updated server.
    @discardableResult
    private func apply(_ info: GatewayInfo) -> Bool {
        gatewayInfo = info
        guard info.compatibility != .needsNewerApp else {
            phase = .needsNewerApp
            return false
        }
        return true
    }

    /// The soft notice for an OLDER server (`.olderServer`) appears once per server address and server build; this is its memory.
    func olderServerNoticeDue() -> Bool {
        guard let info = gatewayInfo, info.compatibility == .olderServer else { return false }
        return defaults.string(forKey: olderServerNoticeKey) != olderServerNoticeValue(info)
    }

    func dismissOlderServerNotice() {
        guard let info = gatewayInfo else { return }
        defaults.set(olderServerNoticeValue(info), forKey: olderServerNoticeKey)
    }

    /// One key per server address; the value is the server's level and build, so an updated (still older) server asks once more.
    private var olderServerNoticeKey: String { "cbase.mobile.olderServerNotice:\(serverAddress)" }
    private func olderServerNoticeValue(_ info: GatewayInfo) -> String { "level=\(info.api?.level ?? 1) build=\(info.build ?? info.version ?? "")" }

    func login(username: String, password: String, setup: Bool, setupToken: String = "") async throws {
        guard let client else { throw APIError(status: 0, message: L("Not connected to a server yet.")) }
        // First-time setup also carries the one-time token from the gateway's log (server/gateway/setup-token.js).
        struct Credentials: Codable { let username: String; let password: String; let setupToken: String? }
        let token = setup ? setupToken.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let response: LoginResponse = try await client.post(setup ? "/gw/setup" : "/gw/login", body: Credentials(username: username, password: password, setupToken: token))
        user = response.user
        defaults.set(username, forKey: "cbase.mobile.username")
        // The server may have been updated while the sign-in stood open: judge its range once more before the environment starts.
        if let info: GatewayInfo = try? await client.get("/gw/info"), !apply(info) { return }
        await ensureEnvironment()
    }

    func ensureEnvironment() async {
        guard let client else { return }
        phase = .startingEnvironment
        do {
            let _: EnvironmentResponse = try await client.post("/gw/env/ensure")
            phase = .ready
            if let pendingPushToken { await registerPushToken(pendingPushToken) }
        } catch let error as APIError where error.isUnauthorized {
            user = nil
            phase = .needsLogin(setup: false)
        } catch {
            phase = .connectionFailed(error.localizedDescription)
        }
    }

    func logout() async {
        if let client {
            _ = try? await client.send(
                "/gw/push/devices/current",
                method: .delete,
                body: PushDeviceRemoval(installationId: PushNotifications.installationID)
            )
            let _: OKResponse? = try? await client.post("/gw/logout")
        }
        user = nil
        phase = .needsLogin(setup: false)
    }

    /// Deletes the OWN account (POST /gw/account/delete, App Store guideline 5.1.1(v)). Like `logout`, the push device goes first —
    /// afterwards there is no session to remove it with; if the deletion is refused (403 wrong password, 409 last admin), the device
    /// is registered again and the error goes to the sheet unchanged (it words it by its code). On 202 the app returns to the login — or to the setup if the
    /// gateway already reports no user.
    func deleteAccount(password: String) async throws {
        guard let client else { throw APIError(status: 0, message: L("Not connected to a server yet.")) }
        _ = try? await client.send(
            "/gw/push/devices/current",
            method: .delete,
            body: PushDeviceRemoval(installationId: PushNotifications.installationID)
        )
        do {
            try await client.deleteOwnAccount(password: password)
        } catch {
            if let pendingPushToken { await registerPushToken(pendingPushToken) }
            throw error
        }
        let info: GatewayInfo? = try? await client.get("/gw/info")
        user = nil
        if let info, !apply(info) { return }
        phase = .needsLogin(setup: info?.setup ?? false)
    }

    func prepareServerChange() {
        if let client {
            Task {
                _ = try? await client.send(
                    "/gw/push/devices/current",
                    method: .delete,
                    body: PushDeviceRemoval(installationId: PushNotifications.installationID)
                )
            }
        }
        client = nil
        user = nil
        gatewayInfo = nil
        phase = .connectionFailed("")
    }

    var savedUsername: String {
        defaults.string(forKey: "cbase.mobile.username") ?? ""
    }

    func receivePushToken(_ token: String) {
        pendingPushToken = token
        guard phase == .ready else { return }
        Task { await registerPushToken(token) }
    }

    private func registerPushToken(_ token: String) async {
        guard let client, phase == .ready else { return }
        let body = PushDeviceRegistration(
            installationId: PushNotifications.installationID,
            token: token,
            environment: PushNotifications.environment,
            locale: Loc.lang.rawValue
        )
        do {
            let _: OKResponse = try await client.put("/gw/push/devices/current", body: body)
        } catch let error as APIError where error.isUnauthorized {
            // Normal session restoration handles signing in again.
        } catch {
            // APNs registration is an extra and must not block app start.
        }
    }

    private func normalizedURL(_ raw: String) throws -> URL {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.lowercased().hasPrefix("http://") && !value.lowercased().hasPrefix("https://") {
            value = "https://\(value)"
        }
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value), url.host != nil else {
            throw APIError(status: 0, message: L("Please enter a valid server address."))
        }
        return url
    }
}
