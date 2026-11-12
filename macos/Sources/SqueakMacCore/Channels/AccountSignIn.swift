import Foundation
import Security

/// `GET /control/remote/account`: whether this Mac is linked to a Squeak account, and where sign-in lives.
public struct AccountState: Decodable, Sendable, Equatable {
    public var linked: Bool
    public var email: String?
    /// Present only when the Mac's cloud is Catalyst.
    public var signInUrl: String?
    /// When true, the owner approves their own devices too; nil from an older daemon (treated as off).
    public var askOwnDevices: Bool?
    /// When the account's photo last changed (ms); nil = none, or an older daemon.
    public var avatarAt: Double?

    public init(linked: Bool = false, email: String? = nil, signInUrl: String? = nil, askOwnDevices: Bool? = nil, avatarAt: Double? = nil) {
        self.linked = linked; self.email = email; self.signInUrl = signInUrl; self.askOwnDevices = askOwnDevices; self.avatarAt = avatarAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        linked = (try? c.decode(Bool.self, forKey: .linked)) ?? false
        email = (try? c.decode(String.self, forKey: .email)).flatMap { $0.isEmpty ? nil : $0 }
        signInUrl = (try? c.decode(String.self, forKey: .signInUrl)).flatMap { $0.isEmpty ? nil : $0 }
        askOwnDevices = try? c.decode(Bool.self, forKey: .askOwnDevices)
        avatarAt = (try? c.decode(Double.self, forKey: .avatarAt)).flatMap { $0 > 0 ? $0 : nil }
    }
    enum CodingKeys: String, CodingKey { case linked, email, signInUrl, askOwnDevices, avatarAt }

    public static func decode(_ data: Data) -> AccountState? { try? JSONDecoder().decode(AccountState.self, from: data) }
}

/// `POST /control/remote/account/link` answer.
public struct AccountLinkResult: Decodable, Sendable, Equatable {
    /// The daemon's sentence for a body it does not accept; how an older daemon answers `{ ticket, token }`.
    public static let unreadable = "That sign-in could not be read. Sign in again."
    public var ok: Bool
    public var email: String?
    public var reason: String?

    public static func decode(_ data: Data) -> AccountLinkResult {
        struct Raw: Decodable { var ok: Bool?; var email: String?; var reason: String? }
        let r = try? JSONDecoder().decode(Raw.self, from: data)
        return AccountLinkResult(ok: r?.ok ?? false, email: r?.email, reason: r?.reason)
    }
}

/// The sign-in handshake: a random state kept in memory, and the callback the page ends on.
public enum AccountSignIn {
    public static let callbackScheme = "squeak-mac"
    public static let maxTicketLength = 512

    /// 32 random bytes, base64url without padding.
    public static func makeState() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// `<signInUrl>#mac-signin=<state>`; nil unless the address is https.
    /// With `both`, `&want=ticket,token` asks the page for the link ticket and the account token in one pass.
    public static func startURL(signInUrl: String, state: String, both: Bool = false) -> URL? {
        guard var c = URLComponents(string: signInUrl), c.scheme == "https", c.host?.isEmpty == false else { return nil }
        c.fragment = "mac-signin=\(state)" + (both ? "&want=ticket,token" : "")
        return c.url
    }

    /// What a one-step callback carries: the link ticket, and the account token when the page minted one.
    public struct SignedIn: Equatable, Sendable { public var ticket: String; public var token: String? }

    /// `squeak-mac://signed-in?ticket=…[&token=…]&state=…`: the ticket as `ticket(from:)` checks it, plus an optional token
    /// (an old page sends none; a token of an unexpected size is dropped, never failing the sign-in).
    public static func signedIn(from callback: URL, expectedState: String) -> Result<SignedIn, Failure> {
        switch ticket(from: callback, expectedState: expectedState) {
        case .failure(let f): return .failure(f)
        case .success(let t):
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let token = items.first(where: { $0.name == "token" })?.value
            return .success(SignedIn(ticket: t, token: token.flatMap { !$0.isEmpty && $0.count <= 1024 ? $0 : nil }))
        }
    }

    /// `<signInUrl>#mac-cloud=<state>`: asks the page for an account token (not a link ticket); nil unless https.
    public static func cloudURL(signInUrl: String, state: String) -> URL? {
        guard var c = URLComponents(string: signInUrl), c.scheme == "https", c.host?.isEmpty == false else { return nil }
        c.fragment = "mac-cloud=\(state)"
        return c.url
    }

    /// The account token from `squeak-mac://signed-in?token=…&state=…`, only if the state matches exactly.
    public static func token(from callback: URL, expectedState: String) -> Result<String, Failure> {
        guard callback.scheme == callbackScheme, callback.host == "signed-in" else { return .failure(.wrongHost) }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let state = items.first { $0.name == "state" }?.value ?? ""
        guard constantTimeEqual(state, expectedState), !expectedState.isEmpty else { return .failure(.stateMismatch) }
        guard let t = items.first(where: { $0.name == "token" })?.value, !t.isEmpty else { return .failure(.missingTicket) }
        guard t.count <= 2048 else { return .failure(.ticketTooLong) }
        return .success(t)
    }

    /// `<signInUrl>#photo=<state>`; nil unless the address is https.
    public static func photoURL(signInUrl: String, state: String) -> URL? {
        guard var c = URLComponents(string: signInUrl), c.scheme == "https", c.host?.isEmpty == false else { return nil }
        c.fragment = "photo=\(state)"
        return c.url
    }

    /// True only for `squeak-mac://photo-updated?state=…` whose state matches exactly.
    public static func photoUpdated(callback: URL, expectedState: String) -> Bool {
        guard callback.scheme == callbackScheme, callback.host == "photo-updated", !expectedState.isEmpty else { return false }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let state = items.first { $0.name == "state" }?.value ?? ""
        return constantTimeEqual(state, expectedState)
    }

    public enum Failure: Error, Equatable, Sendable {
        case wrongHost, stateMismatch, missingTicket, ticketTooLong

        public var sentence: String {
            switch self {
            case .wrongHost, .stateMismatch: "Sign-in didn't match this request, so Squeak ignored it. Try again."
            case .missingTicket: "Sign-in finished without a ticket. Try again."
            case .ticketTooLong: "Sign-in sent something Squeak didn't expect. Try again."
            }
        }
    }

    /// The ticket from `squeak-mac://signed-in?ticket=…&state=…`, only if the state matches exactly.
    public static func ticket(from callback: URL, expectedState: String) -> Result<String, Failure> {
        guard callback.scheme == callbackScheme, callback.host == "signed-in" else { return .failure(.wrongHost) }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let state = items.first { $0.name == "state" }?.value ?? ""
        guard constantTimeEqual(state, expectedState), !expectedState.isEmpty else { return .failure(.stateMismatch) }
        guard let t = items.first(where: { $0.name == "ticket" })?.value, !t.isEmpty else { return .failure(.missingTicket) }
        guard t.count <= maxTicketLength else { return .failure(.ticketTooLong) }
        return .success(t)
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<max(x.count, y.count) {
            diff |= Int(i < x.count ? x[i] : 0) ^ Int(i < y.count ? y[i] : 0)
        }
        return diff == 0
    }
}
