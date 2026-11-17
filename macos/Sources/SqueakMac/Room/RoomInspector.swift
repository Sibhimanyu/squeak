import SqueakIcons
import SqueakMacCore
import SwiftUI

// The room's right column (draft A): People, then Ducks with role and presence; below, Invite by email and Pond controls.
// Only rows with a real setting behind them.

/// The pond inspector: one column beside both pond pages, in place while the centre slides. Its sections follow the page
/// (`PondInspectorSections`); the shared ones keep their identity and move, Ducks cross-fades.
struct RoomInspector: View {
    let key: String
    let room: PondRoomModel
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editing: DuckEdit?
    @State private var showOff = false
    @State private var adding = false
    @State private var notice: String?
    private var roster: RoomRosterModel { RoomRosterStore.shared.model(for: room.projectId) }
    @State private var email = ""
    @State private var inviting = false
    @State private var inviteLine: String?
    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { ponds.detail(key: key) }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var me: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }

    var body: some View {
        let page = RoomViewPref.shared.mode(for: key)
        let sections = PondInspectorSections.sections(for: page, canInvite: role.canInvite)
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ForEach(sections) { section in
                    view(for: section, page: page).transition(.opacity)
                        .modifier(PanFade(key: key, fades: !PondInspectorSections.shared(canInvite: role.canInvite).contains(section)))
                }
            }
            .padding(.horizontal, Space.xl).padding(.vertical, Space.xl)
            .animation(reduceMotion ? nil : Motion.standard, value: page)
        }
        .background(Theme.bg)
    }

    @ViewBuilder private func view(for section: PondInspectorSection, page: PondPage) -> some View {
        switch section {
        case .ducks: ducksList
        case .people: flock
        case .invite: invite(page: page)
        case .controls: controls
        }
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

    /// People: the pond's members with role, presence and, for those who may, role changes and removal (the Dashboard's Flock,
    /// moved here).
    private var flock: some View {
        let count = detail?.members.count ?? 1
        return VStack(alignment: .leading, spacing: 6) {
            label("People", count)
            PondFlockSection(key: key, dashboard: true, showsHeading: false)
        }
    }

    private var allDucks: [PondDuck] { roster.ducks ?? room.feed.threads.map(PondDuck.init(thread:)) }

    private var ducksList: some View {
        let r = RoomRoster.roster(allDucks, threads: room.feed.threads)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(verbatim: RoomRoster.header(r.count)).font(.system(size: 11)).foregroundStyle(Theme.subtle).padding(.horizontal, 6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button { withAnimation(Motion.standard) { adding.toggle() } } label: {
                    HStack(spacing: 4) { Lucide(.plus, size: 11, color: Theme.muted); Text("New duck").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink) }
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("New duck")
            }
            if adding {
                NewDuckForm(roster: roster, room: room, close: { withAnimation(Motion.standard) { adding = false } })
            }
            if r.count == 0 && !adding {
                Text("No ducks yet. Start one and it joins the room.").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
            }
            ForEach(r.onDuty) { d in duckRow(d) }
            if !r.offDuty.isEmpty {
                Button { withAnimation(Motion.standard) { showOff.toggle() } } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(showOff ? 90 : 0))
                        Text(verbatim: RoomRoster.offDutyLabel(r.offDuty.count)).font(.system(size: 11))
                    }
                    .foregroundStyle(Theme.subtle).padding(.horizontal, 6).padding(.top, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(RoomRoster.offDutyLabel(r.offDuty.count)).accessibilityHint(showOff ? "Collapses the list" : "Expands the list")
                if showOff { ForEach(r.offDuty) { d in duckRow(d) } }
            }
            if let e = roster.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative).padding(.horizontal, 6).padding(.top, 4) }
        }
        .task(id: room.feed.threads) {
            try? await Task.sleep(for: .milliseconds(250))
            if !Task.isCancelled { await roster.refresh(host: model.nativeHost) }
        }
        .sheet(item: $editing) { e in
            DuckEditSheet(edit: e) { text in
                let field: RoomDuckField = e.field == .name ? (RoomDucks.cleanName(text).map { .set($0) } ?? .unchanged) : (RoomDucks.cleanRole(text) ?? .unchanged)
                if field == .unchanged { return e.field == .name ? NewDuckForm.Problem.nameTooLong.rawValue : NewDuckForm.Problem.roleTooLong.rawValue }
                let action: DuckAction
                switch (e.field, field) {
                case (.name, .set(let n)): action = .rename(duck: e.duckId, name: n)
                case (_, .set(let r)): action = .setRole(duck: e.duckId, role: r)
                default: action = .setRole(duck: e.duckId, role: nil)
                }
                await roster.perform(action, host: model.nativeHost)
                return roster.error
            }
        }
    }

    private func duckRow(_ d: RosterDuck) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            DuckRow(
                duck: d, open: { open(d) },
                edit: { editing = DuckEdit(duckId: d.id, field: $0, text: $0 == .name ? d.name : (d.role ?? "")) },
                duty: { on in Task { await roster.perform(.duty(duck: d.id, on: on), host: model.nativeHost) } })
            if notice == d.id { Text(verbatim: RoomRoster.noJobLine).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.leading, 51).padding(.bottom, 4) }
        }
    }

    /// A duck's tab through the same path as a click in the room; a duck with no session opens nothing.
    private func open(_ d: RosterDuck) {
        switch RoomRoster.click(d) {
        case .noJob: notice = notice == d.id ? nil : d.id
        case .open(let sessionId):
            notice = nil
            guard model.openFromPond(.duck(sessionId), pond: key, page: .room) else { return }
            if !d.onDuty { Task { await roster.perform(.duty(duck: d.id, on: true), host: model.nativeHost) } }
        }
    }

    // MARK: Invite

    private func invite(page: PondPage) -> some View {
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
            if page == .dashboard, let pond, !pond.local { PondInvitesSection(pond: pond) }
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
    var id: String { duckId + (field == .name ? ":name" : ":role") }
    var duckId: String
    var field: Field
    var text: String
}

/// One duck in the roster: avatar, name and agent, role, place, presence. Click opens its tab; hover shows Open and
/// Close (off duty) or Bring back; the menu renames, sets a role or changes its duty.
private struct DuckRow: View {
    let duck: RosterDuck
    let open: () -> Void
    let edit: (DuckEdit.Field) -> Void
    let duty: (Bool) -> Void
    @State private var hover = false

    var body: some View {
        HStack(alignment: .center, spacing: 11) {
            DuckAvatar(sessionId: duck.colourSeed, agent: duck.agent, size: 34, off: !duck.onDuty)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: duck.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let l = duck.agentLabel { Text(verbatim: l).font(.system(size: 11)).foregroundStyle(Theme.subtle) }
                }
                if let r = duck.role { Text(verbatim: r).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                HStack(spacing: 5) {
                    switch duck.presence {
                    case .working: WorkingGlyph(slot: TideGlyph.Grid.micro.size.width, alignment: .leading, grid: .micro)
                    case .waiting: Lucide(.triangleAlert, size: 11, color: Theme.warning)
                    case .idle, .off: EmptyView()
                    }
                    Text(verbatim: duck.presenceLine).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                    if let chip = duck.placeChip {
                        Text(verbatim: chip).font(.system(size: 10)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                            .padding(.horizontal, 5).frame(height: 16).background(Theme.selected, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    }
                }
                .padding(.top, 1)
            }
            Spacer(minLength: 0)
            if hover {
                HStack(spacing: 2) {
                    if duck.hasJob { hoverButton("Open", action: open) }
                    hoverButton(duck.onDuty ? "Close" : "Bring back") { duty(!duck.onDuty) }
                }
            }
        }
        .opacity(duck.onDuty ? 1 : 0.5)
        .padding(.horizontal, 6).padding(.vertical, 7)
        .background(hover ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .onHover { hover = $0 }
        .contextMenu {
            Button("Rename\u{2026}") { edit(.name) }
            Button("Set role\u{2026}") { edit(.role) }
            Divider()
            if duck.onDuty { Button("Put off duty") { duty(false) } } else { Button("Bring on duty") { duty(true) } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(duck.name)\(duck.agentLabel.map { ", " + $0 } ?? ""). \(duck.role ?? ""). \(duck.placeChip ?? ""). \(duck.presenceLine)")
        .accessibilityHint(duck.hasJob ? "Opens the duck" : "Has no job yet")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { open() }
    }

    private func hoverButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.ink).padding(.horizontal, 7).frame(height: 22)
                .background(Theme.selectedStrong, in: RoundedRectangle(cornerRadius: 6, style: .continuous)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel("\(title) \(duck.name)")
    }
}

/// The inline New duck form: name, optional role, optional first job (posted to the room as "@name ..."), Create.
private struct NewDuckForm: View {
    typealias Problem = SqueakMacCore.NewDuckForm.Problem
    let roster: RoomRosterModel
    let room: PondRoomModel
    let close: () -> Void
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var role = ""
    @State private var job = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            field("Name", text: $name)
            field("Role (optional)", text: $role)
            field("Give it a job (optional)", text: $job)
            if let p = problem ?? roster.error { Text(verbatim: p).font(.system(size: 12)).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button("Cancel", action: close).buttonStyle(SecondaryButtonStyle())
                Button(roster.creating ? "Creating\u{2026}" : "Create", action: create).buttonStyle(SecondaryButtonStyle()).disabled(roster.creating)
            }
        }
        .padding(10)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text).textFieldStyle(.plain).font(.system(size: 13)).onSubmit(create)
            .padding(.horizontal, 10).frame(height: 30)
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
            .accessibilityLabel(placeholder)
    }

    private func create() {
        switch SqueakMacCore.NewDuckForm.validate(name: name, role: role) {
        case .failure(let p): problem = p.rawValue
        case .success(let v):
            problem = nil
            let jobText = job
            Task {
                guard let duck = await roster.create(name: v.name, role: v.role, host: model.nativeHost) else { return }
                if let text = RoomRoster.jobMessage(duckName: duck.name, text: jobText) { await room.send(text, host: model.nativeHost) }
                close()
            }
        }
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
