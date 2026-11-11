import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The chat's model line under its header. Where the daemon can change it, it is a menu: the models it offers for
/// this chat's own agent, the chosen model's thinking levels and fast mode, each applied as it is picked. Locked
/// while a turn runs or waits on you.
struct ChatSetupLine: View {
    let session: HostSession
    let extras: ChatExtras
    /// Inside the composer's control row: no hanging indent.
    var inline = false
    @Environment(AppModel.self) private var model

    private var midTurn: Bool { session.state == .working || session.state == .blocked && session.pendingQuestion == nil }

    var body: some View {
        if let line = extras.setupLine {
            let choices = extras.choices(from: model.chatModels)
            if choices.isEmpty || session.conductorSessionId == nil {
                Text(verbatim: line).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            } else {
                SqueakMenu {
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
                .padding(.leading, inline ? 0 : -4)
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
        SqueakMenu {
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
                Lucide(.triangleAlert, size: 14, color: Theme.warning).accessibilityHidden(true)
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
                Capsule().fill(Theme.negative).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            .accessibilityElement(children: .combine)
        }
    }
}

/// The chat's subagents and background shells, one chevron: collapsed, a single line (icon, "Background", a summary
/// like "1 subagent · ended" and, when few, a chip each); expanded, one list with a row per task (kind icon, title,
/// status mark, time, and a chevron to open a subagent's own steps). No chips and no second header when open.
struct BackgroundStrip: View {
    let extras: ChatExtras
    /// Something else sits above the composer too (the stuck card): the list still starts folded; kept for callers.
    var crowded = false
    @State private var open = false
    /// The subagent whose steps are showing under its row.
    @State private var expanded: String?

    private var summary: String { extras.backgroundLine ?? "" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 0) {
                header(now: context.date)
                if open {
                    ForEach(extras.background) { task in
                        Divider()
                        if task.canShowSteps, let key = extras.sessionKey {
                            VStack(spacing: 0) {
                                Button { expanded = expanded == task.id ? nil : task.id } label: {
                                    row(task, now: context.date, expandable: true, isExpanded: expanded == task.id)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(expanded == task.id ? "Hides the subagent's steps" : "Shows the subagent's steps")
                                if expanded == task.id {
                                    SubagentFeedView(sessionKey: key, task: task).transition(.opacity)
                                }
                            }
                        } else {
                            row(task, now: context.date)
                        }
                    }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
        .onAppear {
            // Capture only: the demo's running subagent opens at once so a screenshot shows its steps.
            if DemoData.opensSubagent, expanded == nil { open = true; expanded = extras.background.first { $0.canShowSteps && $0.status == "running" }?.id }
        }
    }

    private func header(now: Date) -> some View {
        HStack(spacing: Space.s) {
            Lucide(.layers, size: 14, color: Theme.muted).accessibilityHidden(true)
            Text("Background").font(Typo.label).foregroundStyle(Theme.ink)
            Text(verbatim: summary).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            if !open, BackgroundSummary.showsChips(count: extras.background.count) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(extras.background) { chip($0, now: now) } }
                }
            }
            Spacer(minLength: Space.s)
            Lucide(.chevronDown, size: 12, color: Theme.muted).rotationEffect(.degrees(open ? 180 : 0)).accessibilityHidden(true)
        }
        .padding(.horizontal, Space.m).frame(height: 32).contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Background work: \(summary)")
        .accessibilityHint(open ? "Hides the tasks" : "Shows the tasks")
    }

    private func chip(_ task: DaemonBackgroundTask, now: Date) -> some View {
        HStack(spacing: 5) {
            Text(verbatim: task.kind == "agent" ? task.label : "Shell \(task.label)").lineLimit(1)
            if let time = task.duration(now: now) { Text(verbatim: "· \(time)").monospacedDigit() }
        }
        .font(Typo.meta).foregroundStyle(Theme.muted)
        .padding(.horizontal, 8).frame(height: 22)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.line))
    }

    private func row(_ task: DaemonBackgroundTask, now: Date, expandable: Bool = false, isExpanded: Bool = false) -> some View {
        HStack(spacing: Space.s) {
            Lucide(task.kind == "agent" ? .users : .terminal, size: 13, color: Theme.muted).frame(width: 16).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: task.label).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                if task.status != "running", let summary = task.summary, !summary.contains(task.label) || task.kind == "shell" {
                    Text(verbatim: summary).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: Space.s)
            switch task.status {
            case "running": DotGridLoader(size: 12)
            case "failed": Lucide(.circleX, size: 12, color: Theme.negative).accessibilityLabel("Failed")
            case "done": Lucide(.circleCheck, size: 12, color: Theme.subtle).accessibilityLabel("Done")
            default: Text("stopped").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let time = task.duration(now: now) { Text(verbatim: time).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
            if expandable {
                Lucide(.chevronRight, size: 11, color: Theme.subtle)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0)).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// One subagent's live steps under its row: the same step rows as the Activity tab, read from the daemon every
/// 2 s only while it is open, so the feed alone refreshes and the window's scroll and draft stay as they are.
struct SubagentFeedView: View {
    let sessionKey: String
    let task: DaemonBackgroundTask
    @Environment(AppModel.self) private var model
    @State private var result: Result<DaemonSubagentFeed?, any Error>?
    @State private var shown: SubagentFeedPresentation?

    private var presentation: SubagentFeedPresentation {
        shown ?? SubagentFeedPresentation.make(result: nil, fallbackStatus: task.status)
    }

    var body: some View {
        let p = presentation
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                if let chip = p.chip { StatusChip(text: chip, status: p.chipStatus) }
                if let note = p.clippedNote { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }
                Spacer(minLength: 0)
            }
            if case .steps(let steps) = p.body {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                                ActivityStepRow(step: step, compact: true).id(i)
                                if i < steps.count - 1 { Divider().padding(.leading, 30) }
                            }
                        }
                    }
                    .frame(maxHeight: 220)
                    .onChange(of: steps.count) { _, n in if n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) } }
                    .onAppear { proxy.scrollTo(steps.count - 1, anchor: .bottom) }
                }
            } else if let message = p.message {
                Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg.opacity(0.5))
        .task(id: task.id) {
            while !Task.isCancelled {
                let read = await model.subagentFeed(sessionKey: sessionKey, taskId: task.id)
                let next = SubagentFeedPresentation.make(result: read, previous: shown, fallbackStatus: task.status)
                if next != shown { shown = next }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
}

/// "Running" / "Finished" / "Failed" / "Stopped" as a quiet capsule in the state's own colour.
struct StatusChip: View {
    let text: String
    let status: String?
    private var color: Color {
        switch status {
        case "running": Theme.working
        case "failed": Theme.negative
        default: Theme.muted
        }
    }
    var body: some View {
        Text(verbatim: text).font(Typo.meta.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .accessibilityLabel("Status: \(text)")
    }
}
