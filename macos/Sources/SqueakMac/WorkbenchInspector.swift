import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector (30% of the window until dragged, closed by default): All files, Changes, Checks, Review, Setup and Run. Activity hosts the
// chat's step feed; Changes and Files read the daemon's change list (ChangesViews.swift).

struct WorkbenchInspector: View {
    let session: HostSession?
    @Binding var tab: InspectorTab
    var width: CGFloat = Metrics.workbenchInspector
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 2) {
                ForEach(InspectorTab.available(native: session?.source == .squeak)) { t in
                    Button { tab = t } label: {
                        HStack(spacing: 5) {
                            Text(t.title).font(Typo.label).foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                            
                        }
                        .padding(.horizontal, 10).frame(height: 28)
                        .background(tab == t ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab == t ? .isSelected : [])
                }
              }
              .padding(.horizontal, Space.s)
            }
            .frame(height: Metrics.header)
            .background(WindowDragArea())
            Rectangle().fill(Theme.line).frame(height: 1)
            switch tab {
            case .checks, .setup, .run where session?.source != .squeak:
                changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count) }
            case .checks: changesOrEmpty { PRTab(session: $0) }
            case .setup: changesOrEmpty { SetupTab(session: $0) }
            case .run: changesOrEmpty { RunTab(session: $0) }
            case .review: changesOrEmpty { ReviewTab(session: $0) }
            case .changes: changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count) }
            case .files: changesOrEmpty { FilesTab(session: $0) }
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
}
