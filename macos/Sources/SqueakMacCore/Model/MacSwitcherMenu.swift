import Foundation

/// What the sidebar's "<Name>'s Mac" menu offers, decided here so the view only draws.
/// Top: the account (or a way to sign in) or, when Squeak's service is down, one warning row with Restart.
/// Connected is never an item: the connection only speaks up when something is wrong.
public enum MacSwitcherMenu {
    public enum Item: Equatable, Sendable {
        /// Signed in: initial avatar and email; opens Settings › Account.
        case account(email: String, initial: String)
        /// Signed out with a cloud: starts the sign-in session directly.
        case signIn
        /// Signed out and the daemon has no cloud to sign in to: opens Settings › Account.
        case signInInSettings
        /// The service is not running: one warning row; Restart repairs it.
        case serviceDown
        case usage
        case divider
        case settings
    }

    public static func items(signedInEmail: String?, cloudAvailable: Bool, daemonHealthy: Bool) -> [Item] {
        var out: [Item] = []
        if !daemonHealthy { out.append(.serviceDown) }
        if let email = signedInEmail, !email.isEmpty {
            out.append(.account(email: email, initial: initial(of: email)))
        } else {
            out.append(cloudAvailable ? .signIn : .signInInSettings)
        }
        out += [.usage, .divider, .settings]
        return out
    }

    public static let serviceDownTitle = "Squeak's service isn't running"

    public static func initial(of email: String) -> String {
        email.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"
    }

    /// The popover is for the problem only.
    public static func showsConnectionPopover(daemonHealthy: Bool) -> Bool { !daemonHealthy }
}
