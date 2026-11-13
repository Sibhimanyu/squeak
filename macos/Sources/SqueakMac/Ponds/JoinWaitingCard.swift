import SqueakMacCore
import SwiftUI

/// A join request that is waiting on an owner, or ended (declined, expired, withdrawn, removed): the same card on the New
/// pond page and when the sidebar's row is opened. The host's pond list is the only truth, and it says every state in the
/// host's own sentence; an ended request stays until Remove is pressed, so nobody waits on something that is over.
struct JoinWaitingCard: View {
    let pond: PondSummary
    /// Closes the page; the request keeps waiting.
    var onDone: () -> Void
    private var ponds: PondsModel { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(spacing: Space.m) {
                PondTile(name: pond.name, pondId: pond.id, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: pond.name).font(Typo.title).foregroundStyle(Theme.ink)
                    if pond.isWaiting { Text(verbatim: PondJoinWaiting.asked(pond)).font(Typo.footnote).foregroundStyle(Theme.muted) }
                }
            }
            PondStateCardView(pond: pond)
            if pond.isWaiting, !pond.words.isEmpty { MatchingWords(words: pond.words, hint: InviteSheetText.wordsHintJoiner(owner: pond.ownerName)) }
            if pond.isWaiting {
                Text("You can close this. The pond appears in the sidebar once you\u{2019}re approved, and Squeak tells you.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button("Done") { onDone() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
        .onAppear { ponds.note = nil }
    }
}
