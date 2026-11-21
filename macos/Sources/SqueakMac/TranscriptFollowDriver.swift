import SwiftUI
import SqueakMacCore

/// Hosts `TranscriptScrollFollower` inside the transcript's ScrollView content (as a `.background`), so it can find the
/// NSScrollView under it. The follow model itself is `TranscriptFollow`; see `TranscriptScrollFollower`. With a `memoryKey`
/// the chat's place is saved as it is read and put back when it is opened again (`ChatScrollMemory`).
struct TranscriptFollowDriver: NSViewRepresentable {
    var jumpToken: Int
    var holdPlace: Bool
    var memoryKey: String? = nil
    var firstRow: String? = nil
    var lastRow: String? = nil
    /// The chat was put back mid-scroll; `true` when rows arrived while it was away.
    var onPlaced: (Bool) -> Void = { _ in }
    var onFollowChange: (Bool) -> Void

    func makeNSView(context: Context) -> TranscriptScrollFollower {
        let view = TranscriptScrollFollower()
        view.onFollowChange = onFollowChange
        view.onPlaced = onPlaced
        view.memoryKey = memoryKey
        view.firstRow = firstRow
        view.lastRow = lastRow
        return view
    }

    func updateNSView(_ view: TranscriptScrollFollower, context: Context) {
        view.onFollowChange = onFollowChange
        view.onPlaced = onPlaced
        view.firstRow = firstRow
        view.lastRow = lastRow
        view.update(jumpToken: jumpToken, holdPlace: holdPlace)
    }

    static func dismantleNSView(_ view: TranscriptScrollFollower, coordinator: ()) { view.saveMemory() }
}
