import Foundation

/// What the Account card is busy with, as pure state: at most one flow at a time, each with an id so a late callback
/// from a cancelled one cannot end the next, and a deadline so a browser sheet nobody can see never holds the buttons.
public struct AccountFlow: Equatable, Sendable {
    public enum Kind: Sendable { case signIn, connect, photo, signOut }
    public static let timeout: TimeInterval = 300

    public private(set) var kind: Kind?
    public private(set) var id = 0
    public private(set) var startedAt: Date?

    public init() {}

    public var busy: Bool { kind != nil }
    /// A browser session is (or may be) open for it, so a Cancel link makes sense.
    public var cancellable: Bool { kind == .signIn || kind == .connect || kind == .photo }

    /// The sentence beside Cancel.
    public var line: String? {
        switch kind {
        case .signIn?: "Signing in…"
        case .connect?: "Connecting to Squeak's cloud…"
        case .photo?: "Updating your photo…"
        case .signOut?: "Signing out…"
        case nil: nil
        }
    }

    /// Starts a flow; refused (nil) while another runs. Returns the id to end it with.
    public mutating func begin(_ k: Kind, at now: Date = Date()) -> Int? {
        guard kind == nil else { return nil }
        id += 1; kind = k; startedAt = now
        return id
    }

    /// Ends the flow `token` started; a stale token (it was cancelled and replaced) changes nothing.
    public mutating func end(_ token: Int) {
        guard token == id else { return }
        kind = nil; startedAt = nil
    }

    /// Ends whatever runs, returning what it was.
    @discardableResult public mutating func cancel() -> Kind? {
        let was = kind
        id += 1; kind = nil; startedAt = nil
        return was
    }

    public func expired(at now: Date = Date()) -> Bool {
        guard let s = startedAt, cancellable else { return false }
        return now.timeIntervalSince(s) >= Self.timeout
    }

    /// Sign out is never blocked: any pending flow is cancelled first (returned so the caller closes its session).
    public mutating func beginSignOut(at now: Date = Date()) -> (cancelled: Kind?, token: Int) {
        let was = cancel()
        let t = begin(.signOut, at: now) ?? id
        return (was, t)
    }

    /// The token step after a sign-in: only when the daemon waits for it, the move is not on hold, and this launch has not tried.
    public static func shouldAutoConnect(hosted: HostedCloud?, accountLinked: Bool, triedThisLaunch: Bool) -> Bool {
        guard accountLinked, !triedThisLaunch, let h = hosted, h.needsSignIn, h.moveDeferred != true else { return false }
        return true
    }
}
