import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector (320, closed by default): Changes, Files and Activity. Activity hosts the
// chat's step feed; Changes and Files read the daemon's change list (ChangesViews.swift).

enum InspectorTab: String, CaseIterable, Identifiable {
    case changes = "Changes", files = "Files", activity = "Activity"
    var id: String { rawValue }
}

struct WorkbenchInspector: View {
    let session: HostSession?
    @Binding var tab: InspectorTab
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                ForEach(InspectorTab.allCases) { t in
                    Button { tab = t } label: {
                        HStack(spacing: 5) {
                            Text(t.rawValue).font(Typo.label).foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                            if t == .activity, session?.state == .working { MarkSpinner(size: 11).help("Working") }
                        }
                        .padding(.horizontal, 10).frame(height: 28)
                        .background(tab == t ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab == t ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s).frame(height: Metrics.header)
            .background(WindowDragArea())
            Rectangle().fill(Theme.line).frame(height: 1)
            switch tab {
            case .changes: changesOrEmpty { ChangesTab(sessionKey: $0, activityStamp: model.activity.count) }
            case .files: changesOrEmpty { FilesTab(sessionKey: $0) }
            case .activity: activity
            }
        }
        .frame(width: Metrics.workbenchInspector)
        .frame(maxHeight: .infinity)
        .background(Theme.sidebar.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }

    @ViewBuilder private func changesOrEmpty<V: View>(@ViewBuilder _ content: (String) -> V) -> some View {
        if let session {
            content(session.key.hostSessionId)
        } else {
            Text("Open a chat to see what it changed.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }

    @ViewBuilder private var activity: some View {
        if let session {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("What it's doing").font(Typo.heading).foregroundStyle(Theme.ink).padding(.bottom, Space.s)
                    // A sentence in a log, not a row label: what the chat is waiting on.
                    if let mark = model.mark(for: session), mark.kind == .waiting {
                        Text(verbatim: mark.words).font(Typo.body).foregroundStyle(Theme.ink).padding(.bottom, Space.s)
                    }
                    if model.activity.isEmpty {
                        Text(model.activityPhase == .loading ? "Reading the steps…"
                            : session.state == .working ? "Steps appear here as the agent works." : "No steps to show for this chat.")
                            .font(Typo.body).foregroundStyle(Theme.muted)
                    } else {
                        // Newest first, like every list (§8.10).
                        ForEach(Array(model.activity.reversed().enumerated()), id: \.offset) { _, step in
                            ActivityStepRow(step: step, compact: true)
                        }
                    }
                }
                .padding(Space.m)
            }
            .task(id: session.key.stringValue) {
                while !Task.isCancelled {
                    await model.refreshActivity()
                    try? await Task.sleep(for: .seconds(session.state == .working ? 2 : 10))
                }
            }
        } else {
            Text("Open a chat to see what it is doing.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }
}
