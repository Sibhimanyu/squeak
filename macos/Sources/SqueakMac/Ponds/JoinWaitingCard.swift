import SqueakMacCore
import SwiftUI

/// A join request that is waiting on an owner, or was declined: the same card on the New pond page and when the
/// sidebar's greyed row is opened. The host's pond list is the only truth (`PondJoinWaiting`).
struct JoinWaitingCard: View {
    let pond: PondSummary
    /// Closes the page; the request keeps waiting.
    var onDone: () -> Void
    @State private var busy = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(spacing: Space.m) {
                PondTile(name: pond.name, pondId: pond.id, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: pond.name).font(Typo.title).foregroundStyle(Theme.ink)
                    Text(verbatim: PondJoinWaiting.asked(pond)).font(Typo.footnote).foregroundStyle(Theme.muted)
                }
            }
            if pond.isDeclined {
                Text(verbatim: PondJoinWaiting.declinedNote).font(Typo.label).foregroundStyle(Theme.ink)
                Text("The owner can send you a new invite.").font(Typo.body).foregroundStyle(Theme.muted)
            } else {
                // WorkingGlyph holds still when the window is inactive and under Reduce Motion (DESIGN.md motion rules).
                HStack(spacing: Space.s) {
                    WorkingGlyph(width: 20, height: 15)
                    Text("Waiting for the owner to approve").font(Typo.label).foregroundStyle(Theme.ink)
                }
                Text("You can close this. The pond appears in the sidebar once you\u{2019}re approved, and Squeak tells you.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button(pond.isDeclined ? "Remove" : (busy ? "Cancelling\u{2026}" : "Cancel request")) {
                    busy = true
                    Task { await ponds.cancelJoin(pond: pond.id); busy = false; onDone() }
                }
                .buttonStyle(SecondaryButtonStyle()).disabled(busy)
                Button("Done") { onDone() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
    }
}
