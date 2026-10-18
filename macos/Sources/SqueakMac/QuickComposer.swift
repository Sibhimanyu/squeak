import AppKit
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

    func toggle() {
        if let panel, panel.isVisible { hide() } else { show() }
    }

    func show() {
        let model = AppModel.shared
        state.prepare(model: model)
        if panel == nil {
            let p = QuickPanel(
                contentRect: NSRect(x: 0, y: 0, width: QuickComposerView.width, height: 150),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false
            )
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.isMovableByWindowBackground = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.onEscape = { [weak self] in self?.hide() }
            let host = NSHostingView(rootView: QuickComposerView(close: { [weak self] in self?.hide() }, resize: { [weak self] h in self?.resize(to: h) })
                .environment(model).environment(state))
            host.sizingOptions = []
            p.contentView = host
            panel = p
        }
        guard let panel else { return }
        if !panel.isVisible { panel.center() }
        state.focus += 1
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() { panel?.orderOut(nil) }

    /// Grows downward: the top edge stays where the user sees it.
    private func resize(to height: CGFloat) {
        guard let panel, abs(panel.frame.height - height) > 0.5 else { return }
        var f = panel.frame
        f.origin.y += f.height - height
        f.size.height = height
        panel.setFrame(f, display: true)
    }
}

@MainActor @Observable
final class QuickState {
    var target: SessionKey?
    var text = ""
    var focus = 0
    var result: SendResult?
    var sending = false

    func prepare(model: AppModel) {
        text = ""
        result = nil
        sending = false
        if let last = model.lastUsed, let s = model.session(last), model.canSend(s) {
            target = last
        } else {
            // Only a default: the chip names it, and nothing is sent until ⌘↩.
            target = model.grouped.first { $0.kind == .needsYou }?.sessions.first { model.canSend($0) }?.key
        }
    }
}

/// Glass panel, 640 wide: duck, "To:" chip, one growing field, hint row. Nothing else.
struct QuickComposerView: View {
    var close: () -> Void
    var resize: (CGFloat) -> Void = { _ in }
    @Environment(AppModel.self) private var model
    @Environment(QuickState.self) private var state
    @State private var fieldHeight: CGFloat = 36

    static let width: CGFloat = 640
    private let lineHeight: CGFloat = 17

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.m) {
                DuckGlyph(size: 24)
                Text("To:").font(.system(size: 14)).foregroundStyle(Theme.muted)
                destinationMenu
                Spacer()
            }
            if model.sendableSessions.isEmpty {
                Text(model.isConnected ? "None of your sessions can take a reply right now." : "Squeak can't reach its service, so there is no one to message. Open Squeak for the fix.")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, Space.m)
            } else {
                ComposerField(
                    text: $state.text, sendKey: .commandReturnSends,
                    placeholder: state.target == nil ? "Choose who to message, then type" : "Message…",
                    isEnabled: !state.sending, focusToken: state.focus, onSend: send, onEscape: close,
                    onContentHeight: { fieldHeight = $0 }
                )
                .frame(height: min(max(fieldHeight, 36), 36 + lineHeight * 5))
                .background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.card))
            }
            HStack(spacing: Space.s) {
                Text("⌘↩ Send").foregroundStyle(Theme.muted)
                Text("·").foregroundStyle(Theme.subtle)
                Text("Esc Close").foregroundStyle(Theme.muted)
                Spacer()
                status
            }
            .font(.system(size: 12))
        }
        .padding(Space.l)
        .frame(width: Self.width)
        .background(GeometryReader { Color.clear.preference(key: QuickHeightKey.self, value: $0.size.height) })
        .onPreferenceChange(QuickHeightKey.self) { resize($0) }
        .modifier(GlassPanel(radius: 16))
    }

    private var canSend: Bool {
        guard let t = state.target, let s = model.session(t), model.canSend(s), model.isConnected, !state.sending else { return false }
        return !state.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var destinationMenu: some View {
        Menu {
            ForEach(model.sendableSessions) { s in
                Button(destinationName(s)) { state.target = s.key }
            }
        } label: {
            HStack(spacing: Space.s) {
                Text(verbatim: destinationTitle).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, Space.m)
            .frame(height: 30)
            .background(Theme.surfaceRaised.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Destination session")
    }

    private func destinationName(_ s: HostSession) -> String {
        [s.label, s.repoName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var destinationTitle: String {
        if let t = state.target, let s = model.session(t) { return destinationName(s) }
        return "Choose a session"
    }

    @ViewBuilder private var status: some View {
        if state.sending {
            Text("Sending…").foregroundStyle(Theme.muted)
        } else if let r = state.result, let f = SendFeedback(r) {
            Label(f.text, systemImage: f.symbol).foregroundStyle(f.color).lineLimit(2)
        } else if !model.isConnected, model.health != nil {
            Text("Offline. Nothing is sent until you press ⌘↩ while connected.").foregroundStyle(Theme.muted)
        }
    }

    private func send() {
        guard canSend, let key = state.target else { return }
        let text = state.text
        state.sending = true
        state.result = nil
        Task {
            let r = await model.send(text, to: key)
            state.sending = false
            state.result = r
            if case .accepted = r {
                state.text = ""
                try? await Task.sleep(for: .milliseconds(900))
                close()
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
