import SqueakMacCore
import SwiftUI

/// Invitations waiting for this person's answer, as the sidebar's block and the Dashboard's Needs you strip. One row per
/// invitation with Join and Decline; the host's record is the only truth, so a row leaves only when the host says it is settled.
struct InvitationsBlock: View {
    var needsYou = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        let list = ponds.invitationsToAnswer
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(needsYou ? "Needs you" : "Invitations").font(needsYou ? Typo.label : Typo.meta).foregroundStyle(Theme.muted)
                    .accessibilityAddTraits(.isHeader)
                ForEach(list) { invitation in InvitationRow(invitation: invitation) }
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            }
            .padding(.horizontal, needsYou ? 0 : Space.s).padding(.vertical, Space.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        }
    }
}

private struct InvitationRow: View {
    let invitation: PondInvitation
    private var ponds: PondsModel { .shared }

    var body: some View {
        let busy = ponds.answering.contains(invitation.id)
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.s) {
                PondTile(name: invitation.pondName, pondId: invitation.pondId, size: 20)
                Text(verbatim: invitation.pondName).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
            }
            Text(verbatim: PondInvitations.line(invitation)).font(Typo.footnote).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Space.s) {
                Button(busy ? "Working\u{2026}" : "Join") { Task { await ponds.join(invitation: invitation.id) } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(busy)
                Button("Decline") { Task { await ponds.decline(invitation: invitation.id) } }
                    .buttonStyle(SecondaryButtonStyle()).disabled(busy)
            }
        }
        .padding(Space.s).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(PondInvitations.line(invitation))
    }
}
