import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the transcript's quiet parts: thinking, tool calls, the "Worked · N steps" fold, the working
// row and the background strip. Tokens only; hairlines, no shadow; nothing jumps.

/// A key as a small hairline chip (`⌘.`, `↵`).
struct KeyCap: View {
    let text: String
    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(Theme.muted)
            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 16)
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            .accessibilityHidden(true)
    }
}

// MARK: Turn

/// The steps of a turn between its two messages: a fold for the older ones, then the newest as rows.
struct TurnBlockView: View {
    let block: TurnBlock
    /// "3 files changed", from the host's checkpoints (a Squeak chat's finished turn); nil when none.
    var filesLine: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Per-turn "Expand all / Collapse all" and ⌃O both land in `expand`; a row's own toggle still works after.
    @State private var expand = TurnExpansion()
    private var prefs = WorkbenchPrefs.shared

    private var hasDetails: Bool {
        (block.folded + block.shown).contains {
            switch $0 {
            case .tool(_, _, _, let d): d?.expands == true
            case .thinking(_, let text, _, _): !text.isEmpty
            }
        }
    }

    /// No "Worked · N steps" fold while reading (owner's correction 2026-11-09): every thinking block and tool call
    /// shows, each as its own row. "Expand all" (and ⌃O) opens the details that have them.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if hasDetails {
                HStack {
                    if let filesLine { Text(verbatim: filesLine).font(Typo.meta).foregroundStyle(Theme.muted) }
                    Spacer(minLength: 0)
                    Button(expand.open ? "Collapse all" : "Expand all") {
                        withAnimation(Motion.standard) { expand.toggleTurn() }
                    }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
                    .accessibilityHint("Opens or closes every step's detail")
                }
                .padding(.bottom, 4)
            }
            items(block.folded + block.shown)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: prefs.generation) {
            expand.applyGlobal(generation: prefs.generation, allOpen: prefs.allOpen)
        }
    }

    /// One stack with the gap above each item from `TurnLayout`: consecutive tool rows 4 pt apart, a change of kind 8.
    private func items(_ list: [TurnItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(TurnLayout.entries(list)) { entry in
                Group {
                    switch entry.item {
                    case .thinking(_, let text, let seconds, let live): ThinkingRow(text: text, seconds: seconds, live: live, expand: expand)
                    case .tool(_, let preview, let running, let detail): ToolCallRow(preview: preview, running: running, detail: detail, expand: expand)
                    }
                }
                .padding(.top, entry.gap)
            }
        }
    }
}

/// A finished turn, folded under its reply like Conductor's: one quiet line ("Worked for 2m 4s · 14 steps") that opens to
/// the turn's thinking and tool calls, each as in the live turn. Closed until asked.
struct FoldedTurnView: View {
    let steps: [ActivityStep]
    /// The steers sent into this turn (time and words): the opened steps sit above and below each, as they happened.
    var steers: [(at: Date, text: String)] = []
    var filesLine: String?
    @State private var open = false

    var body: some View {
        let block = TurnFolding.finished(steps: steps)
        let title = TurnFolding.foldedTitle(steps: steps, items: block.folded.count) ?? "Worked"
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(Motion.standard) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text(verbatim: title).font(.system(size: 14)).foregroundStyle(Theme.muted).lineLimit(1)
                    Lucide(.chevronRight, size: 12, color: Theme.subtle).rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 2).frame(minHeight: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
            if open {
                let runs = TurnFolding.split(steps: steps.filter { $0.kind != "progress" && $0.kind != "retry" }, at: steers.map(\.at))
                let ordered = steers.sorted { $0.at < $1.at }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(runs.enumerated()), id: \.offset) { n, run in
                        if n > 0 { SteerCard(text: ordered[n - 1].text, state: .taken, cwd: nil) }
                        let b = TurnFolding.finished(steps: run)
                        if !b.isEmpty { TurnBlockView(block: TurnBlock(folded: [], shown: b.folded), filesLine: n == runs.count - 1 ? filesLine : nil) }
                    }
                }
                .padding(.top, 4).transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Thinking on one line ("Thought for 3s", "Thinking…" while live); its summary opens under it. Collapsed by default,
/// like Conductor: the steps are what you read, the thinking is there when you want it.
struct ThinkingRow: View {
    let text: String
    let seconds: Int?
    let live: Bool
    var expand = TurnExpansion()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false

    private var title: String { TurnLayout.thinkingTitle(seconds: seconds, live: live) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard !text.isEmpty else { return }
                withAnimation(Motion.standard) { open.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Lucide(.brain, size: 14, color: Theme.muted).frame(width: 18)
                    Text(verbatim: title).font(.system(size: 14)).foregroundStyle(Theme.muted).lineLimit(1)
                    if !text.isEmpty { Lucide(.chevronRight, size: 12, color: Theme.subtle).rotationEffect(.degrees(open ? 90 : 0)) }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 2).frame(minHeight: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onChange(of: expand) { _, ask in if !text.isEmpty { open = ask.open } }
            if open, !text.isEmpty {
                // Thinking is the quietest text (`subtle`); no bottom padding, so the next row's own gap is the only gap.
                Text(verbatim: text).font(.system(size: 14)).foregroundStyle(Theme.subtle)
                    .lineSpacing(CGFloat(Tokens.Workbench.readingLeading)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .padding(.leading, 28)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

/// The chat's model name and the catalogue, for a started subagent's row: its own model, else "same as chat".
struct AgentModelContext: Equatable {
    var chatModelName: String?
    var choices: [DaemonChatModel] = []
}
private struct AgentModelContextKey: EnvironmentKey { static let defaultValue = AgentModelContext() }
extension EnvironmentValues {
    var agentModelContext: AgentModelContext {
        get { self[AgentModelContextKey.self] }
        set { self[AgentModelContextKey.self] = newValue }
    }
}

/// One 24pt tool row: icon, name, target in mono (truncated), duration, chevron. Opens to output or a diff only when the transcript
/// holds one (none does yet), so a row without detail shows no chevron and does not respond.
struct ToolCallRow: View {
    let preview: ToolCallPreview
    let running: Bool
    let detail: ToolDetail?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.agentModelContext) private var agentContext
    @Environment(\.pathLinker) private var linker
    var expand = TurnExpansion()
    @State private var open = false
    @State private var hovering = false
    private var expandable: Bool { detail?.expands == true }
    /// The file a Read/Write/Edit row is about, in full (the label keeps only the name).
    private var targetPath: String? { preview.targetIsPath || preview.kind == .edit ? detail?.path : nil }
    private var agentModel: String? { preview.agentModel(chatModelName: agentContext.chatModelName, in: agentContext.choices) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard expandable else { return }
                withAnimation(Motion.standard) { open.toggle() }
            } label: { row }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .onChange(of: expand) { _, ask in
                    guard expandable else { return }
                    open = ask.open
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(preview.shownVerb)\(agentModel.map { " · \($0)" } ?? "") \(preview.target)\(running ? ", running" : "")")
            if case .image(let path, let caption, let card)? = detail {
                StepImageView(path: path, caption: caption, card: card).padding(.leading, 28).padding(.top, 4).padding(.bottom, 4)
            } else if open, let detail, expandable {
                ToolDetailView(detail: detail).padding(.top, 2).padding(.bottom, 6).transition(.opacity)
            }
        }
    }

    /// Body size: a ">_" icon (a command) or the kind's own, a plain description, the target in a mono chip.
    private var row: some View {
        HStack(spacing: 10) {
            Lucide(Self.icon(preview.kind), size: 14, color: Theme.muted).frame(width: 18)
            Text(verbatim: preview.shownVerb).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
            if let agentModel {
                Text(verbatim: "· \(agentModel)").font(.system(size: 14)).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
            }
            Text(verbatim: preview.target).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1)
                .underline(targetPath.map { linker?.isLinkable($0) == true } ?? false)
                .truncationMode(preview.targetIsPath ? .head : .tail)
                .padding(.horizontal, 7).frame(height: 20)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.chip))
                .layoutPriority(-1)
            Spacer(minLength: 8)
            if running { DotGridLoader(size: 12) }
            if let meta = preview.meta {
                Text(verbatim: meta).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
            }
            if expandable {
                Lucide(.chevronRight, size: 12, color: Theme.subtle).rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .padding(.horizontal, 2).frame(minHeight: 24)
        .background(hovering && expandable ? Theme.selected.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
        .contentShape(Rectangle())
        .contextMenu { pathMenu }
    }

    /// Right-click: the actions for the file the row names, or for the existing paths in a command (only when they exist).
    @ViewBuilder private var pathMenu: some View {
        if let linker {
            let paths = targetPath.map { [$0] } ?? (preview.kind == .run ? linker.existing(in: preview.target) : [])
            ForEach(paths.filter { linker.isLinkable($0) }, id: \.self) { path in
                Menu(ChangesPresentation.fileName(path)) {
                    ForEach(PathLinking.Action.allCases, id: \.self) { action in
                        Button(action.title) { linker.perform(action, raw: path) }
                    }
                }
            }
        }
    }

    static func icon(_ kind: ToolKind) -> LucideName {
        switch kind {
        case .read: .fileText
        case .edit: .filePen
        case .run: .terminal   // the ">_" glyph
        case .search: .search
        case .fetch: .link
        case .agent: .users
        case .plan: .clipboardList
        case .other: .wrench
        }
    }
}

struct ToolDetailView: View {
    let detail: ToolDetail
    @State private var showAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch detail {
            case .output(let command, let tail, let succeeded): output(command, tail, succeeded)
            case .diff(let path, let lines): diff(path, lines)
            case .subagent(let steps, let result, let state): subagent(steps, result, state)
            case .text(let text): plain(text)
            case .progress, .image, .file: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
    }

    private func output(_ command: String, _ tail: [String], _ ok: Bool?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(verbatim: "$ \(command)").font(Typo.code).foregroundStyle(Theme.ink).lineLimit(2)
                Spacer(minLength: 0)
                if ok == true { Lucide(.check, size: 12, color: Theme.working) }
            }
            ForEach(Array(tail.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10).textSelection(.enabled)
    }

    @ViewBuilder private func diff(_ path: String, _ lines: [InlineDiffLine]) -> some View {
        let stat = InlineDiff.stat(lines)
        let shown = InlineDiff.visible(lines, showAll: showAll)
        HStack(spacing: 8) {
            Lucide(.filePen, size: 14, color: Theme.muted)
            Text(verbatim: path).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 0)
            Text(verbatim: "+\(stat.added)").font(Typo.code).foregroundStyle(Theme.working)
            Text(verbatim: "−\(stat.removed)").font(Typo.code).foregroundStyle(Theme.negative)
        }
        .padding(.horizontal, 12).frame(height: 32)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.lines.enumerated()), id: \.offset) { _, l in diffLine(l) }
        }
        .padding(.vertical, 4)
        if shown.hidden > 0 {
            Button("Show all \(lines.count) lines") { showAll = true }
                .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.horizontal, 12).padding(.bottom, 8)
        }
    }

    /// A subagent's steps as a thread under its row, then its answer once it reported.
    @ViewBuilder private func subagent(_ steps: [String], _ result: String?, _ state: SubagentState) -> some View {
        let shown = showAll || steps.count <= 12 ? steps : Array(steps.suffix(12))
        VStack(alignment: .leading, spacing: 4) {
            if shown.count < steps.count {
                Button("Show all \(steps.count) steps") { showAll = true }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                let p = ToolCallLabel.preview(line)
                HStack(spacing: 6) {
                    Lucide(ToolCallRow.icon(p.kind), size: 12, color: Theme.subtle).frame(width: 14)
                    Text(verbatim: line).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        .truncationMode(p.targetIsPath ? .head : .tail)
                }
            }
            if state == .failed, result == nil {
                Text("Stopped before it answered").font(Typo.meta).foregroundStyle(Theme.negative)
            } else if state == .done, steps.isEmpty, result == nil {
                Text("Finished").font(Typo.meta).foregroundStyle(Theme.subtle)
            } else if steps.isEmpty, result == nil {
                Text("Starting…").font(Typo.meta).foregroundStyle(Theme.subtle)
            }
            if let result {
                Text(verbatim: result).font(Typo.body).foregroundStyle(Theme.ink).lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .padding(.top, steps.isEmpty ? 0 : 6)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.lineStrong).frame(width: 1).padding(.vertical, 10) }
    }

    private func plain(_ text: String) -> some View {
        Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.ink).lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private func diffLine(_ l: InlineDiffLine) -> some View {
        let sign = l.kind == .added ? "+" : l.kind == .removed ? "−" : " "
        return HStack(alignment: .top, spacing: 0) {
            Text(verbatim: l.number.map(String.init) ?? "").font(Typo.code).foregroundStyle(Theme.subtle)
                .frame(width: 40, alignment: .trailing).padding(.trailing, 8)
            Text(verbatim: l.kind == .hunk ? l.text : "\(sign) \(l.text)").font(Typo.code)
                .foregroundStyle(l.kind == .hunk ? Theme.subtle : Theme.ink).lineLimit(1)
            Spacer(minLength: 0)
        }
        .frame(height: 18)
        .background(l.kind == .added ? Theme.working.opacity(0.12) : l.kind == .removed ? Theme.negative.opacity(0.12) : .clear)
    }
}

// MARK: Progress tracker

/// The tracker an agent keeps above the composer with Squeak's update_progress tool: its stages as a row with
/// the current one lit, an optional bar and a one-line status. It replaces itself on every update and goes when
/// the agent clears it.
struct ProgressTracker: View {
    let steps: [String]
    let current: Int?
    let percent: Double?
    let status: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, label in
                    let done = (current ?? -1) > i, now = current == i
                    if i > 0 { Rectangle().fill(done || now ? Theme.ink.opacity(0.5) : Theme.line).frame(height: 1).frame(maxWidth: 24) }
                    HStack(spacing: 4) {
                        if done { Lucide(.check, size: 11, color: Theme.muted) }
                        else if now { DotGridLoader(size: 10) }
                        Text(verbatim: label).font(Typo.meta).lineLimit(1)
                            .foregroundStyle(now ? Theme.ink : done ? Theme.muted : Theme.subtle)
                    }
                }
                Spacer(minLength: 0)
                if let percent { Text(verbatim: "\(Int(percent.rounded()))%").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
            }
            if let percent {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.line)
                        Capsule().fill(Theme.ink.opacity(0.6)).frame(width: g.size.width * min(1, max(0, percent / 100)))
                    }
                }
                .frame(height: 3)
            }
            if let status, !status.isEmpty {
                Text(verbatim: status).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Progress: \(current.flatMap { steps.indices.contains($0) ? steps[$0] : nil } ?? "")\(status.map { ", \($0)" } ?? "")")
    }
}

// MARK: Working row and background

/// The running line (§8.10, owner's correction 2026-11-09): Squeak's matrix glyph and the clock ("2m, 38.1s"), with the
/// next-request/update button at the right when another chat needs you. It sits in the dock, reserved for as long
/// as a turn runs, so the transcript and the composer can never clip it. ⌘. still stops (no hint text; the composer's
/// stop button is the visible one).
struct WorkbenchLiveRow: View {
    let steps: [ActivityStep]
    let since: Date?
    /// What the chat is doing in words ("Working…", "Waiting for you to allow a command"); nil draws glyph and clock only.
    var label: String?
    /// A way to stop this chat; the `⌘.` shortcut is only there when there is one.
    let onStop: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            WorkingGlyph(width: 26, height: 15)
            if let label { Text(verbatim: label).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1) }
            if let since { LiveClockText(since: since) }
            Spacer(minLength: 8)
            NextAttentionPill()
        }
        .frame(height: 40)
        .background {
            if let onStop {
                Button("Stop", action: onStop).keyboardShortcut(".", modifiers: .command).opacity(0).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label ?? LiveStepLine.line(steps: steps, since: since, now: Date()))
    }
}

/// The only ticking element of the running line: once a second, in its own leaf, so a tick invalidates this one Text
/// and never the dock or the transcript around it.
struct LiveClockText: View {
    let since: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(verbatim: ElapsedFormat.live(context.date.timeIntervalSince(since)))
                .font(.system(size: 13, design: .monospaced)).monospacedDigit().foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
        }
    }
}

/// The agent's message as it is being written, in a leaf of its own: only this view reads the buffer, so a token
/// redraws this row and never the detail view around it. Empty (no height, no gap) until text arrives.
struct StreamingRow<Content: View>: View {
    let buffer: StreamingTextBuffer
    @ViewBuilder let content: (String) -> Content

    var body: some View {
        let text = buffer.text
        VStack(alignment: .leading, spacing: 0) {
            if !text.isEmpty { content(text).padding(.top, ChatSpacing.messageToMessage) }
        }
    }
}
