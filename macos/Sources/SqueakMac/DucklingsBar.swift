import SqueakIcons
import SqueakMacCore
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
        TimelineView(.periodic(from: .now, by: 15)) { context in
            HStack(spacing: Space.s) {
                DucklingView(parentId: session.key.stringValue, parentSize: ThreadDuck.Size.sidebarRow).accessibilityHidden(true)
                Text(verbatim: readyLine ?? DucklingWords.barText(set) ?? "").font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(set.items) { chip($0, now: context.date) } }
                }
            }
            .padding(.horizontal, Space.m).frame(height: 34)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
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

/// One duckling, read-only, beside the thread: its brief, its steps (the same rows as the Activity tab, live while it
/// runs) and its report. The host's route answers; a host without it gets one sentence.
struct DucklingPanel: View {
    let session: HostSession
    let chip: Duckling?
    let taskId: String
    @Environment(AppModel.self) private var model
    @State private var shown: DucklingPanelModel?

    private var panel: DucklingPanelModel { shown ?? DucklingPanelModel.make(result: nil, chip: chip) }

    var body: some View {
        let p = panel
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: p.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(2)
                    HStack(spacing: 6) {
                        StatusChip(text: chip?.statusWord ?? Duckling(id: "", title: "", status: p.status).statusWord, status: p.status.rawValue)
                        if let m = p.model { Text(verbatim: m).font(Typo.meta).foregroundStyle(Theme.muted) }
                    }
                }
                Spacer(minLength: 0)
                Button { model.openDuckling = nil } label: { Lucide(.x, size: 13, color: Theme.muted).frame(width: 24, height: 24) }
                    .buttonStyle(.plain).accessibilityLabel("Close the duckling").help("Close")
            }
            .padding(Space.m)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: Space.m) {
                    if let brief = p.brief { section("Brief") { Text(verbatim: brief).font(Typo.body).foregroundStyle(Theme.ink).textSelection(.enabled) } }
                    if !p.steps.isEmpty {
                        section("Steps") {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(p.steps.enumerated()), id: \.offset) { i, step in
                                    ActivityStepRow(step: step, compact: true)
                                    if i < p.steps.count - 1 { Divider().padding(.leading, 30) }
                                }
                            }
                        }
                    }
                    if let report = p.report { section("Report") { Text(verbatim: report).font(Typo.body).foregroundStyle(Theme.ink).textSelection(.enabled) } }
                    if let message = p.message { Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted) }
                }
                .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 340).frame(maxHeight: .infinity)
        .background(Theme.surface)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Duckling: \(p.title)")
        .task(id: taskId) {
            shown = nil
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

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.muted)
            content()
        }
    }
}

extension AppModel {
    /// One duckling from the host; a failure is returned, never thrown. A chat that is not Squeak's has no route (nil).
    func ducklingDetail(session: HostSession, taskId: String) async -> Result<DucklingDetail?, any Error> {
        guard let id = hostId(session) else { return .success(nil) }
        if demoMode { return .success(nil) }
        do { return .success(try await nativeHost.duckling(sessionId: id, taskId: taskId)) } catch { return .failure(error) }
    }
}
