import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector (320, closed by default): Changes, Files and Activity. Activity hosts the
// chat's step feed; Changes and Files read the daemon's change list (ChangesViews.swift).

enum InspectorTab: String, CaseIterable, Identifiable {
    case changes = "Changes", files = "Files", activity = "Activity", pr = "PR"
    var id: String { rawValue }

    /// The PR tab is Conductor's "PR status" for a chat Squeak runs; a Conductor chat has no such tab.
    static func available(native: Bool) -> [InspectorTab] { native ? allCases : allCases.filter { $0 != .pr } }
}

struct WorkbenchInspector: View {
    let session: HostSession?
    @Binding var tab: InspectorTab
    var width: CGFloat = Metrics.workbenchInspector
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                ForEach(InspectorTab.available(native: session?.source == .squeak)) { t in
                    Button { tab = t } label: {
                        HStack(spacing: 5) {
                            Text(t.rawValue).font(Typo.label).foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                            if t == .activity, session?.state == .working { DotGridLoader(size: 12).help("Working") }
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
            case .pr:
                if let session, session.source == .squeak { PRTab(session: session) } else {
                    changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count) }
                }
            case .changes: changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count) }
            case .files: changesOrEmpty { FilesTab(session: $0) }
            case .activity: activity
            }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Theme.sidebar.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }

    @ViewBuilder private func changesOrEmpty<V: View>(@ViewBuilder _ content: (HostSession) -> V) -> some View {
        if let session {
            content(session)
        } else {
            Text("Open a chat to see what it changed.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }

    /// A Squeak chat's allow rules (what "Allow for this chat" keeps), each removable. Hidden for any other chat and
    /// when the host has no rules route (an older service answers 404).
    @ViewBuilder private func rulesSection(_ session: HostSession) -> some View {
        if session.source == .squeak, model.native.key == session.key, let rules = model.native.rules {
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.m).padding(.bottom, Space.m).padding(.top, Space.s)
        }
    }

    @ViewBuilder private var activity: some View {
        if let session {
            ScrollView {
              VStack(alignment: .leading, spacing: 0) {
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
                        ForEach(Array(model.activity.filter { $0.kind != "progress" }.reversed().enumerated()), id: \.offset) { _, step in
                            ActivityStepRow(step: step, compact: true)
                        }
                    }
                }
                .padding(Space.m)
                rulesSection(session)
              }
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
