import Foundation

// Language choice like in the desktop client: the English UI string IS the dictionary key, `LocDE` supplies the German
// translation (context suffix `##ctx` tells equal English texts apart). A missing entry stays English.
// The choice is stored locally (UserDefaults) and also reported to the backend (PUT /api/ui-lang), so that server messages speak
// the same language.

enum AppLang: String, CaseIterable, Sendable {
    case de
    case en

    var nativeName: String { self == .en ? "English" : "Deutsch" }
    var displayLabel: String { self == .en ? "English" : "German" }
    var localeIdentifier: String { self == .en ? "en_US" : "de_DE" }
}

enum Loc {
    private static let key = "cbase.mobile.lang"

    /// Current language. Written only by the main actor; the app root carries `.id(lang)` so that a change rebuilds the whole UI.
    static var lang: AppLang = AppLang(rawValue: UserDefaults.standard.string(forKey: key) ?? systemDefault) ?? .en

    /// Without a stored choice the app follows the system language: German on a German system, English otherwise.
    private static var systemDefault: String {
        (Locale.preferredLanguages.first ?? "en").hasPrefix("de") ? "de" : "en"
    }

    static func persist(_ next: AppLang) {
        lang = next
        UserDefaults.standard.set(next.rawValue, forKey: key)
    }

    static var locale: Locale { Locale(identifier: lang.localeIdentifier) }

    static func translate(_ key: String) -> String {
        lang == .de ? (LocDE[key] ?? plain(key)) : plain(key)
    }

    /// The text shown for a key in English: the key without its context suffix ("Open##state" → "Open").
    static func plain(_ key: String) -> String {
        guard let cut = key.range(of: "##") else { return key }
        return String(key[..<cut.lowerBound])
    }
}

/// Translates a UI string (the English text is the key). `{name}` placeholders are interpolated.
func L(_ key: String) -> String {
    Loc.translate(key)
}

func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var text = Loc.translate(key)
    for (name, value) in params {
        text = text.replacingOccurrences(of: "{\(name)}", with: value.description)
    }
    return text
}

// Numbers/dates in the chosen language.
func locFormattedInt(_ value: Int) -> String {
    let formatter = NumberFormatter()
    formatter.locale = Loc.locale
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = 0
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
}

func locFormattedMoney(_ value: Double, currency: String) -> String {
    let decimals = value > 0 && value < 1 ? 4 : 2
    let formatter = NumberFormatter()
    formatter.locale = Loc.locale
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = decimals
    formatter.maximumFractionDigits = decimals
    let number = formatter.string(from: NSNumber(value: value)) ?? String(value)
    return "\(currency) \(number)"
}

func locShortDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Loc.locale
    formatter.dateStyle = .short
    formatter.timeStyle = .none
    return formatter.string(from: date)
}

func locWeekdayTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Loc.locale
    formatter.setLocalizedDateFormatFromTemplate("EEE HH:mm")
    return formatter.string(from: date)
}

/// The end of a run behind the figures line: ALWAYS just the clock time ("21:03") — the day is given by the day separator
/// (Chat/DaySeparator.swift). Like `endText` in web/src/components/chat/RunDisplay.tsx.
func locEndTime(_ date: Date) -> String {
    let clock = DateFormatter()
    clock.locale = Loc.locale
    clock.setLocalizedDateFormatFromTemplate("HH:mm")
    return clock.string(from: date)
}

func locDateTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Loc.locale
    formatter.setLocalizedDateFormatFromTemplate("dd.MM. HH:mm")
    return formatter.string(from: date)
}

/// Turns seconds/milliseconds from the backend into a date (the API mixes both).
func locDate(fromServer value: Double) -> Date {
    Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value)
}

/// Relative time ("just now", "3 min ago") like in the desktop's notification center.
func locRelative(_ milliseconds: Double) -> String {
    let diff = Date().timeIntervalSince1970 * 1000 - milliseconds
    let minutes = Int(diff / 60000)
    if minutes < 1 { return L("just now") }
    if minutes < 60 { return L("{min} min ago", ["min": minutes]) }
    let hours = minutes / 60
    if hours < 24 { return L("{h} h ago", ["h": hours]) }
    return locShortDate(Date(timeIntervalSince1970: milliseconds / 1000))
}
