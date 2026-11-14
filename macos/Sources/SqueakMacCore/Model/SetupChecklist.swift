import Foundation

public enum SetupStepID: String, CaseIterable, Sendable, Identifiable {
    case service, hooks, conductor, notifications, hotkey, hands, channels
    public var id: String { rawValue }
}

public enum SetupStepState: Sendable, Equatable {
    /// Finished (or nothing to do).
    case done
    /// Waiting for the person.
    case todo
    /// Cannot start until an earlier step is done.
    case blocked
    /// Not needed for Squeak to work; offered, never counted against "finished".
    case optional
    /// Tried and failed, or the daemon reports a problem.
    case error
}

/// What a button on a step does. The view maps each to a real call or a System Settings link.
public enum SetupAction: Sendable, Equatable {
    case installService, repairService, installHooks, setUpConductor, skipConductor
    case requestNotifications, openNotificationSettings
    case grantInputMonitoring, openAccessibility, openChannels
    case openLoginItems
}

public enum SetupServiceFact: Sendable, Equatable {
    /// Not read yet.
    case checking
    case running
    case installing
    case notInstalled
    /// macOS has Squeak's background item switched off (Login Items): the service cannot be started until it is allowed.
    case needsApproval
    case failed(String)
    /// A build with no bundled service (`swift run`).
    case unavailable

    /// From the app's reading of the daemon: anything that answers counts as running.
    /// The longest a start may run before the step says it failed, instead of looking busy for ever. The installer waits up
    /// to 10 minutes while the service is alive and getting somewhere (`StartWatch`); this is only the backstop above it.
    public static let serviceDeadline: TimeInterval = 660
    public static let didNotStart = "The background service didn't start."

    public static func from(_ status: DaemonStatus, connected: Bool, busy: Bool, busySince: Date? = nil, now: Date = Date(),
                            deadline: TimeInterval = serviceDeadline, timeoutReason: String? = nil) -> SetupServiceFact {
        if connected { return .running }
        if busy {
            if let since = busySince, now.timeIntervalSince(since) > deadline {
                let reason = timeoutReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return .failed(reason.isEmpty ? didNotStart : reason)
            }
            return .installing
        }
        switch status {
        case .unavailable: return .unavailable
        case .notInstalled: return .notInstalled
        case .updating: return .installing
        case .needsApproval: return .needsApproval
        case .failed(let reason, _): return .failed(reason)
        case .upToDate, .devCheckout, .external: return .checking
        }
    }
}

public enum NotificationAccess: Sendable, Equatable {
    case unknown, notDetermined, denied, authorized
}

/// Everything the checklist reads, gathered by the app. The checklist decides nothing else.
public struct SetupFacts: Sendable, Equatable {
    public var service: SetupServiceFact
    /// nil until read, or from a daemon without the hooks routes (then `hooksNeedUpdate`).
    public var hooks: HooksStatus?
    public var hooksNeedUpdate: Bool
    public var hooksProblem: String?
    /// Whether an add-on provides a Conductor link; without one there is no Conductor step.
    public var linkAvailable: Bool
    public var link: ConductorLinkReading?
    public var linkNeedUpdate: Bool
    public var conductorInstalled: Bool
    public var conductorSkipped: Bool
    public var notifications: NotificationAccess
    /// Whether Input Monitoring is granted; true when the chosen shortcut needs none.
    public var inputMonitoringOK: Bool
    public var channelsConfigured: Bool

    public init(
        service: SetupServiceFact = .checking, hooks: HooksStatus? = nil, hooksNeedUpdate: Bool = false, hooksProblem: String? = nil,
        linkAvailable: Bool = false, link: ConductorLinkReading? = nil, linkNeedUpdate: Bool = false, conductorInstalled: Bool = true, conductorSkipped: Bool = false,
        notifications: NotificationAccess = .unknown, inputMonitoringOK: Bool = false, channelsConfigured: Bool = false
    ) {
        self.service = service; self.hooks = hooks; self.hooksNeedUpdate = hooksNeedUpdate; self.hooksProblem = hooksProblem
        self.linkAvailable = linkAvailable; self.link = link; self.linkNeedUpdate = linkNeedUpdate; self.conductorInstalled = conductorInstalled
        self.conductorSkipped = conductorSkipped; self.notifications = notifications
        self.inputMonitoringOK = inputMonitoringOK; self.channelsConfigured = channelsConfigured
    }
}

public struct SetupStep: Sendable, Equatable, Identifiable {
    public var id: SetupStepID
    public var title: String
    /// One line on why the step matters, or what is wrong.
    public var why: String
    public var state: SetupStepState
    /// A required step keeps the checklist unfinished and can hold the primary button.
    public var required: Bool
    public var action: SetupAction?
    public var actionTitle: String?
    public var secondaryAction: SetupAction?
    public var secondaryTitle: String?
}

public struct SetupChecklist: Sendable, Equatable {
    public let steps: [SetupStep]

    public init(_ f: SetupFacts) {
        let all = [
            Self.service(f), Self.hooks(f), Self.conductor(f), Self.notifications(f),
            Self.hotkey(f), Self.hands(f), Self.channels(f),
        ]
        steps = f.linkAvailable ? all : all.filter { $0.id != .conductor }
    }

    public func step(_ id: SetupStepID) -> SetupStep { steps.first { $0.id == id }! }
    public var total: Int { steps.count }
    public var doneCount: Int { steps.filter { $0.state == .done }.count }
    public var progressLabel: String { "\(doneCount) of \(total) done" }

    /// The first required step still to do (or failed): the one yellow button.
    public var primary: SetupStepID? {
        steps.first { $0.required && ($0.state == .todo || $0.state == .error) }?.id
    }

    /// Every required step is done. Optional steps never hold this back.
    public var isComplete: Bool { !steps.contains { $0.required && $0.state != .done } }
    public var requiredRemaining: Int { steps.filter { $0.required && $0.state != .done }.count }

    // MARK: Steps

    private static func service(_ f: SetupFacts) -> SetupStep {
        let title = "Background service"
        let why = "Watches every agent session and answers for you."
        switch f.service {
        case .running:
            return .init(id: .service, title: title, why: "Running.", state: .done, required: true)
        case .installing:
            return .init(id: .service, title: title, why: "Installing…", state: .todo, required: true)
        case .checking:
            return .init(id: .service, title: title, why: "Looking for the service…", state: .todo, required: true,
                         action: .repairService, actionTitle: "Restart service")
        case .notInstalled:
            return .init(id: .service, title: title, why: why, state: .todo, required: true,
                         action: .installService, actionTitle: "Install")
        case .needsApproval:
            return .init(id: .service, title: title, why: "Allow Squeak to run in the background in Login Items.", state: .error, required: true,
                         action: .openLoginItems, actionTitle: "Open Login Items Settings")
        case .failed(let reason):
            return .init(id: .service, title: title, why: reason, state: .error, required: true,
                         action: .repairService, actionTitle: "Repair")
        case .unavailable:
            return .init(id: .service, title: title, why: "This build of Squeak carries no background service. Start it with squeak start.",
                         state: .error, required: true)
        }
    }

    private static func serviceReady(_ f: SetupFacts) -> Bool { f.service == .running }

    /// Agent hooks only serve Claude Code and Codex started outside Squeak, which are the "(external)" add-ons: the
    /// step is never required, and a daemon that answers 404 to `/control/hooks` (both add-ons off) is not an old one.
    private static func hooks(_ f: SetupFacts) -> SetupStep {
        let title = "Agent hooks"
        let why = "Only for Claude Code and Codex started outside Squeak: lets them tell Squeak when they are waiting for you. Edits ~/.claude/settings.json with a backup; you can undo it."
        let off = "Not needed for Squeak's own chats. To also see Claude Code or Codex started outside Squeak, turn on Claude Code (external) or Codex (external) in Settings › Extensions."
        guard serviceReady(f) else {
            return .init(id: .hooks, title: title, why: "Needs the background service first.", state: .blocked, required: false)
        }
        guard let h = f.hooks else {
            if let p = f.hooksProblem {
                return .init(id: .hooks, title: title, why: p, state: .error, required: false, action: .installHooks, actionTitle: "Try again")
            }
            return .init(id: .hooks, title: title, why: off, state: .optional, required: false)
        }
        switch h.state {
        case .installed:
            return .init(id: .hooks, title: title, why: h.message.isEmpty ? "Installed." : h.message, state: .done, required: false)
        case .partial, .missing:
            return .init(id: .hooks, title: title, why: why, state: .optional, required: false, action: .installHooks,
                         actionTitle: h.state == .partial ? "Finish installing" : "Install hooks")
        case .error, .unknown:
            return .init(id: .hooks, title: title, why: h.message.isEmpty ? "Squeak couldn't read the hooks." : h.message,
                         state: .error, required: false, action: .installHooks, actionTitle: "Try again")
        }
    }

    private static func conductor(_ f: SetupFacts) -> SetupStep {
        let title = "Conductor"
        let why = "Lets Squeak start chats and answer them live."
        if !f.conductorInstalled || f.link?.state == .notInstalled {
            return .init(id: .conductor, title: title, why: "Conductor isn't installed. Skip this if you don't use it.", state: .optional, required: false)
        }
        if f.link?.state == .connected {
            return .init(id: .conductor, title: title, why: "Connected.", state: .done, required: true)
        }
        if f.conductorSkipped {
            return .init(id: .conductor, title: title, why: "Skipped. Settings › Conductor has it later.", state: .optional, required: false,
                         action: .setUpConductor, actionTitle: "Set up")
        }
        guard serviceReady(f) else {
            return .init(id: .conductor, title: title, why: "Needs the background service first.", state: .blocked, required: true)
        }
        if f.linkNeedUpdate {
            return .init(id: .conductor, title: title, why: ServiceSentence.updateService, state: .error, required: true,
                         action: .repairService, actionTitle: "Update service")
        }
        let isError = f.link?.state == .failed
        return .init(id: .conductor, title: title, why: f.link.flatMap { $0.message.isEmpty ? nil : $0.message } ?? why,
                     state: isError ? .error : .todo, required: true,
                     action: .setUpConductor, actionTitle: "Set up Conductor",
                     secondaryAction: .skipConductor, secondaryTitle: "Skip if you don't use Conductor")
    }

    private static func notifications(_ f: SetupFacts) -> SetupStep {
        let title = "Notifications"
        switch f.notifications {
        case .authorized:
            return .init(id: .notifications, title: title, why: "On.", state: .done, required: false)
        case .denied:
            return .init(id: .notifications, title: title,
                         why: "Turned off in System Settings, so a banner never shows when a chat is waiting for you.", state: .todo,
                         required: false, action: .openNotificationSettings, actionTitle: "Open System Settings")
        case .notDetermined, .unknown:
            return .init(id: .notifications, title: title, why: "A banner when a chat is waiting for you or finishes.", state: .todo,
                         required: false, action: .requestNotifications, actionTitle: "Allow notifications")
        }
    }

    private static func hotkey(_ f: SetupFacts) -> SetupStep {
        let title = "Quick-message shortcut"
        if f.inputMonitoringOK {
            return .init(id: .hotkey, title: title, why: "Ready.", state: .done, required: false)
        }
        return .init(id: .hotkey, title: title,
                     why: "Double-tapping Control needs Input Monitoring. Squeak only watches for the tap, never what you type.",
                     state: .todo, required: false, action: .grantInputMonitoring, actionTitle: "Open Input Monitoring")
    }

    /// The Accessibility grant belongs to Squeak Hands, which Squeak cannot read, so this is never "done".
    private static func hands(_ f: SetupFacts) -> SetupStep {
        let title = "Reply into Conductor's window"
        if !f.linkAvailable {
            return .init(id: .hands, title: title,
                         why: "Squeak Hands types the reply for you. In System Settings › Privacy & Security › Accessibility, turn on Squeak Hands.",
                         state: .optional, required: false, action: .openAccessibility, actionTitle: "Open System Settings")
        }
        if f.link?.state == .connected {
            return .init(id: .hands, title: title, why: "Not needed while Conductor's link is connected.", state: .optional, required: false)
        }
        return .init(id: .hands, title: title,
                     why: "Only needed when Conductor's link is down: Squeak Hands types the reply for you. In System Settings › Privacy & Security › Accessibility, turn on Squeak Hands.",
                     state: .optional, required: false, action: .openAccessibility, actionTitle: "Open System Settings")
    }

    private static func channels(_ f: SetupFacts) -> SetupStep {
        let title = "Telegram, Zoho Cliq or iPhone"
        if f.channelsConfigured {
            return .init(id: .channels, title: title, why: "At least one is set up.", state: .done, required: false)
        }
        return .init(id: .channels, title: title, why: "Get the same cards and answer from your phone.", state: .optional, required: false,
                     action: .openChannels, actionTitle: "Choose")
    }
}
