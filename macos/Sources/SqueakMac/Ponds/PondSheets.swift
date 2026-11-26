import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.10 sheets, docs/spec.md "People and remote", mocks 2026-11-26/pond-dashboard (invite-sheet, people-sheet).
// Two sheets over the Pond's Dashboard: Invite (email tokens, a role, Send) and People (members, then invitations). What
// they say and offer is decided in SqueakMacCore (`InviteSheetPlan`, `PeopleSheetPlan`); this only draws it. Actions that wait
// on the cloud say so in place (Inviting…, Withdrawing…) and a failure stays there with Try again.

extension View {
    /// Presents `PondsModel.sheet` over this view.
    func pondSheets() -> some View {
        @Bindable var ponds = PondsModel.shared
        return sheet(item: $ponds.sheet) { sheet in
            switch sheet {
            case .invite(let pondId): InvitePondSheet(pondId: pondId)
            case .people(let pondId): PeopleSheet(pondId: pondId)
            }
        }
    }
}

// MARK: Invite

struct InvitePondSheet: View {
    let pondId: String
    @Environment(\.dismiss) private var dismiss
    @State private var plan: InviteSheetPlan
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool
    private var ponds: PondsModel { .shared }
    private var pondName: String { ponds.ponds.first { $0.id == pondId }?.name ?? "the pond" }
    private var key: String { "invite:\(pondId)" }
    private var sending: Bool { ponds.actions.isPending(key) }

    init(pondId: String) {
        self.pondId = pondId
        let people = PondsModel.shared.people[pondId]
        _plan = State(initialValue: InviteSheetPlan(
            used: people?.used ?? PondsModel.shared.details[pondId]?.members.count ?? 1, cap: people?.cap ?? 10))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            header
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Email addresses").font(Typo.footnote).foregroundStyle(Theme.muted)
                field
                if let line = plan.problemLine {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Lucide(.triangleAlert, size: 12, color: Theme.negative)
                        Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                if let failed = ponds.actions.failure(key) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(verbatim: failed).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        Button(PondActionWords.tryAgain) { send() }.buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Role").font(Typo.footnote).foregroundStyle(Theme.muted)
                HStack(spacing: Space.m) { ForEach(InviteSheetPlan.roles, id: \.self) { roleCard($0) } }
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .contain).accessibilityLabel("They can")
            }
            Divider().overlay(Theme.line)
            footer
        }
        .padding(Space.xl).frame(width: 520).background(Theme.surface)
        .onAppear { ponds.note = nil; fieldFocused = true }
        .task { await ponds.loadPeople(pondId) }
        .onChange(of: ponds.people[pondId]) { _, people in
            if let people { plan.setPlaces(used: people.used, cap: people.cap) }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Space.m) {
            PondTile(name: pondName, pondId: pondId, projectId: ponds.directory?.pond(pondId: pondId)?.projectId, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: InviteSheetPlan.headline(pond: pondName)).font(Typo.title).foregroundStyle(Theme.ink)
                Text(verbatim: InviteSheetPlan.subtitle).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if !plan.tokens.isEmpty {
                FlowChips(items: plan.tokens.map(\.address)) { address in
                    let token = plan.tokens.first { $0.address == address }
                    let bad = token.map { !$0.valid || $0.refusal != nil } ?? false
                    HStack(spacing: Space.xs) {
                        Text(verbatim: address).font(Typo.footnote).foregroundStyle(Theme.ink).lineLimit(1)
                        Button { plan.remove(address) } label: { Lucide(.x, size: 10, color: Theme.muted) }
                            .buttonStyle(.plain).accessibilityLabel("Remove \(address)")
                    }
                    .padding(.horizontal, Space.s).padding(.vertical, 3)
                    .background(PondColour.tint(pondId), in: Capsule())
                    .overlay(Capsule().strokeBorder(bad ? Theme.negative : Color.clear, lineWidth: 1))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(bad ? "\(address), can\u{2019}t be invited" : address)
                }
            }
            TextField(plan.tokens.isEmpty ? InviteSheetPlan.firstPlaceholder : InviteSheetPlan.placeholder, text: $draft)
                .textFieldStyle(.plain).font(Typo.body).foregroundStyle(Theme.ink)
                .focused($fieldFocused)
                .onChange(of: draft) { _, text in
                    // A separator (comma, space, return) or a paste turns what is typed into tokens.
                    if text.rangeOfCharacter(from: InviteSheetPlan.separators) != nil { commit() }
                }
                .onSubmit { commit(); if plan.canSend { send() } }
                .accessibilityLabel("Email addresses")
        }
        .padding(Space.m).frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
        .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(Theme.line))
    }

    private func roleCard(_ r: PondRole) -> some View {
        let on = plan.role == r
        return Button { withAnimation(Motion.quick) { plan.role = r } } label: {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text(verbatim: r.word).font(Typo.heading).foregroundStyle(Theme.ink)
                    Spacer()
                    if on { Lucide(.check, size: 14, color: Theme.ink) }
                }
                Text(verbatim: InviteSheetPlan.roleBlurb(r)).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .topLeading)
            .background(on ? PondColour.tint(pondId) : Theme.selected, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(on ? PondColour.accent : Theme.line, lineWidth: on ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(r.word). \(InviteSheetPlan.roleBlurb(r))")
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }

    private var footer: some View {
        HStack {
            Text(verbatim: plan.placesLine).font(Typo.footnote).foregroundStyle(Theme.muted)
            Spacer()
            Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            Button(sending ? PondActionWords.pending(.invite, who: nil) : plan.sendTitle) { send() }
                .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                .disabled(sending || !(plan.canSend || (draftIsAddress && !plan.tokens.contains { $0.refusal != nil })))
        }
    }

    private var draftIsAddress: Bool { EmailAddress.isValid(draft) }

    private func commit() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { draft = ""; return }
        plan.add(draft)
        draft = ""
    }

    private func send() {
        commit()
        guard plan.canSend, !sending else { return }
        let emails = plan.sendable, role = plan.role
        Task {
            guard let results = await ponds.sendInvites(pond: pondId, emails: emails, role: role) else { return }
            withAnimation(Motion.standard) { plan.apply(results) }
            if plan.isDone { dismiss() }
        }
    }
}

// MARK: People

struct PeopleSheet: View {
    let pondId: String
    @Environment(\.dismiss) private var dismiss
    @State private var removing: PeopleSheetPlan.MemberRow?
    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.ponds.first { $0.id == pondId } }
    private var pondName: String { pond?.name ?? "the pond" }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: PeopleSheetPlan.title(pond: pondName)).font(Typo.title).foregroundStyle(Theme.ink)
                    if let people = ponds.people[pondId] {
                        Text(verbatim: PeopleSheetPlan.make(people, now: Date()).subtitle).font(Typo.footnote).foregroundStyle(Theme.muted)
                    }
                }
                Spacer()
                Button { dismiss() } label: { Lucide(.x, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                    .buttonStyle(.plain).keyboardShortcut(.cancelAction).accessibilityLabel("Close")
            }
            if let people = ponds.people[pondId] {
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    content(PeopleSheetPlan.make(people, now: ctx.date))
                }
            } else {
                Text("Reading the people\u{2026}").font(Typo.footnote).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 80)
            }
        }
        .padding(Space.xl).frame(width: 580).background(Theme.surface)
        .onAppear { ponds.note = nil }
        .task { await ponds.loadPeople(pondId) }
        .confirmationDialog(
            "Remove \(removing?.name ?? "this person") from \(pondName)?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let m = removing { Task { await ponds.removeMember(pond: pondId, member: m.id) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("The pond\u{2019}s key changes, so they can\u{2019}t read anything new. Their own Mac keeps what it already has.")
        }
    }

    private var canWrite: Bool { ponds.freshness(pond).canWrite }

    private func content(_ plan: PeopleSheetPlan) -> some View {
        VStack(alignment: .leading, spacing: Space.l) {
            section("Members") { ForEach(plan.members) { memberRow($0) } }
            if !plan.invites.isEmpty { section("Invitations") { ForEach(plan.invites) { inviteRow($0) } } }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative).textSelection(.enabled) }
            if !canWrite, let why = ponds.freshness(pond).writesDisabledReason {
                Text(verbatim: why).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            if plan.canInvite || !plan.invites.isEmpty {
                Divider().overlay(Theme.line)
                HStack {
                    if !plan.invites.isEmpty { Text(verbatim: PeopleSheetPlan.finishedFootnote).font(Typo.footnote).foregroundStyle(Theme.muted) }
                    Spacer()
                    if plan.canInvite {
                        Button { ponds.startInvite(pondId: pondId, account: AppModel.shared.account) } label: { Label("Invite", systemImage: "envelope") }
                            .buttonStyle(PondPrimaryButtonStyle()).disabled(!canWrite)
                    }
                }
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: title).font(Typo.footnote).foregroundStyle(Theme.muted).padding(.bottom, Space.s)
            Divider().overlay(Theme.line)
            rows()
        }
    }

    // MARK: Members

    private func memberRow(_ m: PeopleSheetPlan.MemberRow) -> some View {
        let removeKey = "remove:\(pondId):\(m.id)"
        let removingNow = ponds.actions.isPending(removeKey)
        let changing = ponds.isBusy("role:\(pondId):\(m.id)")
        return VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.m) {
                FlockAvatar(member: FlockMember(id: m.id, name: m.name, you: m.you), online: false, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(verbatim: m.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                        if m.you { Text("(you)").font(Typo.label).foregroundStyle(Theme.muted) }
                    }
                    Text(verbatim: m.email).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                }
                Spacer(minLength: Space.s)
                if let seen = m.seen { Text(verbatim: seen).font(Typo.footnote).foregroundStyle(Theme.muted) }
                roleControl(m).frame(width: 96, alignment: .leading)
                Group {
                    if m.canRemove {
                        Button(removingNow ? "Removing\u{2026}" : "Remove") { removing = m }
                            .buttonStyle(.plain).font(Typo.label).foregroundStyle(Theme.negative)
                            .disabled(removingNow || changing || !canWrite)
                    } else { Color.clear }
                }
                .frame(width: 76, alignment: .trailing)
            }
            if let failed = ponds.actions.failure(removeKey) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(verbatim: failed).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                    Button(PondActionWords.tryAgain) { Task { await ponds.retry(action: removeKey, pond: pondId) } }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .padding(.vertical, Space.s)
        .opacity(removingNow ? 0.6 : 1)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.line) }
    }

    @ViewBuilder private func roleControl(_ m: PeopleSheetPlan.MemberRow) -> some View {
        if m.roleChoices.isEmpty {
            Text(verbatim: m.role.word).font(Typo.label).foregroundStyle(Theme.muted)
        } else {
            SqueakPicker("Role", selection: Binding(get: { m.role }, set: { new in Task { await ponds.setRole(pond: pondId, member: m.id, role: new) } })) {
                SqueakOptions(m.roleChoices) { SqueakChoice(title: $0.word, value: $0) }
            }
            .labelsHidden().pickerStyle(.menu).fixedSize().disabled(!canWrite).accessibilityLabel("Role for \(m.name)")
        }
    }

    // MARK: Invitations

    private func actionKey(_ a: PeopleSheetPlan.InviteAction, _ id: String) -> String {
        "\(a == .resend ? "resend" : a == .withdraw ? "withdraw" : "again"):\(pondId):\(id)"
    }

    private func inviteRow(_ r: PeopleSheetPlan.InviteRow) -> some View {
        let keys = r.actions.map { actionKey($0, r.id) }
        let working = keys.first { ponds.actions.isPending($0) }
        let failedKey = keys.first { ponds.actions.offersTryAgain($0) }
        return VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.m) {
                Image(systemName: "envelope").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 36, height: 36)
                    .overlay(Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: r.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                    if let sub = r.subtitle { Text(verbatim: sub).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle) }
                    Text(verbatim: working.flatMap { ponds.actions.line($0) } ?? r.line).font(Typo.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: Space.s)
                ForEach(r.actions, id: \.self) { action in
                    switch action {
                    case .resend: Button("Resend") { run(action, r) }.buttonStyle(SecondaryButtonStyle())
                    case .withdraw: Button("Withdraw") { run(action, r) }.buttonStyle(.plain).font(Typo.label).foregroundStyle(Theme.negative)
                    case .inviteAgain: Button("Invite again") { run(action, r) }.buttonStyle(SecondaryButtonStyle())
                    }
                }
                .disabled(working != nil || !canWrite)
            }
            if let failedKey, let failed = ponds.actions.failure(failedKey) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(verbatim: failed).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                    Button(PondActionWords.tryAgain) { Task { await ponds.retry(action: failedKey, pond: pondId) } }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .padding(.vertical, Space.s)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.line) }
        .accessibilityElement(children: .contain)
    }

    private func run(_ action: PeopleSheetPlan.InviteAction, _ row: PeopleSheetPlan.InviteRow) {
        guard let record = ponds.people[pondId]?.invites.first(where: { $0.id == row.id }) else { return }
        Task { await ponds.inviteAction(action, pond: pondId, invite: record) }
    }
}
