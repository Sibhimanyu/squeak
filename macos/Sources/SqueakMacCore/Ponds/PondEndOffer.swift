import Foundation

// What the daemon's PondEnding module offers for a Pond (docs/ponds.md, "Ending a Pond"): Delete, Leave or Remove, in the
// words to draw. The daemon alone decides local versus shared; a view only draws what is here and sends `end(kind:)`.

public enum PondEndKind: String, Sendable, Equatable, Decodable { case delete, leave, forget }

public struct PondEndWords: Sendable, Equatable, Decodable {
    /// The sidebar and settings menu item, with its ellipsis: "Delete Pond…", "Leave Pond…".
    public var menu: String
    public var title: String
    public var message: String
    /// The destructive button of the confirm dialog.
    public var button: String

    public init(menu: String, title: String, message: String, button: String) {
        self.menu = menu; self.title = title; self.message = message; self.button = button
    }
}

public struct PondEndOffer: Sendable, Equatable, Decodable {
    public var primary: PondEndKind
    public var words: PondEndWords
    /// A sentence when it cannot be done right now (the cloud cannot be reached); drawn instead of the button.
    public var blockedBy: String?

    enum CodingKeys: String, CodingKey { case primary, words, blockedBy }

    public init(primary: PondEndKind, words: PondEndWords, blockedBy: String? = nil) {
        self.primary = primary; self.words = words; self.blockedBy = blockedBy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let raw = c.lenient(String.self, .primary), let primary = PondEndKind(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .primary, in: c, debugDescription: "unknown end")
        }
        self.primary = primary
        words = try c.decode(PondEndWords.self, forKey: .words)
        blockedBy = c.lenient(String.self, .blockedBy).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// An end that has not finished: "Deleting…", or "Couldn't finish deleting Alpha." with the daemon's reason and Try again.
public struct PondEndingProgress: Sendable, Equatable, Decodable {
    public var kind: PondEndKind
    public var line: String
    public var failed: String?
}

/// The three states of sharing, as the daemon computes them.
public enum PondSharingState: String, Sendable, Equatable { case local, sharing, shared }

extension PondSummary {
    /// `local` until a share starts, `sharing` while one is unfinished, `shared` after; an older host's rows read by `local`.
    public var sharingState: PondSharingState {
        sharing.flatMap(PondSharingState.init(rawValue:)) ?? (local ? .local : .shared)
    }

    /// What may be done to end this Pond, as the daemon words it. An older host sends none: the same words are made from
    /// the role, so nothing is missing (the host in the app always sends it).
    public var endOffering: PondEndOffer {
        if let endOffer { return endOffer }
        if state.isTerminal || state == .pending {
            return PondEndOffer(primary: .forget, words: PondEndWords(menu: "Remove Pond\u{2026}", title: "Remove \(name)?", message: "It leaves your list.", button: "Remove"))
        }
        if role == .owner {
            if local {
                return PondEndOffer(primary: .delete, words: PondEndWords(
                    menu: "Remove from Squeak\u{2026}", title: "Remove \(name) from Squeak?",
                    message: "Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.", button: "Remove from Squeak"))
            }
            return PondEndOffer(primary: .delete, words: PondEndWords(
                menu: "Delete Pond\u{2026}", title: "Delete \(name) for everyone?",
                message: PondActionWords.deleteMessage(name, others: max(0, memberCount - 1)), button: "Delete for everyone"))
        }
        return PondEndOffer(primary: .leave, words: PondEndWords(
            menu: "Leave Pond\u{2026}", title: "Leave \(name)?",
            message: PondActionWords.leaveMessage(name, owner: ownerName), button: "Leave"))
    }

    /// Invite is on every Pond this person owns, a local one with no Ducks included (the invite shares it first). `detailRole` is
    /// the role the Pond's page says; before it is read the row's own role answers.
    public func mayInvite(detailRole: PondRole?) -> Bool { PondCan(role: detailRole ?? role).allows(.invite) }
}
