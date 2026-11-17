import Foundation

/// Stashed mode (docs/ponds.md): a member runs their own agent on their own Mac. The daemon says whether it is on
/// (`pondOwnThreads` in the pond directory, `SQUEAK_POND_OWN_THREADS`); every surface hides by that data, never by a
/// constant. A host that does not say is an older one, which still has the mode.
public enum PondOwnThreads {
    public static func enabled(_ hostSays: Bool?) -> Bool { hostSays ?? true }

    /// The pond as this Mac may use it: in a pond someone else owns, with the mode off, this Mac cannot start here, so the
    /// only start is "Runs on <owner>'s Mac" (a signed request).
    public static func adjusted(_ pond: PondSummary, ownThreads: Bool) -> PondSummary {
        guard !ownThreads, PondSharing.isSharedWithMe(pond) else { return pond }
        var p = pond
        p.canStartHere = false
        return p
    }

    public static func adjusted(_ ponds: [PondSummary], ownThreads: Bool) -> [PondSummary] {
        ownThreads ? ponds : ponds.map { adjusted($0, ownThreads: false) }
    }

    /// Whether a new thread in this pond may offer "on my Mac": always in a pond of mine, in someone else's only with the mode on.
    public static func offersMyMac(_ pond: PondSummary, ownThreads: Bool) -> Bool {
        ownThreads || !PondSharing.isSharedWithMe(pond)
    }

    /// "Powered by <their Mac> \u{00B7} Flotilla" only with the mode on; nil hides the mark.
    public static func poweredBy(nest: String?, ownThreads: Bool) -> String? {
        ownThreads ? PondPresets.poweredBy(nest: nest) : nil
    }
}
