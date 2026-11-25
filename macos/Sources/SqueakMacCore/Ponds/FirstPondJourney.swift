import Foundation

/// The words and small decisions of a newcomer's first Pond: what the empty screens say to do next, and which
/// "next step" items the Pond's own more-menu offers so Invite and "Make it a Git Pond" are findable from the Pond itself
/// (not only in Pond settings). Pure; views draw what comes back.
public enum FirstPondJourney {
    // MARK: Empty states

    /// The Dashboard with no pond at all.
    public static let noPondsTitle = "Start with a pond"
    public static let noPondsDetail = "A pond is a folder on this Mac that you and your ducks work in. Make a new one, choose a folder you already have, or clone a repository."

    /// The Pond's own page before its first duck: say what to do next and what comes after.
    public static func emptyPondDetail(plainFolder: Bool) -> String {
        plainFolder
            ? "Start a duck to work with an agent in this folder. Its conversations will live here. Put the pond on GitHub any time from the \u{22EF} menu."
            : "Start a duck to work with an agent. Its streams and conversations will live here. Give out more work from the Room."
    }

    /// The Room before anyone has said anything: how work gets handed out.
    public static let emptyRoom = "Say what you want done, then choose \u{201C}Make task\u{201D} under your latest message to hand it to a duck. Or start a duck yourself. What the ducks do shows up here."

    // MARK: New pond choices

    /// The line under a choice on the New pond page: where the pond lives, and that publishing can wait.
    public static func choiceNote(_ kind: NewPondKind, blankPath: String?) -> String? {
        switch kind {
        case .blank:
            return (blankPath.map { "Makes the folder \($0)." } ?? "Makes a folder in ~/Squeak with that name.")
                + " It stays on this Mac; put it on GitHub later from the pond\u{2019}s \u{22EF} menu."
        case .folder: return "Your files stay where they are. Git is not needed."
        case .clone, .invite: return nil
        }
    }

    // MARK: The pond's menu

    public static let inviteItem = "Invite someone\u{2026}"
    public static let gitPondItem = "Make it a Git Pond\u{2026}"
    public static let gitPondHelp = "Put this folder on GitHub and give the pond streams"

    public struct MenuOffer: Equatable, Sendable {
        public var invite: Bool
        public var gitPond: Bool
    }

    /// `canInvite`: the person's role may invite (the owner). `hasPond`: the directory knows the pond (an invite needs it).
    /// `plainFolder`: this Mac's project is a plain folder. Only the owner on their own Mac can publish it.
    public static func menuOffer(canInvite: Bool, hasPond: Bool, plainFolder: Bool, isRemote: Bool) -> MenuOffer {
        MenuOffer(invite: canInvite && hasPond && !isRemote, gitPond: plainFolder && !isRemote)
    }

    // MARK: After "Make it a Git Pond" from the menu

    public static let gitPondDoneTitle = "It is a Git Pond"
    public static let gitPondFailedTitle = "Could not make it a Git Pond"
}
