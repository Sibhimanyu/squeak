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
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 250),
                styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .closable],
                backing: .buffered, defer: false
            )
            p.titleVisibility = .hidden
            p.titlebarAppearsTransparent = true
            p.standardWindowButton(.miniaturizeButton)?.isHidden = true
            p.standardWindowButton(.zoomButton)?.isHidden = true
            p.standardWindowButton(.closeButton)?.isHidden = true
            p.isMovableByWindowBackground = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.onEscape = { [weak self] in self?.hide() }
            p.contentView = NSHostingView(rootView: QuickComposerView(close: { [weak self] in self?.hide() }).environment(model).environment(state))
            panel = p
        }
        guard let panel else { return }
        if !panel.isVisible { panel.center() }
        state.focus += 1
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() { panel?.orderOut(nil) }
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
        if let last = model.lastUsed, let s = model.session(last), model.canSend(s) { target = last } else { target = nil }
    }
}

struct QuickComposerView: View {
    var close: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(QuickState.self) private var state

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").foregroundStyle(Theme.muted).accessibilityHidden(true)
                Text("Quick message").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                Spacer()
                destinationMenu
            }
            if model.sendableSessions.isEmpty {
                EmptyStateView(
                    symbol: "bolt.slash", title: "Nobody to message",
                    message: model.isConnected ? "None of your sessions can take a reply right now." : "Squeak can't reach its service, so there is no one to message. Open Squeak for the fix."
                )
                .frame(maxWidth: .infinity)
            } else {
                ComposerField(
                    text: $state.text, sendKey: .returnSends,
                    placeholder: state.target == nil ? "Choose a session above, then type" : "Message…",
                    isEnabled: !state.sending, focusToken: state.focus, onSend: send, onEscape: close
                )
                .frame(height: 100)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
            }
            HStack {
                status
                Spacer()
                Text("↩ send · ⇧↩ new line · esc close").font(.system(size: 10)).foregroundStyle(Theme.subtle)
                Button("Send", action: send)
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
            }
        }
        .padding(16)
        .padding(.top, 8)
        .frame(width: 520, height: 250)
        .background(.regularMaterial)
    }

    private var canSend: Bool {
        guard let t = state.target, let s = model.session(t), model.canSend(s), model.isConnected, !state.sending else { return false }
        return !state.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var destinationMenu: some View {
        Menu {
            ForEach(model.sendableSessions) { s in
                Button(s.label) { state.target = s.key }
            }
        } label: {
            Text(destinationTitle).font(.system(size: 12, weight: .medium))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Destination session")
    }

    private var destinationTitle: String {
        if let t = state.target, let s = model.session(t) { return "To: \(s.label)" }
        return "Choose a session"
    }

    @ViewBuilder
    private var status: some View {
        if state.sending {
            Text("Sending…").font(.system(size: 11)).foregroundStyle(Theme.muted)
        } else if let r = state.result, let d = DeliveryText(state: r.messageState) {
            Label(d.text, systemImage: d.symbol).font(.system(size: 11)).foregroundStyle(d.color).lineLimit(2)
        } else if !model.isConnected, model.health != nil {
            Text("Squeak is offline. Nothing is sent until you press Send while connected.").font(.system(size: 11)).foregroundStyle(Theme.muted)
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
            switch r {
            case .accepted:
                state.text = ""
                try? await Task.sleep(for: .milliseconds(900))
                close()
            case .none:
                break
            default:
                break // refused, not sent or unconfirmed: keep the text so nothing is lost
            }
        }
    }
}
