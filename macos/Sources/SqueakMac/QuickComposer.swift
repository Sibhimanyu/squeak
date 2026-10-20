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

    func toggle() {
        if let panel, panel.isVisible { hide() } else { show() }
    }

    func show() {
        let model = AppModel.shared
        state.prepare(model: model)
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
            if model.sendableSessions.isEmpty {
                Text(model.isConnected ? "None of your sessions can take a reply right now." : "Squeak can't reach its service, so there is no one to message. Open Squeak for the fix.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .padding(.horizontal, 6)
            } else {
                ComposerField(
                    text: $state.text, sendKey: .commandReturnSends,
                    placeholder: target.map { "Message \($0.label)…" } ?? "Choose who to message, then type",
                    isEnabled: !state.sending, focusToken: state.focus, onSend: { send(.queue) }, onEscape: close,
                    onContentHeight: { fieldHeight = $0 }, fontSize: 16,
                    onOptionReturn: target?.state == .working ? { send(.steer) } : nil
                )
                .frame(height: min(max(fieldHeight, 32), 32 + lineHeight * 5))
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
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
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
                Button(destinationName(s)) { state.target = s.key }
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
                Text(verbatim: destinationTitle).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
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
        target?.label ?? "Choose a session"
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
        state.sending = true
        state.result = nil
        Task {
            let r = await model.send(text, to: key, mode: target?.state == .working ? mode : .queue)
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
