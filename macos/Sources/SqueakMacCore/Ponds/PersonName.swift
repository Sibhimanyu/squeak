import Foundation

// A person's name has one source: their Squeak account (name, else email), as the daemon serves it (docs/ponds.md,
// "Names"). Nothing here reads the Mac's own user name, and nothing offers a rename. Pure; views only draw.

public enum PersonName {
    /// What a person is called: the account's name, else the account's email, else "Someone".
    public static func shown(_ m: FlockMember) -> String {
        let name = m.name.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { return name }
        return m.email?.trimmingCharacters(in: .whitespaces).nonEmpty ?? "Someone"
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
