import Foundation

/// A Pond waiting on the invitee side (an invite not yet accepted, or ended), as the sidebar reads it. Pure: the host's
/// pond list (`status`: pending, active, denied) is the only truth.
public enum PondJoinWaiting {
    public static let waitingNote = "Waiting for approval"
    public static let declinedNote = "Your request was declined"

    /// The sidebar's greyed rows: requests still waiting and ones the owner declined.
    public static func rows(_ ponds: [PondSummary]) -> [PondSummary] { ponds.filter(PondStates.isGreyedRow) }

    public static func rowTitle(_ pond: PondSummary) -> String {
        pond.isWaiting || pond.isDeclined ? "\(pond.name) \u{00B7} \(pond.isDeclined ? declinedNote : waitingNote)" : PondStates.rowTitle(pond)
    }

    /// Ponds that were waiting in `old` and are active in `new` (the notifications now come from `PondNotes.joiner`).
    public static func approved(old: [PondSummary], new: [PondSummary]) -> [PondSummary] {
        let waiting = Set(old.filter(\.isWaiting).map(\.id))
        return new.filter { waiting.contains($0.id) && $0.status == "active" }
    }
}
