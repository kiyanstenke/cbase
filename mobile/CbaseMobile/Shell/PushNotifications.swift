import Foundation
import SwiftUI
import UIKit
import UserNotifications

extension Notification.Name {
    static let cbasePushToken = Notification.Name("cbase.push-token")
    static let cbasePushOpened = Notification.Name("cbase.push-opened")
    static let cbasePushRegistrationFailed = Notification.Name("cbase.push-registration-failed")
}

/// Thin UIKit bridge: SwiftUI owns the session state, but the UIApplicationDelegate receives the
/// device token issued by APNs and reactions to system notifications.
final class CbaseAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // The keyboard announcer listens from launch (Chat/ChatStageController.swift): a chat stage created after the
        // last keyboard notification must know its position, or it falls back to the guide.
        KeyboardAnnouncement.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .cbasePushToken, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .cbasePushRegistrationFailed, object: error.localizedDescription)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // In the foreground SSE and the bell update the UI — but ONLY for the chat that is open. A question from
        // another conversation must still reach the user, so the banner is not suppressed wholesale; the comparison
        // with the open chat decides. Every push carries `chatId`.
        let info = notification.request.content.userInfo
        let chatId = (info["chatId"] as? String) ?? ""
        Task { @MainActor in
            let ownChat = !chatId.isEmpty && chatId == PushNotifications.openChat
            completionHandler(ownChat ? [] : [.banner, .sound])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = response.notification.request.content.userInfo
        Task { @MainActor in
            PushNotifications.pendingPayload = payload
            NotificationCenter.default.post(name: .cbasePushOpened, object: nil, userInfo: payload)
            completionHandler()
        }
    }
}

enum PushNotifications {
    /// Stable across token changes; lets the gateway remove exactly THIS installation on
    /// logout. Apple says the APNs token itself must not be cached locally.
    static let installationID: String = {
        let key = "cbase.mobile.push-installation"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: key)
        return created
    }()

    #if DEBUG
    static let environment = "sandbox"
    #else
    static let environment = "production"
    #endif

    @MainActor static var pendingPayload: [AnyHashable: Any]?

    /// Which chat is currently on screen — set by AppState. The UIKit delegate cannot reach any
    /// EnvironmentObject, hence this one narrow pass-through.
    @MainActor static var openChat: String?

    @MainActor
    static func activate() async {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            settings = await center.notificationSettings()
        }
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional
                || settings.authorizationStatus == .ephemeral else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    @MainActor
    static func takePendingPayload() -> [AnyHashable: Any]? {
        defer { pendingPayload = nil }
        return pendingPayload
    }
}

struct PushDeviceRegistration: Codable, Sendable {
    let installationId: String
    let token: String
    let environment: String
    let locale: String
}

struct PushDeviceRemoval: Codable, Sendable {
    let installationId: String
}
