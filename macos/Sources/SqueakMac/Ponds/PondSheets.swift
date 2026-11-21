import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond sheets: invite by email (addresses, a role, Send invites),
// join with a pasted code. Controls say what they do; Pond and Flock only name things.

extension View {
    /// Presents `PondsModel.sheet` over this view.
    func pondSheets() -> some View {
        @Bindable var ponds = PondsModel.shared
        return sheet(item: $ponds.sheet) { sheet in
            switch sheet {
            case .invite(let pondId): InvitePondSheet(pondId: pondId)
            case .join: JoinPondSheet()
            }
        }
    }
}

private struct SheetFrame<Content: View>: View {
    let title: String
    let content: Content
    init(_ title: String, @ViewBuilder _ content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            Text(verbatim: title).font(Typo.title).foregroundStyle(Theme.ink)
            content
        }
        .padding(Space.xl).frame(width: 440).background(Theme.surface)
    }
}

// MARK: Invite

/// Invite by email (docs/ponds.md): type addresses, pick what they can do, send. Each person gets a link and joins by
/// signing in with that address: no code, no QR, no second approval. "Copy invite link" is a small secondary action.
struct InvitePondSheet: View {
    let pondId: String
    @Environment(\.dismiss) private var dismiss
    @State private var role: PondRole = .member
    @State private var list = EmailInviteList()
    @State private var draft = ""
    @State private var sending = false
    @State private var rows: [EmailInviteRow] = []
    @State private var error: String?
    @State private var linkCopy = CopyFeedback()
    @State private var makingLink = false
    @State private var now = Date()
    @FocusState private var fieldFocused: Bool
    private var ponds: PondsModel { .shared }
    private var pondName: String { ponds.ponds.first { $0.id == pondId }?.name ?? "the pond" }
    private var sent: Bool { !rows.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            header
            if sent { results } else { form }
            buttons
        }
        .padding(Space.xl).frame(width: 480).background(Theme.surface)
        .animation(Motion.standard, value: rows)
        .onAppear { ponds.note = nil; fieldFocused = true }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Space.m) {
            PondTile(name: pondName, pondId: pondId, projectId: ponds.directory?.pond(pondId: pondId)?.projectId, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: EmailInviteText.headline(pond: pondName)).font(Typo.title).foregroundStyle(Theme.ink)
                Text(verbatim: EmailInviteText.subtitle).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Form

    private var form: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: Space.s) {
                if !list.addresses.isEmpty {
                    FlowChips(items: list.addresses) { address in
                        HStack(spacing: Space.xs) {
                            Text(verbatim: address).font(Typo.footnote).foregroundStyle(Theme.ink).lineLimit(1)
                            Button { list.remove(address) } label: { Lucide(.x, size: 10, color: Theme.muted) }
                                .buttonStyle(.plain).accessibilityLabel("Remove \(address)")
                        }
                        .padding(.horizontal, Space.s).padding(.vertical, 3)
                        .background(PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: Radius.chip))
                    }
                }
                TextField(list.addresses.isEmpty ? EmailInviteText.placeholder : "Add another", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1...3)
                    .focused($fieldFocused)
                    .onChange(of: draft) { _, text in
                        // A separator (comma, space, return) or a paste turns what is typed into tokens.
                        if text.rangeOfCharacter(from: EmailInviteList.separators) != nil { commit(text) }
                    }
                    .onSubmit { commit(draft); if list.canSend { send() } }
                    .accessibilityLabel("Email addresses")
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(Theme.line))
            HStack(spacing: Space.m) { ForEach([PondRole.member, .viewer], id: \.self) { roleCard($0) } }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .contain).accessibilityLabel("They can")
            Text(verbatim: EmailInviteText.note).font(Typo.footnote).foregroundStyle(Theme.muted)
            if let line = errorLine {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var errorLine: String? {
        if let error { return error }
        if list.overflow { return EmailInviteText.tooMany() }
        if let bad = list.rejected.first { return EmailInviteText.notAnAddress(bad) }
        return nil
    }

    private func roleCard(_ r: PondRole) -> some View {
        let on = role == r
        return Button { withAnimation(Motion.quick) { role = r } } label: {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Lucide(r == .viewer ? .eye : .messageSquare, size: 16, color: Theme.ink)
                    Text(verbatim: InviteSheetText.roleTitle(r)).font(Typo.heading).foregroundStyle(Theme.ink)
                    Spacer()
                    if on { Lucide(.check, size: 14, color: Theme.ink) }
                }
                Text(verbatim: InviteSheetText.roleBlurb(r)).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .topLeading)
            .background(on ? PondColour.tint(pondId) : Theme.selected, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(on ? PondColour.accent : Theme.line, lineWidth: on ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(InviteSheetText.roleTitle(r)). \(InviteSheetText.roleBlurb(r))")
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }

    // MARK: Results

    private var results: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Lucide(row.sent ? .check : .x, size: 12, color: row.sent ? Theme.success : Theme.negative)
                    Text(verbatim: row.email).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: Space.s)
                    Text(verbatim: row.line).font(Typo.footnote).foregroundStyle(row.sent ? Theme.muted : Theme.negative)
                        .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.trailing)
                }
                .accessibilityElement(children: .combine)
            }
            if rows.contains(where: { $0.sent }) {
                Text(verbatim: "They\u{2019}re in as soon as they open the link and sign in with that address.")
                    .font(Typo.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    // MARK: Buttons

    private var buttons: some View {
        HStack {
            if !sent {
                Button(linkCopy.label(makingLink ? "Making a link\u{2026}" : EmailInviteText.copyLink, now: now)) { copyLink() }
                    .buttonStyle(.plain).font(Typo.footnote).foregroundStyle(Theme.muted).disabled(makingLink)
                    .help(EmailInviteText.linkNote)
            }
            Spacer()
            if sent {
                if rows.contains(where: { !$0.sent }) {
                    Button("Try the rest again") { retryFailed() }.buttonStyle(SecondaryButtonStyle())
                }
                Button("Done") { dismiss() }.buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button(sending ? EmailInviteText.sending(list.count) : EmailInviteText.send) { send() }
                    .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                    .disabled(sending || !(list.canSend || EmailAddress.isValid(draft)))
            }
        }
    }

    // MARK: Actions

    private func commit(_ text: String) {
        list.dismissRejected()
        list.add(text)
        // Text that is not an address stays in the field so it can be fixed; the rest became tokens.
        draft = list.rejected.joined(separator: " ")
        error = nil
    }

    private func send() {
        if !draft.isEmpty { commit(draft) }
        guard list.canSend, !sending else { return }
        sending = true; error = nil
        let emails = list.addresses
        Task {
            defer { sending = false }
            if let result = await ponds.inviteByEmail(pond: pondId, emails: emails, role: role) {
                withAnimation(Motion.standard) { rows = EmailInviteRow.rows(from: result) }
            } else {
                error = ponds.note ?? "That didn\u{2019}t go through"
            }
        }
    }

    private func retryFailed() {
        let failed = rows.filter { !$0.sent }.map(\.email)
        var next = EmailInviteList()
        next.add(failed.joined(separator: " "))
        list = next; rows = []; draft = ""; error = nil
    }

    /// The small secondary action: a link anyone can open, which still waits for the owner's approval.
    private func copyLink() {
        guard !makingLink else { return }
        makingLink = true
        Task {
            defer { makingLink = false }
            if let made = await ponds.invite(pond: pondId, role: role), let link = made.link {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
                now = Date(); linkCopy.copied(at: now)
                try? await Task.sleep(for: .seconds(CopyFeedback.holdFor + 0.05))
                now = Date()
            } else {
                error = ponds.note ?? "That didn\u{2019}t go through"
            }
        }
    }
}

// MARK: Join

struct JoinPondSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame("Join a pond") { JoinPondForm(dismiss: { dismiss() }) }
    }
}

/// The join form, in the sheet and inline on the Create page.
struct JoinPondForm: View {
    var dismiss: () -> Void
    /// The sheet has Cancel and Close; the page is already where the person is.
    var inline = false
    @State private var code = ""
    @Environment(AppModel.self) private var model
    @State private var phase: Phase = .entering
    private var ponds: PondsModel { .shared }

    enum Phase: Equatable { case entering, sending, waiting(pondId: String), joined(pondId: String) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            switch phase {
            case .entering, .sending:
                TextField("Type the code (K7P-4QD) or paste an invite link", text: $code).textFieldStyle(.roundedBorder).font(Typo.code)
                    .onSubmit { if phase == .entering, PondInviteText.canJoin(code: code) { ask() } }
                // A name is never typed: the pond shows the name on the Squeak account.
                if model.account.state?.linked != true { SignInToJoinLine(account: model.account) }
                Text("An owner approves you on their Mac before you see anything.").font(Typo.footnote).foregroundStyle(Theme.muted)
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
                HStack {
                    Spacer()
                    if !inline { Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction) }
                    let askButton = Button(phase == .sending ? "Asking\u{2026}" : "Ask to join") { ask() }
                        .buttonStyle(PondPrimaryButtonStyle())
                        .disabled(phase == .sending || !PondInviteText.canJoin(code: code))
                    if inline { askButton } else { askButton.keyboardShortcut(.defaultAction) }
                }
            case .waiting(let id):
                HStack(spacing: Space.s) {
                    StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16)
                    Text("Waiting for the owner to approve").font(Typo.label).foregroundStyle(Theme.ink)
                }
                if let words = ponds.ponds.first(where: { $0.id == id })?.words, !words.isEmpty { MatchingWords(words: words, hint: InviteSheetText.wordsHintJoiner(owner: ponds.ponds.first(where: { $0.id == id })?.ownerName)) }
                Text(inline ? "The pond appears in the sidebar once you\u{2019}re approved." : "You can close this. The pond appears in the sidebar once you\u{2019}re approved.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
                if !inline {
                    HStack { Spacer(); Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.defaultAction) }
                }
                Color.clear.frame(height: 0).task(id: id) { await waitForApproval(id) }
            case .joined(let id):
                let pond = ponds.ponds.first { $0.id == id }?.name ?? "the pond"
                Text(verbatim: "You\u{2019}re in \(pond).").font(Typo.body).foregroundStyle(Theme.ink)
                HStack {
                    Spacer()
                    Button("Open") { AppModel.shared.openPondHome(ponds.ponds.first { $0.id == id }.map { ponds.key(forPond: $0) } ?? id); dismiss() }.buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { ponds.note = nil }
    }

    private func ask() {
        guard let clean = PondInviteText.cleaned(code) else { return }
        phase = .sending
        Task {
            if let r = await ponds.join(code: clean, account: model.account) {
                phase = r.isPending ? .waiting(pondId: r.pondId) : .joined(pondId: r.pondId)
            } else {
                phase = .entering
            }
        }
    }

    /// Reads the list until the pond is in it: the owner's approval is what puts it there.
    private func waitForApproval(_ id: String) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            await ponds.refresh()
            if let p = ponds.ponds.first(where: { $0.id == id }) { phase = .joined(pondId: p.id); return }
        }
    }
}


/// Joining needs the Squeak account, because the name people see is the account's. Said plainly, with the way in.
struct SignInToJoinLine: View {
    let account: AccountModel

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text(verbatim: PondJoinGate.signInLine).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if account.canSignIn {
                Button("Sign in") { account.openSignIn(from: .pond("")) }.buttonStyle(SecondaryButtonStyle())
            }
        }
    }
}

/// The three words both sides of a join see: the owner's approval card and the joiner's waiting card, so a relay that
/// swapped a key shows different words on the two screens (docs/ponds.md, "Matching words").
struct MatchingWords: View {
    let words: [String]
    let hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(verbatim: JoinWords.line(words)).font(Typo.heading.monospaced()).foregroundStyle(Theme.ink).textSelection(.enabled)
            Text(verbatim: hint).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Matching words: \(words.joined(separator: ", ")). \(hint)")
    }
}
