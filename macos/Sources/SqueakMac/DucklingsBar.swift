import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// The slim bar above the composer: "N in the background" and a chip per duckling (title, model, elapsed, a loader or a
/// check or a cross). A click opens the duckling in the side panel. Shown only while one runs or a recent one finished.
struct DucklingsBar: View {
    let session: HostSession
    let set: DucklingSet
    /// The status line of an idle chat with helpers: "Ready · 2 ducklings running".
    var readyLine: String?
    @Environment(AppModel.self) private var model

    var body: some View {
        // Finished chips leave once the agent has their report (or 20 s on); the whole bar goes with the last one.
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let text = DucklingWords.barText(set, now: context.date)
            let chips = set.barItems(now: context.date)
            Group {
                if let text {
                    HStack(spacing: Space.s) {
                        DucklingView(parentId: session.key.stringValue, parentSize: ThreadDuck.Size.sidebarRow).accessibilityHidden(true)
                        Text(verbatim: readyLine ?? text).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) { ForEach(chips) { chip($0, now: context.date).transition(.opacity) } }
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
        .accessibilityElement(children: .contain)
    }

    private func chip(_ d: Duckling, now: Date) -> some View {
        let open = model.openDuckling == DucklingRef(session: session.key, taskId: d.id)
        return Button { model.openDuckling = open ? nil : DucklingRef(session: session.key, taskId: d.id) } label: {
            HStack(spacing: 5) {
                DucklingStatusMark(duckling: d)
                Text(verbatim: d.chipText(now: now)).lineLimit(1)
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

/// A running duckling's loader, a check for a finished one, a red cross for a failed one. Not duck yellow: yellow is the accent.
struct DucklingStatusMark: View {
    let duckling: Duckling
    var body: some View {
        switch duckling.status {
        case .running: DotGridLoader(size: 10)
        case .done: Lucide(.circleCheck, size: 11, color: Theme.subtle).accessibilityLabel("Finished")
        case .failed: Lucide(.circleX, size: 11, color: Theme.negative).accessibilityLabel("Failed")
        case .stopped: Text(verbatim: "–").font(Typo.meta).foregroundStyle(Theme.muted).accessibilityLabel("Stopped")
        }
    }
}

/// One duckling, read-only, in the right inspector in place of its tabs: a Back row, then its header, its steps (the
/// chat's own rows, live while it runs), its report once it has one, and what it was asked, folded. The host's route
/// answers; a host without it gets one sentence. Esc and Back close it; another chat closes it too (`AppModel.selected`).
struct DucklingPanel: View {
    let session: HostSession
    let chip: Duckling?
    let taskId: String
    var width: CGFloat = Metrics.workbenchInspector
    @Environment(AppModel.self) private var model
    @State private var shown: DucklingPanelModel?
    @State private var briefOpen = false

    private var panel: DucklingPanelModel { shown ?? DucklingPanelModel.make(result: nil, chip: chip) }
    private func close() { model.openDuckling = nil }

    var body: some View {
        let p = panel
        VStack(alignment: .leading, spacing: 0) {
            backRow
            Rectangle().fill(Theme.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    header(p)
                    if let message = p.message { Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted) }
                    ForEach(p.parts, id: \.self) { part in partView(part, p) }
                }
                .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            }
            // A running one follows its newest step; a finished one opens at the top. Scrolling up is left alone.
            .defaultScrollAnchor(p.isLive ? .bottom : .top)
        }
        .frame(width: width).frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .background { Button("", action: close).keyboardShortcut(.escape, modifiers: []).opacity(0).accessibilityHidden(true) }
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

    /// The inspector's top row: the same height as its tab row, so nothing moves when it swaps in.
    private var backRow: some View {
        HStack(spacing: Space.s) {
            Color.clear.frame(width: PaneToggle.size, height: PaneToggle.size)   // the inspector's toggle (PaneToggleOverlay)
            Button(action: close) {
                HStack(spacing: 6) {
                    Lucide(.arrowLeft, size: 14, color: Theme.muted)
                    Text("Back").font(.system(size: 14)).foregroundStyle(Theme.ink)
                }
                .padding(.horizontal, 10).frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Back to the panel (Esc)").accessibilityLabel("Close the duckling")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.m).frame(height: Metrics.header).background(WindowDragArea())
    }

    private func header(_ p: DucklingPanelModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: p.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(3).textSelection(.enabled)
            TimelineView(.periodic(from: .now, by: 15)) { context in
                HStack(spacing: 6) {
                    StatusChip(text: Duckling(id: "", title: "", status: p.status).statusWord, status: p.status.rawValue)
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
