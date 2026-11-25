import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// The slim bar above the composer: "N ducklings working" and a chip per duckling (title, model, elapsed, a loader or a
/// check or a cross). A click opens the duckling as a tab in the centre strip, after its thread. Shown only while one runs or a recent one finished.
struct DucklingsBar: View {
    let session: HostSession
    let set: DucklingSet
    /// The status line of an idle chat with helpers: "Ready · 2 ducklings running".
    var readyLine: String?
    /// A quiet Stop, only while Claude's turn waits on a foreground duckling (it cancels the turn, as the composer's Stop did).
    var onStop: (() -> Void)?
    @Environment(AppModel.self) private var model

    var body: some View {
        // Finished chips leave once the agent has their report (or 20 s on); the whole bar goes with the last one.
        // While one runs nothing expires, so the bar is plain (rebuilt only when the set changes) and only each chip's elapsed text ticks.
        // Once none runs, finished chips expire by time: only then does a slow timeline wrap the bar.
        Group {
            if set.running == 0 {
                TimelineView(.periodic(from: .now, by: 5)) { context in content(now: context.date) }
            } else {
                content(now: Date())
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func content(now: Date) -> some View {
        let text = DucklingWords.barText(set, now: now)
        let chips = set.barItems(now: now)
            Group {
                if let text {
                    HStack(spacing: Space.s) {
                        DucklingView(parentId: session.key.stringValue, parentSize: ThreadDuck.Size.sidebarRow).accessibilityHidden(true)
                        Text(verbatim: readyLine ?? text).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) { ForEach(chips) { chip($0).transition(.opacity) } }
                        }
                        if let onStop {
                            Button("Stop", action: onStop)
                                .buttonStyle(.plain).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
                                .help("Stop this turn").accessibilityLabel("Stop")
                        }
                    }
                    .padding(.horizontal, Space.m).frame(height: 34)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
                    .transition(.opacity)
                }
            }
            .animation(Motion.standard, value: chips.map(\.id))
            .animation(Motion.standard, value: text == nil)
    }

    private func chip(_ d: Duckling) -> some View {
        let ref = DucklingRef(session: session.key, taskId: d.id)
        let open = model.isDucklingOpen(ref)
        return Button { model.openDucklingAnywhere(ref) } label: {
            HStack(spacing: 5) {
                DucklingStatusMark(duckling: d)
                ChipText(duckling: d)
            }
            .font(Typo.meta).foregroundStyle(d.status == .failed ? Theme.negative : Theme.muted)
            .padding(.horizontal, 8).frame(height: 24)
            .background(open ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(open ? Theme.lineStrong : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Radius.chip))
        }
        .buttonStyle(.plain)
        .help("Watch this duckling")
        .accessibilityLabel("\(d.title), \(d.statusWord)")
    }
}

/// A chip's text; only a running chip's elapsed time ticks, in this leaf.
private struct ChipText: View {
    let duckling: Duckling
    var body: some View {
        if duckling.status == .running {
            TimelineView(.periodic(from: .now, by: 5)) { Text(verbatim: duckling.chipText(now: $0.date)).lineLimit(1) }
        } else {
            Text(verbatim: duckling.chipText()).lineLimit(1)
        }
    }
}

/// A running duckling's loader, a check for a finished one, a red cross for a failed one. Not duck yellow: yellow is the accent.
struct DucklingStatusMark: View {
    let duckling: Duckling
    var body: some View {
        switch duckling.status {
        case .running: TideGlyph(color: Theme.muted, grid: .mini)
        case .done: Lucide(.circleCheck, size: 11, color: Theme.subtle).accessibilityLabel("Finished")
        case .failed: Lucide(.circleX, size: 11, color: Theme.negative).accessibilityLabel("Failed")
        case .stopped: Text(verbatim: "–").font(Typo.meta).foregroundStyle(Theme.muted).accessibilityLabel("Stopped")
        case .unknown: Text(verbatim: "?").font(Typo.meta).foregroundStyle(Theme.muted).accessibilityLabel(duckling.statusWord)
        }
    }
}

/// One duckling, read-only, as the body of its tab: its header, its steps (the chat's own rows, live
/// while it runs), its report once it has one, and what it was asked, folded. The host's route answers; a host without
/// it gets one sentence. The tab's close (or middle click) ends it; another chat closes it too.
struct DucklingPanel: View {
    let session: HostSession
    let chip: Duckling?
    let taskId: String
    /// In the centre strip: laid out at the transcript's reading width, not edge to edge like a side zone.
    var centred = false
    @Environment(AppModel.self) private var model
    @State private var shown: DucklingPanelModel?
    @State private var briefOpen = false

    private var panel: DucklingPanelModel { shown ?? DucklingPanelModel.make(result: nil, chip: chip) }

    var body: some View {
        let p = panel
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    header(p)
                    if let message = p.message { Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted) }
                    ForEach(p.parts, id: \.self) { part in partView(part, p) }
                }
                .padding(centred ? Metrics.readingInset : Space.m)
                .frame(maxWidth: centred ? Metrics.readingColumn + 2 * Metrics.readingInset : .infinity, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
            }
            // A running one follows its newest step; a finished one opens at the top. Scrolling up is left alone.
            .defaultScrollAnchor(p.isLive ? .bottom : .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Duckling: \(p.title)")
        .task(id: taskId) {
            shown = nil
            briefOpen = false
            while !Task.isCancelled {
                let read = await model.ducklingDetail(session: session, taskId: taskId)
                let next = DucklingPanelModel.make(result: read, chip: chip, previous: shown)
                if next != shown { shown = next }
                // Live only while it runs; a finished one is read once more by the chip's own change.
                if !next.isLive { break }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .task(id: chip?.status) {
            // The chip says it ended: read once more so the report and the last steps show.
            guard chip?.status != .running else { return }
            let read = await model.ducklingDetail(session: session, taskId: taskId)
            let next = DucklingPanelModel.make(result: read, chip: chip, previous: shown)
            if next != shown { shown = next }
        }
    }

    private func header(_ p: DucklingPanelModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: p.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(3).textSelection(.enabled)
            TimelineView(.periodic(from: .now, by: 15)) { context in
                HStack(spacing: 6) {
                    StatusChip(text: p.statusLine, status: p.status.rawValue)
                    ForEach([p.model, p.elapsed(now: context.date)].compactMap { $0 }, id: \.self) {
                        Text(verbatim: $0).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
    }

    @ViewBuilder private func partView(_ part: DucklingPanelModel.Part, _ p: DucklingPanelModel) -> some View {
        switch part {
        case .steps: stepsSection(p)
        case .report: reportSection(p)
        case .brief: briefSection(p)
        case .output: outputSection(p)
        case .command: commandSection(p)
        }
    }

    @ViewBuilder private func reportSection(_ p: DucklingPanelModel) -> some View {
        if let r = p.report { section("Report") { MessageText(markdown: r, style: .squeak).textSelection(.enabled) } }
    }

    @ViewBuilder private func stepsSection(_ p: DucklingPanelModel) -> some View {
        section("Steps") {
            if let empty = p.stepsEmptyText {
                Text(verbatim: empty).font(Typo.body).foregroundStyle(Theme.muted)
            } else if !p.steps.isEmpty {
                let b = TurnFolding.block(steps: p.steps, working: p.isLive, keepRecent: .max)
                TurnBlockView(block: TurnBlock(folded: [], shown: b.folded + b.shown), filesLine: nil)
            }
        }
    }

    /// A background command's live output: monospace, the host's last lines, never rendered as Markdown.
    @ViewBuilder private func outputSection(_ p: DucklingPanelModel) -> some View {
        section("Output") {
            if let empty = p.outputEmptyText {
                Text(verbatim: empty).font(Typo.body).foregroundStyle(Theme.muted)
            } else if let out = p.output {
                VStack(alignment: .leading, spacing: 4) {
                    if out.truncated { Text(verbatim: "Earlier output not shown").font(Typo.meta).foregroundStyle(Theme.subtle) }
                    codeBlock(out.text)
                }
            }
        }
    }

    /// The command itself, as code, whole (it is a program, not prose).
    @ViewBuilder private func commandSection(_ p: DucklingPanelModel) -> some View {
        if let command = p.brief { section("Command") { codeBlock(command) } }
    }

    private func codeBlock(_ text: String) -> some View {
        Text(verbatim: text).font(Typo.code).foregroundStyle(Theme.ink).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.s)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
    }

    private func briefSection(_ p: DucklingPanelModel) -> some View {
        let preview = p.briefPreview
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Motion.standard) { briefOpen.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("What it was asked").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.muted)
                    Lucide(.chevronRight, size: 12, color: Theme.subtle).rotationEffect(.degrees(briefOpen ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityHint(briefOpen ? "Folds the brief" : "Shows all of the brief")
            if let preview, let brief = p.brief {
                MessageText(markdown: briefOpen ? brief : preview.text + (preview.isCut ? " …" : ""), style: .squeak)
                    .textSelection(.enabled)
                    .foregroundStyle(Theme.muted)
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.muted)
            content()
        }
    }
}

extension AppModel {
    /// A chat's ducklings as its thread shows them (the session's own, else a Squeak chat's host record).
    func ducklings(for session: HostSession) -> DucklingSet? {
        session.ducklings ?? (session.source == .squeak && native.key == session.key ? native.info?.ducklings : nil)
    }

    /// One duckling from the host; a failure is returned, never thrown. A chat that is not Squeak's has no route (nil).
    func ducklingDetail(session: HostSession, taskId: String) async -> Result<DucklingDetail?, any Error> {
        guard let id = hostId(session) else { return .success(nil) }
        if demoMode { return .success(nil) }
        do { return .success(try await nativeHost.duckling(sessionId: id, taskId: taskId)) } catch { return .failure(error) }
    }
}
