import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector's Review, Setup and Run tabs: the content Squeak already had (the comments waiting
// to go to the chat, the setup log, the run script) given the place a workspace's tools sit in.

/// Review: the diff comments waiting to be sent, as a list, with Send to chat. Comments are added from a line in Changes.
struct ReviewTab: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: session.key.hostSessionId)
        if store.tray.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("No review comments yet.").font(Typo.heading).foregroundStyle(Theme.ink)
                Text("Click the + beside a line in Changes to note something for the agent. They wait here until you send them as one message.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            Spacer(minLength: 0)
        } else {
            CommentTray(store: store, session: session, startsOpen: true)
            Spacer(minLength: 0)
        }
    }
}

/// Setup: the workspace's setup log, following it while the script runs. Squeak's own chats only.
struct SetupTab: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @State private var log: NativeWorkspaceLog?
    @State private var failed = false

    var body: some View {
        let ws = model.git.workspace(path: session.cwd)
        VStack(alignment: .leading, spacing: Space.s) {
            if let ws {
                HStack(spacing: Space.s) {
                    Text("Setup log").font(Typo.heading).foregroundStyle(Theme.ink)
                    if let mark = log.flatMap({ WorkspaceLifecycle.mark($0.state) }) { LifecycleSlot(mark: mark) }
                    Spacer(minLength: 0)
                }
                ScrollView {
                    Text(verbatim: text).font(Typo.code).foregroundStyle(log?.log.isEmpty == false ? Theme.ink : Theme.muted)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.s)
                }
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                .task(id: ws.id) {
                    log = nil
                    while !Task.isCancelled {
                        if let read = try? await model.nativeHost.workspaceLog(workspaceId: ws.id) { log = read; failed = false } else { failed = true }
                        if log.map({ $0.state != "setting_up" }) == true { break }
                        try? await Task.sleep(for: .seconds(2))
                    }
                }
            } else {
                Text("This chat has no stream Squeak set up.").font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
        .padding(Space.m).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var text: String {
        if let text = log?.log, !text.isEmpty { return text }
        if failed { return "Squeak couldn't read the log." }
        return log == nil ? "Reading the log…" : "The setup script printed nothing."
    }
}

/// Run: the run script's state and the tail of its output; Run / Stop and Open localhost. Squeak's own chats only.
struct RunTab: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if let ws = model.git.workspace(path: session.cwd) {
            let run = model.git.runs[ws.id]
            let port = run?.port ?? ws.port
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Text(run?.running == true ? "Running" : "Not running").font(Typo.heading).foregroundStyle(Theme.ink)
                    if run?.running == true { DotGridLoader(size: 12) }
                    if run?.running == true, let port { Text(verbatim: ":\(port)").font(Typo.code).foregroundStyle(Theme.subtle) }
                    Spacer(minLength: 0)
                    if run?.running == true, WorkspaceLifecycle.localhostURL(port: port) != nil {
                        Button("Open localhost") { model.openLocalhost(ws) }.buttonStyle(QuietButtonStyle())
                    }
                    Button(run?.running == true ? "Stop" : "Run") { model.toggleRun(ws) }
                        .buttonStyle(SecondaryButtonStyle()).disabled(ws.state != "ready")
                }
                ScrollView {
                    Text(verbatim: output(run)).font(Typo.code).foregroundStyle(run?.logTail.isEmpty == false ? Theme.ink : Theme.muted)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(Space.s)
                }
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            .padding(Space.m).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            Text("This chat has no stream Squeak runs a script in.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
            Spacer(minLength: 0)
        }
    }

    private func output(_ run: NativeRunStatus?) -> String {
        if let tail = run?.logTail, !tail.isEmpty { return tail }
        return run?.running == true ? "The run script has printed nothing yet." : "Run starts the pond's run script. Its output shows here."
    }
}

// MARK: Rules, in the chat's header

/// A Squeak chat's allow rules (what "Allow for this chat" keeps), each removable, in a popover from a shield in the
/// header. Hidden for any other chat and when the host has no rules route (an older service answers 404).
struct ChatRulesButton: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @State private var open = false

    var body: some View {
        if session.source == .squeak, model.native.key == session.key, let rules = model.native.rules {
            Button { open.toggle() } label: {
                HStack(spacing: 4) {
                    Lucide(.shield, size: 14, color: rules.isEmpty ? Theme.muted : Theme.ink)
                    if !rules.isEmpty { Text("\(rules.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
                }
                .frame(minWidth: 28, minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("What this chat is allowed to do without asking")
            .accessibilityLabel("Rules for this chat, \(rules.count)")
            .popover(isPresented: $open, arrowEdge: .bottom) { popover(rules) }
        }
    }

    private func popover(_ rules: [NativeRule]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Rules").font(Typo.heading).foregroundStyle(Theme.ink)
            if rules.isEmpty {
                Text("None. Allow for this chat on an approval adds one.").font(Typo.body).foregroundStyle(Theme.muted)
            }
            ForEach(rules) { rule in
                HStack(spacing: 8) {
                    Text(verbatim: rule.text).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(2).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button { model.nativeRemoveRule(session, rule) } label: {
                        Lucide(.x, size: 12, color: Theme.muted).frame(width: 22, height: 22).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("Remove this rule").accessibilityLabel("Remove rule \(rule.text)")
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            if let note = model.native.rulesNote { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }
        }
        .frame(width: 320, alignment: .leading).padding(Space.m)
    }
}
