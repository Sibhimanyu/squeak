import SwiftUI
import SqueakMacCore

/// Hosts `TranscriptScrollFollower` inside the transcript's ScrollView content (as a `.background`), so it can find the
/// NSScrollView under it. The follow model itself is `TranscriptFollow`; see `TranscriptScrollFollower`.
struct TranscriptFollowDriver: NSViewRepresentable {
    var jumpToken: Int
    var holdPlace: Bool
    var onFollowChange: (Bool) -> Void

    func makeNSView(context: Context) -> TranscriptScrollFollower {
        let view = TranscriptScrollFollower()
        view.onFollowChange = onFollowChange
        return view
    }

    func updateNSView(_ view: TranscriptScrollFollower, context: Context) {
        view.onFollowChange = onFollowChange
        view.update(jumpToken: jumpToken, holdPlace: holdPlace)
    }
}
