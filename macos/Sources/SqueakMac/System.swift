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
/// name and what the agent is asking. A finished chat Squeak can send to gets a
/// Reply field; anything else opens the session.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    var onOpen: ((SessionKey) -> Void)?
    /// A reply typed into a notification: an explicit user action, so it is sent.
    var onReply: ((SessionKey, String) -> Void)?
    private var configured = false

    nonisolated static let replyCategory = "squeak.reply"
    nonisolated static let replyAction = "squeak.reply.send"

    private var center: UNUserNotificationCenter? { Bundled.isApp ? UNUserNotificationCenter.current() : nil }

    func configure() {
        guard let center, !configured else { return }
        configured = true
        center.delegate = self
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyAction, title: "Reply", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.replyCategory, actions: [reply], intentIdentifiers: [])])
    }

    func requestAuthorization() {
        configure()
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// False when macOS will deliver but never show Squeak's banners (alert style
    /// None, or notifications off), so Settings can say so. Nil outside a bundle.
    func bannersShown() async -> Bool? {
        guard let center else { return nil }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return nil
        case .denied: return false
        default: return settings.alertStyle != .none
        }
    }

    func post(_ event: NotificationEvent, showName: Bool) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = "Squeak"
        content.body = Self.body(event, showName: showName)
        content.sound = .default
        content.threadIdentifier = event.key.stringValue
        content.userInfo = ["session": event.key.stringValue]
        if event.replyable { content.categoryIdentifier = Self.replyCategory }
        let request = UNNotificationRequest(identifier: "\(event.key.stringValue)-\(event.kind.rawValue)", content: content, trigger: nil)
        center.add(request)
    }

    /// A one-off line about the session, e.g. a reply from a notification that did not go.
    func postNote(_ text: String, for key: SessionKey) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = "Squeak"
        content.body = text
        content.threadIdentifier = key.stringValue
        content.userInfo = ["session": key.stringValue]
        center.add(UNNotificationRequest(identifier: "\(key.stringValue)-note", content: content, trigger: nil))
    }

    static func body(_ event: NotificationEvent, showName: Bool) -> String {
        guard showName else { return genericBody(event.kind) }
        guard let detail = event.detail, !detail.isEmpty else { return event.body }
        return "\(event.body)\n\(detail)"
    }

    static func genericBody(_ kind: NotificationKind) -> String {
        switch kind {
        case .blocked: "A session needs you"
        case .question: "A session is asking you something"
        case .plan: "A session has a plan for you to review"
        case .finished: "A session is done"
        case .error: "A session hit an error"
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let raw = response.notification.request.content.userInfo["session"] as? String
        let typed = response.actionIdentifier == Self.replyAction ? (response as? UNTextInputNotificationResponse)?.userText : nil
        let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
        Task { @MainActor in
            if let raw, let key = SessionKey(stringValue: raw) {
                if let typed { self.onReply?(key, typed) } else if !dismissed { self.onOpen?(key) }
            }
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
