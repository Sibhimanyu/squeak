import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the transcript's quiet parts: thinking, tool calls, the "Worked · N steps" fold, the working
// row and the background strip. Tokens only; hairlines, no shadow; nothing jumps.

/// §7 motion tokens.
enum WorkbenchMotion {
    static let quick = Animation.easeOut(duration: 0.12)
    static let standard = Animation.easeOut(duration: 0.2)
    static let emphasis = Animation.timingCurve(0.2, 0.9, 0.3, 1.2, duration: 0.32)

    static func animation(_ a: Animation, reduce: Bool) -> Animation? { reduce ? nil : a }
}

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
    @State private var foldOpen = false
    /// "Expand all" / "Collapse all": every row opens or closes at once; a row's own toggle still works after.
    @State private var expand = ExpandAll(open: false, version: 0)

    private var hasDetails: Bool {
        (block.folded + block.shown).contains { if case .tool(_, _, _, let d) = $0 { d != nil } else { false } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title = block.foldTitle {
                HStack(spacing: 0) {
                Button {
                    withAnimation(WorkbenchMotion.animation(WorkbenchMotion.standard, reduce: reduceMotion)) { foldOpen.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Lucide(.chevronRight, size: 12, color: Theme.muted).rotationEffect(.degrees(foldOpen ? 90 : 0))
                        Text(verbatim: title).font(Typo.body).foregroundStyle(Theme.muted)
                        if let filesLine { Text(verbatim: "· \(filesLine)").font(Typo.body).foregroundStyle(Theme.muted) }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityHint(foldOpen ? "Hides the steps" : "Shows the steps")
                if hasDetails {
                    Button(expand.open ? "Collapse all" : "Expand all") {
                        let next = !expand.open
                        withAnimation(WorkbenchMotion.animation(WorkbenchMotion.standard, reduce: reduceMotion)) {
                            expand = ExpandAll(open: next, version: expand.version + 1)
                            if next { foldOpen = true }
                        }
                    }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
                    .accessibilityHint("Opens or closes every step's detail")
                }
                }
                if foldOpen { items(block.folded).transition(.opacity) }
            }
            items(block.shown)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func items(_ list: [TurnItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(list) { item in
                switch item {
                case .thinking(_, let text, let seconds, let live): ThinkingRow(text: text, seconds: seconds, live: live)
                case .tool(_, let preview, let running, let detail): ToolCallRow(preview: preview, running: running, detail: detail, expand: expand)
                }
            }
        }
    }
}

/// The turn block's expand-all signal: `version` changes on every press, `open` is what it asks of the rows.
struct ExpandAll: Equatable {
    var open: Bool
    var version: Int
}

/// "Thought for 8s", closed once finished; "Thinking…" open and following the summary while live.
struct ThinkingRow: View {
    let text: String
    let seconds: Int?
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false

    private var isOpen: Bool { live || open }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard !live else { return }
                withAnimation(WorkbenchMotion.animation(WorkbenchMotion.standard, reduce: reduceMotion)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Lucide(.chevronRight, size: 12, color: Theme.muted).rotationEffect(.degrees(isOpen ? 90 : 0))
                    Lucide(.brain, size: 14, color: Theme.muted)
                    Text(live ? "Thinking…" : ElapsedFormat.thought(seconds)).font(Typo.body).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(live ? "Thinking" : ElapsedFormat.thought(seconds))
            if isOpen, !text.isEmpty {
                Text(verbatim: text).font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .lineSpacing(5).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.lineStrong).frame(width: 1) }
                    .padding(.leading, 6).padding(.bottom, 6)
                    .transition(.opacity)
            }
        }
    }
}

/// One 28pt tool row: icon, verb column, target, right meta. Opens to output or a diff only when the transcript
/// holds one (none does yet), so a row without detail shows no chevron and does not respond.
struct ToolCallRow: View {
    let preview: ToolCallPreview
    let running: Bool
    let detail: ToolDetail?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var expand = ExpandAll(open: false, version: 0)
    @State private var open = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard detail != nil else { return }
                withAnimation(WorkbenchMotion.animation(WorkbenchMotion.standard, reduce: reduceMotion)) { open.toggle() }
            } label: { row }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .onChange(of: expand) { _, ask in
                    guard detail != nil else { return }
                    open = ask.open
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(preview.shownVerb) \(preview.target)\(running ? ", running" : "")")
            if open, let detail {
                ToolDetailView(detail: detail).padding(.top, 2).padding(.bottom, 6).transition(.opacity)
            }
        }
    }

    private var row: some View {
        HStack(spacing: 8) {
            Lucide(Self.icon(preview.kind), size: 14, color: Theme.muted).frame(width: 18)
            Text(verbatim: preview.shownVerb).font(Typo.body).foregroundStyle(Theme.muted).frame(width: 56, alignment: .leading)
            // The target sits in a `selected` chip, like inline code in the reading text: it is the thing the step touched.
            Text(verbatim: preview.target).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1)
                .truncationMode(preview.targetIsPath ? .head : .tail)
                .padding(.horizontal, 6).frame(height: 20)
                .background(Theme.selected.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.chip))
            Spacer(minLength: 8)
            if running { DotGridLoader(size: 12) }
            if let meta = preview.meta {
                Text(verbatim: meta).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
            }
            if detail != nil {
                Lucide(.chevronRight, size: 12, color: Theme.subtle).rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .padding(.horizontal, 8).frame(height: 28)
        .background(hovering && detail != nil ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
        .contentShape(Rectangle())
    }

    static func icon(_ kind: ToolKind) -> LucideName {
        switch kind {
        case .read: .fileText
        case .edit: .filePen
        case .run: .terminal
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
            case .progress: EmptyView()
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

/// The live row (§8.10): `<spinner> <step> · <elapsed>`, "Editing store.test.ts · 1m 12s", "Thinking · 40s", `⌘.` to stop.
/// It sits in the dock above the background strip, 32pt and reserved for as long as a turn runs, so the transcript
/// and the composer can never clip it. No model name, no "Claude is working".
struct WorkbenchLiveRow: View {
    let steps: [ActivityStep]
    let since: Date?
    /// A way to stop this chat; the `⌘.` hint and shortcut are only there when there is one.
    let onStop: (() -> Void)?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 8) {
                DotGridLoader(size: 14)
                Text(verbatim: LiveStepLine.step(steps)).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                if let since {
                    Text(verbatim: "· " + ElapsedFormat.short(context.date.timeIntervalSince(since)))
                        .font(Typo.footnoteMono).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
                }
                Spacer(minLength: 8)
                if let onStop {
                    Button(action: onStop) {
                        HStack(spacing: 6) {
                            KeyCap(text: "⌘.")
                            Text("to stop").font(Typo.body).foregroundStyle(Theme.muted)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(".", modifiers: .command)
                    .accessibilityLabel("Stop")
                }
            }
            .frame(height: 32)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(LiveStepLine.line(steps: steps, since: since, now: context.date))
        }
    }
}

/// "Background" and one chip per subagent or shell (working dot, name, what, age): 30pt, only while something runs.
/// The chevron opens the subagents' own steps beneath (the existing strip).
struct BackgroundChips: View {
    let tasks: [DaemonBackgroundTask]
    @Binding var open: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            HStack(spacing: 8) {
                Lucide(.layers, size: 14, color: Theme.muted)
                Text("Background").font(Typo.body).foregroundStyle(Theme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { ForEach(tasks) { chip($0, now: context.date) } }
                }
                Button { open.toggle() } label: {
                    Lucide(.chevronDown, size: 12, color: Theme.muted).rotationEffect(.degrees(open ? 180 : 0))
                        .frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(open ? "Hide background details" : "Show background details")
            }
            .frame(height: 30)
            .accessibilityElement(children: .contain)
        }
    }

    /// The same marks as a chat's (§8.1): the loader while it runs, circle-x if it failed, a `subtle` circle-check once it finished.
    @ViewBuilder private func taskMark(_ task: DaemonBackgroundTask) -> some View {
        switch task.status {
        case "running": DotGridLoader(size: 12)
        case "failed": Lucide(.circleX, size: 12, color: Theme.negative).accessibilityHidden(true)
        default: Lucide(.circleCheck, size: 12, color: Theme.subtle).accessibilityHidden(true)
        }
    }

    private func chip(_ task: DaemonBackgroundTask, now: Date) -> some View {
        HStack(spacing: 6) {
            taskMark(task)
            Text(verbatim: task.kind == "agent" ? task.label : "Shell").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink)
            if task.kind != "agent" || (task.summary?.isEmpty == false && task.status == "running") {
                Text(verbatim: task.kind == "agent" ? (task.summary ?? "") : task.label).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let time = task.duration(now: now) { Text(verbatim: time).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
        }
        .lineLimit(1)
        .padding(.horizontal, 9).frame(height: 24)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.line))
        .accessibilityElement(children: .combine)
    }
}
