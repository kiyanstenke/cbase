import Combine
import SwiftUI

@main
struct CbaseMobileApp: App {
    @UIApplicationDelegateAdaptor(CbaseAppDelegate.self) private var appDelegate
    @StateObject private var session = SessionStore()
    @StateObject private var state = AppState()
    @StateObject private var theme = ThemeStore()
    /// A language change rebuilds the whole UI: the English strings are the dictionary keys,
    /// so there is no reactive binding per text.
    @State private var languageToken = Loc.lang.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(state)
                .environmentObject(theme)
                // Accent from Settings → Appearance (the asset if none is chosen), plus the window tint.
                .cbAccentRoot()
                .preferredColorScheme(theme.preference.colorScheme)
                // In dark mode the parts of the main window painted by the system sit on the raised level (form/list
                // rows are painted by the palette via `CbForm`/`CbList`, `ListLevel` sets their insides to the base);
                // the app's own surfaces come from `CbColor` (Kit/Theme.swift, Kit/CbColor.swift).
                .background(WindowLevel())
                // App-wide text size: an offset to the system size as a trait on the window
                // (Kit/TextSize.swift) — reaches sheets, popovers and UIKit children.
                .background(WindowFont())
                .id(languageToken)
                .onReceive(NotificationCenter.default.publisher(for: .cbaseLanguageChanged)) { _ in
                    languageToken = Loc.lang.rawValue
                }
                .onReceive(NotificationCenter.default.publisher(for: .cbasePushToken)) { note in
                    guard let token = note.object as? String else { return }
                    session.receivePushToken(token)
                }
                .onReceive(NotificationCenter.default.publisher(for: .cbasePushOpened)) { note in
                    guard session.phase == .ready else { return }
                    let payload = PushNotifications.takePendingPayload() ?? note.userInfo ?? [:]
                    Task { await state.openPushPayload(payload) }
                }
                .onChange(of: session.phase) { _, phase in
                    guard phase == .ready else { return }
                    Task {
                        await PushNotifications.activate()
                        if let payload = PushNotifications.takePendingPayload() {
                            await state.openPushPayload(payload)
                        }
                    }
                }
        }
    }
}
