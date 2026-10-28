import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar panel: one panel, several screens (`PopupNav`). Four tabs (Home, Needs you, Usage,
/// Controls) sit under a header; New chat, its workspace list and an opened session replace them with a
/// back arrow. Each screen is a fixed top, a scrolling band and an optional pinned footer
/// (`PopupScaffold`), so the panel is as tall as its content up to the screen cap. Opening the overflow
/// or a tab keeps the panel open; destinations outside it (Settings, the window, the quick composer)
/// close it first, so focus moves with nothing left behind.
struct PopoverView: View {
    @Environment(AppModel.self) private var model
    @State private var searching = false
    @State private var sessionStore = PopupSessionModel()
    let nav = PopupNav.shared

    /// Offline captures pin the screen height to show a short screen. Live, the panel always draws its
    /// own surface, and `MenuPanel`'s window shadow follows it.
    var drawsOwnSurface = true
    var screenHeightOverride: CGFloat?

    static let width = PopoverMetrics.width

    var body: some View {
        screen
            .id(nav.screen.id)
            .background(escapeToClose)
            .background(newChatShortcut)
            .task(id: model.hasLoaded) { await model.pollLiveSteps() }
            .task { await model.readUsage() }
            .task {
                while !Task.isCancelled {
                    await model.refreshMenuPreviews()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
    }

    @ViewBuilder private var screen: some View {
        switch nav.screen {
        case .tab(.home):
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupHomeTop(searching: $searching, dismiss: dismissMenu)
            } band: {
                PopupHomeBand()
            } footer: {
                PopupHomeFooter(dismiss: dismissMenu)
            }
        case .tab(.needsYou):
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupTabHeader(selected: .needsYou) {
                    Text("Needs you").font(.popup(22, .bold)).foregroundStyle(Theme.ink)
                } trailing: { EmptyView() }
            } band: {
                PopupHomeBand(onlyNeedsYou: true)
            }
        case .tab(.usage):
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupUsageHeader()
            } band: {
                PopupUsageBand()
            }
        case .tab(.controls):
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupControlsHeader()
            } band: {
                PopupControlsBand(dismiss: dismissMenu)
            }
        case .newChat:
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupNewChatTop()
            } band: {
                PopupNewChatBand()
            } footer: {
                PopupNewChatFooter()
            }
        case .workspaces:
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupWorkspacesTop()
            } band: {
                PopupWorkspacesBand()
            }
        case .session(let key):
            PopupScaffold(drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride) {
                PopupSessionTop(key: key)
            } band: {
                PopupSessionBand(key: key, store: sessionStore)
            } footer: {
                PopupSessionFooter(key: key, store: sessionStore)
            }
            .task(id: key) { await sessionStore.load(key, model: model) }
        }
    }

    /// Hides the panel. Drafts live in the composer and the search text in the model, so nothing is lost.
    private func dismissMenu() { model.dismissMenuBar?() }

    /// ⌘N while the popup is open starts a chat in the popup, not in the New chat window.
    private var newChatShortcut: some View {
        Button("New chat") { nav.openNewChat() }
            .keyboardShortcut("n", modifiers: .command)
            .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }

    /// Escape closes the panel. A hidden cancel-action button carries the shortcut.
    private var escapeToClose: some View {
        Button("Close", action: dismissMenu)
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
    }
}

/// DESIGN.md §3.2 `panel-glass`: the system's own popover material, blurring what is behind the
/// menu, with a light tint over it, so the panel reads as glass rather than a painted sheet.
/// Reduce Transparency gets the near-opaque `panel-translucent`.
struct PanelBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// Offscreen captures cannot draw the window material, so they draw the near-opaque token.
    nonisolated(unsafe) static var captureOpaque = false

    var body: some View {
        if reduceTransparency || Self.captureOpaque {
            Theme.panelTranslucent
        } else {
            ZStack {
                VisualEffectBackground(material: .popover)
                Theme.panelGlass
            }
        }
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}
