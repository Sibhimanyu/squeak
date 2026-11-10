import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond sheets: create a pond from a project, invite (a code with a visible Copy and its expiry),
// join with a pasted code. Controls say what they do; Pond and Flock only name things.

extension View {
    /// Presents `PondsModel.sheet` over this view.
    func pondSheets() -> some View {
        @Bindable var ponds = PondsModel.shared
        return sheet(item: $ponds.sheet) { sheet in
            switch sheet {
            case .create(let project, let projectId, let rootPath): CreatePondSheet(project: project, projectId: projectId, rootPath: rootPath)
            case .invite(let pondId): InvitePondSheet(pondId: pondId)
            case .join: JoinPondSheet()
            case .startThread(let pondId, let name): StartThreadSheet(pondId: pondId, pondName: name)
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

// MARK: Create

struct CreatePondSheet: View {
    let project: String
    let projectId: String?
    let rootPath: String?
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        SheetFrame("Share this pond") {
            Text("\u{201C}\(project)\u{201D} becomes a pond. You\u{2019}re its owner and its first member; you can invite people once it exists.")
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            Text("Threads you share show their messages and steps to the flock. Code moves only through Git, so a pond with a Git remote can also run each person\u{2019}s own threads.")
                .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button(busy ? "Creating\u{2026}" : "Create pond") {
                    busy = true
                    Task {
                        let made = await ponds.create(name: project, projectId: projectId, rootPath: rootPath)
                        busy = false
                        if made != nil { ponds.route = .home(project: project); dismiss() }
                    }
                }
                .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(busy)
            }
        }
        .onAppear { ponds.note = nil }
    }
}

// MARK: Start a thread

/// An own thread: the prompt and the model picker the rest of the app uses. It runs on this Mac, in a workspace of
/// the pond's repository, and the flock sees it.
struct StartThreadSheet: View {
    let pondId: String
    let pondName: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var models: [DaemonChatModel] = []
    @State private var modelId = ""
    @State private var busy = false
    private var ponds: PondsModel { .shared }
    private var chosen: DaemonChatModel? { models.first { $0.id == modelId } }

    var body: some View {
        SheetFrame("Start a thread") {
            Text("It runs on this Mac, in a copy of \u{201C}\(pondName)\u{201D}\u{2019}s repository. Everyone in the pond sees it.")
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(Typo.body).scrollContentBackground(.hidden).padding(Space.s)
                .frame(height: 110)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            if models.isEmpty {
                Text("Squeak is still reading the models.").font(Typo.footnote).foregroundStyle(Theme.muted)
            } else {
                Picker("Model", selection: $modelId) {
                    ForEach(models) { m in Text(verbatim: m.label).tag(m.id) }
                }
                .labelsHidden().frame(width: 260)
            }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button(busy ? "Starting\u{2026}" : "Start thread") {
                    guard let m = chosen else { return }
                    busy = true
                    Task {
                        let ok = await ponds.startThread(pond: pondId, text: text.trimmingCharacters(in: .whitespacesAndNewlines), agent: m.agent, model: m.id)
                        busy = false
                        if ok { dismiss() }
                    }
                }
                .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                .disabled(busy || chosen == nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onAppear { ponds.note = nil }
        .task {
            models = await model.newChatModels()
            if modelId.isEmpty, let first = PondStartThread.defaultModel(in: models) { modelId = first.id }
        }
    }
}

// MARK: Invite

struct InvitePondSheet: View {
    let pondId: String
    @Environment(\.dismiss) private var dismiss
    @State private var role: PondRole = .member
    @State private var invite: PondInvite?
    @State private var busy = false
    @State private var copied = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        SheetFrame("Invite to \(ponds.ponds.first { $0.id == pondId }?.name ?? "the pond")") {
            if let invite {
                codeBlock(invite)
            } else {
                Picker("They can", selection: $role) {
                    ForEach([PondRole.member, .viewer], id: \.self) { Text(verbatim: $0.word).tag($0) }
                }
                .pickerStyle(.segmented)
                Text(verbatim: role.summary).font(Typo.footnote).foregroundStyle(Theme.muted)
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
            }
            HStack {
                Spacer()
                if invite == nil {
                    Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                    Button(busy ? "Creating\u{2026}" : "Create code") {
                        busy = true
                        Task { invite = await ponds.invite(pond: pondId, role: role); busy = false }
                    }
                    .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(busy)
                } else {
                    Button("Done") { dismiss() }.buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { ponds.note = nil }
    }

    private func codeBlock(_ invite: PondInvite) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Send this code. It works once, and you approve whoever uses it.").font(Typo.body).foregroundStyle(Theme.muted)
            HStack(alignment: .top, spacing: Space.s) {
                Text(verbatim: invite.shareable).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
                    .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control))
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(invite.shareable, forType: .string)
                    copied = true
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                if let line = PondInviteText.expiry(invite.expiresAt, now: ctx.date) {
                    Text(verbatim: "\(line) \u{00B7} joins as \(role.word.lowercased())").font(Typo.footnote).foregroundStyle(Theme.muted)
                }
            }
        }
    }
}

// MARK: Join

struct JoinPondSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var name = NSFullUserName()
    @State private var phase: Phase = .entering
    private var ponds: PondsModel { .shared }

    enum Phase: Equatable { case entering, sending, waiting(pondId: String), joined(name: String) }

    var body: some View {
        SheetFrame("Join a pond") {
            switch phase {
            case .entering, .sending:
                TextField("Paste the invite code", text: $code).textFieldStyle(.roundedBorder).font(Typo.code)
                TextField("Your name in the pond", text: $name).textFieldStyle(.roundedBorder)
                Text("An owner approves you on their Mac before you see anything.").font(Typo.footnote).foregroundStyle(Theme.muted)
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                    Button(phase == .sending ? "Asking\u{2026}" : "Ask to join") { ask() }
                        .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                        .disabled(phase == .sending || !PondInviteText.canJoin(code: code, name: name))
                }
            case .waiting(let id):
                HStack(spacing: Space.s) {
                    WorkingGlyph(width: 20, height: 15)
                    Text("Waiting for the owner to approve").font(Typo.label).foregroundStyle(Theme.ink)
                }
                Text("You can close this. The pond appears in the sidebar once you\u{2019}re approved.").font(Typo.body).foregroundStyle(Theme.muted)
                HStack { Spacer(); Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.defaultAction) }
                    .task(id: id) { await waitForApproval(id) }
            case .joined(let pond):
                Text(verbatim: "You\u{2019}re in \(pond).").font(Typo.body).foregroundStyle(Theme.ink)
                HStack {
                    Spacer()
                    Button("Open") { ponds.route = .home(project: pond); dismiss() }.buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { ponds.note = nil }
    }

    private func ask() {
        guard let clean = PondInviteText.cleaned(code) else { return }
        phase = .sending
        Task {
            if let r = await ponds.join(code: clean, name: name.trimmingCharacters(in: .whitespaces)) {
                phase = r.isPending ? .waiting(pondId: r.pondId) : .joined(name: ponds.ponds.first { $0.id == r.pondId }?.name ?? "the pond")
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
            if let p = ponds.ponds.first(where: { $0.id == id }) { phase = .joined(name: p.name); return }
        }
    }
}
