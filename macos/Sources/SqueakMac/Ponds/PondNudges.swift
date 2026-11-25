import SqueakIcons
import SqueakMacCore
import SwiftUI

// Two one-time helps for a first Pond, the same in the old and the new layout: the "Next steps" card on the Dashboard and
// the quiet "Put this on GitHub?" line in the Room. What shows is decided in SqueakMacCore (`PondPolish.swift`); each is
// gone for good once dismissed, and the choice is kept per Pond.

/// The Dashboard's card: Start a duck, Invite someone, Put it on GitHub (folder ponds only).
struct PondNextStepsCard: View {
    let key: String
    let steps: PondNextSteps.Steps
    let startDuck: () -> Void
    let invite: () -> Void
    let dismiss: () -> Void
    @State private var askGitHub = false
    @State private var gitHubBusy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(PondNextSteps.title).font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 24, height: 24).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted).pointerHand()
                    .help("Dismiss. This will not come back.").accessibilityLabel(PondNextSteps.dismiss)
            }
            HStack(spacing: 10) {
                if steps.startDuck { Button(PondNextSteps.startDuck, action: startDuck).buttonStyle(SecondaryButtonStyle()) }
                if steps.invite { Button(PondNextSteps.invite, action: invite).buttonStyle(SecondaryButtonStyle()) }
                if steps.gitHub {
                    Button(PondNextSteps.gitHub) { askGitHub = true }
                        .buttonStyle(SecondaryButtonStyle()).disabled(gitHubBusy).help(FirstPondJourney.gitPondHelp)
                    if gitHubBusy { ProgressView().controlSize(.small) }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .contain).accessibilityLabel(PondNextSteps.title)
        .gitPondFlow(key: key, ask: $askGitHub, busy: $gitHubBusy)
    }
}

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
