import AppKit
import Heresay
import SqueakMacCore
import SwiftUI

/// Where Heresay's report sheet opens. On macOS the sheet hangs off the one view carrying `.heresay()`, so a
/// report asked for from setup used to open nowhere while the conversation window was closed. Each window that
/// can ask carries a `reportAnchor`; exactly one anchor at a time holds `.heresay()`: the key window's, else
/// any open one, else the conversation window is opened for it.
@MainActor @Observable
final class ReportRouter {
    static let shared = ReportRouter()

    private(set) var active: String?
    @ObservationIgnored private var windows: [String: WeakWindow] = [:]

    private struct WeakWindow { weak var window: NSWindow? }

    func register(_ id: String, _ window: NSWindow?) {
        windows[id] = WeakWindow(window: window)
        if active == nil || windows[active!]?.window?.isVisible != true { active = id }
    }

    func unregister(_ id: String) {
        windows[id] = nil
        if active == id { active = windows.first { $0.value.window?.isVisible == true }?.key }
    }

    /// The report sheet, filled in when there is a problem to describe. The person still reads and sends it.
    /// `place` names where it happened ("Setup › Connect"), so the report says without the person typing it.
    func present(problem: String? = nil, place: String? = nil, details: String? = nil, text prefilled: String? = nil) {
        guard SqueakMacApp.reportsEnabled else { return }
        var text: String? = prefilled
        if let problem, prefilled == nil {
            text = (place.map { "\($0): " } ?? "") + problem
            if let details, !details.isEmpty { text! += "\n\n" + details }
        }
        let open = windows.filter { $0.value.window?.isVisible == true }
        let target = open.first { $0.value.window?.isKeyWindow == true }?.key ?? active.flatMap { open[$0] != nil ? $0 : nil } ?? open.first?.key
        let show = { Heresay.present(type: (problem == nil && prefilled == nil) ? nil : .broken, text: text) }
        if let target {
            active = target
            NSApp.activate()
            windows[target]?.window?.makeKeyAndOrderFront(nil)
            // Let the anchor move before the sheet is asked for.
            DispatchQueue.main.async(execute: show)
        } else {
            // From the menu-bar panel or the quick composer: the conversation window hosts it.
            AppModel.shared.openConversationWindow?()
            NSApp.activate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: show)
        }
    }
}

private struct ReportAnchor: ViewModifier {
    let id: String
    @State private var router = ReportRouter.shared

    func body(content: Content) -> some View {
        content
            .background {
                WindowReader { router.register(id, $0) }
                if router.active == id, SqueakMacApp.reportsEnabled { Color.clear.heresay() }
            }
            .onDisappear { router.unregister(id) }
    }
}

extension View {
    /// This window can show Heresay's report sheet (see `ReportRouter`).
    func reportAnchor(_ id: String) -> some View { modifier(ReportAnchor(id: id)) }
}

/// Reports the hosting window once it is known.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow?) -> Void
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { [weak v] in found(v?.window) }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// "Report this…" beside an error: opens the report sheet as Broken with the error already written in.
struct ReportProblemButton: View {
    let problem: String
    var place: String?
    var details: String?
    var title = "Report this…"

    var body: some View {
        if SqueakMacApp.reportsEnabled {
            Button(title) { ReportRouter.shared.present(problem: problem, place: place, details: details) }
                .buttonStyle(QuietButtonStyle())
                .accessibilityHint("Opens a report with this problem filled in. You read it before it is sent.")
        }
    }
}

/// Help › Report a Problem… (⌥⌘R), through the router so it opens in front of whatever window is key.
struct ReportCommands: Commands {
    init() { _ = HeresayCommands() }  // tells Heresay's introduction that the menu item exists
    var body: some Commands {
        CommandGroup(after: .help) {
            Button("Report a Problem…") { ReportRouter.shared.present() }
                .keyboardShortcut("r", modifiers: [.command, .option])
        }
    }
}

/// What the app tells Heresay about itself: who is signed in, which screen is up, and when it sees trouble.
/// Every call is a no-op in capture and demo runs.
@MainActor
enum HeresayBridge {
    private static var identified: String?

    /// Signed in (with the account's email) or out (nil).
    static func account(email: String?, userId: String? = nil) {
        guard SqueakMacApp.reportsEnabled else { return }
        guard let id = HeresayIdentity.id(userId: userId, email: email) else {
            if identified != nil { identified = nil; Heresay.identify() }
            return
        }
        guard identified != id else { return }
        identified = id
        Heresay.identify(id: id, label: HeresayIdentity.label(email: email), email: email)
    }

    static func screen(_ name: String) {
        guard SqueakMacApp.reportsEnabled else { return }
        Heresay.setScreen(name)
    }

    /// The app saw trouble itself: Heresay offers its help note (once per launch, its own limits).
    static func trouble() {
        guard SqueakMacApp.reportsEnabled else { return }
        _ = Heresay.nudge()
    }

    private static var reachability = NudgeGate(after: 30)

    /// Feed each look at the Squeak service; offers help once per episode of it staying down while a window is open.
    static func service(reachable: Bool, windowOpen: Bool) {
        if reachability.observe(reachable: reachable), windowOpen { trouble() }
    }
}

private struct ScreenName: ViewModifier {
    let name: String
    func body(content: Content) -> some View {
        content
            .onAppear { if SqueakMacApp.reportsEnabled { Heresay.setScreen(name) } }
            .onChange(of: name) { _, new in if SqueakMacApp.reportsEnabled { Heresay.setScreen(new) } }
    }
}

extension View {
    /// Names this screen for Heresay's trail while it is shown (not in capture or demo runs).
    func screen(_ name: String) -> some View { modifier(ScreenName(name: name)) }
}
