import Foundation

// The backend omits fields (or sends null) in many responses. One missing field must never
// empty a whole view, so all models decode tolerantly through these helpers instead of the
// strict default decoder.
extension KeyedDecodingContainer {
    func str(_ key: Key, _ fallback: String = "") -> String {
        ((try? decodeIfPresent(String.self, forKey: key)) ?? nil) ?? fallback
    }

    func strOpt(_ key: Key) -> String? {
        (try? decodeIfPresent(String.self, forKey: key)) ?? nil
    }

    func int(_ key: Key, _ fallback: Int = 0) -> Int {
        if let value = (try? decodeIfPresent(Int.self, forKey: key)) ?? nil { return value }
        if let value = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil { return Int(value) }
        return fallback
    }

    func intOpt(_ key: Key) -> Int? {
        if let value = (try? decodeIfPresent(Int.self, forKey: key)) ?? nil { return value }
        if let value = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil { return Int(value) }
        return nil
    }

    func dbl(_ key: Key, _ fallback: Double = 0) -> Double {
        ((try? decodeIfPresent(Double.self, forKey: key)) ?? nil) ?? fallback
    }

    func dblOpt(_ key: Key) -> Double? {
        (try? decodeIfPresent(Double.self, forKey: key)) ?? nil
    }

    func bool(_ key: Key, _ fallback: Bool = false) -> Bool {
        ((try? decodeIfPresent(Bool.self, forKey: key)) ?? nil) ?? fallback
    }

    func boolOpt(_ key: Key) -> Bool? {
        (try? decodeIfPresent(Bool.self, forKey: key)) ?? nil
    }

    func list<T: Decodable>(_ key: Key, _ type: T.Type) -> [T] {
        ((try? decodeIfPresent([T].self, forKey: key)) ?? nil) ?? []
    }

    func strings(_ key: Key) -> [String] {
        ((try? decodeIfPresent([String].self, forKey: key)) ?? nil) ?? []
    }

    func map(_ key: Key) -> [String: String] {
        ((try? decodeIfPresent([String: String].self, forKey: key)) ?? nil) ?? [:]
    }

    /// The capabilities of a provider or preset: an object of plain Bool values.
    /// Deliberately a MAP, not a fixed record: a key this app does not know (e.g. `documents`)
    /// must survive saving. A record would silently delete an override the editor merely does not show.
    func boolMap(_ key: Key) -> [String: Bool] {
        ((try? decodeIfPresent([String: Bool].self, forKey: key)) ?? nil) ?? [:]
    }

    func json(_ key: Key) -> JSONValue? {
        (try? decodeIfPresent(JSONValue.self, forKey: key)) ?? nil
    }
}
