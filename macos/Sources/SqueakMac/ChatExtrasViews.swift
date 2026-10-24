import SqueakMacCore
import SwiftUI

/// The chat's model line under its header. Where the daemon can change it, it is a menu: the models it offers for
/// this chat's own agent, the chosen model's thinking levels and fast mode, each applied as it is picked. Locked
/// while a turn runs or waits on you.
struct ChatSetupLine: View {
    let session: HostSession
    let extras: ChatExtras
    @Environment(AppModel.self) private var model

    private var midTurn: Bool { session.state == .working || session.state == .blocked && session.pendingQuestion == nil }

    var body: some View {
        if let line = extras.setupLine {
            let choices = extras.choices(from: model.chatModels)
            if choices.isEmpty || session.conductorSessionId == nil {
                Text(verbatim: line).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            } else {
                Menu {
                    Section("Model") {
                        ForEach(choices) { option in
                            Toggle(option.label, isOn: Binding(get: { option.id == extras.modelId }, set: { _ in
                                Task { await model.changeSetup(session, model: option.id) }
                            }))
                        }
                    }
                    if let current = choices.first(where: { $0.id == extras.modelId }), !current.levels.isEmpty {
                        Section("Thinking") {
                            ForEach(current.levels, id: \.self) { level in
                                Toggle(DaemonChatModel.levelName(level), isOn: Binding(get: { level == extras.effortId }, set: { _ in
                                    Task { await model.changeSetup(session, model: current.id, thinking: level) }
                                }))
                            }
                        }
                    }
                    if let current = choices.first(where: { $0.id == extras.modelId }), extras.agent == "claude" {
                        Toggle("Fast mode", isOn: Binding(get: { extras.fast }, set: { on in
                            Task { await model.changeSetup(session, model: current.id, fast: on) }
                        }))
                    }
                } label: {
                    Text(verbatim: line).font(Typo.meta)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .padding(.leading, -4)
                .foregroundStyle(Theme.muted)
                .disabled(midTurn || model.chatBusy)
                .help(midTurn ? "Change the model once this turn ends" : "Change the model or thinking level")
                .accessibilityLabel("Model: \(line)")
            }
        }
    }
}

/// The chat's workspace actions, beside Open in Conductor.
struct ChatActionsMenu: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    private var resting: Bool { session.state != .working && !(session.state == .blocked && session.pendingQuestion == nil) }

    var body: some View {
        Menu {
            Button("Open a pull request") { Task { await model.askForPullRequest(session) } }
                .disabled(!resting)
            Divider()
            Button("Archive workspace…", role: .destructive) { Task { await model.archiveWorkspace(session) } }
                .disabled(!resting)
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .modifier(GlassBorderedButton())
        .help("Workspace actions")
        .accessibilityLabel("Workspace actions")
        .disabled(model.chatBusy)
    }
}

/// A working chat with no word from the model for minutes: what it waits on, for how long, and Conductor's Stop.
struct StuckCard: View {
    let stall: DaemonStall
    let stop: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(spacing: Space.m) {
                Circle().fill(Theme.needsYou).frame(width: 8, height: 8).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Seems stuck").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: "\(stall.line(now: context.date)). Stop it, then send a message to run the turn again.")
                        .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(2)
                }
                Spacer(minLength: Space.s)
                Button("Stop", action: stop).buttonStyle(SecondaryButtonStyle()).disabled(model.chatBusy)
            }
            .padding(.horizontal, Space.m).padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(alignment: .leading) {
                Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            .accessibilityElement(children: .combine)
        }
    }
}

/// The chat's subagents and background shells: one line, opening to a row each with its time and how it ended.
/// Folded by default above two, or when the stuck card shows too.
struct BackgroundStrip: View {
    let extras: ChatExtras
    /// Something else sits above the composer too (the stuck card): start folded, the window is only so tall.
    var crowded = false
    @State private var open: Bool?

    private var isOpen: Bool { open ?? (extras.background.count <= 2 && !crowded) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 0) {
                Button { open = !isOpen } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: "square.stack.3d.up").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        Text(verbatim: extras.backgroundSummary ?? "").font(Typo.label).foregroundStyle(Theme.ink)
                        Spacer(minLength: Space.s)
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
                            .rotationEffect(.degrees(isOpen ? 180 : 0))
                    }
                    .padding(.horizontal, Space.m).frame(minHeight: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Background work: \(extras.backgroundSummary ?? "")")
                if isOpen {
                    ForEach(extras.background) { task in
                        Divider()
                        row(task, now: context.date)
                    }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
    }

    private func row(_ task: DaemonBackgroundTask, now: Date) -> some View {
        HStack(spacing: Space.s) {
            Image(systemName: task.kind == "agent" ? "person.2" : "terminal")
                .font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 16).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: task.label).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                if task.status != "running", let summary = task.summary, !summary.contains(task.label) || task.kind == "shell" {
                    Text(verbatim: summary).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: Space.s)
            let time = task.duration(now: now)
            switch task.status {
            case "running":
                HStack(spacing: 5) {
                    Circle().fill(Theme.working).frame(width: 6, height: 6)
                    if let time { Text(verbatim: time).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
                }
            case "done":
                Label(time ?? "done", systemImage: "checkmark").font(Typo.meta).foregroundStyle(Theme.muted)
            case "failed":
                Label("failed", systemImage: "xmark").font(Typo.meta).foregroundStyle(Theme.error)
            default:
                Text("stopped").font(Typo.meta).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }
}
