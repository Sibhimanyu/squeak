import AppKit
import Heresay
import SqueakIcons
import SqueakMacCore
import SwiftUI

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    var isShowing: Bool { window?.isVisible ?? false }

    /// Only for someone who has not finished first run. Updates never bring it back.
    func showIfNeeded() {
        let model = AppModel.shared
        guard !model.onboardingDone, !model.setup.progress.finished, !model.captureMode else { return }
        show()
    }

    /// First run from the start (resuming at the first unfinished screen), or with `at`, straight to that
    /// screen (Settings › Setup).
    func show(at stage: SetupStage? = nil) {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 850, height: 640),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
            )
            w.minSize = NSSize(width: 760, height: 540)
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        window?.title = stage == nil ? "Welcome to Squeak" : "Set up Squeak"
        window?.contentView = NSHostingView(
            rootView: OnboardingView(stage: stage, finish: { [weak self] in self?.window?.close() })
                .environment(AppModel.shared))
        ActivationPolicyController.shared.willShowWindow()
        window?.makeKeyAndOrderFront(nil)
    }
}

/// First run, in the workbench's style: a sidebar of steps, the step in the centre. `SetupFlow` (SqueakMacCore)
/// decides the order, what is done, what may be skipped and where to resume; each step runs the app's own actions.
struct OnboardingView: View {
    var finish: () -> Void
    @Environment(AppModel.self) private var model
    @State private var stage: SetupStage?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `stage` nil: work out where to start from what is already set up.
    init(stage: SetupStage? = nil, finish: @escaping () -> Void) {
        _stage = State(initialValue: stage)
        self.finish = finish
    }

    var body: some View {
        let flow = model.setupFlow
        HStack(spacing: 0) {
            SetupSidebar(stage: stage, flow: flow) { target in
                // Only back to a step already reached; forward moves go through Continue.
                if let stage, let a = flow.stages.firstIndex(of: target), let b = flow.stages.firstIndex(of: stage), a < b { go(target) }
            }
            .frame(width: 236)
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(spacing: 0) {
                if let stage {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.l) {
                            DuckSprite(mood: mood(stage, flow), width: stage == .welcome || stage == .done ? 120 : 84)
                            content(stage, flow)
                        }
                        .id(stage)
                        .transition(.opacity)
                        .frame(maxWidth: 520, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    footer(stage, flow).frame(maxWidth: 520).frame(maxWidth: .infinity).padding(.top, Space.m)
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(.horizontal, 36).padding(.top, 36).padding(.bottom, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg)
        }
        .background(Theme.bg)
        .reportAnchor("setup")
        .onAppear { if SqueakMacApp.reportsEnabled { Heresay.setScreen("Setup") } }
        // Esc never closes the window or leaves a required step.
        .onExitCommand {}
        .task { await prepare() }
        .task { await poll() }
        .onChange(of: flow.isReturning) { _, returning in
            // The service answered a moment after Welcome showed: someone who already has Squeak skips ahead.
            if returning, stage == .welcome, !model.setup.progress.started { go(.done) }
        }
    }

    // MARK: Moving

    private func prepare() async {
        guard stage == nil else { return }
        model.setup.redetect()
        await model.setup.refresh(model)
        await model.account.refresh()
        go(model.setupFlow.startStage)
    }

    private func poll() async {
        var tick = 0
        while !Task.isCancelled {
            if let stage {
                await model.setup.refresh(model)
                if stage == .service, model.setupFlow.nextConnectAction(attempted: model.setup.connectAttempted) == .service,
                   model.setup.progress.started { model.startService() }
                model.recordSetupProgress()
                if stage == .account || stage == .phone { await model.account.refresh() }
                if tick % 2 == 0, stage == .phone { await model.channels.refresh() }
                tick += 1
            }
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    private func mood(_ s: SetupStage, _ flow: SetupFlow) -> SetupDuckMood {
        switch s {
        case .welcome: model.setup.progress.started ? .idle : .asleep
        case .service: flow.serviceRow.state.isFailed ? .needsYou : flow.serviceRunning ? .celebrating : .working
        case .agents: flow.hooksRow.state.isFailed && !flow.agentsFound.isEmpty ? .needsYou : flow.connectReady && !flow.agentsFound.isEmpty ? .celebrating : .idle
        case .account: flow.facts.signedIn ? .celebrating : .idle
        case .phone: flow.facts.phonePaired ? .celebrating : .idle
        case .done: .celebrating
        }
    }

    private func go(_ s: SetupStage) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: SetupMotion.standard)) { stage = s }
        // Reaching Done is finishing: setup never comes back on its own.
        if s == .done { model.finishSetup() }
    }

    private func advance(from s: SetupStage, skipping: Bool) {
        if skipping { model.skipSetupStage(s) } else { model.unskipSetupStage(s); model.completeSetupStage(s) }
        go(model.setupFlow.next(after: s) ?? .done)
    }

    // MARK: Steps

    @ViewBuilder private func content(_ s: SetupStage, _ flow: SetupFlow) -> some View {
        switch s {
        case .welcome: WelcomeStep()
        case .service: ServiceStep()
        case .agents: AgentsStep()
        case .account: AccountStep()
        case .phone: PhoneStep()
        case .done: DoneStep()
        }
    }

    private func footer(_ s: SetupStage, _ flow: SetupFlow) -> some View {
        HStack(spacing: Space.s) {
            if let p = flow.previous(before: s) {
                Button("Back") { go(p) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .accessibilityLabel("Back to \(p.title)")
            } else if s == .welcome {
                Button("Set up later") { finish() }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .accessibilityLabel("Close and set up Squeak later")
            }
            Spacer()
            switch s {
            case .welcome:
                Button("Get started") { model.startSetup(); go(.service) }
                    .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            case .service, .agents:
                if s.isRequired, !flow.canContinue(s) {
                    // The step's own button does the work; Continue waits until it worked.
                    Button("Continue") {}.buttonStyle(PrimaryButtonStyle()).disabled(true)
                } else {
                    Button("Continue") { advance(from: s, skipping: false) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            case .account, .phone:
                Button("Skip") { advance(from: s, skipping: true) }.buttonStyle(SecondaryButtonStyle())
                    .accessibilityLabel("Skip \(s.title)")
                if flow.isDone(s) {
                    Button("Continue") { advance(from: s, skipping: false) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            case .done:
                Button("Finish", action: finish).buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .font(.system(size: 13))
    }
}

// MARK: Sidebar

private struct SetupSidebar: View {
    let stage: SetupStage?
    let flow: SetupFlow
    let pick: (SetupStage) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LogoLockup(height: 24).padding(.bottom, Space.l)
            Text("Set up Squeak").font(Typo.meta).foregroundStyle(Theme.muted).padding(.bottom, Space.s)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(SetupStage.allCases) { item in row(item) }
            }
            Spacer(minLength: 0)
            Text("Required steps are marked. Everything else can wait.").font(Typo.meta).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 22)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.sidebar)
    }

    private func row(_ item: SetupStage) -> some View {
        let current = item == stage
        let state = item == .welcome ? (flow.progress.started || flow.isReturning ? SetupStageState.done : .todo)
            : item == .done ? (flow.progress.finished ? .done : .todo) : flow.state(item)
        return Button { pick(item) } label: {
            HStack(spacing: 10) {
                mark(state, current: current).frame(width: 16, height: 16)
                Text(item.title).font(.system(size: 13, weight: current ? .semibold : .regular))
                    .foregroundStyle(current ? Theme.ink : Theme.muted).lineLimit(1)
                Spacer(minLength: 0)
                if item.isRequired { Text("Required").font(Typo.meta).foregroundStyle(Theme.subtle) }
                else if item.canSkip { Text("Optional").font(Typo.meta).foregroundStyle(Theme.subtle) }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(current ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.title), \(item.isRequired ? "required, " : item.canSkip ? "optional, " : "")\(state == .done ? "done" : state == .skipped ? "skipped" : "not done")")
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    @ViewBuilder private func mark(_ state: SetupStageState, current: Bool) -> some View {
        switch state {
        case .done: Lucide(.check, size: 13, color: Theme.working)
        case .skipped: Circle().strokeBorder(Theme.offline, lineWidth: 1.5).frame(width: 9, height: 9)
        case .todo:
            if current { Circle().fill(Theme.duck).frame(width: 8, height: 8) }
            else { Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5).frame(width: 9, height: 9) }
        }
    }
}
