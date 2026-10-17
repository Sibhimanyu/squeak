import AppKit
import ServiceManagement
import SqueakMacCore
import UserNotifications

/// True only when running from a real .app bundle (SMAppService and
/// UNUserNotificationCenter both trap or misbehave from a bare `swift run` binary).
enum Bundled {
    static var isApp: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }
}

enum LoginItem {
    static var isEnabled: Bool { Bundled.isApp && SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        guard Bundled.isApp else { return }
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

/// Notifications carry the app, an event and (only if the user opts in) the session
/// name. Never message content.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    var onOpen: ((SessionKey) -> Void)?
    private var configured = false

    private var center: UNUserNotificationCenter? { Bundled.isApp ? UNUserNotificationCenter.current() : nil }

    func configure() {
        guard let center, !configured else { return }
        configured = true
        center.delegate = self
    }

    func requestAuthorization() {
        configure()
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(_ event: NotificationEvent, showName: Bool) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = "Squeak"
        content.body = showName ? event.body : Self.genericBody(event.kind)
        content.sound = .default
        content.userInfo = ["session": event.key.stringValue]
        let request = UNNotificationRequest(identifier: "\(event.key.stringValue)-\(event.kind.rawValue)", content: content, trigger: nil)
        center.add(request)
    }

    static func genericBody(_ kind: NotificationKind) -> String {
        switch kind {
        case .blocked: "A session needs your approval"
        case .finished: "A session finished"
        case .error: "A session hit an error"
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let raw = response.notification.request.content.userInfo["session"] as? String
        Task { @MainActor in
            if let raw, let key = SessionKey(stringValue: raw) { self.onOpen?(key) }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
