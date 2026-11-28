import Foundation

// A person's name has one source: their Squeak account (name, else email), as the daemon serves it (docs/ponds.md,
// "Names"). Nothing here reads the Mac's own user name, and nothing offers a rename. Pure; views only draw.

public enum PersonName {
    /// What a person is called: the account's name, else the part of the email before the @ ("asha.rao@x.com" is "Asha"),
    /// never the address itself. The daemon already sends this; the same rule here covers a name saved as an email.
    public static func shown(_ m: FlockMember) -> String {
        let name = m.name.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty, !name.contains("@") { return name }
        let address = [name, m.email?.trimmingCharacters(in: .whitespaces) ?? ""].first { $0.contains("@") } ?? ""
        let local = address.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let first = local.split(whereSeparator: { ".+-_0123456789".contains($0) }).first.map(String.init) ?? ""
        return first.isEmpty ? "Someone" : first.prefix(1).uppercased() + first.dropFirst().lowercased()
    }

    /// The email drawn under a name and on hover: nil when there is none or it is already the name.
    public static func emailLine(_ m: FlockMember) -> String? {
        guard let email = m.email?.trimmingCharacters(in: .whitespaces), !email.isEmpty else { return nil }
        return email == shown(m) ? nil : email
    }

    /// This person's own name: the daemon's "you" member in any pond, else "" (callers say "You").
    public static func mine(in details: [PondDetail]) -> String {
        for d in details { if let me = d.members.first(where: \.you) { return shown(me) } }
        return ""
    }

    /// The email for a name seen in the Room (authors carry a name only): only when exactly one member has it.
    public static func email(forName name: String, in members: [FlockMember]) -> String? {
        let hits = members.filter { shown($0) == name }
        return hits.count == 1 ? emailLine(hits[0]) : nil
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
