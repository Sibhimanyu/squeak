import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar panel's window: borderless, clear, with its own real window shadow. SwiftUI's
/// `MenuBarExtra` cut the system shadow under a tiny corner mask, leaving a square patch behind the
/// rounded corners; a panel we own shadows the 24pt shape `PanelSurface` draws. It can become key
/// (search, the composer's fields) without activating Squeak, like the quick composer's panel.
final class MenuPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// Hosts the panel's SwiftUI and reports the size it wants (its ideal size, not the window's), every
/// time that changes, so the panel grows and shrinks with its content.
final class MenuHostingView<Content: View>: NSHostingView<Content> {
    var onWantedSize: ((CGSize) -> Void)?
    private var last = CGSize.zero

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        report()
    }

    override func layout() {
        super.layout()
        report()
    }

    private func report() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let size = self.fittingSize
            guard size != self.last else { return }
            self.last = size
            self.onWantedSize?(size)
        }
    }
}

/// Squeak's status item and the panel it opens: the duck (and the needs-you count, awake countdown and
/// update dot, drawn by `MenuBarIcon`) in the menu bar, and a click toggles `PopoverView`.
@MainActor
final class MenuBarController: NSObject {
    static let shared = MenuBarController()

    private var item: NSStatusItem?
    private var panel: MenuPanel?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var awakeTask: Task<Void, Never>?
    /// The size SwiftUI last asked the panel to be.
    private var wanted = CGSize(width: PopoverMetrics.width, height: 520)

    var isOpen: Bool { panel?.isVisible == true }

    /// Where a panel of `size` opens under the status item, as the menu-bar panel does: New chat drops
    /// from the same spot. Nil before the item has a window.
    func dropFrame(size: CGSize) -> CGRect? {
        guard let button = item?.button, let buttonWindow = button.window else { return nil }
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let visible = (buttonWindow.screen ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return PopoverPlacement.frame(button: anchor, size: size, visible: visible)
    }

    func start(model: AppModel) {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.item = item
        if let button = item.button {
            button.target = self
            button.action = #selector(toggleFromButton)
            button.sendAction(on: [.leftMouseDown])
            button.imagePosition = .imageOnly
        }
        refresh(model: model)
        track(model: model)
        model.dismissMenuBar = { [weak self] in self?.close() }
        // The awake countdown beside the duck, kept current from launch.
        awakeTask = Task { await model.pollAwake() }
    }

    /// Redraws the button from the model, and again whenever anything it read changes.
    private func track(model: AppModel) {
        withObservationTracking {
            _ = MenuBarIcon.State(model: model)
            _ = model.updateBadgeShown
            _ = model.attentionCount
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model else { return }
                self.refresh(model: model)
                self.track(model: model)
            }
        }
    }

    private func refresh(model: AppModel) {
        guard let button = item?.button else { return }
        button.image = MenuBarIcon.image(for: MenuBarIcon.State(model: model), updateDot: model.updateBadgeShown)
        button.setAccessibilityLabel((model.attentionCount > 0 ? "Squeak, \(model.attentionCount) need you" : "Squeak") + (model.updateBadgeShown ? ", update available" : ""))
    }

    // MARK: Open and close

    @objc private func toggleFromButton() { toggle() }

    func toggle() { isOpen ? close() : open() }

    func open() {
        guard let button = item?.button, let buttonWindow = button.window else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        if let fit = panel.contentView?.fittingSize, fit.width > 1, fit.height > 1 { wanted = fit }
        // The screen that holds the status item, not the one the pointer or the key window is on.
        panel.setFrame(placement(anchor: anchor, screen: buttonWindow.screen), display: false)
        panel.makeKeyAndOrderFront(nil)
        button.highlight(true)
        installDismissObservers()
    }

    func close() {
        removeDismissObservers()
        item?.button?.highlight(false)
        panel?.orderOut(nil)
    }

    private func makePanel() -> MenuPanel {
        let model = AppModel.shared
        let p = MenuPanel(
            contentRect: NSRect(origin: .zero, size: wanted),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.onEscape = { [weak self] in self?.close() }
        let host = MenuHostingView(rootView: PopoverView().environment(model))
        host.sizingOptions = [.intrinsicContentSize]
        host.onWantedSize = { [weak self] size in self?.resize(to: size) }
        p.contentView = host
        return p
    }

    private func placement(anchor: CGRect, screen: NSScreen?) -> CGRect {
        let visible = (screen ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return PopoverPlacement.frame(button: anchor, size: wanted, visible: visible)
    }

    /// Follows the content's height: the top edge stays under the menu bar, the panel grows and shrinks below it.
    private func resize(to size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        wanted = size
        guard let panel, panel.isVisible, let button = item?.button, let window = button.window else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        let frame = placement(anchor: anchor, screen: window.screen)
        guard frame != panel.frame else { return }
        panel.setFrame(frame, display: true)
        // The shadow follows the content's alpha as it was drawn; after a resize it is stale.
        panel.invalidateShadow()
    }

    // MARK: Dismissal

    /// A click anywhere else closes the panel: other apps' clicks through the global monitor, this
    /// app's own windows through the local one (never swallowed). Menus and the status button are
    /// not "elsewhere". Another app coming forward, a Space change and Squeak resigning also close it.
    private func installDismissObservers() {
        removeDismissObservers()
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
            MainActor.assumeIsolated { self?.handleLocalClick(in: event.window) }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            },
            center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                guard app != NSRunningApplication.current else { return }
                MainActor.assumeIsolated { self?.close() }
            },
        ]
        observers = [
            NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            },
        ]
    }

    private func removeDismissObservers() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        workspaceObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        observers.forEach(NotificationCenter.default.removeObserver)
        localMonitor = nil; globalMonitor = nil; workspaceObservers = []; observers = []
    }

    private func handleLocalClick(in window: NSWindow?) {
        if let window {
            // The panel, its menus (popUpMenu level and above) and the status button's own window
            // (its action toggles) are not outside.
            if window === panel || window === item?.button?.window || window.parent === panel
                || window.level.rawValue >= NSWindow.Level.popUpMenu.rawValue { return }
        }
        close()
    }
}

/// A section's heading in the menu: sentence case, muted, with its count and an optional trailing note
/// (the "new" count on Finished).
struct MenuSectionHeader: View {
    let title: String
    let count: Int
    var note: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
            Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
            Spacer(minLength: Space.s)
            if let note {
                Text(verbatim: note).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.color(for: .finished))
            }
        }
        .padding(.horizontal, Space.l)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One session in the menu, compact: a state dot, the headline and its age, `repo · agent`, and for a
/// finished or errored chat the start of its reply. Two lines otherwise, because the section heading
/// already says the state. Menu-only: the shared `SessionRowView` is not changed for it.
struct MenuSessionRow: View {
    let session: HostSession
    /// A reply excerpt (finished, errored) or a search snippet.
    var detail: String?
    var unread = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Space.m) {
                // The state is said in words for VoiceOver (below); the dot is colour only.
                Circle().fill(Theme.color(for: session.state)).frame(width: 8, height: 8).padding(.top, 6)
                    .accessibilityHidden(true)
                AgentAvatar(session: session, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: SessionText.headline(session))
                            .font(.system(size: 13, weight: unread ? .semibold : .medium))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Spacer(minLength: Space.xs)
                        if unread {
                            Text("New").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.color(for: .finished))
                        }
                        RelativeTimeText(session.lastActivityAt, size: 12)
                    }
                    Text(verbatim: SessionText.secondLine(session))
                        .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let detail, !detail.isEmpty {
                        Text(verbatim: detail).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering ? 0.09 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    /// Headline, `repo · agent`, the state word, the reply excerpt, and whether it is new, in full for VoiceOver.
    private var accessibilityText: String {
        var parts = [SessionText.headline(session), SessionText.secondLine(session), SessionText.stateWord(session)]
        if let detail, !detail.isEmpty { parts.append(detail) }
        if unread { parts.append("new") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// A band that opens in place: the header is a button whose chevron and accessibility value say whether
/// it is open. The body stays in the same scroll region, so the menu does not close.
struct MenuDisclosure<Content: View>: View {
    let title: String
    var count: Int?
    @Binding var expanded: Bool
    @ViewBuilder var content: Content
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: Space.s) {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    if let count {
                        Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
                    }
                    Spacer(minLength: Space.s)
                    Lucide(expanded ? .chevronDown : .chevronRight, size: 14, color: Theme.muted)
                }
                .padding(.horizontal, Space.m)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering ? 0.09 : 0)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 4)
            .onHover { hovering = $0 }
            .accessibilityValue(expanded ? "expanded" : "collapsed")

            if expanded { content }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: expanded)
    }
}

/// A session that needs you, as a compact decision row (the phone's AskCard, condensed): a 3pt red
/// capsule down its left edge, the title, the agent's question, and its lettered options as one-tap
/// chips. A chip sends just its letter, as an answer to the chat's current turn, and only when tapped.
struct MenuAskRow: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    let open: () -> Void
    @State private var hovering = false
    @State private var sending: String?
    @State private var note: String?

    var body: some View {
        let choices = Array(model.choices(for: session.key).prefix(4))
        HStack(alignment: .top, spacing: Space.s) {
            Capsule().fill(Theme.needsYou).frame(width: 3).accessibilityHidden(true)
            AgentAvatar(session: session, size: 18).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Button(action: open) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: SessionText.headline(session))
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            Spacer(minLength: Space.xs)
                            RelativeTimeText(session.lastActivityAt, size: 12)
                        }
                        Text(verbatim: SessionText.secondLine(session))
                            .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                        if let q = model.question(for: session.key), !q.isEmpty {
                            Text(verbatim: q).font(.system(size: 12)).foregroundStyle(Theme.ink.opacity(0.85)).lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !choices.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(choices, id: \.letter) { c in
                            Button { send(c) } label: {
                                HStack(spacing: 6) {
                                    Text(c.letter).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink)
                                        .frame(width: 18, height: 18)
                                        .background(Circle().fill(Theme.ink.opacity(0.08)))
                                    Text(verbatim: c.label).font(.system(size: 12)).foregroundStyle(Theme.ink).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 6).frame(height: 24)
                                .background(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).fill(Theme.ink.opacity(sending == c.letter ? 0.14 : 0.05)))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(sending != nil)
                            .accessibilityLabel("Answer \(c.letter): \(c.label)")
                        }
                    }
                }
                if let note { Text(verbatim: note).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2) }
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering ? 0.05 : 0)))
        .onHover { hovering = $0 }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
    }

    private func send(_ c: Choice) {
        sending = c.letter
        note = nil
        Task {
            let result = await model.send(c.letter, to: session.key, answering: true)
            sending = nil
            switch result {
            case .accepted: note = "Sent \(c.letter)"
            case .none: break
            default: note = "Not sent. Open the chat to answer."
            }
        }
    }
}
