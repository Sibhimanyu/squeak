import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

final class QuickPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

@MainActor
final class QuickComposerController {
    static let shared = QuickComposerController()
    private var panel: QuickPanel?
    let state = QuickState()
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var spaceObserver: NSObjectProtocol?
    private var menuObservers: [NSObjectProtocol] = []
    private var menuTracking = false
    private var reopenTask: Task<Void, Never>?
    private var lastExplicitOpen = Date.distantPast
    /// A click that ends a menu is still on its way when tracking stops; it is not an outside click.
    private var ignoreClicksUntil = Date.distantPast

    func toggle() {
        if let panel, panel.isVisible { hide() } else { show() }
    }

    /// `target` is explicit (a chat opened on purpose): it wins over the last chat messaged and
    /// opens with that chat's latest reply above the field. Without one, an open composer keeps its
    /// chat and a closed one picks a default, compact, with no context.
    func show(target: SessionKey? = nil) {
        present(target: target, anchor: nil, fromNotification: false)
    }

    /// A clicked notification: its chat, and the reply this very event was about. It cancels a
    /// pending generic reopen and is not undone by one that fires late.
    func show(notification open: PendingNotificationOpen) {
        reopenTask?.cancel()
        lastExplicitOpen = Date()
        present(target: open.key, anchor: open.anchor, fromNotification: open.fromNotification)
    }

    /// The activation that follows a Spotlight/Finder reopen, and that a clicked notification also
    /// causes, arrives either side of the notification response. Waiting a moment lets an explicit
    /// notification open win; a generic open never touches an explicit target or its context.
    func scheduleReopen() {
        reopenTask?.cancel()
        reopenTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let self else { return }
            guard Date().timeIntervalSince(lastExplicitOpen) > 2, panel?.isVisible != true else { return }
            // A window opened during the wait (Open Squeak, New Chat, Settings) owns the screen now.
            guard !NSApp.windows.contains(where: ActivationPolicyController.isAppWindow) else { return }
            show()
        }
    }

    private func present(target: SessionKey?, anchor: NotificationAnchor?, fromNotification: Bool) {
        // Any explicit open supersedes a generic reopen still waiting: a close right after it must not bring it back.
        if target != nil { reopenTask?.cancel() }
        let model = AppModel.shared
        model.dismissMenuBar?()
        if panel?.isVisible == true {
            // Same chat and event already showing: nothing to reset. Anything else retargets, with the draft kept.
            if let target, target != state.target || anchor?.eventId != state.context.anchor?.eventId || !state.context.isVisible {
                state.stashDraft()
                state.prepare(model: model, explicit: target)
                state.context.load(key: target, anchor: anchor, fromNotification: fromNotification, model: model)
            }
        } else {
            state.prepare(model: model, explicit: target)
            if let target { state.context.load(key: target, anchor: anchor, fromNotification: fromNotification, model: model) }
        }
        if panel == nil {
            let p = QuickPanel(
                contentRect: NSRect(x: 0, y: 0, width: QuickComposerView.windowWidth, height: 200),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false
            )
            p.isOpaque = false
            p.backgroundColor = .clear
            // The pill draws its own shadow: a window shadow would also outline the glow's soft edge.
            p.hasShadow = false
            p.isMovableByWindowBackground = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            // Opens on the desktop you are on (or beside a full-screen app) and stays there: a Space
            // swipe closes it rather than carrying it along.
            p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            p.onEscape = { [weak self] in self?.hide() }
            let host = NSHostingView(rootView: QuickComposerView(close: { [weak self] in self?.hide() }, resize: { [weak self] h in self?.resize(to: h) })
                .environment(model).environment(state))
            host.sizingOptions = []
            p.contentView = host
            panel = p
        }
        guard let panel else { return }
        if !panel.isVisible { position(panel) }
        state.screenHeight = (panel.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        state.focus += 1
        panel.makeKeyAndOrderFront(nil)
        installDismissObservers()
        AppLog.info("quick composer shown")
    }

    /// Only hides: the text is kept for its chat, and nothing is sent or cancelled.
    func hide() {
        removeDismissObservers()
        state.stashDraft()
        state.epoch += 1
        state.context.clear()
        panel?.orderOut(nil)
        AppLog.info("quick composer hidden")
    }

    // MARK: Dismissal

    /// A nonactivating panel gets no reliable resign-key when you click elsewhere, so a click
    /// outside is read from mouse monitors (global for other apps, local for this app's own windows)
    /// and a Space swipe from the workspace. All are removed on every hide and replaced on show.
    private func installDismissObservers() {
        removeDismissObservers()
        ignoreClicksUntil = .distantPast // a fresh open owes nothing to the last menu's grace
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
            MainActor.assumeIsolated { self?.handleLocalClick(in: event.window) }
            return event // never swallowed: the click still reaches what was clicked
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismissForOutsideClick() }
        }
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
        // The destination menu is native: while it tracks, clicks belong to it.
        let nc = NotificationCenter.default
        menuObservers = [
            nc.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.menuTracking = true }
            },
            nc.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.menuTracking = false
                    self?.ignoreClicksUntil = Date().addingTimeInterval(0.3)
                }
            },
        ]
    }

    private func removeDismissObservers() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let spaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(spaceObserver) }
        menuObservers.forEach(NotificationCenter.default.removeObserver)
        localMonitor = nil; globalMonitor = nil; spaceObserver = nil; menuObservers = []
        menuTracking = false
    }

    private func handleLocalClick(in window: NSWindow?) {
        if let window {
            // The pill, its sheets, and menu windows (which float above everything) are not outside.
            if window === panel || window.parent === panel || window.level.rawValue >= NSWindow.Level.popUpMenu.rawValue { return }
        }
        dismissForOutsideClick()
    }

    private func dismissForOutsideClick() {
        guard panel?.isVisible == true, !menuTracking, Date() >= ignoreClicksUntil else { return }
        hide()
    }

    /// On the screen the pointer is on, a little above the middle, as `center()` would but not
    /// always on the main display.
    private func position(_ panel: NSPanel) {
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let v = screen?.visibleFrame else { return panel.center() }
        var f = panel.frame
        f.origin.x = v.midX - f.width / 2
        f.origin.y = v.minY + (v.height - f.height) * 0.62
        panel.setFrame(f, display: false)
    }

    /// Grows downward: the top edge stays where the user sees it. Never taller than its screen, and
    /// moved back inside it, so the field and Send stay reachable however long the context is.
    private func resize(to height: CGFloat) {
        guard let panel else { return }
        let visible = (panel.screen ?? NSScreen.main)?.visibleFrame
        let h = visible.map { min(height, $0.height - 16) } ?? height
        var f = panel.frame
        guard abs(f.height - h) > 0.5 else { return clamp(panel) }
        f.origin.y += f.height - h
        f.size.height = h
        panel.setFrame(f, display: true)
        clamp(panel)
    }

    private func clamp(_ panel: NSPanel) {
        guard let v = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
        var f = panel.frame
        let y = min(max(f.origin.y, v.minY + 8), v.maxY - 8 - f.height)
        guard abs(y - f.origin.y) > 0.5 else { return }
        f.origin.y = y
        panel.setFrame(f, display: true)
    }
}

@MainActor @Observable
final class QuickState {
    var target: SessionKey?
    var text = ""
    var focus = 0
    var result: SendResult?
    /// Chats with a send still in flight. Outlives a hide, so a reopened composer cannot send the same text twice.
    private(set) var inFlight: Set<SessionKey> = []
    /// Bumped on every show and hide: a send that finishes under an older one must not touch this composer.
    var epoch = 0
    /// The reply the pill shows above its field, for an explicit target or a clicked notification.
    let context = QuickContextModel()
    /// Height of the screen the pill is on, so long context leaves room for the field.
    var screenHeight: CGFloat = 900
    private var drafts = ComposerDrafts()

    var sending: Bool { target.map(inFlight.contains) ?? false }

    /// Opens on `explicit` (a clicked notification) if given, even when that chat can no longer be
    /// sent to: Send is then disabled rather than aimed at another chat. Each chat has its own draft.
    func prepare(model: AppModel, explicit: SessionKey? = nil) {
        epoch += 1
        result = nil
        context.clear()
        // Only a default: the chip names it, and nothing is sent until ⌘↩.
        target = ComposerRouting.target(
            explicit: explicit, lastUsed: model.lastUsed,
            needsYou: model.grouped.first { $0.kind == .needsYou }?.sessions.map(\.key) ?? [],
            canSend: { key in model.session(key).map(model.canSend) ?? false })
        text = drafts.text(for: target)
    }

    func stashDraft() { drafts.stash(text, for: target) }

    func beginSend(to key: SessionKey) { inFlight.insert(key); result = nil }

    /// Settles a send. Only a composer still on the same show (`epoch`) and chat takes the outcome;
    /// a hidden or reopened one is left as it is, and an accepted draft is just forgotten.
    func endSend(of sent: String, to key: SessionKey, epoch started: Int, result r: SendResult?) -> Bool {
        inFlight.remove(key)
        let accepted: Bool = if case .accepted? = r { true } else { false }
        if accepted { drafts.sent(sent, to: key) }
        let s = ComposerDrafts.settlement(
            sent: sent, to: key, startedEpoch: started, currentEpoch: epoch,
            target: target, text: text, accepted: accepted)
        if s.adoptResult { result = r }
        if s.clearText { text = "" }
        return accepted
    }

    /// The destination menu: a new show as far as in-flight sends are concerned, with each chat's
    /// draft kept apart and text typed before any chat was chosen carried to the first one picked.
    func chooseTarget(_ key: SessionKey, model: AppModel = .shared) {
        guard key != target else { return }
        epoch += 1
        result = nil
        // The reply belongs to the chat it was loaded for, never to the one now chosen. A composer
        // that was showing context keeps showing it, for the new chat's latest reply and with no
        // notification anchor; a compact one stays compact.
        let keepContext = context.isVisible
        context.clear()
        text = drafts.choose(key, from: target, current: text)
        target = key
        focus += 1
        if keepContext { context.load(key: key, anchor: nil, fromNotification: false, model: model) }
    }
}

/// The quick message pill (DESIGN.md §8.5): one growing field on top; under it the "To" chip with
/// the chat's state dot, the repo and agent, and the round duck-yellow Send. The shortcuts sit
/// below the glass, and a warm light spills from under it: nearly still while you type, brighter and
/// breathing while it sends. Still under Reduce Motion, gone under Reduce Transparency.
struct QuickComposerView: View {
    var close: () -> Void
    var resize: (CGFloat) -> Void = { _ in }
    @Environment(AppModel.self) private var model
    @Environment(QuickState.self) private var state
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var fieldHeight: CGFloat = 32
    @State private var breathing = false

    static let width: CGFloat = 640
    /// Room around the pill for its shadow and the light under it.
    static let margin: CGFloat = 48
    static var windowWidth: CGFloat { width + margin * 2 }
    private let lineHeight: CGFloat = 20

    private var target: HostSession? { state.target.flatMap { model.session($0) } }

    var body: some View {
        VStack(spacing: 10) {
            pill
                .background(alignment: .bottom) { glow }
            hints
        }
        .padding(.horizontal, Self.margin)
        .padding(.top, 28)
        .padding(.bottom, 40)
        .frame(width: Self.windowWidth)
        .background(GeometryReader { Color.clear.preference(key: QuickHeightKey.self, value: $0.size.height) })
        .onPreferenceChange(QuickHeightKey.self) { resize($0) }
        // Follows the panel to another display, so the context's room is the screen it is on.
        .background(ScreenHeightReader { if let h = $0 { state.screenHeight = h } })
        .onChange(of: state.sending) { _, sending in
            guard !reduceMotion else { return }
            if sending {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { breathing = true }
            } else {
                withAnimation(.easeOut(duration: 0.6)) { breathing = false }
            }
        }
    }

    private var pill: some View {
        @Bindable var state = state
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        return VStack(alignment: .leading, spacing: 10) {
            if state.context.isVisible, let key = state.context.key {
                QuickContextView(
                    context: state.context, session: model.session(key), key: key,
                    maxHeight: QuickLayout.contextLimit(screenHeight: state.screenHeight, fieldHeight: fieldHeight), close: close)
                // A hairline between reading and writing, not a box around either.
                Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 2)
            }
            if model.sendableSessions.isEmpty {
                Text(model.isConnected ? "None of your sessions can take a reply right now." : "Squeak can't reach its service, so there is no one to message. Open Squeak for the fix.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .padding(.horizontal, 6)
            } else {
                ComposerField(
                    text: $state.text, sendKey: .commandReturnSends,
                    placeholder: placeholder,
                    isEnabled: !state.sending, focusToken: state.focus, onSend: { send(.queue) }, onEscape: close,
                    onContentHeight: { fieldHeight = $0 }, fontSize: 16,
                    onOptionReturn: target?.state == .working ? { send(.steer) } : nil
                )
                .frame(height: min(max(fieldHeight, QuickLayout.minFieldHeight), QuickLayout.maxFieldHeight))
            }
            HStack(spacing: 10) {
                destinationMenu
                if let meta = targetMeta {
                    Text(verbatim: meta).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 8)
                status
                sendButton
            }
        }
        .padding(.horizontal, state.context.isVisible ? 22 : 16).padding(.top, 14).padding(.bottom, 12)
        .frame(width: Self.width)
        .modifier(GlassPanel(radius: 26))
        // A barely-there warm tint along the lower edge, where the light comes from.
        .overlay {
            if !reduceTransparency {
                shape.strokeBorder(
                    LinearGradient(colors: [.clear, .clear, Theme.duck.opacity(breathing ? 0.32 : 0.16)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
            }
        }
        .shadow(color: .black.opacity(0.35), radius: 24, y: 14)
    }

    /// Warm light spilling from under the pill onto whatever is behind: duck yellow at the centre
    /// shading to the bill's orange at the sides, heavily blurred, gone within ~120pt.
    @ViewBuilder private var glow: some View {
        if !reduceTransparency {
            // Elliptical gradients that reach nothing at their own edge, so no outline can show.
            ZStack {
                Rectangle()
                    .fill(EllipticalGradient(colors: [Self.beak.opacity(0.7), Self.beak.opacity(0.25), .clear],
                                             center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
                    .frame(width: 680, height: 150)
                Rectangle()
                    .fill(EllipticalGradient(colors: [Theme.duck, Theme.duck.opacity(0.35), .clear],
                                             center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
                    .frame(width: 440, height: 90)
            }
            .blur(radius: 18)
            .opacity(breathing ? 0.75 : 0.42)
            .offset(y: 58)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private static let beak = Color(nsColor: NSColor(hex: Tokens.beak))

    private var hints: some View {
        HStack(spacing: 8) {
            Text("⌘↩ send")
            if target?.state == .working { Text("·").foregroundStyle(Theme.subtle); Text("⌥↩ steer") }
            Text("·").foregroundStyle(Theme.subtle)
            Text("esc close")
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.muted)
        .accessibilityElement(children: .combine)
    }

    private var targetMeta: String? {
        guard let target else { return nil }
        let agent = target.agent.map { $0.prefix(1).uppercased() + $0.dropFirst() }
        let parts = [target.repoName, agent].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var sendButton: some View {
        Button { send(.queue) } label: {
            Lucide(.arrowUp, size: 16, color: canSend ? Theme.primaryText : Theme.muted)
                .frame(width: 32, height: 32)
                .background(Circle().fill(canSend ? Theme.primaryFill : Theme.surfaceRaised.opacity(0.8)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel(target?.state == .working ? "Queue" : "Send")
    }

    private var canSend: Bool {
        guard let t = state.target, let s = model.session(t), model.canSend(s), model.isConnected, !state.sending else { return false }
        return !state.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var destinationMenu: some View {
        Menu {
            ForEach(model.sendableSessions) { s in
                Button(destinationName(s)) { state.chooseTarget(s.key) }
            }
            Divider()
            Button("New chat in…") {
                let ws = state.target.flatMap { model.session($0)?.conductorWorkspaceId }
                QuickComposerController.shared.hide()
                NewChatController.shared.show(preselect: ws)
            }
        } label: {
            HStack(spacing: 7) {
                Text("To").font(.system(size: 13)).foregroundStyle(Theme.muted)
                if let target {
                    Circle().fill(Theme.color(for: target.state)).frame(width: 7, height: 7).accessibilityHidden(true)
                }
                // Capped so a long title shortens with "…" instead of pushing Send off the row.
                Text(verbatim: destinationTitle).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: 220, alignment: .leading)
                Lucide(.chevronDown, size: 14, color: Theme.muted)
            }
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(Capsule().fill(Theme.surfaceRaised.opacity(0.75)))
            .overlay(Capsule().stroke(Theme.line))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        // The menu's own bezel draws past the chip's ends; only the capsule shows.
        .clipShape(Capsule())
        .accessibilityLabel("Destination session")
    }

    private func destinationName(_ s: HostSession) -> String {
        [s.label, s.repoName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var destinationTitle: String {
        target?.label ?? (state.target == nil ? "Choose a session" : "Unavailable chat")
    }

    private var placeholder: String {
        guard let target else { return missingTargetPrompt }
        if state.context.isVisible, let agent = target.agent, !agent.isEmpty {
            return "Reply to \(agent.prefix(1).uppercased() + agent.dropFirst())…"
        }
        return "Message \(target.label)…"
    }

    /// A clicked notification's chat that is gone or cannot take a reply is said so, never swapped for another.
    private var missingTargetPrompt: String {
        guard state.target != nil else { return "Choose who to message, then type" }
        return model.hasLoaded ? "That chat can't take a reply. Choose another to message." : "Loading your sessions…"
    }

    @ViewBuilder private var status: some View {
        Group {
            if state.sending {
                Text("Sending…").foregroundStyle(Theme.muted)
            } else if let r = state.result, let f = SendFeedback(r) {
                HStack(spacing: 6) { Lucide(f.symbol, size: 14, color: f.color); Text(f.text).foregroundStyle(f.color).lineLimit(1) }
            } else if !model.isConnected, model.health != nil {
                Text("Offline").foregroundStyle(Theme.muted)
            }
        }
        .font(.system(size: 12))
    }

    private func send(_ mode: SendMode) {
        guard canSend, let key = state.target else { return }
        let text = state.text
        let epoch = state.epoch
        let mode: SendMode = target?.state == .working ? mode : .queue
        state.beginSend(to: key)
        Task {
            let r = await model.send(text, to: key, mode: mode)
            if state.endSend(of: text, to: key, epoch: epoch, result: r) {
                try? await Task.sleep(for: .milliseconds(900))
                // Closes only the composer this send was made from, not one reopened since.
                if state.epoch == epoch { close() }
            }
            // refused, not sent or unconfirmed: keep the text so nothing is lost
        }
    }
}

private struct QuickHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Liquid glass on macOS 26, a material elsewhere; clipped to the radius with a hairline edge.
struct GlassPanel: ViewModifier {
    var radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if AppModel.shared.demoMode {
            // cacheDisplay cannot render live glass, so a capture shows a stand-in with the same edge.
            content.background(Theme.surface.opacity(0.78), in: shape).overlay(shape.stroke(Theme.line))
        } else if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.regularMaterial, in: shape).overlay(shape.stroke(Theme.line))
        }
    }
}
