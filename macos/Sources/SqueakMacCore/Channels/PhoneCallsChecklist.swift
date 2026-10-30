import Foundation

/// Settings › Voice › "Phone calls setup": one list of what a phone line owner still has to do, derived only from
/// what the daemon already says (`GET /control/voice`, the gateway view, the realistic voice install). It decides
/// nothing the daemon does not already know; it words it and names the one button each step needs.
public struct PhoneCallsFacts: Sendable, Equatable {
    /// False while the daemon does not answer: nothing can be known, so nothing is claimed.
    public var daemonReachable: Bool
    public var voice: VoiceSettings?
    /// The daemon predates phone calls.
    public var voiceOutdated: Bool
    public var gateway: GatewayView?
    /// False once the gateway routes answered 404/503 (an older daemon, or no phone channel database).
    public var gatewayAvailable: Bool
    public var naturalSetup: NaturalSetupStatus?
    /// A test call is being placed right now (before the daemon has said "ringing").
    public var testPlacing: Bool
    /// Where "Update add-on" stands, or nil when none was pressed.
    public var addonUpdate: GatewayUpdateWatch.Phase?

    public init(daemonReachable: Bool = true, voice: VoiceSettings? = nil, voiceOutdated: Bool = false,
                gateway: GatewayView? = nil, gatewayAvailable: Bool = true,
                naturalSetup: NaturalSetupStatus? = nil, testPlacing: Bool = false,
                addonUpdate: GatewayUpdateWatch.Phase? = nil) {
        self.daemonReachable = daemonReachable; self.voice = voice; self.voiceOutdated = voiceOutdated
        self.gateway = gateway; self.gatewayAvailable = gatewayAvailable
        self.naturalSetup = naturalSetup; self.testPlacing = testPlacing; self.addonUpdate = addonUpdate
    }
}

public enum PhoneCallsStepID: String, Sendable, CaseIterable {
    case gateway, addonUpdate, extensionToRing, pin, realisticVoice, testCall
}

public enum PhoneCallsAction: String, Sendable, Equatable {
    case pairGateway, updateAddon, setExtension, setPin, installVoice, retryVoice, testCall

    /// The button's words.
    public var label: String {
        switch self {
        case .pairGateway: "Add gateway"
        case .updateAddon: "Update add-on"
        case .setExtension: "Set extension"
        case .setPin: "Set a PIN"
        case .installVoice: "Set up realistic voice"
        case .retryVoice: "Retry"
        case .testCall: "Call me now"
        }
    }
}

public struct PhoneCallsStep: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable {
        /// Done.
        case done
        /// Needs the person; has a button unless only the person can fix it elsewhere.
        case todo
        /// Cannot be done yet; an earlier step comes first.
        case blocked
        /// Something is running right now (an install, a call): shows a spinner.
        case working
        /// Not known: the daemon is not answering.
        case unknown
    }

    public var id: PhoneCallsStepID
    public var title: String
    public var state: State
    /// One line: what is true now, or what to do.
    public var detail: String
    public var action: PhoneCallsAction?
    /// An optional step never keeps "Phone calls are ready" from showing (the plain voice still works).
    public var isOptional: Bool

    public var isDone: Bool { state == .done }
    /// True when the step still stands between the person and working calls.
    public var isOutstanding: Bool { !isDone && !isOptional }
}

public struct PhoneCallsChecklist: Sendable, Equatable {
    public enum Summary: Sendable, Equatable {
        case unavailable
        case outdated
        case ready
        case left(Int)
    }

    public private(set) var steps: [PhoneCallsStep]
    public private(set) var summary: Summary

    /// "Phone calls are ready", "2 steps left", "1 step left".
    public var summaryLine: String {
        switch summary {
        case .unavailable: "Can't check right now: Squeak on this Mac isn't answering."
        case .outdated: "Squeak on this Mac is older than phone calls. Update it, then come back."
        case .ready: "Phone calls are ready"
        case let .left(n): n == 1 ? "1 step left" : "\(n) steps left"
        }
    }

    public var isReady: Bool { summary == .ready }

    public func step(_ id: PhoneCallsStepID) -> PhoneCallsStep? { steps.first { $0.id == id } }

    public init(_ f: PhoneCallsFacts) {
        if f.voiceOutdated {
            steps = []; summary = .outdated; return
        }
        guard f.daemonReachable, let v = f.voice else {
            steps = Self.build(unknownOf: f); summary = .unavailable; return
        }
        steps = Self.build(f, v)
        let left = steps.filter(\.isOutstanding).count
        summary = left == 0 ? .ready : .left(left)
    }

    // MARK: Steps

    private static func step(_ id: PhoneCallsStepID, _ title: String, _ state: PhoneCallsStep.State, _ detail: String,
                             _ action: PhoneCallsAction? = nil, optional: Bool = false) -> PhoneCallsStep {
        PhoneCallsStep(id: id, title: title, state: state, detail: detail, action: action, isOptional: optional)
    }

    /// Titles only, every state unknown, so the list keeps its shape while the daemon is away.
    private static func build(unknownOf f: PhoneCallsFacts) -> [PhoneCallsStep] {
        let all: [(PhoneCallsStepID, String, Bool)] = [
            (.gateway, "Phone-call gateway", false), (.addonUpdate, "Add-on up to date", false),
            (.extensionToRing, "Extension to ring", false), (.pin, "PIN", false),
            (.realisticVoice, "Realistic voice", true), (.testCall, "Test call", false),
        ]
        return all.map { step($0.0, $0.1, .unknown, "Not known: Squeak isn't answering.", optional: $0.2) }
    }

    private static func build(_ f: PhoneCallsFacts, _ v: VoiceSettings) -> [PhoneCallsStep] {
        var steps: [PhoneCallsStep] = []
        let gatewayOnly = v.mode != "direct"          // the Mac places the call itself in direct mode
        let gateway = f.gateway ?? GatewayView()
        let gatewayHere = gatewayOnly && f.gatewayAvailable
        let waitForGateway = "Connect the gateway first."

        // (a) the add-on is paired and reachable
        var gatewayDone = true
        if gatewayHere {
            switch gateway.status.state {
            case .ok:
                steps.append(step(.gateway, "Phone-call gateway", .done, "Home Assistant add-on is connected."))
            case .none:
                gatewayDone = false
                steps.append(step(.gateway, "Phone-call gateway", .todo, "No gateway paired yet. Pair the Home Assistant add-on with a short code.", .pairGateway))
            case .stale:
                gatewayDone = false
                steps.append(step(.gateway, "Phone-call gateway", .todo, GatewayText.statusLine(gateway.status) + ". Check that Home Assistant is running, or pair again.", .pairGateway))
            case .sipDown:
                gatewayDone = false
                steps.append(step(.gateway, "Phone-call gateway", .todo, GatewayText.statusLine(gateway.status) + ". Check the add-on's PBX address and login in Home Assistant."))
            }
        }

        // (b) the add-on is current
        if gatewayHere {
            if gateway.status.state == .none {
                steps.append(step(.addonUpdate, "Add-on up to date", .blocked, waitForGateway))
            } else if f.addonUpdate == .updating {
                steps.append(step(.addonUpdate, "Add-on up to date", .working, GatewayText.updating))
            } else if f.addonUpdate == .timedOut {
                steps.append(step(.addonUpdate, "Add-on up to date", .todo, GatewayText.updateTimedOut, gateway.updateAvailable ? .updateAddon : nil))
            } else if gateway.updateAvailable {
                steps.append(step(.addonUpdate, "Add-on up to date", .todo, GatewayText.updateLine(gateway) ?? "A newer add-on is available.", .updateAddon))
            } else {
                steps.append(step(.addonUpdate, "Add-on up to date", .done, GatewayText.versionLine(gateway) ?? "Up to date."))
            }
        }

        // (c) the extension to ring
        let extensionDone = v.callee != nil || v.defaultCallee != nil
        if let who = v.callee ?? v.defaultCallee {
            steps.append(step(.extensionToRing, "Extension to ring", .done, "Squeak rings \(who)."))
        } else if !v.isOn {
            steps.append(step(.extensionToRing, "Extension to ring", .blocked, waitForGateway))
        } else {
            steps.append(step(.extensionToRing, "Extension to ring", .todo, "Type your phone's extension in 3CX, like 101.", .setExtension))
        }

        // (d) a PIN, or consciously none
        if let pin = v.pinState {
            switch pin {
            case .set: steps.append(step(.pin, "PIN", .done, "A PIN protects replies by key."))
            case .off: steps.append(step(.pin, "PIN", .done, "PIN is off: anyone who answers can reply by key."))
            case .none:
                if v.isOn { steps.append(step(.pin, "PIN", .todo, "No PIN is set. Calls that require one cannot take replies.", .setPin)) }
                else { steps.append(step(.pin, "PIN", .blocked, waitForGateway)) }
            case .unknown: steps.append(step(.pin, "PIN", .working, "Checking…"))
            }
        }

        // (e) the realistic voice: optional, calls use the plain voice without it
        if let natural = v.natural {
            let setup = f.naturalSetup
            if natural.installed {
                steps.append(step(.realisticVoice, "Realistic voice", .done, natural.enabled ? "Calls use the realistic voice." : "Installed. Switched off for calls.", optional: true))
            } else if !v.isOn {
                steps.append(step(.realisticVoice, "Realistic voice", .blocked, waitForGateway, optional: true))
            } else if let setup, setup.isRunning {
                steps.append(step(.realisticVoice, "Realistic voice", .working, setup.progressLine, optional: true))
            } else if let setup, setup.state == .failed {
                steps.append(step(.realisticVoice, "Realistic voice", .todo, setup.failureLine, setup.needsPython ? nil : .retryVoice, optional: true))
            } else {
                steps.append(step(.realisticVoice, "Realistic voice", .todo, "Optional. Calls use the plain voice until you install it (about 350 MB, once).", .installVoice, optional: true))
            }
        }

        // (f) a test call that was answered
        if let blocked = v.testBlockedReason {
            steps.append(step(.testCall, "Test call", .blocked, blocked))
        } else if !gatewayDone || !extensionDone {
            steps.append(step(.testCall, "Test call", .blocked, "Finish the steps above first."))
        } else if f.testPlacing || v.isRinging {
            steps.append(step(.testCall, "Test call", .working, "Ringing your phone…"))
        } else if v.lastTest?.status == "answered" {
            steps.append(step(.testCall, "Test call", .done, "Your last test call was answered."))
        } else if let line = VoiceSettings.testLine(v.lastTest) {
            steps.append(step(.testCall, "Test call", .todo, line, .testCall))
        } else {
            steps.append(step(.testCall, "Test call", .todo, "Ring your phone once to check it all works.", .testCall))
        }
        return steps
    }
}
