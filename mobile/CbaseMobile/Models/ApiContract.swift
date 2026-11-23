import Foundation

// The app's side of the API contract with the server (VERSIONING.md, "API level").
//
// The server names a range `{ level, oldest }`: `level` is the newest API level it speaks, `oldest` the oldest it still
// accepts. The app speaks exactly ONE level, `ApiContract.level`. Three outcomes:
// - `oldest > level`: the server no longer speaks this app's level → a blocking screen that sends the user to the App Store.
// - `level < ApiContract.level`: the server is older than the app → a soft, dismissible notice; the app keeps working.
// - anything else, and a server that sends no `api` at all (before the contract existed, i.e. level 1): nothing to say.
//
// Every request names the app (`X-Cbase-Client`, `User-Agent`), built in `APIClient.makeRequest` from the two properties at
// the bottom. A request without the header counts as level 1 on the server.
//
// The part above `// MARK: - Bundle` is pure (Foundation only, no `L`, no UIKit): `web/test/ios-api-contract.test.mjs`
// EXECUTES it with `xcrun swift` and holds the header and the outcomes against the contract.
enum ApiContract {
    /// The one API level this build speaks. Raise it only together with the server's `API_LEVEL.level` (the backend module
    /// `api-level.js`) and VERSIONING.md.
    static let level = 1

    /// The App Store page of the app — the way out of the blocking screen.
    static let storeAddress = "https://apps.apple.com/app/id6838276587"

    enum Compatibility: Equatable, Sendable {
        /// The server speaks this app's level (or names no range: an old server, level 1).
        case compatible
        /// The server no longer accepts this app's level (`oldest` above it).
        case needsNewerApp
        /// The server is older than the app (`level` below it): some features may be missing.
        case olderServer
    }

    /// The outcome for a server range. `nil` for both = the server sent no `api` (old server) → level 1.
    /// A half range: a missing `level` is `oldest`; a missing `oldest` is 1 (or `level`, if that is lower).
    static func compatibility(serverLevel: Int?, serverOldest: Int?, appLevel: Int = level) -> Compatibility {
        let serverLevel = serverLevel ?? serverOldest ?? 1
        let serverOldest = serverOldest ?? min(serverLevel, 1)
        if serverOldest > appLevel { return .needsNewerApp }
        if serverLevel < appLevel { return .olderServer }
        return .compatible
    }

    /// `X-Cbase-Client: ios/<CFBundleShortVersionString> (<CFBundleVersion>); api=<level>`.
    static func clientHeader(version: String, build: String, appLevel: Int = level) -> String {
        "ios/\(version) (\(build)); api=\(appLevel)"
    }

    /// `User-Agent: CbaseMobile/<CFBundleShortVersionString>`.
    static func userAgent(version: String) -> String {
        "CbaseMobile/\(version)"
    }

    // MARK: - Bundle

    /// `CFBundleShortVersionString`, "?" if the bundle does not carry it.
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    /// `CFBundleVersion`, "?" if the bundle does not carry it.
    static var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    }

    /// The header value of THIS build (computed once; the bundle does not change while the app runs).
    static let currentClientHeader = clientHeader(version: appVersion, build: appBuild)
    static let currentUserAgent = userAgent(version: appVersion)
}
