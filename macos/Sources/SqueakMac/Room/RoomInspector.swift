import SqueakIcons
import SqueakMacCore
import SwiftUI

// The room's right column (draft A): People, then Ducks with role and presence; below, Invite by email and Pond controls.
// Only rows with a real setting behind them.

struct RoomInspector: View {
    let key: String
    let room: PondRoomModel
    @Environment(AppModel.self) private var model
    @State private var editing: DuckEdit?
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
                ducksList
                if role.canInvite { invite }
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

    // MARK: People and ducks

    private func label(_ t: String, _ n: Int) -> some View {
        Text(verbatim: "\(t) \u{00B7} \(n)").font(.system(size: 11)).foregroundStyle(Theme.subtle).padding(.horizontal, 6)
            .accessibilityAddTraits(.isHeader)
    }

    private var flock: some View {
        let presence = detail?.presence ?? []
        let members = detail.map { PondFlock.ordered($0.members, presence: presence) }
            ?? [FlockMember(id: "me", name: me, role: .owner, nest: "This Mac", online: true, you: true)]
        let waiting = PondInvites.rows(detail?.invites ?? [], now: Date()).filter(\.pending)
        let offline = ponds.freshness(pond).isProblem
        return VStack(alignment: .leading, spacing: 4) {
            label("People", members.count)
            ForEach(members) { m in
                let online = PondFlock.isOnline(m, presence: presence) && !offline
                HStack(spacing: 11) {
                    PersonAvatar(name: m.name, size: 34)
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: m.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            if m.you { Text("You").font(.system(size: 11)).foregroundStyle(Theme.subtle) }
                        }
                        Text(verbatim: m.you ? PondMembers.chip(m) : [PondMembers.chip(m), online ? "online" : nil].compactMap { $0 }.joined(separator: " \u{00B7} "))
                            .font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 7)
                .accessibilityElement(children: .combine)
            }
            ForEach(waiting) { r in
                HStack(spacing: 11) {
                    PersonAvatar(name: r.title, size: 34)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(verbatim: r.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                        Text("Invited \u{00B7} waiting").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 7)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var ducksList: some View {
        let ducks = RoomDucks.roster(room.feed.threads)
        return VStack(alignment: .leading, spacing: 4) {
            label("Ducks", ducks.count)
            if ducks.isEmpty {
                Text("No ducks yet. Start one and it joins the room.").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
            }
            ForEach(ducks) { d in DuckRow(duck: d, open: { openDuck(d.sessionId) }, edit: { editing = DuckEdit(sessionId: d.sessionId, field: $0, text: $0 == .name ? d.name : (d.role ?? "")) },
                                          duty: { on in Task { await room.setDuty(sessionId: d.sessionId, on: on, host: model.nativeHost) } }) }
        }
        .sheet(item: $editing) { e in
            DuckEditSheet(edit: e) { text in
                let field: RoomDuckField = e.field == .name ? (RoomDucks.cleanName(text).map { .set($0) } ?? .unchanged) : (RoomDucks.cleanRole(text) ?? .unchanged)
                if field == .unchanged { return "That is too long." }
                return await room.edit(sessionId: e.sessionId, name: e.field == .name ? field : .unchanged, role: e.field == .role ? field : .unchanged, host: model.nativeHost)
            }
        }
    }

    private func openDuck(_ sessionId: String) {
        guard let s = model.pondDuckSession(sessionId), model.openFromPond(.duck(s.key.hostSessionId), pond: key, page: .room) else { return }
        if room.feed.threads.first(where: { $0.sessionId == s.key.hostSessionId })?.onDuty == false {
            Task { await room.setDuty(sessionId: s.key.hostSessionId, on: true, host: model.nativeHost) }
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

    // MARK: Controls

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

/// The right zone while the room shows: a header-height strip (room for the pane toggle), then the room inspector.
struct RoomRightColumn: View {
    let projectId: String
    let key: String
    let width: CGFloat

    var body: some View {
        let room = PondRoomStore.shared.model(for: projectId)
        VStack(spacing: 0) {
            Color.clear.frame(height: Metrics.header).background(WindowDragArea())
            RoomInspector(key: key, room: room)
        }
        .frame(width: width).frame(maxHeight: .infinity).clipped()
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }
}

struct DuckEdit: Identifiable {
    enum Field { case name, role }
    var id: String { sessionId + (field == .name ? ":name" : ":role") }
    var sessionId: String
    var field: Field
    var text: String
}

/// One duck in the roster: avatar, name and agent, role, presence. Click opens its tab; the menu renames, sets a role or
/// changes its duty.
private struct DuckRow: View {
    let duck: RoomDuck
    let open: () -> Void
    let edit: (DuckEdit.Field) -> Void
    let duty: (Bool) -> Void
    @State private var hover = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: 11) {
                DuckAvatar(sessionId: duck.sessionId, agent: duck.agent, size: 34, off: !duck.onDuty)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: duck.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        if let l = duck.agentLabel { Text(verbatim: l).font(.system(size: 11)).foregroundStyle(Theme.subtle) }
                    }
                    if let r = duck.roleLine { Text(verbatim: r).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                    HStack(spacing: 5) {
                        switch duck.presence {
                        case .working: WorkingGlyph(slot: TideGlyph.Grid.micro.size.width, alignment: .leading, grid: .micro)
                        case .waiting: Lucide(.triangleAlert, size: 11, color: Theme.warning)
                        case .idle, .off: EmptyView()
                        }
                        Text(verbatim: duck.presenceLine).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                    }
                    .padding(.top, 1)
                }
                Spacer(minLength: 0)
            }
            .opacity(duck.onDuty ? 1 : 0.5)
            .padding(.horizontal, 6).padding(.vertical, 7)
            .background(hover ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hover = $0 }
        .contextMenu {
            Button("Rename\u{2026}") { edit(.name) }
            Button("Set role\u{2026}") { edit(.role) }
            Divider()
            if duck.onDuty { Button("Put off duty") { duty(false) } } else { Button("Bring on duty") { duty(true) } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(duck.name)\(duck.agentLabel.map { ", " + $0 } ?? ""). \(duck.roleLine ?? ""). \(duck.presenceLine)")
        .accessibilityHint("Opens the duck")
    }
}

/// Rename a duck or set its role: one field, Save sends it (`PATCH .../duck`), a refusal shows under it.
private struct DuckEditSheet: View {
    let edit: DuckEdit
    let save: (String) async -> String?
    @State private var text: String
    @State private var problem: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(edit: DuckEdit, save: @escaping (String) async -> String?) {
        self.edit = edit; self.save = save; _text = State(initialValue: edit.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(edit.field == .name ? "Rename duck" : "Set role").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
            TextField(edit.field == .name ? "Name" : "One line, like \u{201C}Layout builder\u{201D}", text: $text).textFieldStyle(.plain).font(.system(size: 14)).onSubmit(go)
                .padding(.horizontal, 12).frame(height: 36)
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
            if let p = problem { Text(verbatim: p).font(.system(size: 12)).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle())
                Button(saving ? "Saving\u{2026}" : "Save", action: go).buttonStyle(SecondaryButtonStyle()).disabled(saving)
            }
        }
        .padding(20).frame(width: 340).background(Theme.bg)
    }

    private func go() {
        saving = true
        Task {
            let r = await save(text)
            saving = false
            if let r { problem = r } else { dismiss() }
        }
    }
}
