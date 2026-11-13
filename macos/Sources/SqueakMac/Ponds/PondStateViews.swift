import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The owner's rule: every person always sees a clear state. These are the pieces every pond surface shares: the strip
// above a pond that says what is true of its data, the card of a pond that is waiting or ended, a join request, the
// owner's invites, and the pond actions. What they say is decided in SqueakMacCore (`PondStates.swift`); the host's own
// sentence is drawn whenever it sent one.

// MARK: Strip

/// "Refreshing…", "Reading the pond…", the host's offline line with what time it shows, or the app's own can't-reach line.
struct PondFreshnessStrip: View {
    let pond: PondSummary?
    private var ponds: PondsModel { .shared }

    var body: some View {
        let f = ponds.freshness(pond)
        if let line = f.line {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                if f == .reading { WorkingGlyph(width: 20, height: 15) } else { Lucide(.triangleAlert, size: 13, color: f.isProblem ? Theme.warning : Theme.muted) }
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let reason = f.writesDisabledReason {
                    Text(verbatim: reason).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if f == .couldntRead || f == .stale, let id = pond?.id {
                    Button("Try again") { ponds.retry(id) }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: Waiting or ended

/// The state card of a pond that is not an ordinary active one (the same sentences in the sidebar tooltip, home, panel
/// and menu bar); the Remove / Cancel button clears it.
struct PondStateCardView: View {
    let pond: PondSummary
    var compact = false
    @State private var busy = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        if let card = PondStates.card(for: pond), pond.state != .active {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    switch card.tone {
                    case .waiting: WorkingGlyph(width: 20, height: 15)
                    case .problem: Lucide(.triangleAlert, size: 14, color: Theme.negative)
                    case .calm: Lucide(.users, size: 14, color: Theme.muted)
                    }
                    Text(verbatim: card.title).font(Typo.label).foregroundStyle(Theme.ink)
                }
                Text(verbatim: card.line).font(compact ? Typo.footnote : Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let button = card.button {
                    Button(busy ? "Working\u{2026}" : button) {
                        busy = true
                        Task { _ = card.forgets ? await ponds.forget(pond: pond.id) : await ponds.cancelJoin(pond: pond.id); busy = false }
                    }
                    .buttonStyle(SecondaryButtonStyle()).disabled(busy)
                }
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .accessibilityElement(children: .contain)
        }
    }
}

// MARK: Join request

/// One request to join: who is asking (name, Mac or browser, machine, verified email), the role to give (a picker that
/// starts at what the invite offered) and Approve / Deny, saying "Approving…" from the press and what to do on failure.
struct JoinRequestCard: View {
    let pond: PondSummary
    let join: JoinRequest
    var compact = false
    @State private var role: PondRole
    private var ponds: PondsModel { .shared }

    init(pond: PondSummary, join: JoinRequest, compact: Bool = false) {
        self.pond = pond; self.join = join; self.compact = compact
        _role = State(initialValue: join.role == .owner ? .member : join.role)
    }

    var body: some View {
        let deciding = ponds.isDeciding(join)
        let canWrite = ponds.freshness(pond).canWrite
        let line = ponds.decisionLine(join)
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .top, spacing: Space.s) {
                FlockAvatar(member: FlockMember(id: join.id, name: join.name), online: false, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: JoinCardText.title(join, pond: compact ? pond.name : nil)).font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: JoinCardText.source(join)).font(Typo.meta).foregroundStyle(Theme.muted)
                    if let email = JoinCardText.email(join) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.seal.fill").imageScale(.small)
                            Text(verbatim: email).textSelection(.enabled)
                        }
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                    Text(verbatim: "Asked to join as a \(join.role.word.lowercased()). \(JoinCardText.hint)").font(Typo.meta).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if !join.words.isEmpty { MatchingWords(words: join.words, hint: InviteSheetText.wordsHint) }
            HStack(spacing: Space.s) {
                SqueakPicker("Role", selection: $role) {
                    SqueakChoice(title: "Member", value: PondRole.member)
                    SqueakChoice(title: "Viewer", value: PondRole.viewer)
                }
                .labelsHidden().pickerStyle(.menu).fixedSize().disabled(deciding).accessibilityLabel("Role to give \(join.displayName)")
                Spacer(minLength: 0)
                Button("Deny") { decide(false) }.buttonStyle(SecondaryButtonStyle()).disabled(deciding || !canWrite)
                Button("Approve") { decide(true) }.buttonStyle(PondPrimaryButtonStyle()).disabled(deciding || !canWrite)
            }
            if let line {
                Text(verbatim: line.text).font(Typo.footnote).foregroundStyle(line.failed ? Theme.negative : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            } else if !canWrite, let why = ponds.freshness(pond).writesDisabledReason {
                Text(verbatim: why).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(join.accessibilityLabel)
    }

    private func decide(_ approve: Bool) {
        let picked = role
        Task { await ponds.decideJoin(pond: pond.id, request: join.id, approve: approve, role: picked) }
    }
}

// MARK: Invites (owner)

/// Every invite with its state: pending with its expiry (copy the link or code again, or revoke), accepted by name,
/// declined, expired, revoked; the older ones fold away.
struct PondInvitesSection: View {
    let pond: PondSummary
    @Environment(AppModel.self) private var model
    @State private var revoking: PondInviteRow?
    @State private var showEarlier = false
    @State private var copied: String?
    private var ponds: PondsModel { .shared }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let entries = ponds.details[pond.id]?.invites ?? []
            let rows = PondInvites.rows(entries, now: ctx.date)
            let recent = rows.filter(\.recent), earlier = rows.filter { !$0.recent }
            VStack(alignment: .leading, spacing: Space.s) {
                HStack {
                    Text("Invites").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Invite someone") { ponds.startInvite(pondId: pond.id, account: model.account) }.buttonStyle(SecondaryButtonStyle())
                        .disabled(!ponds.freshness(pond).canWrite)
                }
                Text(verbatim: PondInvites.oneEach).font(Typo.footnote).foregroundStyle(Theme.muted)
                if rows.isEmpty {
                    Text("No invites yet.").font(Typo.footnote).foregroundStyle(Theme.subtle)
                }
                ForEach(recent) { r in row(r, entries) }
                if !earlier.isEmpty {
                    Button { showEarlier.toggle() } label: {
                        HStack(spacing: 4) {
                            Lucide(showEarlier ? .chevronDown : .chevronRight, size: 11, color: Theme.muted)
                            Text(verbatim: PondInvites.earlierTitle).font(Typo.label).foregroundStyle(Theme.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    if showEarlier { ForEach(earlier) { r in row(r, entries) } }
                }
            }
            .confirmationDialog("Revoke this invite?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
                Button("Revoke", role: .destructive) {
                    if let r = revoking { Task { await ponds.revokeInvite(pond: pond.id, invite: r.id) } }
                    revoking = nil
                }
                Button("Cancel", role: .cancel) { revoking = nil }
            } message: { Text(verbatim: PondInvites.revokeWarning) }
        }
    }

    private func row(_ r: PondInviteRow, _ entries: [PondInviteEntry]) -> some View {
        let entry = entries.first { $0.id == r.id }
        let busy = ponds.isBusy("invite:\(pond.id):\(r.id)")
        return HStack(spacing: Space.s) {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: r.title).font(Typo.label).foregroundStyle(Theme.ink)
                Text(verbatim: busy ? "Revoking\u{2026}" : r.line).font(Typo.meta).foregroundStyle(r.tone == .problem ? Theme.muted : Theme.muted)
            }
            Spacer(minLength: 0)
            if r.canCopy, let link = entry?.link {
                Button(copied == r.id + "l" ? "Copied" : "Copy link") { copy(link, r.id + "l") }.buttonStyle(SecondaryButtonStyle())
            }
            if r.canCopy, let code = entry?.code {
                Button(copied == r.id + "c" ? "Copied" : "Copy code") { copy(code, r.id + "c") }.buttonStyle(SecondaryButtonStyle())
            }
            if r.canRevoke {
                Button("Revoke") { revoking = r }.buttonStyle(SecondaryButtonStyle()).disabled(busy || !ponds.freshness(pond).canWrite)
            }
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .opacity(r.pending ? 1 : 0.75)
    }

    private func copy(_ text: String, _ key: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = key
        Task { try? await Task.sleep(for: .seconds(2)); if copied == key { copied = nil } }
    }
}

// MARK: Pond actions

/// Rename and Delete (owner), Leave (member), Change the pond key (owner), each with its plain explanation and result.
struct PondActionsSection: View {
    let pond: PondSummary
    var detail: PondDetail?
    @State private var renaming = false
    @State private var name = ""
    @State private var confirm: Confirm?
    private var ponds: PondsModel { .shared }

    enum Confirm: Identifiable { case leave, delete, rotate; var id: Self { self } }

    private var role: PondRole { detail?.myRole ?? pond.role }
    private var others: Int { max(0, (detail?.members.count ?? pond.memberCount) - 1) }

    var body: some View {
        let canWrite = ponds.freshness(pond).canWrite
        VStack(alignment: .leading, spacing: Space.m) {
            Text("This pond").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
            if role.canInvite {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Name").font(Typo.label).foregroundStyle(Theme.ink)
                    if renaming {
                        HStack(spacing: Space.s) {
                            TextField("Pond name", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 280).onSubmit(rename)
                            Button(ponds.isBusy("rename:\(pond.id)") ? "Saving\u{2026}" : "Save") { rename() }.buttonStyle(PondPrimaryButtonStyle())
                                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || ponds.isBusy("rename:\(pond.id)"))
                            Button("Cancel") { renaming = false }.buttonStyle(SecondaryButtonStyle())
                        }
                    } else {
                        HStack {
                            Text(verbatim: pond.name).font(Typo.body).foregroundStyle(Theme.muted)
                            Button("Rename") { name = pond.name; renaming = true }.buttonStyle(SecondaryButtonStyle()).disabled(!canWrite)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Pond key").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: PondActionWords.rotateExplain).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    Button(ponds.isBusy("rotate:\(pond.id)") ? "Changing the key\u{2026}" : "Change the pond key\u{2026}") { confirm = .rotate }
                        .buttonStyle(SecondaryButtonStyle()).disabled(!canWrite || ponds.isBusy("rotate:\(pond.id)"))
                }
            }
            if let line = ponds.result[pond.id] { Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted) }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            if !canWrite, let why = ponds.freshness(pond).writesDisabledReason { Text(verbatim: why).font(Typo.footnote).foregroundStyle(Theme.muted) }
            Divider().overlay(Theme.line)
            if role.canInvite {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Delete this pond").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: PondActionWords.deleteMessage(pond.name, others: others)).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    Button(ponds.isBusy("delete:\(pond.id)") ? "Deleting\u{2026}" : "Delete pond\u{2026}") { confirm = .delete }
                        .buttonStyle(DestructiveButtonStyle()).disabled(!canWrite || ponds.isBusy("delete:\(pond.id)"))
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Leave this pond").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: PondActionWords.leaveMessage(pond.name)).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    Button(ponds.isBusy("leave:\(pond.id)") ? "Leaving\u{2026}" : "Leave pond\u{2026}") { confirm = .leave }
                        .buttonStyle(DestructiveButtonStyle()).disabled(!canWrite || ponds.isBusy("leave:\(pond.id)"))
                }
            }
        }
        .confirmationDialog(title, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            switch confirm {
            case .leave: Button("Leave", role: .destructive) { Task { _ = await ponds.leave(pond: pond.id) } }
            case .delete: Button("Delete for everyone", role: .destructive) { Task { _ = await ponds.deletePond(pond: pond.id) } }
            case .rotate: Button("Change the key") { Task { await ponds.rotateKey(pond: pond.id) } }
            case nil: EmptyView()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            switch confirm {
            case .leave: Text(verbatim: PondActionWords.leaveMessage(pond.name))
            case .delete: Text(verbatim: PondActionWords.deleteMessage(pond.name, others: others))
            case .rotate: Text(verbatim: PondActionWords.rotateExplain)
            case nil: EmptyView()
            }
        }
    }

    private var title: String {
        switch confirm {
        case .leave: "Leave \(pond.name)?"
        case .delete: "Delete \(pond.name) for everyone?"
        case .rotate: "Change the pond key?"
        case nil: ""
        }
    }

    private func rename() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        Task { if await ponds.rename(pond: pond.id, name: n) { renaming = false } }
    }
}

// MARK: Heartbeat

extension View {
    /// Tells the pond this person is here every 20 s while this is on screen, so "online" and "viewing" are right for others.
    func pondHeartbeat(pond: String?, viewing: String? = nil, typing: @escaping () -> Bool = { false }) -> some View {
        task(id: pond ?? "") {
            guard let pond, !pond.isEmpty else { return }
            while !Task.isCancelled {
                PondsModel.shared.presence(pond: pond, viewing: viewing, typing: typing())
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }
}
