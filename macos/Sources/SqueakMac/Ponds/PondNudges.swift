import SqueakIcons
import SqueakMacCore
import SwiftUI

// The one-time help for a first Pond: the quiet "Put this on GitHub?" line in the Room. What shows is decided in
// SqueakMacCore (`PondPolish.swift`); it is gone for good once dismissed, and the choice is kept per Pond. (The Dashboard's
// "Next steps" card is gone: its three steps are the header's buttons.)
/// "Put this on GitHub?": one quiet line above the Room's composer after the first duck finished, in a folder pond.
struct GitHubLineView: View {
    let key: String
    let room: PondRoomModel
    @State private var dismissed: Bool
    @State private var ask = false
    @State private var busy = false

    init(key: String, room: PondRoomModel) {
        self.key = key; self.room = room
        _dismissed = State(initialValue: PondOnce().done(.gitHubLine, pond: key))
    }

    private var ponds: PondsModel { .shared }

    var body: some View {
        let plain = ponds.native(key: key)?.isPlainFolder == true
        let show = PondGitHubLine.shows(
            plainFolder: plain, isRemote: ponds.chrome(key: key).isRemote,
            firstDuckFinished: PondGitHubLine.firstDuckFinished(turns: room.feed.turns, tasks: room.feed.jobs), dismissed: dismissed)
        Group {
            if show {
                HStack(spacing: 10) {
                    Text(PondGitHubLine.text).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    Button(PondGitHubLine.action) { ask = true }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).pointerHand().disabled(busy)
                        .help(FirstPondJourney.gitPondHelp)
                    Button(PondGitHubLine.dismiss) { finish() }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.subtle).pointerHand()
                    if busy { ProgressView().controlSize(.small) }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Metrics.readingInset).frame(maxWidth: 740 + 2 * Metrics.readingInset).frame(maxWidth: .infinity)
                .padding(.top, Space.s)
                .accessibilityElement(children: .contain)
            }
        }
        .gitPondFlow(key: key, ask: $ask, busy: $busy, done: { finish() })
    }

    /// Acting on it or sending it away both end it: the line shows once per pond.
    private func finish() {
        PondOnce().markDone(.gitHubLine, pond: key)
        dismissed = true
    }
}
