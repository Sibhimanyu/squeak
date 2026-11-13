import Foundation

/// `GET /control/cliq/handlers`: the three Zoho Cliq handlers to paste, built by the daemon (the code holds the
/// signing secret, so it is held only while the page is open and never logged).
public struct CliqHandlersView: Decodable, Sendable, Equatable {
    public struct Block: Decodable, Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var `where`: String
        public var code: String
        public init(id: String, title: String, where place: String, code: String) {
            self.id = id; self.title = title; self.where = place; self.code = code
        }
    }
    public var blocks: [Block]
    public var relayReady: Bool
    public var lastTapAt: String?
    /// "catalyst", "firebase" or "both": which inbox the daemon reads.
    public var inbox: String
    /// Hosted Macs: the daemon registers this Mac's own Cliq key with Squeak's cloud itself.
    public var automatic: Bool
    /// Set when that registration failed (a fixed sentence from the daemon); the page offers Retry.
    public var registerError: String?

    public init(blocks: [Block] = [], relayReady: Bool = false, lastTapAt: String? = nil, inbox: String = "catalyst",
                automatic: Bool = false, registerError: String? = nil) {
        self.blocks = blocks; self.relayReady = relayReady; self.lastTapAt = lastTapAt; self.inbox = inbox
        self.automatic = automatic; self.registerError = registerError
    }

    enum CodingKeys: String, CodingKey { case blocks, relayReady, lastTapAt, inbox, automatic, registerError }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        blocks = c.lenient([Block].self, .blocks) ?? []
        relayReady = c.lenient(Bool.self, .relayReady) ?? false
        lastTapAt = c.lenient(String.self, .lastTapAt)
        inbox = c.lenient(String.self, .inbox) ?? "catalyst"
        automatic = c.lenient(Bool.self, .automatic) ?? false
        registerError = c.lenient(String.self, .registerError)
    }
}

/// `POST /control/cliq/handlers/regenerate`.
public struct CliqRegenerateResult: Decodable, Sendable, Equatable {
    public var ok: Bool
    public var needsRelayDeploy: Bool
    /// Only when Squeak's cloud must be given a key it does not have yet.
    public var relayKey: String?
    public var reason: String?

    enum CodingKeys: String, CodingKey { case ok, needsRelayDeploy, relayKey, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        needsRelayDeploy = c.lenient(Bool.self, .needsRelayDeploy) ?? false
        relayKey = c.lenient(String.self, .relayKey)
        reason = c.lenient(String.self, .reason)
    }
}

/// One card of the guided setup.
public struct CliqSetupStep: Equatable, Identifiable, Sendable {
    public var id: String
    public var number: Int
    public var title: String
    public var place: String
    public var code: String
}

public enum CliqSetupModel {
    /// What the handlers page shows before any step.
    public enum Page: Equatable, Sendable {
        /// The daemon predates the route.
        case outdated
        case loading
        /// The handlers are ready to paste.
        case ready
        /// A hosted Mac whose key is being registered: nothing for the person to do.
        case gettingKey
        /// Registration failed: the sentence, and a Retry.
        case failed(String)
        /// An own-cloud Mac that makes its handlers with a button.
        case needsHandlers
    }

    public static func page(_ view: CliqHandlersView?, outdated: Bool) -> Page {
        if outdated { return .outdated }
        guard let view else { return .loading }
        if view.relayReady { return .ready }
        if let error = view.registerError { return .failed(error) }
        return view.automatic ? .gettingKey : .needsHandlers
    }

    /// Where "Open Zoho Cliq" goes. The bot's own settings page has no stable link, so it is Cliq itself.
    public static let cliqURL = URL(string: "https://cliq.zoho.in")!

    /// Steps 1-3: one per handler, in the order they are pasted. Step 4 is the check.
    public static func steps(_ view: CliqHandlersView) -> [CliqSetupStep] {
        let order = ["message", "squeakbutton", "squeakreply"]
        return order.enumerated().compactMap { index, id in
            view.blocks.first { $0.id == id }.map {
                CliqSetupStep(id: id, number: index + 1, title: $0.title, place: $0.where, code: $0.code)
            }
        }
    }

    public enum TapStatus: Equatable, Sendable {
        case waiting
        /// A tap arrived after the page opened.
        case received(String)
        /// A tap had already arrived before the page opened: Cliq works.
        case alreadyWorking(String)
    }

    /// `baseline` is `lastTapAt` as it was when the page first loaded; a different value is a new tap.
    public static func tapStatus(baseline: String?, current: String?) -> TapStatus {
        guard let current else { return .waiting }
        return current == baseline ? .alreadyWorking(current) : .received(current)
    }
}

/// Several Copy buttons on one page, each with its own "Copied ✓" moment (the existing `CopyFeedback`, 1.5 s).
public struct CopyButtons: Equatable, Sendable {
    private var pressed: [String: CopyFeedback] = [:]
    public init() {}

    public mutating func press(_ id: String, at now: Date = Date()) {
        var f = pressed[id] ?? CopyFeedback()
        f.copied(at: now)
        pressed[id] = f
    }
    public func label(_ id: String, at now: Date = Date()) -> String {
        (pressed[id] ?? CopyFeedback()).label("Copy", now: now)
    }
}
