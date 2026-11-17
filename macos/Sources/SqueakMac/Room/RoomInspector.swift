import SqueakIcons
import SqueakMacCore
import SwiftUI

// The room's right column: Flock, Invite by email, Today, Pond controls. Only rows with a real setting behind them.

struct RoomInspector: View {
    let key: String
    let today: RoomSummary.Today
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var inviting = false
    @State private var inviteLine: String?
    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { ponds.detail(key: key) }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var me: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                flock
                if role.canInvite { invite }
                todayTiles
                controls
            }
            .padding(.horizontal, Space.xl).padding(.vertical, Space.xl)
        }
        .background(Theme.bg)
    }

    private func heading(_ t: String, trailing: String? = nil) -> some View {
        HStack {
            Text(verbatim: t).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            if let trailing { Text(verbatim: trailing).font(.system(size: 12)).foregroundStyle(Theme.subtle) }
        }
    }

    // MARK: Flock

    private var flock: some View {
        let presence = detail?.presence ?? []
        let members = detail.map { PondFlock.ordered($0.members, presence: presence) }
            ?? [FlockMember(id: "me", name: me, role: .owner, nest: "This Mac", online: true, you: true)]
        let waiting = PondInvites.rows(detail?.invites ?? [], now: Date()).filter(\.pending)
        let offline = ponds.freshness(pond).isProblem
        return VStack(alignment: .leading, spacing: 12) {
            heading("Flock", trailing: members.count == 1 ? "1 person" : "\(members.count) people")
            ForEach(members) { m in
                let online = PondFlock.isOnline(m, presence: presence) && !offline
                let seen = detail.flatMap { PondMembers.seen(m, presence: presence, threads: $0.threads, pondOffline: offline, now: Date()) }
                HStack(spacing: 10) {
                    FlockAvatar(member: m, online: online, size: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            Text(verbatim: m.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                            if m.you { Text("(you)").font(.system(size: 14)).foregroundStyle(Theme.muted) }
                        }
                        Text(verbatim: [PondMembers.chip(m), m.you ? "on this Mac" : seen].compactMap { $0 }.joined(separator: " \u{00B7} "))
                            .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(waiting) { r in
                HStack(spacing: 10) {
                    Text(verbatim: String(r.title.prefix(2)).uppercased()).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                        .frame(width: 32, height: 32).background(Theme.selected, in: Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: r.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                        Text("Invited \u{00B7} waiting").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Invite

    private var invite: some View {
        VStack(alignment: .leading, spacing: 10) {
            heading("Invite")
            HStack(spacing: 8) {
                Image(systemName: "envelope").font(.system(size: 12)).foregroundStyle(Theme.muted)
                TextField("Email address", text: $email).textFieldStyle(.plain).font(.system(size: 14)).onSubmit(send)
                    .accessibilityLabel("Email address to invite")
            }
            .padding(.horizontal, 12).frame(height: 36)
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
            HStack(alignment: .top, spacing: 10) {
                Text(verbatim: inviteLine ?? "Members can start threads and answer.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(inviting ? "Inviting\u{2026}" : "Invite", action: send).buttonStyle(SecondaryButtonStyle())
                    .disabled(inviting || !(pond.map { ponds.freshness($0).canWrite } ?? true))
            }
        }
    }

    /// A valid address goes out as an email invite (the same call as the invite sheet); anything else opens the sheet.
    private func send() {
        guard let pond else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        guard EmailAddress.isValid(address), !pond.local, model.account.state?.linked == true else {
            ponds.startInvite(pondId: pond.id, account: model.account)
            return
        }
        inviting = true
        Task {
            let result = await ponds.inviteByEmail(pond: pond.id, emails: [address], role: .member)
            inviting = false
            if let result, result.failed.isEmpty { inviteLine = "Invite sent to \(address)."; email = "" }
            else if let f = result?.failed.first { inviteLine = f.reason }
            else { inviteLine = ponds.note ?? "The invite did not go. Try again." }
        }
    }

    // MARK: Today and controls

    private var todayTiles: some View {
        VStack(alignment: .leading, spacing: 10) {
            heading("Today")
            HStack(spacing: 8) {
                tile(today.turns, "turns"); tile(today.files, "files"); tile(today.threads, "threads")
            }
        }
    }

    private func tile(_ n: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(n)").font(.system(size: 20, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.ink)
            Text(verbatim: label).font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .accessibilityElement(children: .ignore).accessibilityLabel("\(n) \(label) today")
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Pond controls").padding(.bottom, 6)
            controlRow("Pond colour", value: ponds.native(key: key)?.colour?.capitalized ?? "Automatic", swatch: PondColour.tint(pond?.id))
            controlRow("All pond settings", value: nil, swatch: nil)
        }
    }

    private func controlRow(_ title: String, value: String?, swatch: Color?) -> some View {
        Button { ponds.route = .settings(project: key) } label: {
            HStack(spacing: 8) {
                Text(verbatim: title).font(.system(size: 14)).foregroundStyle(Theme.muted)
                Spacer()
                if let swatch { RoundedRectangle(cornerRadius: 3).fill(swatch).frame(width: 12, height: 12) }
                if let value { Text(verbatim: value).font(.system(size: 14)).foregroundStyle(Theme.ink) }
                else { Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.subtle) }
            }
            .frame(height: 38).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
        .accessibilityLabel(value.map { "\(title), \($0)" } ?? title).accessibilityHint("Opens pond settings")
    }
}
