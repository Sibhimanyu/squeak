import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, a Squeak chat's history: quiet actions on a hovered message (Edit, Fork from here, Restore files),
// the inline editor, the restore confirm and the "N files changed" on the fold. The host does the work
// (src/native/host.ts: turns, revert, fork, edit); the words and rules are `NativeHistory`.

struct RestoreAsk: Identifiable, Equatable {
    var id: Int { turn.turn }
    var hostId: String
    var turn: NativeTurn
}

@MainActor @Observable
final class HistoryModel {
    static let shared = HistoryModel()
    /// The host id the turns belong to.
    var hostId: String?
    var turns: [NativeTurn] = []
    var editingTurn: Int?
    var editText = ""
    var alsoRestore = false
    var restoreAsk: RestoreAsk?
    var busy = false
    var restoreError: String?

    func turns(for id: String?) -> [NativeTurn] { id == hostId ? turns : [] }
    func cancelEdit() { editingTurn = nil; editText = ""; alsoRestore = false }
}

/// What a user message needs to offer its actions.
struct HistoryHandle {
    var session: HostSession
    var turn: NativeTurn
    /// Why the actions are off right now; nil when they work.
    var disabled: String?
}

extension AppModel {
    var history: HistoryModel { HistoryModel.shared }

    func loadTurns(_ s: HostSession) async {
        guard !demoMode, !captureMode, let id = hostId(s) else { return }
        if history.hostId != id { history.hostId = id; history.turns = []; history.cancelEdit() }
        // A host that predates checkpoints answers 404: no actions, nothing said.
        let read = (try? await nativeHost.turns(sessionId: id)) ?? []
        if history.hostId == id, read != history.turns { history.turns = read }
    }

    /// Fork the chat at a turn (nil: its latest) and open the copy.
    func forkChat(_ s: HostSession, atTurn: Int? = nil) {
        guard let id = hostId(s), !history.busy else { return }
        if demoMode { native.note = "Demo data: nothing is forked."; return }
        if let why = NativeHistory.disabledReason(working: s.state == .working) { native.note = why; return }
        history.busy = true
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            defer { history.busy = false }
            do {
                let fork = try await nativeHost.fork(sessionId: id, atTurn: atTurn)
                AppLog.info("native chat forked")
                await openNativeSession(fork)
            } catch let e as NativeHostError {
                native.note = e.reason
            } catch {
                native.note = "Squeak couldn't fork the chat"
            }
        }
    }

    func submitEdit(_ s: HostSession, turn: Int) {
        guard let id = hostId(s), !history.busy, let text = NativeHistory.trimmedEdit(history.editText) else { return }
        if demoMode { native.note = "Demo data: nothing is sent."; return }
        let revert = history.alsoRestore
        history.busy = true
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            defer { history.busy = false }
            do {
                let fork = try await nativeHost.edit(sessionId: id, turn: turn, text: text, revertFiles: revert)
                AppLog.info("native message edited")
                history.cancelEdit()
                await openNativeSession(fork)
            } catch let e as NativeHostError {
                // An uncertain edit may have made the copy: say so rather than offering a second try.
                if case .uncertain = e { native.note = "\(e.reason) Check the sidebar before editing again." } else { native.note = e.reason }
            } catch {
                native.note = "Squeak couldn't edit the message"
            }
        }
    }

    func restoreFiles(_ ask: RestoreAsk) {
        guard !history.busy else { return }
        if demoMode { history.restoreAsk = nil; native.note = "Demo data: nothing is restored."; return }
        history.busy = true
        history.restoreError = nil
        Task { [weak self] in
            guard let self else { return }
            defer { history.busy = false }
            do {
                try await nativeHost.revertFiles(sessionId: ask.hostId, turn: ask.turn.turn, to: "start")
                AppLog.info("native files restored")
                history.restoreAsk = nil
                native.note = "Files restored to before message \(ask.turn.turn)."
                git.lastRead[ask.hostId] = nil
                await broker.refreshTranscript()
            } catch let e as NativeHostError {
                history.restoreError = e.reason
            } catch {
                history.restoreError = "Squeak couldn't restore the files"
            }
        }
    }

    private func openNativeSession(_ s: NativeSession) async {
        let key = SessionKey(provider: "\(s.agent)-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + s.id)
        await broker.refresh()
        let end = Date().addingTimeInterval(5)
        while Date() < end, !sessions.contains(where: { $0.key == key }) { try? await Task.sleep(for: .milliseconds(200)) }
        open(key)
    }
}

// MARK: Hover actions

struct HistoryActions: View {
    let handle: HistoryHandle
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 2) {
            action(.squarePen, "Edit message") {
                model.history.editText = handle.turn.text
                model.history.alsoRestore = false
                model.history.editingTurn = handle.turn.turn
            }
            action(.gitBranch, "Fork from here") { model.forkChat(handle.session, atTurn: handle.turn.turn) }
            if NativeHistory.canRestore(handle.turn) {
                action(.history, "Restore files to before this") {
                    model.history.restoreError = nil
                    if let id = model.hostId(handle.session) { model.history.restoreAsk = RestoreAsk(hostId: id, turn: handle.turn) }
                }
            }
        }
    }

    private func action(_ icon: LucideName, _ label: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Lucide(icon, size: 13, color: handle.disabled == nil ? Theme.muted : Theme.subtle)
                .frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(handle.disabled != nil || model.history.busy)
        .help(handle.disabled ?? label)
        .accessibilityLabel(label)
    }
}

// MARK: Inline editor

struct HistoryEditor: View {
    let handle: HistoryHandle
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var history = model.history
        VStack(alignment: .leading, spacing: Space.s) {
            TextEditor(text: $history.editText)
                .font(.system(size: 14)).scrollContentBackground(.hidden)
                .focused($focused)
                .frame(minHeight: 72, maxHeight: 220)
                .padding(8)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.lineStrong))
            if NativeHistory.canRestore(handle.turn) {
                Toggle(isOn: $history.alsoRestore) { Text("Also restore files to before this message").font(Typo.body) }
                    .toggleStyle(.checkbox)
            }
            HStack(spacing: Space.s) {
                Text("Sends a copy of the chat from here; this one stays as it is.").font(Typo.meta).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
                Button("Cancel") { model.history.cancelEdit() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button { model.submitEdit(handle.session, turn: handle.turn.turn) } label: {
                    HStack(spacing: 6) {
                        if model.history.busy { DotGridLoader(size: 12) }
                        Text("Send")
                        Text("⌘↵").font(Typo.meta)
                    }
                }
                .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.return, modifiers: .command)
                .disabled(NativeHistory.trimmedEdit(model.history.editText) == nil || model.history.busy || handle.disabled != nil)
            }
        }
        .frame(maxWidth: .infinity)
        .onAppear { focused = true }
    }
}

// MARK: Restore confirm

struct RestoreSheet: View {
    let ask: RestoreAsk
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Restore files to before this message?").font(Typo.heading).foregroundStyle(Theme.ink)
            Text(NativeHistory.restoreSummary(turn: ask.turn.turn))
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if ask.turn.files.isEmpty {
                Text("That message's own turn changed no files. Anything later turns changed is put back too.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("The message changed").font(Typo.meta).foregroundStyle(Theme.muted)
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(ask.turn.files, id: \.self) { f in
                            Text(verbatim: NativeHistory.fileLine(f)).font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }
            if let error = model.history.restoreError {
                Text(verbatim: error).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Space.s) {
                Spacer(minLength: 0)
                Button("Cancel") { model.history.restoreAsk = nil }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button { model.restoreFiles(ask) } label: {
                    HStack(spacing: 6) {
                        if model.history.busy { DotGridLoader(size: 12) }
                        Text("Restore files")
                    }
                }
                .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(model.history.busy)
            }
        }
        .padding(Space.l).frame(width: 440)
        .background(Theme.surfaceRaised)
    }
}
