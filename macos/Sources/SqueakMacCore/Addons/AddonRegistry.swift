import Foundation

// Squeak for Mac's add-on seam. An add-on is optional code that is not distributed (macos/Addons/<Name>/, wired in
// by Package.swift only when its folder exists and the environment asks for it). Core and the app know only the
// types here: an add-on registers itself once (`InstalledAddons.register`, module SqueakMacAddons, an empty stub
// unless an add-on replaces it), and the app draws what it describes. Nothing in core or the app names an add-on.

/// What a Conductor link, whoever provides it, tells the setup checklist.
public struct ConductorLinkReading: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case connected
        case notInstalled
        /// Something went wrong; `message` is the daemon's sentence.
        case failed
        /// Not connected yet: off, waiting for a restart, unsupported.
        case pending
    }

    public var state: State
    public var message: String
    public var conductorInstalled: Bool

    public init(state: State, message: String = "", conductorInstalled: Bool = true) {
        self.state = state; self.message = message; self.conductorInstalled = conductorInstalled
    }
}

/// Sentences the daemon and the Mac share, here because more than one surface says them.
public enum ServiceSentence {
    /// The daemon predates a route, so its service needs updating from Settings › Connections.
    public static let updateService = "Update the background service"
}

/// A settings page an add-on describes and the app draws in its own design.
public struct AddonPage: Sendable {
    public enum Tone: Sendable { case good, bad, quiet }

    public struct Line: Sendable {
        public var tone: Tone
        public var text: String
        public init(tone: Tone, text: String) { self.tone = tone; self.text = text }
    }

    public struct Confirmation: Sendable {
        public var title: String
        public var message: String
        public var confirmTitle: String
        public var destructive: Bool
        public init(title: String, message: String, confirmTitle: String, destructive: Bool = false) {
            self.title = title; self.message = message; self.confirmTitle = confirmTitle; self.destructive = destructive
        }
    }

    public struct Action: Sendable, Identifiable {
        public var id: String
        public var title: String
        public var primary: Bool
        public var disabled: Bool
        public var confirmation: Confirmation?
        public var run: @MainActor @Sendable () async -> Void
        public init(
            id: String, title: String, primary: Bool = false, disabled: Bool = false, confirmation: Confirmation? = nil,
            run: @escaping @MainActor @Sendable () async -> Void
        ) {
            self.id = id; self.title = title; self.primary = primary; self.disabled = disabled
            self.confirmation = confirmation; self.run = run
        }
    }

    public var title: String
    public var subtitle: String
    /// An SF Symbol name.
    public var symbol: String
    /// nil while the first reading is still on its way (the app shows `loading`).
    public var headline: Line?
    public var loading: String
    public var steps: [String]
    /// Plain paragraphs under the headline.
    public var notes: [String]
    public var problem: String?
    /// Where a Report problem button says the problem came from.
    public var reportPlace: String
    public var reportProblem: String?
    public var actions: [Action]
    public var busy: Bool

    public init(
        title: String, subtitle: String, symbol: String, headline: Line? = nil, loading: String = "Checking…",
        steps: [String] = [], notes: [String] = [], problem: String? = nil, reportPlace: String = "",
        reportProblem: String? = nil, actions: [Action] = [], busy: Bool = false
    ) {
        self.title = title; self.subtitle = subtitle; self.symbol = symbol; self.headline = headline
        self.loading = loading; self.steps = steps; self.notes = notes; self.problem = problem
        self.reportPlace = reportPlace; self.reportProblem = reportProblem; self.actions = actions; self.busy = busy
    }
}

/// A way to link Squeak to Conductor beyond typing into its window: the Settings › Conductor page and the setup step.
@MainActor
public protocol ConductorLinkAddon: AnyObject {
    /// What the setup checklist reads; nil until the first reading.
    var reading: ConductorLinkReading? { get }
    /// The daemon predates the add-on's routes.
    var needsServiceUpdate: Bool { get }
    /// A setup or reset is in flight.
    var busy: Bool { get }
    /// The Settings › Conductor page as it is now. Read in a view body, so it tracks the add-on's observable state.
    var page: AddonPage { get }
    func refresh() async
    /// Runs while the page is on screen, until cancelled.
    func poll() async
    func setUp() async
    /// Whether a chat's error text says this link is down, so a surface can offer the Conductor settings page.
    func isLinkProblem(_ text: String?) -> Bool
}

/// Where add-ons register. Reading `hasConductorLink` is allowed from anywhere; registering is the app's, once.
@MainActor
public final class AddonRegistry {
    public static let shared = AddonRegistry()

    /// Whether a Conductor link add-on is registered: the Conductor settings page and setup step exist only then.
    public nonisolated static var hasConductorLink: Bool { conductorLinkFlag.value }

    public private(set) var conductorLink: (any ConductorLinkAddon)?

    public func register(conductorLink link: any ConductorLinkAddon) {
        conductorLink = link
        conductorLinkFlag.value = true
    }

    /// For tests.
    public func removeAll() {
        conductorLink = nil
        conductorLinkFlag.value = false
    }
}

private let conductorLinkFlag = LockedFlag()

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}
