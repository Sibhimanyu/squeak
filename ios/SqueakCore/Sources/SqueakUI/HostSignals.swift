#if os(iOS)
import Foundation
import SqueakCore

/// What the screens tell the host app (which owns Heresay): who is signed in, and when the app sees trouble itself.
/// The host sets the closures once at launch; nothing here knows about Heresay.
@MainActor
public enum HostSignals {
    /// Signed in (email, name) or signed out (nil, nil). Set after the account is known, it is called at once with it.
    public static var onAccount: ((_ email: String?, _ name: String?) -> Void)? {
        didSet { if current.email != nil { onAccount?(current.email, current.name) } }
    }
    /// The app saw trouble itself: a command failed or timed out, the Mac stayed unreachable, sign-in failed.
    public static var onTrouble: (() -> Void)?

    private static var current: (email: String?, name: String?) = (nil, nil)

    static func account(email: String?, name: String?) {
        current = (email, name)
        onAccount?(email, name)
    }

    static func trouble() { onTrouble?() }
}
#endif
