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
    /// A click on "Revoke" or the body of a device-added notification.
    var onRevokeDevice: ((String) -> Void)?
    var onOpenDevices: (() -> Void)?
    /// A click on a pond notification, with the pond's id.
    var onOpenPond: ((String) -> Void)?
    private var pendingUpdateClick = false
    private var pendingOpens = PendingNotificationOpens()
    private var configured = false

    private var center: UNUserNotificationCenter? { Bundled.isApp ? UNUserNotificationCenter.current() : nil }

    func configure() {
        guard let center, !configured else { return }
        configured = true
        center.delegate = self
        // Older versions registered an inline Reply action; no category means no new one carries it.
        let revoke = UNNotificationAction(identifier: Self.revokeAction, title: "Revoke", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.deviceCategory, actions: [revoke], intentIdentifiers: [])
        ])
    }

    static let deviceCategory = "squeak.device-added"
    static let revokeAction = "squeak.revoke-device"

    /// Told the moment a device joins through the account. Names no chat, so it never reaches the composer.
    func postDeviceAdded(id: String, name: String, email: String?) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = "\(name) was added to this Mac"
        content.body = (email.map { "Signed in as \($0). " } ?? "") + "Not you? Revoke it."
        content.sound = .default
        content.categoryIdentifier = Self.deviceCategory
        content.threadIdentifier = "squeak.devices"
        content.userInfo = ["squeakDevice": id]
        center.add(UNNotificationRequest(identifier: "device-\(id)", content: content, trigger: nil))
    }

    /// A pond event the person should know (a request to join, "You\u{2019}re in", declined, expired, removed, a thread that needs
    /// them). Tapping it opens the pond; it names no chat, so the composer never hears of it.
    func postPond(_ note: PondNote) {
        guard let center else { return }
        configure()
        let content = UNMutableNotificationContent()
        content.title = note.title
        content.body = note.body
        content.sound = .default
        content.threadIdentifier = "squeak.ponds"
        content.userInfo = ["squeakPond": note.pondId]
        center.add(UNNotificationRequest(identifier: note.id, content: content, trigger: nil))
    }

    func requestAuthorization() {
        configure()
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// What macOS says about Squeak's notification permission, for the setup checklist. Unknown outside a bundle.
    func access() async -> NotificationAccess {
        guard let center else { return .unknown }
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        default: return .authorized
        }
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
        // State first (Finished, Asking you something...), then the chat, then what it said.
        content.title = event.kind == .blocked && event.body.hasSuffix("is waiting for you") ? "Waiting for you" : event.kind.stateTitle
        if showName, let label = event.label, !label.isEmpty { content.subtitle = label }
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
        if let detail = event.detail, !detail.isEmpty { return detail }
        return event.label == nil ? event.body : kindLine(event.kind)
    }

    /// What the title leaves unsaid when there is no detail to show.
    private static func kindLine(_ kind: NotificationKind) -> String {
        switch kind {
        case .blocked: "Open it to allow or decline."
        case .question: "Open it to answer."
        case .plan: "Open it to review."
        case .finished: "Open it to read the reply."
        case .error: "Open it to see what happened."
        }
    }

    static func genericBody(_ kind: NotificationKind) -> String {
        switch kind {
        case .blocked: "A chat is waiting for you"
        case .question: "A chat is waiting for your answer"
        case .plan: "A chat has a plan ready"
        case .finished: "A chat finished"
        case .error: "A chat failed"
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if let device = info["squeakDevice"] as? String {
            let action = response.actionIdentifier
            Task { @MainActor in
                if action == Self.revokeAction { self.onRevokeDevice?(device) }
                else if action == UNNotificationDefaultActionIdentifier { self.onOpenDevices?() }
                completionHandler()
            }
            return
        }
        if let pond = info["squeakPond"] as? String {
            let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
            Task { @MainActor in
                if !dismissed { self.onOpenPond?(pond) }
                completionHandler()
            }
            return
        }
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
