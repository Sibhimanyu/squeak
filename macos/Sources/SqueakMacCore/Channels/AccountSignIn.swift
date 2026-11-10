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

    public init(linked: Bool = false, email: String? = nil, signInUrl: String? = nil, askOwnDevices: Bool? = nil) {
        self.linked = linked; self.email = email; self.signInUrl = signInUrl; self.askOwnDevices = askOwnDevices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        linked = (try? c.decode(Bool.self, forKey: .linked)) ?? false
        email = (try? c.decode(String.self, forKey: .email)).flatMap { $0.isEmpty ? nil : $0 }
        signInUrl = (try? c.decode(String.self, forKey: .signInUrl)).flatMap { $0.isEmpty ? nil : $0 }
        askOwnDevices = try? c.decode(Bool.self, forKey: .askOwnDevices)
    }
    enum CodingKeys: String, CodingKey { case linked, email, signInUrl, askOwnDevices }

    public static func decode(_ data: Data) -> AccountState? { try? JSONDecoder().decode(AccountState.self, from: data) }
}

/// `POST /control/remote/account/link` answer.
public struct AccountLinkResult: Decodable, Sendable, Equatable {
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
    public static func startURL(signInUrl: String, state: String) -> URL? {
        guard var c = URLComponents(string: signInUrl), c.scheme == "https", c.host?.isEmpty == false else { return nil }
        c.fragment = "mac-signin=\(state)"
        return c.url
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
