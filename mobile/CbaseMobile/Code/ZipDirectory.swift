import Compression
import Foundation

// Reads the central directory of a ZIP without unpacking the archive — the twin of `web/src/lib/zip-directory.ts`, with the
// same name rule and the same pre-check. The preview shows BEFORE the project is created; the archive is uploaded only
// afterwards. Reads through `FileHandle`: end-of-central-directory, ZIP64 locator, and per entry name, size, flags. Only the
// content of a `.git` FILE is unpacked (at most 4 KB, for the git-file rule).
//
// NAMES like Python's `zipfile` in the setup worker: flag bit 11 means UTF-8 (strict, a leading BOM stays), otherwise cp437; the
// "Unicode Path" field (0x7075) is not read; cut at the first NUL; `\` becomes `/`; NFC; "." path parts drop (bsdtar writes
// "./"), a name made only of "." parts is no entry. Paths are split and compared by Unicode SCALARS, never by graphemes
// (`components(separatedBy:)`, `hasPrefix`) — a "/" followed by a combining mark is otherwise no separator, and web and Python
// would see a different structure. The reader is not a trust anchor — the server lists the archive itself (`PLAN_MATCHES_NOT`);
// zip-slip, links and bombs are checked only by the setup worker.

struct ZipEntry {
    /// Decoded and normalized, without a trailing "/".
    let name: String
    let folder: Bool
    let size: Int
    let compressed: Int
    let method: Int
    let encrypted: Bool
    let reference: Bool
    let header: Int
}

struct ZipDirectory {
    enum Reason: String { case unsafe, encrypted, encoding }
    var entries: [ZipEntry]
    /// Exactly one shared first path part (without `__MACOSX/` and `.DS_Store`), and it is a folder — otherwise nil.
    var parentFolder: String?
    /// What the setup worker's pre-check rejects for sure (at most 5 names).
    var denied: (reason: Reason, names: [String])?
}

enum ZipError: LocalizedError {
    case noZip, multipart, broken
    var errorDescription: String? {
        switch self {
        case .noZip: return L("This is not a ZIP file.")
        case .multipart: return L("Multi-part archives are not supported.")
        case .broken: return L("The ZIP archive is damaged.")
        }
    }
}

enum ZipReader {
    // cp437, 0x80–0xFF, generated from Python's codec (`bytes(range(128, 256)).decode("cp437")`); 0x00–0x7F are ASCII.
    private static let cp437: [Character] = Array(
        "\u{00c7}\u{00fc}\u{00e9}\u{00e2}\u{00e4}\u{00e0}\u{00e5}\u{00e7}\u{00ea}\u{00eb}\u{00e8}\u{00ef}\u{00ee}\u{00ec}\u{00c4}\u{00c5}" +
        "\u{00c9}\u{00e6}\u{00c6}\u{00f4}\u{00f6}\u{00f2}\u{00fb}\u{00f9}\u{00ff}\u{00d6}\u{00dc}\u{00a2}\u{00a3}\u{00a5}\u{20a7}\u{0192}" +
        "\u{00e1}\u{00ed}\u{00f3}\u{00fa}\u{00f1}\u{00d1}\u{00aa}\u{00ba}\u{00bf}\u{2310}\u{00ac}\u{00bd}\u{00bc}\u{00a1}\u{00ab}\u{00bb}" +
        "\u{2591}\u{2592}\u{2593}\u{2502}\u{2524}\u{2561}\u{2562}\u{2556}\u{2555}\u{2563}\u{2551}\u{2557}\u{255d}\u{255c}\u{255b}\u{2510}" +
        "\u{2514}\u{2534}\u{252c}\u{251c}\u{2500}\u{253c}\u{255e}\u{255f}\u{255a}\u{2554}\u{2569}\u{2566}\u{2560}\u{2550}\u{256c}\u{2567}" +
        "\u{2568}\u{2564}\u{2565}\u{2559}\u{2558}\u{2552}\u{2553}\u{256b}\u{256a}\u{2518}\u{250c}\u{2588}\u{2584}\u{258c}\u{2590}\u{2580}" +
        "\u{03b1}\u{00df}\u{0393}\u{03c0}\u{03a3}\u{03c3}\u{00b5}\u{03c4}\u{03a6}\u{0398}\u{03a9}\u{03b4}\u{221e}\u{03c6}\u{03b5}\u{2229}" +
        "\u{2261}\u{00b1}\u{2265}\u{2264}\u{2320}\u{2321}\u{00f7}\u{2248}\u{00b0}\u{2219}\u{00b7}\u{221a}\u{207f}\u{00b2}\u{25a0}\u{00a0}"
    )

    // ── Paths by scalars (like `split("/")` and `startsWith` in JavaScript and Python) ──────────────────────────────────────
    static func parts(_ s: String) -> [String] {
        s.unicodeScalars.split(separator: "/", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
    }
    static func begins(_ s: String, _ p: String) -> Bool { s.unicodeScalars.starts(with: p.unicodeScalars) }
    /// `s` without its first `n` scalars.
    static func withoutFront(_ s: String, _ n: Int) -> String { String(String.UnicodeScalarView(s.unicodeScalars.dropFirst(n))) }
    private static func withoutEnd(_ s: String) -> String {
        s.unicodeScalars.last == "/" ? String(String.UnicodeScalarView(s.unicodeScalars.dropLast())) : s
    }

    /// A name from the directory → text (bit 11 means strict UTF-8, otherwise cp437); nil = not valid UTF-8 despite bit 11.
    /// `String(validating:)` keeps a leading BOM like Python's utf-8 codec (`String(data:encoding:)` strips it).
    static func decode(_ bytes: Data, utf8: Bool) -> String? {
        var s: String
        if utf8 {
            guard let u = String(validating: bytes, as: UTF8.self) else { return nil }
            s = u
        } else {
            s = String(bytes.map { $0 < 0x80 ? Character(Unicode.Scalar($0)) : cp437[Int($0) - 0x80] })
        }
        if let nul = s.unicodeScalars.firstIndex(of: "\u{0}") { s = String(String.UnicodeScalarView(s.unicodeScalars[..<nul])) }
        return s
    }

    /// The name as preview and mapping carry it — `\` → `/`, NFC, without "." path parts (a folder's trailing "/"
    /// stays). nil: EVERY path part was "." ("./") — no entry. A leading "/" and empty parts stay (the pre-check).
    static func normal(_ name: String) -> String? {
        let s = name.replacingOccurrences(of: "\\", with: "/", options: .literal).precomposedStringWithCanonicalMapping
        let end = s.unicodeScalars.last == "/"
        let without = parts(withoutEnd(s)).filter { !ProjectLayout.equal($0, ".") }
        if without.isEmpty { return nil }
        return without.joined(separator: "/") + (end ? "/" : "")
    }

    /// Would the setup worker's pre-check reject this (normalized) name? (zip-slip)
    static func unsafe(_ name: String) -> Bool {
        let u = Array(name.unicodeScalars)
        if u.first == "/" { return true }
        if u.count >= 2, u[1] == ":", (u[0].value >= 65 && u[0].value <= 90) || (u[0].value >= 97 && u[0].value <= 122) { return true }
        return parts(withoutEnd(name)).contains { $0.isEmpty || ProjectLayout.equal($0, "..") }
    }

    private static func outside(_ name: String) -> Bool {
        let t = parts(name)
        return ProjectLayout.equal(t.first ?? "", "__MACOSX") || ProjectLayout.equal(t.last ?? "", ".DS_Store")
    }

    /// The shared first path part, if there is exactly one and it is a folder.
    static func parentFolder(_ entries: [ZipEntry]) -> String? {
        var first: String?
        var isFolder = false
        for e in entries where !e.name.isEmpty && !outside(e.name) {
            let t = parts(e.name)
            if t.count > 1 || e.folder { isFolder = true }
            if let x = first { if !ProjectLayout.equal(x, t[0]) { return nil } } else { first = t[0] }
        }
        return isFolder ? first : nil
    }

    /// Folder name for a ZIP without a top folder — the file name without `.zip`, character rule of `managedPath` (`slugify`).
    static func targetName(_ fileName: String) -> String {
        var s = fileName
        if s.lowercased().hasSuffix(".zip") { s = String(s.dropLast(4)) }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var out = ""
        var stroke = false
        for c in s.unicodeScalars {
            let fallback: String?
            switch c {
            case "ä": fallback = "ae"
            case "ö": fallback = "oe"
            case "ü": fallback = "ue"
            case "ß": fallback = "ss"
            default: fallback = nil
            }
            if let e = fallback { out += e; stroke = false; continue }
            let ok = (c.value >= 97 && c.value <= 122) || (c.value >= 48 && c.value <= 57) || c == "." || c == "_" || c == "-"
            if ok { out.unicodeScalars.append(c); stroke = false } else if !stroke { out += "-"; stroke = true }
        }
        while let f = out.first, f == "-" || f == "." { out.removeFirst() }
        while let l = out.last, l == "-" || l == "." { out.removeLast() }
        // `slice(0, 60)` counts UTF-16 units; only ASCII is left here, so the same number.
        let short = String(out.prefix(60))
        return short.isEmpty ? "unnamed" : short
    }

    private static func u16(_ d: Data, _ o: Int) -> Int { Int(d[d.startIndex + o]) | Int(d[d.startIndex + o + 1]) << 8 }
    private static func u32(_ d: Data, _ o: Int) -> Int { u16(d, o) | u16(d, o + 2) << 16 }
    private static func u64(_ d: Data, _ o: Int) throws -> Int {
        let up = u32(d, o + 4)
        guard up < (1 << 21) else { throw ZipError.broken } // beyond 2^53
        return u32(d, o) | up << 32
    }

    private static func read(_ h: FileHandle, _ from: Int, _ until: Int) throws -> Data {
        // A negative offset (the directory names a larger one than it has) would crash in `UInt64(ab)`.
        guard from >= 0, until >= from else { throw ZipError.broken }
        try h.seek(toOffset: UInt64(from))
        return try h.read(upToCount: until - from) ?? Data()
    }

    /// The central directory of the file. Throws `ZipError`.
    static func read(_ url: URL) throws -> ZipDirectory {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        let size = Int(try h.seekToEnd())
        guard size >= 22 else { throw ZipError.noZip }
        let tailFrom = max(0, size - (22 + 0xffff))
        let tail = try read(h, tailFrom, size)
        var ep = -1
        var i = tail.count - 22
        while i >= 0 {
            if u32(tail, i) == 0x06054b50 { ep = i; break }
            i -= 1
        }
        guard ep >= 0 else { throw ZipError.noZip }
        let eocdLocation = tailFrom + ep
        var disk = u16(tail, ep + 4)
        var cdDisk = u16(tail, ep + 6)
        var cdSize = u32(tail, ep + 12)
        var cdDeclared = u32(tail, ep + 16)
        var endLocation = eocdLocation
        if eocdLocation >= 20 {
            let loc = try read(h, eocdLocation - 20, eocdLocation)
            if loc.count == 20, u32(loc, 0) == 0x07064b50 {
                guard u32(loc, 16) <= 1 else { throw ZipError.multipart }
                let location64 = eocdLocation - 20 - 56
                guard location64 >= 0 else { throw ZipError.broken }
                let e64 = try read(h, location64, location64 + 56)
                guard e64.count == 56, u32(e64, 0) == 0x06064b50 else { throw ZipError.broken }
                disk = u32(e64, 16)
                cdDisk = u32(e64, 20)
                cdSize = try u64(e64, 40)
                cdDeclared = try u64(e64, 48)
                endLocation = location64
            }
        }
        guard disk == 0, cdDisk == 0 else { throw ZipError.multipart }
        let cdLocation = endLocation - cdSize
        guard cdLocation >= 0 else { throw ZipError.broken }
        let cd = try read(h, cdLocation, endLocation)
        let shift = cdLocation - cdDeclared

        var entries: [ZipEntry] = []
        var unsafeN: [String] = [], encryptedN: [String] = [], encodingN: [String] = []
        var o = 0
        while o < cd.count {
            guard o + 46 <= cd.count, u32(cd, o) == 0x02014b50 else { throw ZipError.broken }
            let flags = u16(cd, o + 8)
            let method = u16(cd, o + 10)
            var compressed = u32(cd, o + 20)
            var sizeU = u32(cd, o + 24)
            let nameLen = u16(cd, o + 28), extraLen = u16(cd, o + 30), commentLen = u16(cd, o + 32)
            let extern = u32(cd, o + 38)
            var header = u32(cd, o + 42)
            guard o + 46 + nameLen <= cd.count else { throw ZipError.broken }
            let nameRaw = cd.subdata(in: (cd.startIndex + o + 46)..<(cd.startIndex + o + 46 + nameLen))
            var x = o + 46 + nameLen
            let xEnd = min(x + extraLen, cd.count)
            while x + 4 <= xEnd {
                let id = u16(cd, x), len = u16(cd, x + 2)
                if id == 0x0001 {
                    var f = x + 4
                    let fEnd = min(x + 4 + len, cd.count)
                    if sizeU == 0xffffffff, f + 8 <= fEnd { sizeU = try u64(cd, f); f += 8 }
                    if compressed == 0xffffffff, f + 8 <= fEnd { compressed = try u64(cd, f); f += 8 }
                    if header == 0xffffffff, f + 8 <= fEnd { header = try u64(cd, f); f += 8 }
                }
                x += 4 + len
            }
            o += 46 + nameLen + extraLen + commentLen
            guard let raw = decode(nameRaw, utf8: flags & 0x800 != 0) else {
                if encodingN.count < 5 { encodingN.append(String(decoding: nameRaw, as: UTF8.self)) }
                continue
            }
            guard let full = normal(raw) else { continue }
            if unsafe(full) { if unsafeN.count < 5 { unsafeN.append(full) }; continue }
            let folder = full.unicodeScalars.last == "/"
            let name = withoutEnd(full)
            if flags & 1 != 0, encryptedN.count < 5 { encryptedN.append(name) }
            entries.append(ZipEntry(name: name, folder: folder, size: sizeU, compressed: compressed, method: method,
                                        encrypted: flags & 1 != 0, reference: (extern >> 16) & 0o170000 == 0o120000,
                                        header: header + shift))
        }
        let denied: (reason: ZipDirectory.Reason, names: [String])?
        if !unsafeN.isEmpty { denied = (.unsafe, unsafeN) }
        else if !encodingN.isEmpty { denied = (.encoding, encodingN) }
        else if !encryptedN.isEmpty { denied = (.encrypted, encryptedN) }
        else { denied = nil }
        return ZipDirectory(entries: entries, parentFolder: parentFolder(entries), denied: denied)
    }

    /// The content of a small entry (stored or deflate, at most `atMost` bytes) as text — for `.git` files.
    static func smallEntry(_ url: URL, _ e: ZipEntry, atMost: Int = 4096) -> String? {
        guard !e.encrypted, !e.folder, e.header >= 0, e.size <= atMost, e.compressed <= atMost * 2 + 64,
              let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        guard let k = try? read(h, e.header, e.header + 30), k.count == 30, u32(k, 0) == 0x04034b50 else { return nil }
        let from = e.header + 30 + u16(k, 26) + u16(k, 28)
        guard let data = try? read(h, from, from + e.compressed), data.count == e.compressed else { return nil }
        let raw: Data
        if e.method == 0 { raw = data }
        else if e.method == 8 {
            // COMPRESSION_ZLIB is raw deflate (RFC 1951) — exactly what ZIP stores.
            var out = [UInt8](repeating: 0, count: max(e.size, 1))
            let n = data.withUnsafeBytes { (q: UnsafeRawBufferPointer) -> Int in
                guard let base = q.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_decode_buffer(&out, out.count, base, data.count, nil, COMPRESSION_ZLIB)
            }
            raw = Data(out.prefix(n))
        } else { return nil }
        return String(decoding: raw.prefix(atMost), as: UTF8.self)
    }
}
