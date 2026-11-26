import Foundation

/// How a person belongs to a pond, as the daemon's directory says (`access` on each pond in GET /native/directory).
/// `owner`: their own pond. `remote`: someone else's ducks on someone else's Mac, no code here. `git`: own agents on their
/// own Mac (held back behind a flag). Absent: `owner` for an own pond, `remote` for a joined one, so it works before the
/// daemon sends it. Surfaces read this one value (`WorkbenchFocus.access`) and decide nothing beyond it.
public enum PondMembership: String, Sendable, Equatable, Decodable {
    case owner, remote, git

    /// Code (Changes, files, terminals, review), branch, Create PR and pickers: everything but a remote pond.
    public var showsCode: Bool { self != .remote }

    public static func resolve(_ raw: String?, isJoined: Bool) -> PondMembership {
        raw.flatMap(PondMembership.init(rawValue:)) ?? (isJoined ? .remote : .owner)
    }
}

/// Which chrome a pond shows for an access level. Pure: views feed the access (and the member's caps) in and draw what
/// comes back. A remote pond has no code on this Mac, so no Changes, files, terminals, review, branch, Create PR or
/// agent and model pickers; people, recent, messaging and (when allowed) asking the owner's Mac to start remain.
public struct PondChrome: Sendable, Equatable {
    public enum Start: Sendable, Equatable {
        /// Start a duck here, as always.
        case own
        /// A signed request to the owner's Mac; the label says so.
        case askOwner(label: String)
        case hidden
    }

    public enum Composer: Sendable, Equatable {
        /// The usual composer with its agent and model pickers.
        case full
        /// No pickers: one muted line, "Runs on <owner>'s Mac".
        case runsOnOwner(line: String)
        /// A disabled box carrying the reason.
        case disabled(reason: String)
    }

    public var access: PondMembership
    public var ownerName: String?
    /// The member's Can start Tasks: may they ask the owner's Mac to start a duck. Off, the host refuses it (a Duck that waits for approval is not built yet), so no button.
    public var canStart: Bool
    /// May they message at all, and why not (the pond view's `access { canMessage, reason }`).
    public var canMessage: Bool
    public var reason: String?

    public init(access: PondMembership, ownerName: String? = nil, canStart: Bool = true, canMessage: Bool = true, reason: String? = nil) {
        self.access = access; self.ownerName = ownerName; self.canStart = canStart; self.canMessage = canMessage; self.reason = reason
    }

    public var isRemote: Bool { access == .remote }
    /// Changes and diffs, Files, terminals and Review.
    public var showsCode: Bool { !isRemote }
    /// The branch chip and Create PR.
    public var showsBranchAndPR: Bool { !isRemote }
    public var showsAgentModelPickers: Bool { !isRemote }
    /// The inspector shows People and Recent only.
    public var inspectorPeopleRecentOnly: Bool { isRemote }
    /// "Leave pond…": anything but the person's own pond.
    public var showsLeave: Bool { access != .owner }
    /// The small label on the sidebar's pond row.
    public var badge: String? { isRemote ? "Remote" : nil }

    public var ownerMac: String {
        let n = ownerName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return "\(n.isEmpty ? "the owner" : n)\u{2019}s Mac"
    }
    public var runsOnLine: String { "Runs on \(ownerMac)" }

    public var start: Start {
        guard isRemote else { return .own }
        return canStart ? .askOwner(label: "Ask \(ownerMac) to start") : .hidden
    }

    public var composer: Composer {
        if !canMessage { return .disabled(reason: reason ?? "You can\u{2019}t message in this pond.") }
        return isRemote ? .runsOnOwner(line: runsOnLine) : .full
    }
}
