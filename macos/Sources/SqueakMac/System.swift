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
/// name and what the agent is asking. Clicking one opens the quick composer for its session;
/// nothing is ever sent from a notification itself.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    /// Setting the handler hands over any click that arrived before it existed (cold launch).
    var onOpen: ((PendingNotificationOpen) -> Void)? {
        didSet { if onOpen != nil, let open = pendingOpens.drain() { onOpen?(open) } }
    }
    /// A click on an update notification. Held until the handler exists (cold launch).
    var onOpenUpdate: (() -> Void)? {
        didSet { if onOpenUpdate != nil, pendingUpdateClick { pendingUpdateClick = false; onOpenUpdate?() } }
    }
    private var pendingUpdateClick = false
    private var pendingOpens = PendingNotificationOpens()
    private var configured = false

    private var center: UNUserNotificationCenter? { Bundled.isApp ? UNUserNotificationCenter.current() : nil }

    func configure() {
        guard let center, !configured else { return }
        configured = true
        center.delegate = self
        // Older versions registered an inline Reply action; no category means no new one carries it.
        center.setNotificationCategories([])
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

    /// `anchor` carries only opaque ids and times (never text), so a click opens the composer on
    /// the reply this very notification was about. Each event is its own notification: an older
    /// one still in Notification Center keeps its own context.
    func post(_ event: NotificationEvent, showName: Bool, anchor: NotificationAnchor? = nil) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = "Squeak"
        content.body = Self.body(event, showName: showName)
        content.sound = .default
        content.threadIdentifier = event.key.stringValue
        content.userInfo = anchor?.userInfo(session: event.key) ?? ["session": event.key.stringValue]
        let identifier = anchor.map { "\(event.key.stringValue)-\($0.eventId)" } ?? "\(event.key.stringValue)-\(event.kind.rawValue)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    /// Quiet on purpose: no sound, and a version of its own thread so it never groups with a chat.
    func postUpdate(_ p: UpdateAlert.Payload) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = p.title
        content.body = p.body
        content.threadIdentifier = p.threadIdentifier
        content.userInfo = p.userInfo
        center.add(UNNotificationRequest(identifier: p.identifier, content: content, trigger: nil))
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
        let info = response.notification.request.content.userInfo
        if UpdateAlert.isUpdate(info) {
            let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
            Task { @MainActor in
                if !dismissed {
                    if let open = self.onOpenUpdate { open() } else { self.pendingUpdateClick = true }
                }
                completionHandler()
            }
            return
        }
        let raw = info["session"] as? String
        let anchor = NotificationAnchor.parse(info)
        // Any action, including an already-delivered legacy Reply, only opens the composer: its typed text is never read.
        let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
        Task { @MainActor in
            if let open = NotificationRouting.openRequest(dismissed: dismissed, session: raw, anchor: anchor),
               let now = self.pendingOpens.deliver(open, handlerReady: self.onOpen != nil) { self.onOpen?(now) }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(UpdateAlert.isUpdate(notification.request.content.userInfo) ? [.banner] : [.banner, .sound])
    }
}
