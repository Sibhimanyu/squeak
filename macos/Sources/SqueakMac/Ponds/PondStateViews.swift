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
                if f == .reading { WorkingGlyph(slot: 20) } else { Lucide(.triangleAlert, size: 13, color: f.isProblem ? Theme.warning : Theme.muted) }
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
/// and menu bar); the Remove button clears an ended one.
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
                    case .waiting: StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16)
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
                        Task { _ = await ponds.forget(pond: pond.id); busy = false }
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
            ForEach(["leave:\(pond.id)", "delete:\(pond.id)"], id: \.self) { key in
                if let failed = ponds.actions.failure(key) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(verbatim: failed).font(Typo.footnote).foregroundStyle(Theme.negative).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Button(PondActionWords.tryAgain) { Task { await ponds.retry(action: key, pond: pond.id) } }.buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
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
                    Text(verbatim: PondActionWords.leaveMessage(pond.name, owner: pond.ownerName)).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
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
            case .leave: Text(verbatim: PondActionWords.leaveMessage(pond.name, owner: pond.ownerName))
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
