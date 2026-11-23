import Foundation

@MainActor
final class SessionStore: ObservableObject {
    enum Phase: Equatable {
        case connecting
        case needsLogin(setup: Bool)
        case startingEnvironment
        case ready
        case connectionFailed(String)
    }

    @Published var phase: Phase = .connecting
    @Published var serverAddress: String
    @Published var user: GatewayUser?
    @Published private(set) var client: APIClient?

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
            if info.authenticated {
                await ensureEnvironment()
            } else {
                phase = .needsLogin(setup: info.setup)
            }
        } catch {
            client = nil
            user = nil
            phase = .connectionFailed(error.localizedDescription)
        }
    }

    func login(username: String, password: String, setup: Bool, setupToken: String = "") async throws {
        guard let client else { throw APIError(status: 0, message: L("Not connected to a server yet.")) }
        // First-time setup also carries the one-time token from the gateway's log (server/gateway/setup-token.js).
        struct Credentials: Codable { let username: String; let password: String; let setupToken: String? }
        let token = setup ? setupToken.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let response: LoginResponse = try await client.post(setup ? "/gw/setup" : "/gw/login", body: Credentials(username: username, password: password, setupToken: token))
        user = response.user
        defaults.set(username, forKey: "cbase.mobile.username")
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
