import Foundation

/// Where "Sign in to Squeak" was opened from, so its back button returns there (DESIGN.md §8.10, Sign in page).
public enum SignInOrigin: Equatable, Sendable {
    case settings
    case setup
    case pond(String)
    case dashboard

    /// The back button's words: the place you came from.
    public var backTitle: String {
        switch self {
        case .settings: "Settings"
        case .setup: "Setup"
        case .pond(let name): name.isEmpty ? "Dashboard" : name
        case .dashboard: "Dashboard"
        }
    }
}

/// The three buttons. Zoho and Google are the hosted page's own providers; Email is the same hosted page, because the
/// account service exposes no email-and-code API a native client could call (it is Catalyst's hosted login).
public enum SignInProvider: String, CaseIterable, Equatable, Sendable {
    case zoho, google, email

    public var buttonTitle: String {
        switch self {
        case .zoho: "Continue with Zoho"
        case .google: "Continue with Google"
        case .email: "Email"
        }
    }

    /// What to pick on the hosted page, since the page cannot be told in advance.
    public var browserHint: String {
        switch self {
        case .zoho: "Choose Zoho there."
        case .google: "Choose Google there."
        case .email: "Choose email there."
        }
    }
}

/// How one browser sign-in ended.
public enum SignInOutcome: Equatable, Sendable {
    case linked(email: String?)
    case cancelled
    case failed(String)
}

/// The state of the sign-in page: pick a way, wait for the browser, then the account or a plain error with Try again.
public struct SignInPage: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case choose
        case waiting(SignInProvider)
        case signedIn(email: String?)
        case failed(String)
    }

    public private(set) var phase: Phase = .choose
    public let origin: SignInOrigin

    public init(origin: SignInOrigin) { self.origin = origin }

    /// Only a page that is choosing or showing an error starts a sign-in; false means nothing changed.
    @discardableResult
    public mutating func begin(_ provider: SignInProvider) -> Bool {
        switch phase {
        case .choose, .failed: phase = .waiting(provider); return true
        case .waiting, .signedIn: return false
        }
    }

    /// The result of the browser sign-in. Ignored unless one is running. Cancel returns to the choices, quietly.
    public mutating func finish(_ outcome: SignInOutcome) {
        guard case .waiting = phase else { return }
        switch outcome {
        case .linked(let email): phase = .signedIn(email: email)
        case .cancelled: phase = .choose
        case .failed(let sentence): phase = .failed(sentence)
        }
    }

    /// Cancel on the waiting view. True when a running session must be cancelled.
    @discardableResult
    public mutating func cancel() -> Bool {
        guard case .waiting = phase else { return false }
        phase = .choose
        return true
    }

    /// Try again after an error: back to the choices.
    public mutating func retry() { if case .failed = phase { phase = .choose } }

    public var isWaiting: Bool { if case .waiting = phase { true } else { false } }
    public var isSignedIn: Bool { if case .signedIn = phase { true } else { false } }

    /// "Finish signing in in your browser", with the hint for the provider chosen.
    public var waitingLine: String? {
        guard case .waiting(let p) = phase else { return nil }
        return "Finish signing in in your browser. \(p.browserHint)"
    }
}
