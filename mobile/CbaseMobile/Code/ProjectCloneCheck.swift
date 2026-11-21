import Foundation

// Validation of a clone address, PURE (Foundation only) so `web/test/clone-ios-binding.test.mjs` can run it with `xcrun swift`
// (same construction as `ProjectLayout.swift`). The texts (`errorText`) and the sheets live in `ProjectClone.swift`.
// Web twin `web/src/lib/project-clone.ts`, server `projectbox/setup/clone.js` `checkCloneDetail`, fixture
// `server/backend/test/fixtures/clone-check/`. After the character check, paths and hosts are plain ASCII, so
// `components(separatedBy:)` never hits graphemes.

enum ProjectClone {
    enum CheckError: String, Error { case empty, onlyHttps, withUser, withQuery, withFragment, character, hostUnclear, branch, invalid }
    struct Detail: Equatable { let url: String; let branch: String; let host: String; let name: String }

    // ONE rule, three places: the address itself is parsed, not via `URLComponents` — Foundation decodes an IDN host to Unicode
    // (`xn--bcher-kva.example` → `bücher.example`, so the access would be stored under the wrong key), accepts port 99999 and does not
    // resolve "."/"..". Same order as `checkClone` in `web/src/lib/project-clone.ts`, bound by
    // `server/backend/test/fixtures/clone-check/` (`web/test/clone-ios-binding.test.mjs`).
    // RFC 3986: unreserved and reserved characters plus `%`.
    private static let urlCharacter = try! NSRegularExpression(pattern: "^[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]+$")
    private static let percentBroken = try! NSRegularExpression(pattern: "%(?![0-9A-Fa-f]{2})")
    private static let scpForm = try! NSRegularExpression(pattern: "^[^/@\\s]+@[^/:\\s]+:")
    private static let form = try! NSRegularExpression(pattern: "^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([\\s\\S]*)$")
    private static let schemeWithoutSlashes = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9+.-]*:")
    private static let hostPort = try! NSRegularExpression(pattern: "^([^:]*)(?::([0-9]*))?$")
    private static let hostname = try! NSRegularExpression(pattern: "^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
    private static let countSegment = try! NSRegularExpression(pattern: "^(?:[0-9]+|0x[0-9a-f]*)$")
    private static let ipv4Segment = try! NSRegularExpression(pattern: "^(?:0|[1-9][0-9]{0,2})$")
    private static let branchPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9._/-]{1,200}$")

    private static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    /// The groups of a match (`nil` for a group that did not match), or `nil` without a match.
    private static func groups(_ r: NSRegularExpression, _ s: String) -> [String?]? {
        guard let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } }
    }

    /// A host whose last label is a number is an IPv4 address for WHATWG, valid only in dotted form with four numbers.
    private static func ipv4Qualifies(_ host: String) -> Bool {
        let segments = host.components(separatedBy: ".")
        guard let last = segments.last, matches(countSegment, last) else { return true }
        return segments.count == 4 && segments.allSatisfy { matches(ipv4Segment, $0) && (Int($0) ?? 256) <= 255 }
    }

    /// The parts of a path after RFC 3986 "remove_dot_segments" ("."/"..", also as `%2e`).
    private static func pathParts(_ path: String) -> [String] {
        var out: [String] = []
        for t in path.components(separatedBy: "/") {
            let k = t.lowercased()
            if k.isEmpty || k == "." || k == "%2e" { continue }
            if k == ".." || k == ".%2e" || k == "%2e." || k == "%2e%2e" { if !out.isEmpty { out.removeLast() }; continue }
            out.append(t)
        }
        return out
    }

    /// PURE: the same reasons in the same order as `checkClone` on the web.
    static func check(_ urlText: String, _ branchText: String) -> Result<Detail, CheckError> {
        let raw = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        let branch = branchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return .failure(.empty) }
        if matches(scpForm, raw) || raw.lowercased().hasPrefix("ssh://") { return .failure(.onlyHttps) }
        if !matches(urlCharacter, raw) || matches(percentBroken, raw) { return .failure(.character) }
        guard let g = groups(form, raw), let schema = g[0], let authority = g[1] else {
            return .failure(matches(schemeWithoutSlashes, raw) && !raw.lowercased().hasPrefix("https:") ? .onlyHttps : .invalid)
        }
        let rest = g[2] ?? ""
        if schema.lowercased() != "https" { return .failure(.onlyHttps) }
        // Also an empty `@`: the server rejects it the same way.
        if authority.contains("@") { return .failure(.withUser) }
        if raw.contains("?") { return .failure(.withQuery) }
        if raw.contains("#") { return .failure(.withFragment) }
        guard !authority.contains("%"), let hp = groups(hostPort, authority) else { return .failure(.hostUnclear) }
        let host = (hp[0] ?? "").lowercased()
        if !matches(hostname, host) || !ipv4Qualifies(host) { return .failure(.hostUnclear) }
        if let port = hp[1], port.isEmpty || port.count > 5 || (Int(port) ?? 65536) > 65535 { return .failure(.hostUnclear) }
        if !branch.isEmpty && (!matches(branchPattern, branch) || branch.hasPrefix("-")) { return .failure(.branch) }
        let name = defaultName(rest)
        // No path, or a name that cannot be a folder name: not a repository.
        if name.isEmpty || name == "." || name == ".." || name.contains("/") || name.contains("\\") { return .failure(.invalid) }
        return .success(Detail(url: raw, branch: branch, host: host, name: name))
    }

    /// The last path part (after resolving "."/"..") without `.git`, decoded, NFC; empty without a path or with broken encoding.
    static func defaultName(_ path: String) -> String {
        var n = pathParts(path).last ?? ""
        if n.lowercased().hasSuffix(".git") { n = String(n.dropLast(4)) }
        guard let decoded = n.removingPercentEncoding else { return "" }
        return decoded.precomposedStringWithCanonicalMapping
    }
}
