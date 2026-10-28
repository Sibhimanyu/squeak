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
}

public enum SetupServiceFact: Sendable, Equatable {
    /// Not read yet.
    case checking
    case running
    case installing
    case notInstalled
    case failed(String)
    /// A build with no bundled service (`swift run`).
    case unavailable

    /// From the app's reading of the daemon: anything that answers counts as running.
    public static func from(_ status: DaemonStatus, connected: Bool, busy: Bool) -> SetupServiceFact {
        if connected { return .running }
        if busy { return .installing }
        switch status {
        case .unavailable: return .unavailable
        case .notInstalled: return .notInstalled
        case .updating: return .installing
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
    public var relay: RelayStatus?
    public var relayNeedUpdate: Bool
    public var conductorInstalled: Bool
    public var conductorSkipped: Bool
    public var notifications: NotificationAccess
    /// Whether Input Monitoring is granted; true when the chosen shortcut needs none.
    public var inputMonitoringOK: Bool
    public var channelsConfigured: Bool

    public init(
        service: SetupServiceFact = .checking, hooks: HooksStatus? = nil, hooksNeedUpdate: Bool = false, hooksProblem: String? = nil,
        relay: RelayStatus? = nil, relayNeedUpdate: Bool = false, conductorInstalled: Bool = true, conductorSkipped: Bool = false,
        notifications: NotificationAccess = .unknown, inputMonitoringOK: Bool = false, channelsConfigured: Bool = false
    ) {
        self.service = service; self.hooks = hooks; self.hooksNeedUpdate = hooksNeedUpdate; self.hooksProblem = hooksProblem
        self.relay = relay; self.relayNeedUpdate = relayNeedUpdate; self.conductorInstalled = conductorInstalled
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
        steps = [
            Self.service(f), Self.hooks(f), Self.conductor(f), Self.notifications(f),
            Self.hotkey(f), Self.hands(f), Self.channels(f),
        ]
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
        case .failed(let reason):
            return .init(id: .service, title: title, why: reason, state: .error, required: true,
                         action: .repairService, actionTitle: "Repair")
        case .unavailable:
            return .init(id: .service, title: title, why: "This build of Squeak carries no background service. Start it with squeak start.",
                         state: .error, required: true)
        }
    }

    private static func serviceReady(_ f: SetupFacts) -> Bool { f.service == .running }

    private static func hooks(_ f: SetupFacts) -> SetupStep {
        let title = "Agent hooks"
        let why = "Lets Claude Code and Codex tell Squeak when they need you. Edits ~/.claude/settings.json with a backup; you can undo it."
        guard serviceReady(f) else {
            return .init(id: .hooks, title: title, why: "Needs the background service first.", state: .blocked, required: true)
        }
        if f.hooksNeedUpdate {
            return .init(id: .hooks, title: title, why: RelayStatus.updateServiceSentence, state: .error, required: true,
                         action: .repairService, actionTitle: "Update service")
        }
        guard let h = f.hooks else {
            if let p = f.hooksProblem {
                return .init(id: .hooks, title: title, why: p, state: .error, required: true, action: .installHooks, actionTitle: "Try again")
            }
            return .init(id: .hooks, title: title, why: why, state: .todo, required: true, action: .installHooks, actionTitle: "Install hooks")
        }
        switch h.state {
        case .installed:
            return .init(id: .hooks, title: title, why: h.message.isEmpty ? "Installed." : h.message, state: .done, required: true)
        case .partial, .missing:
            return .init(id: .hooks, title: title, why: why, state: .todo, required: true, action: .installHooks,
                         actionTitle: h.state == .partial ? "Finish installing" : "Install hooks")
        case .error, .unknown:
            return .init(id: .hooks, title: title, why: h.message.isEmpty ? "Squeak couldn't read the hooks." : h.message,
                         state: .error, required: true, action: .installHooks, actionTitle: "Try again")
        }
    }

    private static func conductor(_ f: SetupFacts) -> SetupStep {
        let title = "Conductor"
        let why = "Lets Squeak start chats and answer them live."
        if !f.conductorInstalled || f.relay?.state == .notInstalled {
            return .init(id: .conductor, title: title, why: "Conductor isn't installed. Skip this if you don't use it.", state: .optional, required: false)
        }
        if f.relay?.state == .connected {
            return .init(id: .conductor, title: title, why: "Connected.", state: .done, required: true)
        }
        if f.conductorSkipped {
            return .init(id: .conductor, title: title, why: "Skipped. Settings › Conductor has it later.", state: .optional, required: false,
                         action: .setUpConductor, actionTitle: "Set up")
        }
        guard serviceReady(f) else {
            return .init(id: .conductor, title: title, why: "Needs the background service first.", state: .blocked, required: true)
        }
        if f.relayNeedUpdate {
            return .init(id: .conductor, title: title, why: RelayStatus.updateServiceSentence, state: .error, required: true,
                         action: .repairService, actionTitle: "Update service")
        }
        let isError = f.relay?.state == .error
        return .init(id: .conductor, title: title, why: f.relay.flatMap { $0.message.isEmpty ? nil : $0.message } ?? why,
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
                         why: "Turned off in System Settings, so a banner never shows when a session needs you.", state: .todo,
                         required: false, action: .openNotificationSettings, actionTitle: "Open System Settings")
        case .notDetermined, .unknown:
            return .init(id: .notifications, title: title, why: "A banner when a session needs you or finishes.", state: .todo,
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
        if f.relay?.state == .connected {
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
