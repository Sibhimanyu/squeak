import SqueakIcons
import SqueakMacCore
import SwiftUI

// docs/adr/0006-pond-policy.md. Pond settings gets a Permissions section for the Owner (two pickers), and the per-person
// menu gets the two overrides. What is offered, and the words, are decided in SqueakMacCore (`PondPermissions`); the
// values shown are the daemon's `policy`. This only draws and saves.

/// Pond settings, Permissions: who reaches and starts Ducks. Saved as you change, through `POST /native/ponds/<id>/policy`.
struct PondPermissionsSection: View {
    let pondId: String
    private var ponds: PondsModel { .shared }
    private var policy: PondPolicy { ponds.details[pondId]?.policy ?? .standard }
    private var busy: Bool { ponds.isBusy("policy:\(pondId)") }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: PondPermissions.heading).font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text(verbatim: PondPermissions.intro).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 4) {
                    SqueakPicker(PondPermissions.reachLabel, selection: Binding(
                        get: { policy.reachDucks }, set: { new in Task { await ponds.setPolicy(pond: pondId, reach: new) } })) {
                        SqueakOptions(PondPermissions.reachChoices) { SqueakChoice(title: PondPermissions.title($0), value: $0) }
                    }
                    Text(verbatim: PondPermissions.reachCaption).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    SqueakPicker(PondPermissions.startLabel, selection: Binding(
                        get: { policy.startDucks }, set: { new in Task { await ponds.setPolicy(pond: pondId, start: new) } })) {
                        SqueakOptions(PondPermissions.startChoices) { SqueakChoice(title: PondPermissions.title($0), value: $0) }
                    }
                    Text(verbatim: PondPermissions.startCaption).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                if let failed = ponds.note {
                    Text(verbatim: failed).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            .disabled(busy)
        }
    }
}

/// The per-person items (inside the People menu): the two overrides, each "Same as the Pond" or a value, the current one ticked.
struct PondPersonPolicyItems: View {
    let pondId: String
    let member: String
    let policy: PondEffectivePolicy?
    private var ponds: PondsModel { .shared }

    var body: some View {
        let p = policy ?? PondEffectivePolicy()
        SqueakMenu(PondPermissions.reachMenuTitle) {
            row(PondPermissions.sameAsPond, ticked: !p.customReach) { await set(reach: .set(nil)) }
            ForEach(PondPermissions.reachChoices, id: \.self) { v in
                row(PondPermissions.personTitle(v), ticked: p.customReach && p.reachDucks == v) { await set(reach: .set(v)) }
            }
        }
        SqueakMenu(PondPermissions.startMenuTitle) {
            row(PondPermissions.sameAsPond, ticked: !p.customStart) { await set(start: .set(nil)) }
            ForEach(PondPermissions.startChoices, id: \.self) { v in
                row(PondPermissions.personTitle(v), ticked: p.customStart && p.startDucks == v) { await set(start: .set(v)) }
            }
        }
    }

    private func row(_ title: String, ticked: Bool, _ act: @escaping () async -> Void) -> some View {
        Button { Task { await act() } } label: {
            HStack(spacing: 8) {
                Text(verbatim: title)
                Spacer(minLength: 12)
                Lucide(.check, size: 14, color: Theme.ink).opacity(ticked ? 1 : 0)
            }
        }
        .accessibilityAddTraits(ticked ? .isSelected : [])
    }

    private func set(reach: PondOverrideChange<ReachDucks> = .keep, start: PondOverrideChange<StartDucks> = .keep) async {
        await ponds.setOverride(pond: pondId, member: member, reach: reach, start: start)
    }
}
