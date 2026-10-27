import SqueakIcons
import SqueakMacCore
import SwiftUI

/// New chat inside the popup. It drives the same `NewChatState` and Core `NewChatForm` as the New chat
/// window (presets, model, thinking, split, plan first, `startChat`); only the drawing is the popup's.
struct PopupNewChatTop: View {
    var body: some View {
        HStack(spacing: 14) {
            PopupBackButton { PopupNav.shared.back() }
            Text("New chat").font(.popup(16, .bold)).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
        .padding(.top, 14).padding(.bottom, 10)
    }
}

struct PopupNewChatBand: View {
    @Environment(AppModel.self) private var model
    let state = PopupNav.shared.newChat

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 0) {
            switch state.phase {
            case .loading:
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading workspaces…").foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity, minHeight: 160)
            case .offline:
                notice("Squeak can't reach its service, so there is nowhere to start a chat. Open Squeak for the fix.")
            case .outdated:
                notice("This version of the Squeak service can't start chats yet. Update the service in Settings.")
            case .ready, .starting:
                form
            }
        }
        .padding(.bottom, 10)
        .disabled(state.phase == .starting)
    }

    private func notice(_ text: String) -> some View {
        Text(text).font(.popup(12.5)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.popup(13)).foregroundStyle(Theme.muted).padding(.bottom, 7)
    }

    @ViewBuilder private var form: some View {
        @Bindable var state = state
        let f = state.form
        label("Workspace")
        workspaceRow
        if !f.presets.isEmpty {
            label("Preset").padding(.top, 14)
            HStack(spacing: 8) {
                ForEach(f.presets + (f.preset == .custom ? [.custom] : []), id: \.self) { p in
                    let on = f.preset == p
                    Button { if p != .custom { state.form.apply(preset: p) } } label: {
                        Text(p.title).font(.popup(13, on ? .semibold : .regular)).foregroundStyle(on ? Theme.ink : Theme.muted)
                            .frame(maxWidth: .infinity).frame(height: 28)
                            .background(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius, style: .continuous).fill(on ? Theme.selected : Color.wash(0.025)))
                            .overlay(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius, style: .continuous).strokeBorder(Color.wash(on ? 0.2 : 0.10)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        if !f.models.isEmpty {
            Text(f.summary).font(.popup(12.5)).foregroundStyle(Theme.muted).padding(.top, 8)
        }
        customize.padding(.top, 14)
        HStack(spacing: 0) {
            label("First message")
            Spacer(minLength: 0)
            if f.selected?.path != nil { AttachButton(tray: state.images, size: 22).padding(.bottom, 7) }
        }
        .padding(.top, 14)
        ImageStrip(tray: state.images).padding(.bottom, 8)
        ComposerField(text: $state.form.text, sendKey: .commandReturnSends, placeholder: "What should it work on?",
                      isEnabled: state.phase != .starting, focusToken: state.focus, onSend: start, onEscape: { PopupNav.shared.back() },
                      fontSize: 13, onImages: f.selected?.path == nil ? nil : { state.images.add($0) })
            .padding(.horizontal, 6)
            .frame(height: 92)
            .popupCard(radius: 10, fill: 0.03, stroke: 0.10)
            .imageDrop(state.images)
        if state.form.isTooLong {
            Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.")
                .font(.popup(12)).foregroundStyle(Theme.error).padding(.top, 6)
        }
    }

    private var workspaceRow: some View {
        let f = state.form
        return Button { PopupNav.shared.screen = .workspaces } label: {
            HStack(spacing: 13) {
                Lucide(.layers, size: 14, color: Theme.ink).frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: f.selected?.label ?? "Choose a workspace").font(.popup(14, .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let t = f.selected?.title { Text(verbatim: t).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1) }
                }
                Spacer(minLength: 4)
                Lucide(.chevronRight, size: 14, color: Theme.muted)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 52)
            .popupCard(radius: 10, fill: 0.03, stroke: 0.11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace: \(f.selected?.label ?? "none chosen"). Change.")
    }

    // MARK: Customize

    @ViewBuilder private var customize: some View {
        @Bindable var state = state
        let f = state.form
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.15)) { state.customizing.toggle() } } label: {
                HStack(spacing: 11) {
                    Lucide(.settings, size: 14, color: Theme.ink).frame(width: 22)
                    Text("Customize").font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                    Spacer()
                    Lucide(state.customizing ? .chevronDown : .chevronRight, size: 14, color: Theme.ink)
                }
                .frame(height: 38)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(state.customizing ? "expanded" : "collapsed")
            if state.customizing {
                PopupDivider()
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        column("Agent", width: 134) {
                            PopupSegmented(items: NewChatAgent.allCases.map { ($0, $0.displayName) }, selection: f.agent, height: 26, size: 12.5) {
                                state.form.choose(agent: $0)
                            }
                        }
                        if !f.agentModels.isEmpty {
                            column("Model") {
                                PopupMenuField(label: "Model", selection: Binding(get: { state.form.setup.modelId ?? "" }, set: { state.form.pick(modelId: $0) }),
                                               options: f.agentModels.map { m in (m.id, ChatPresets.shortName(m.label) + (m.label.contains("1M") ? " · 1M" : "")) }, height: 26)
                            }
                        }
                    }
                    if let chosen = f.chosenModel, !chosen.levels.isEmpty {
                        column("Thinking level") {
                            PopupSegmented(items: chosen.levels.map { ($0, DaemonChatModel.levelName($0)) }, selection: state.form.setup.level, height: 26, size: 12) {
                                state.form.pick(level: $0)
                            }
                        }
                    }
                    if f.canSplit {
                        PopupDivider()
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Split the work").font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                            Text("Give focused jobs to two agents.").font(.popup(12.5)).foregroundStyle(Theme.muted)
                        }
                        HStack(alignment: .top, spacing: 12) {
                            column("Writes the code") { worker(\.setup.code, "Writes the code") { state.form.pick(code: $0) } }
                            column("Runs tests and builds") { worker(\.setup.run, "Runs tests and builds") { state.form.pick(run: $0) } }
                        }
                        PopupDivider()
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Plan first").font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                                Text("Shows you the plan and waits for your go.").font(.popup(12.5)).foregroundStyle(Theme.muted)
                            }
                            Spacer(minLength: 8)
                            PopupSwitch(label: "Plan first", isOn: Binding(get: { state.form.setup.planFirst }, set: { state.form.set(planFirst: $0) }))
                        }
                        PopupDivider()
                        Text("The chat's model plans and reviews; cheaper ones do the typing.")
                            .font(.popup(12.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.bottom, 14)
            }
        }
        .padding(.horizontal, 14)
        .popupCard(radius: 12, fill: 0.03, stroke: 0.10)
    }

    private func column<C: View>(_ title: String, width: CGFloat? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.popup(12.5)).foregroundStyle(Theme.muted)
            content()
        }
        .frame(width: width, alignment: .leading)
        .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }

    private func worker(_ path: KeyPath<NewChatForm, String?>, _ label: String, set: @escaping (String?) -> Void) -> some View {
        PopupMenuField(label: label, selection: Binding(get: { state.form[keyPath: path] ?? "" }, set: { set($0.isEmpty ? nil : $0) }),
                       options: [("", "Same model")] + ChatWorker.all.map { ($0.id, $0.label) }, height: 28)
    }

    private func start() { state.start(model: model, openInWindow: false, close: { PopupNav.shared.show(.home) }) }
}

/// ⌘↵ starts, Cancel, Start chat: pinned under the form.
struct PopupNewChatFooter: View {
    @Environment(AppModel.self) private var model
    let state = PopupNav.shared.newChat

    var body: some View {
        VStack(spacing: 0) {
            if let e = state.error {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: 14, color: Theme.error)
                    Text(e).font(.popup(12.5)).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 8)
            }
            PopupDivider()
            HStack(spacing: 10) {
                if state.phase == .starting {
                    ProgressView().controlSize(.small)
                    Text("Starting…").font(.popup(12.5)).foregroundStyle(Theme.muted)
                } else if state.phase == .ready {
                    HStack(spacing: 9) {
                        Text("⌘").font(.popup(13))
                        Image(systemName: "return").font(.system(size: 12.5))
                    }
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 12).frame(height: 26)
                    .popupCard(radius: 8, fill: 0.05, stroke: 0.11)
                    Text("starts").font(.popup(12.5)).foregroundStyle(Theme.subtle)
                }
                Spacer(minLength: 4)
                Button("Cancel") { PopupNav.shared.back() }
                    .buttonStyle(PopupButtonStyle(radius: 9, height: 28, hPad: 20, size: 13))
                Button { start() } label: {
                    HStack(spacing: 8) {
                        if let duck = BrandAssets.image("squeak-duck-silhouette-32.png") {
                            Image(nsImage: duck).renderingMode(.template).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                                .frame(width: 22, height: 19).foregroundStyle(Theme.primaryText)
                        }
                        Text("Start chat")
                    }
                }
                .buttonStyle(PopupButtonStyle(kind: .primary, radius: 9, height: 28, hPad: 16, size: 13))
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!state.form.canStart || state.phase != .ready || !model.isConnected)
            }
                .padding(.top, 12).padding(.bottom, 14)
        }
    }

    private func start() { state.start(model: model, openInWindow: false, close: { PopupNav.shared.show(.home) }) }
}

// MARK: Workspace list

struct PopupWorkspacesTop: View {
    let state = PopupNav.shared.newChat

    var body: some View {
        @Bindable var state = state
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                PopupBackButton { PopupNav.shared.back() }
                Text("Workspace").font(.popup(16, .bold)).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                Lucide(.search, size: 14, color: Theme.muted)
                TextField("Search workspaces", text: $state.form.query).textFieldStyle(.plain).font(.popup(13))
            }
            .padding(.horizontal, 12).frame(height: 28)
            .popupCard(radius: 9, fill: 0.03, stroke: 0.11)
        }
        .padding(.top, 14).padding(.bottom, 10)
    }
}

struct PopupWorkspacesBand: View {
    let state = PopupNav.shared.newChat

    var body: some View {
        let rows = state.form.filtered
        VStack(spacing: 0) {
            if rows.isEmpty {
                Text(state.form.workspaces.isEmpty ? "No open workspaces in Conductor." : "No workspace matches.")
                    .font(.popup(12.5)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 80)
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, w in
                let on = w.id == state.form.workspaceId
                if i > 0 { PopupDivider() }
                Button {
                    state.form.select(w.id)
                    PopupNav.shared.back()
                } label: {
                    HStack(spacing: 0) {
                        ZStack { if on { Lucide(.check, size: 14, color: Theme.ink) } }.frame(width: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: w.label).font(.popup(13, on ? .semibold : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
                            if let t = w.title { Text(t).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1) }
                        }
                        Spacer(minLength: 8)
                        RelativeTimeText(w.lastActivityAt, size: 12.5)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .frame(minHeight: 44)
                    .background(Color.wash(on ? 0.07 : 0))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .popupCard(radius: 10, fill: 0.03, stroke: 0.10)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.bottom, 14)
    }
}
