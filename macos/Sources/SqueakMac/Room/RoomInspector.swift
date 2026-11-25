import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond inspector: what needs the person, the ducks, the people. Settings (colour, invites) live in the header's
// "Pond settings\u{2026}" sheet, not here.

/// The pond inspector: one column beside both pond pages, in place while the centre slides. Both pages show the same
/// sections in the same order (`PondInspectorSections`), so nothing fades or moves with the page.
struct RoomInspector: View {
    let key: String
    let room: PondRoomModel
    @Environment(AppModel.self) private var model
    @State private var editing: DuckEdit?
    @State private var search = ""
    @State private var adding = false
    @State private var offDutyOpen = false
    @State private var notice: String?
    @State private var noticeLine = RoomRoster.noJobLine
    private var roster: RoomRosterModel { RoomRosterStore.shared.model(for: room.projectId) }
    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { ponds.detail(key: key) }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var me: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }

    var body: some View {
        let needs = PondInspectorSections.needsYou(room.feed.threads)
        let sections = PondInspectorSections.sections(needsYou: needs.count, ducks: allDucks.count)
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ForEach(sections) { section in
                    view(for: section, needs: needs)
                }
            }
            .padding(.horizontal, Space.xl).padding(.vertical, Space.xl)
        }
        .background(Theme.bg)
    }

    @ViewBuilder private func view(for section: PondInspectorSection, needs: [InspectorNeedsYouRow]) -> some View {
        switch section {
        case .needsYou: needsYou(needs)
        case .ducks: ducksList
        case .people: flock
        }
    }

    /// Needs you: one row per duck waiting on the person (the amber triangle is the only colour); a click opens its tab.
    private func needsYou(_ rows: [InspectorNeedsYouRow]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label("Needs you", rows.count)
            ForEach(rows) { r in
                Button {
                    _ = model.openFromPond(.duck(r.sessionId), pond: key, page: .room)
                } label: {
                    HStack(spacing: 11) {
                        DuckAvatar(sessionId: r.colourSeed, agent: r.agent, size: 30, off: false)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: r.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: r.text).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        Lucide(.triangleAlert, size: 12, color: Theme.warning)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 7).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(r.name), \(r.text)").accessibilityHint("Opens the duck")
            }
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
            HStack {
                label("People", count)
                Spacer()
                if role.canInvite, let pond {
                    Button("Invite") { ponds.startInvite(pondId: pond.id, account: model.account) }
                        .buttonStyle(SecondaryButtonStyle()).controlSize(.small)
                        .disabled(!ponds.freshness(pond).canWrite)
                        .help(ponds.freshness(pond).writesDisabledReason ?? "Invite someone to this pond")
                }
            }
            PondFlockSection(key: key, dashboard: true, showsHeading: false)
        }
    }

    private var allDucks: [PondDuck] { roster.ducks ?? room.feed.threads.map(PondDuck.init(thread:)) }

    private var ducksList: some View {
        let all = RoomRoster.roster(allDucks, threads: room.feed.threads)
        let rows = RoomRoster.visible(allDucks, threads: room.feed.threads, query: search)
        let searching = !search.trimmingCharacters(in: .whitespaces).isEmpty
        let offDuty = RoomRoster.offDutyGroup(allDucks, threads: room.feed.threads)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(verbatim: RoomRoster.header(all.available.count)).font(.system(size: 11)).foregroundStyle(Theme.subtle).padding(.horizontal, 6)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button { withAnimation(Motion.standard) { adding.toggle() } } label: {
                    HStack(spacing: 4) { Lucide(.plus, size: 11, color: Theme.muted); Text("New duck").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink) }
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("New duck")
            }
            if all.count > 0 {
                HStack(spacing: 6) {
                    Lucide(.search, size: 11, color: Theme.subtle)
                    TextField(RoomRoster.searchPrompt, text: $search).textFieldStyle(.plain).font(.system(size: 12))
                        .accessibilityLabel(RoomRoster.searchPrompt)
                }
                .padding(.horizontal, 8).frame(height: 26)
                .background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .padding(.horizontal, 2)
            }
            if adding {
                NewDuckForm(roster: roster, room: room, close: { withAnimation(Motion.standard) { adding = false } })
            }
            if all.count == 0 && !adding {
                Text("No ducks yet. Start one and it joins the room.").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
            } else if searching && rows.isEmpty {
                Text(verbatim: RoomRoster.noMatchLine(search)).font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
            } else if !searching && rows.isEmpty && !adding {
                Text(RoomRoster.noneOnDutyLine).font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 6)
            }
            ForEach(rows) { d in duckRow(d) }
            if !searching, !offDuty.rows.isEmpty { offDutyGroup(offDuty) }
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

    /// "Off duty - N", collapsed: the recent ones with Bring back, then a line pointing at the search for the rest.
    @ViewBuilder
    private func offDutyGroup(_ g: (rows: [RosterDuck], more: Int)) -> some View {
        let total = g.rows.count + g.more
        Button { withAnimation(Motion.standard) { offDutyOpen.toggle() } } label: {
            HStack(spacing: 6) {
                Lucide(.chevronRight, size: 11, color: Theme.subtle).rotationEffect(.degrees(offDutyOpen ? 90 : 0))
                Text(verbatim: RoomRoster.offDutyLabel(total)).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6).frame(height: 24).contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.top, 4)
        .accessibilityLabel(RoomRoster.offDutyLabel(total)).accessibilityValue(offDutyOpen ? "expanded" : "collapsed")
        if offDutyOpen {
            ForEach(g.rows) { d in duckRow(d) }
            if g.more > 0 { Text(verbatim: RoomRoster.offDutyMoreLine(g.more)).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.horizontal, 6) }
        }
    }

    private func duckRow(_ d: RosterDuck) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            DuckRow(
                duck: d, open: { open(d) },
                edit: { editing = DuckEdit(duckId: d.id, field: $0, text: $0 == .name ? d.name : (d.role ?? "")) },
                duty: { on in
                    Task {
                        await roster.perform(.duty(duck: d.id, on: on), host: model.nativeHost)
                        if on, roster.error == nil { search = "" }
                    }
                })
            if notice == d.id { Text(verbatim: noticeLine).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.leading, 51).padding(.bottom, 4) }
        }
    }

    /// A duck's tab through the same path as a click in the room; the row and its hover Open both land here. A duck with no
    /// session, or whose chat the app cannot find, says so inline instead of doing nothing.
    private func open(_ d: RosterDuck) {
        let known = model.allSessions.filter { $0.source == .squeak }.map { NativeAdapter.nativeId($0) ?? $0.key.hostSessionId }
        switch RoomRoster.opening(d, known: known) {
        case .noJob(let line): show(line, for: d)
        case .failed(let line): show(line, for: d)
        case .open(let sessionId):
            notice = nil
            guard model.openFromPond(.duck(sessionId), pond: key, page: .room) else { show(PondOpenResolver.failureNote(name: d.name), for: d); return }
            if !d.onDuty { Task { await roster.perform(.duty(duck: d.id, on: true), host: model.nativeHost) } }
        }
    }

    private func show(_ line: String, for d: RosterDuck) {
        noticeLine = line
        notice = d.id
        Task { try? await Task.sleep(for: .seconds(4)); if notice == d.id { notice = nil } }
    }
}

/// The right zone while a pond page shows: the always-there tab strip (Pond pinned first), then the selected tab.
struct RoomRightColumn: View {
    let projectId: String
    let key: String
    let width: CGFloat

    var body: some View { PondInspectorZone(projectId: projectId, key: key, width: width) }
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
        HStack(alignment: .center, spacing: 0) {
            Button(action: open) { info.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("\(duck.heading)\(duck.agentLabel.map { ", " + $0 } ?? ""). \(duck.role ?? ""). \(duck.placeChip ?? ""). \(duck.presenceLine)")
                .accessibilityHint(duck.hasJob ? "Opens the duck" : "Has no job yet")
            if hover || !duck.onDuty {
                HStack(spacing: 2) {
                    if duck.hasJob && duck.onDuty { hoverButton("Open", action: open) }
                    hoverButton(duck.onDuty ? "Close" : RoomRoster.bringBackTitle) { duty(!duck.onDuty) }
                }
            }
        }
        .opacity(duck.onDuty ? 1 : 0.55)
        .padding(.horizontal, 6).padding(.vertical, 7)
        .background(hover ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onHover { hover = $0 }
        .contextMenu {
            Button("Rename\u{2026}") { edit(.name) }
            Button("Set role\u{2026}") { edit(.role) }
            Divider()
            if duck.onDuty { Button("Put off duty") { duty(false) } } else { Button("Bring back") { duty(true) } }
        }
    }

    private var info: some View {
        HStack(alignment: .center, spacing: 11) {
            DuckAvatar(sessionId: duck.colourSeed, agent: duck.agent, size: 34, off: !duck.onDuty)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: duck.heading).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let l = duck.agentLabel { Text(verbatim: l).font(.system(size: 11)).foregroundStyle(Theme.subtle) }
                }
                if !duck.onDuty, let summary = duck.lastSummary {
                    Text(verbatim: summary).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
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
        }
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
