#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI
import UIKit

/// The standalone app's bottom bar: Home (by project), Sessions (by status), what needs you, and
/// Settings. Every tab is an existing screen over the same snapshot; "Needs you" is the real
/// decision list, and its badge counts only chats that are blocked on you right now.
struct HomeTabs: View {
    enum Tab: Hashable { case home, sessions, needsYou, settings }

    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    @ObservedObject private var router = SqueakRouter.shared
    @State private var selection: Tab = ProcessInfo.processInfo.arguments.contains("-squeak-settings") ? .settings
        : ProcessInfo.processInfo.arguments.contains("-squeak-tab-needs") ? .needsYou
        : ProcessInfo.processInfo.arguments.contains("-squeak-tab-sessions") ? .sessions : .home

    var body: some View {
        TabView(selection: $selection) {
            HomeView(inTabs: true, fixedGrouping: .projects)
                .tabItem { TabLabel("Home", icon: .house) }
                .tag(Tab.home)
            HomeView(inTabs: true, fixedGrouping: .status, opensLinks: false)
                .tabItem { TabLabel("Sessions", icon: .layers) }
                .tag(Tab.sessions)
            NeedsYouTab()
                .tabItem { TabLabel("Needs you", icon: .inbox) }
                .badge(Presentation.needsYouCount(model.snapshot?.sessions ?? []))
                .tag(Tab.needsYou)
            SettingsView(inTab: true)
                .tabItem { TabLabel("Settings", icon: .settings) }
                .tag(Tab.settings)
        }
        .environment(\.openSettingsTab, { selection = .settings })
        // A link to a chat opens it from Home, whichever tab was in front.
        .onChange(of: router.pendingSessionId, initial: true) { _, id in if id != nil { selection = .home } }
        .onChange(of: selection) { _, tab in
            UISelectionFeedbackGenerator().selectionChanged()
            screen.report?(tab == .home ? "Sessions" : tab == .sessions ? "All sessions" : tab == .needsYou ? "Needs you" : "Settings")
        }
    }
}

/// A tab's label with Squeak's Lucide icon, drawn once to a template image the bar can tint:
/// the tab bar takes an image, not a view.
private struct TabLabel: View {
    let title: String
    let icon: LucideName
    init(_ title: String, icon: LucideName) { self.title = title; self.icon = icon }

    var body: some View {
        Label { Text(title) } icon: { Image(uiImage: TabGlyph.image(icon)) }
    }
}

@MainActor
private enum TabGlyph {
    private static var cache: [LucideName: UIImage] = [:]

    static func image(_ name: LucideName) -> UIImage {
        if let cached = cache[name] { return cached }
        let renderer = ImageRenderer(content: Lucide(name, size: 25, color: Color.black))
        renderer.scale = UIScreen.main.scale
        let image = (renderer.uiImage ?? UIImage()).withRenderingMode(.alwaysTemplate)
        cache[name] = image
        return image
    }
}

/// What waits on you: the same decision cards, with their one-tap answers, as Home's Needs you group.
private struct NeedsYouTab: View {
    @State private var path: [HomeRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            NeedsYouPage(path: $path)
                .navigationDestination(for: HomeRoute.self) { route in
                    if case .session(let key) = route { SessionView(key: key) } else { GroupView(route: route, path: $path) }
                }
        }
    }
}
#endif
