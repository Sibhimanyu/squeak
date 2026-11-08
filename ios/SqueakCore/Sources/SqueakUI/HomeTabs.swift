#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI
import UIKit

/// The standalone app's bottom bar: what needs you, Sessions (a List / Projects switch at the top) and
/// Settings. Every tab is an existing screen over the same snapshot; "Needs you" is the real
/// decision list, and its badge counts only chats that are blocked on you right now.
struct HomeTabs: View {
    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    @ObservedObject private var router = SqueakRouter.shared
    /// The last tab used; the first launch has none and opens on Needs you.
    @AppStorage("lastTab") private var lastTab = ""
    @State private var selection = AppTab.initial(stored: UserDefaults.standard.string(forKey: "lastTab"), arguments: ProcessInfo.processInfo.arguments)

    var body: some View {
        TabView(selection: $selection) {
            NeedsYouTab()
                .tabItem { TabLabel("Needs you", icon: .inbox) }
                .badge(NeedsYou.count(sessions: model.snapshot?.sessions ?? [], films: model.snapshot?.films ?? []))
                .tag(AppTab.needsYou)
            // The only tab that opens a linked chat.
            HomeView(inTabs: true)
                .tabItem { TabLabel("Sessions", icon: .layers) }
                .tag(AppTab.sessions)
            SettingsView(inTab: true)
                .tabItem { TabLabel("Settings", icon: .settings) }
                .tag(AppTab.settings)
        }
        .environment(\.openSettingsTab, { selection = .settings })
        // A link to a chat opens it in Sessions, whichever tab was in front.
        .onChange(of: router.pendingSessionId, initial: true) { _, id in if id != nil { selection = .sessions } }
        .onChange(of: selection) { _, tab in
            lastTab = tab.rawValue
            UISelectionFeedbackGenerator().selectionChanged()
            screen.report?(tab == .sessions ? "Sessions" : tab == .needsYou ? "Needs you" : "Settings")
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
                    if case .session(let key) = route { SessionView(key: key) } else if case .film(let id) = route { FilmView(id: id) } else { GroupView(route: route, path: $path) }
                }
        }
    }
}
#endif
