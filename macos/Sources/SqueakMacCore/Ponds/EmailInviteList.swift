import Foundation

// "Invite by email" (docs/ponds.md): the sheet's email field accepts several addresses at once (comma, space, semicolon
// or return between them), shows each as a token, and sends them in one go. The rules here match the host's and the
// relay's (a simple strict address, lower-cased, at most 10 per send), so a refusal is never a surprise.

public enum EmailAddress {
    public static let maxPerSend = 10

    /// A simple strict address: one @, a dotted host, no spaces or quotes; at most 254 characters.
    public static func isValid(_ value: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespaces)
        guard v.count <= 254, let at = v.lastIndex(of: "@") else { return false }
        let local = v[v.startIndex..<at]
        let host = v[v.index(after: at)...]
        guard (1...64).contains(local.count), !local.contains("@"), !host.isEmpty else { return false }
        let localOK = local.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ".!#$%&'*+/=?^_`{|}~-".contains($0)) }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard localOK, labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            (1...63).contains(label.count) && label.first != "-" && label.last != "-"
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }

    public static func normalized(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// "p***@e***.com": how the page and the relay say whose an invite is.
    public static func masked(_ value: String) -> String {
        let e = normalized(value)
        guard let at = e.lastIndex(of: "@"), at != e.startIndex else { return "***" }
        let host = String(e[e.index(after: at)...])
        let dot = host.lastIndex(of: ".")
        let name = dot.map { String(host[host.startIndex..<$0]) } ?? host
        let tld = dot.map { String(host[$0...]) } ?? ""
        return "\(e.first!)***@\(name.first.map(String.init) ?? "")***\(tld)"
    }
}

/// The tokens in the email field: addresses that passed, and typed text that did not (kept visible so it can be fixed).
public struct EmailInviteList: Sendable, Equatable {
    public private(set) var addresses: [String] = []
    /// Text the person typed that is not an address (shown in the field's own colour for errors until fixed or removed).
    public private(set) var rejected: [String] = []
    public private(set) var overflow = false

    public init() {}

    public static let separators = CharacterSet(charactersIn: ", ;\n\t\r")

    /// Splits typed or pasted text into pieces.
    public static func pieces(_ text: String) -> [String] {
        text.components(separatedBy: separators).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Adds every piece of `text`: valid addresses become tokens (lower-cased, no duplicates, at most 10); the rest are
    /// listed in `rejected`. Returns whether anything was added.
    @discardableResult
    public mutating func add(_ text: String) -> Bool {
        var added = false
        for piece in Self.pieces(text) {
            let a = EmailAddress.normalized(piece)
            guard EmailAddress.isValid(a) else {
                if !rejected.contains(piece) { rejected.append(piece) }
                continue
            }
            if addresses.contains(a) { continue }
            guard addresses.count < EmailAddress.maxPerSend else { overflow = true; continue }
            addresses.append(a)
            added = true
        }
        return added
    }

    public mutating func remove(_ address: String) {
        addresses.removeAll { $0 == address }
        if addresses.count < EmailAddress.maxPerSend { overflow = false }
    }
    public mutating func dismissRejected() { rejected = [] }

    public var canSend: Bool { !addresses.isEmpty }
    public var count: Int { addresses.count }
}

/// What the host answers to `POST /native/ponds/<id>/invites/email`.
public struct PondEmailInviteResult: Sendable, Equatable, Decodable {
    public struct Failure: Sendable, Equatable, Decodable {
        public var email: String
        public var reason: String
        public init(email: String, reason: String) { self.email = email; self.reason = reason }
    }
    public var sent: [String]
    public var failed: [Failure]
    public init(sent: [String], failed: [Failure]) { self.sent = sent; self.failed = failed }
}

/// One result row in the sheet after "Send invites".
public struct EmailInviteRow: Sendable, Equatable, Identifiable {
    public var id: String { email }
    public var email: String
    public var sent: Bool
    /// "Sent" or why it could not be.
    public var line: String

    public static func rows(from result: PondEmailInviteResult) -> [EmailInviteRow] {
        result.sent.map { EmailInviteRow(email: $0, sent: true, line: "Sent") }
            + result.failed.map { EmailInviteRow(email: $0.email, sent: false, line: "Couldn\u{2019}t send: \($0.reason)") }
    }
}

public enum EmailInviteText {
    public static func headline(pond: String) -> String { "Invite to \(pond)" }
    public static let subtitle = "Type email addresses. Each person gets a link; they sign in to Squeak with that address and they\u{2019}re in."
    public static let placeholder = "name@company.com, another@company.com"
    public static let note = "No codes to read out. Only the person with that address can join with the link."
    public static let send = "Send invites"
    public static func sending(_ n: Int) -> String { "Sending\u{2026}" }
    public static let copyLink = "Copy invite link"
    public static let linkNote = "A link anyone can open still needs your approval."
    public static func tooMany() -> String { "At most \(EmailAddress.maxPerSend) people at a time." }
    public static func notAnAddress(_ text: String) -> String { "\u{201C}\(text)\u{201D} doesn\u{2019}t look like an email address." }
}
