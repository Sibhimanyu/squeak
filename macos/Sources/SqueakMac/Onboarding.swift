import AppKit
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

/// First run: Welcome, Connect, See your agents, Away from this Mac, Done. `SetupFlow` (SqueakMacCore) decides
/// the order, what is done and where to resume; each screen runs the app's existing actions.
struct OnboardingView: View {
    var finish: () -> Void
    @Environment(AppModel.self) private var model
    @State private var stage: SetupStage?
    @State private var awayChoice: AwayChoice?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `stage` nil: work out where to start from what is already set up.
    init(stage: SetupStage? = nil, finish: @escaping () -> Void) {
        _stage = State(initialValue: stage)
        self.finish = finish
    }

    var body: some View {
        let flow = model.setupFlow
        HStack(spacing: 0) {
            SetupBrandRail(stage: stage, flow: flow)
                .frame(width: 238)
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(spacing: 0) {
                SetupTrack(current: stage).padding(.bottom, Space.m)
                if let stage {
                    SetupHero(plan: plan(stage, flow), rows: SetupDirector.revealedRows(flow.connectRows),
                              doneStages: SetupStage.listed.filter { flow.state($0) == .done })
                        .padding(.bottom, Space.m)
                    ScrollView {
                        content(stage, flow)
                            .id(stage)
                            .transition(.opacity)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(.bottom, Space.m)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    footer(stage, flow)
                        .padding(.top, Space.m)
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(.horizontal, 30)
            .padding(.top, 28)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg)
        }
        .background(Theme.bg)
        // Esc must never close the window or quit setup by accident.
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
        await model.channels.refresh()
        go(model.setupFlow.startStage)
    }

    private func poll() async {
        var tick = 0
        while !Task.isCancelled {
            if stage != nil {
                await model.setup.refresh(model)
                model.stepConnect()
                model.recordSetupProgress()
                if tick % 2 == 0 { await model.channels.refresh() }
                tick += 1
            }
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    private func plan(_ s: SetupStage, _ flow: SetupFlow) -> SetupScenePlan {
        var i = SetupSceneInput(stage: s)
        i.started = model.setup.progress.started || s != .welcome
        i.connectReady = flow.connectReady
        i.connectFailed = flow.connectFailure != nil
        i.connectRunning = model.setup.connectRunning
        if let active = model.sessions.first(where: { $0.state == .working || $0.state == .blocked || $0.state == .finished || $0.alive == true }) {
            i.sessionTitle = active.distinctTitle ?? active.title
        }
        i.notificationsGranted = model.setup.notifications == .authorized
        i.awayChoice = awayChoice.map { $0 == .iphone ? AwayKind.iphone : $0 == .web ? .web : .telegram }
        let paired = !(model.channels.remote?.activeDevices.isEmpty ?? true)
        i.awaySucceeded = awayChoice == .telegram ? model.channels.testResult?.hasPrefix("Sent") == true : paired
        i.awayWaiting = awayChoice != nil && !i.awaySucceeded
        return SetupDirector.plan(i)
    }

    private func go(_ s: SetupStage) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: SetupMotion.standard)) {
            awayChoice = nil
            stage = s
        }
        // Reaching Done is finishing: setup never comes back on its own.
        if s == .done { model.finishSetup() }
    }

    private func advance(from s: SetupStage, skipping: Bool) {
        if skipping { model.skipSetupStage(s) } else { model.unskipSetupStage(s) }
        go(model.setupFlow.next(after: s) ?? .done)
    }

    // MARK: Screens

    @ViewBuilder private func content(_ s: SetupStage, _ flow: SetupFlow) -> some View {
        switch s {
        case .welcome: WelcomeStage()
        case .connect: ConnectStage()
        case .firstWin: FirstWinStage()
        case .away: AwayStage(choice: $awayChoice)
        case .done: DoneStage()
        }
    }

    private func footer(_ s: SetupStage, _ flow: SetupFlow) -> some View {
        HStack {
            switch s {
            case .welcome:
                Button("Skip for now") { finish() }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .accessibilityLabel("Set up Squeak later")
                Spacer()
                Button("Get started") {
                    model.startSetup()
                    // The duck wakes first, then the screen moves on.
                    Task { try? await Task.sleep(for: .milliseconds(Int(SetupMotion.emphasis * 1000))); go(.connect) }
                }
                    .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            case .connect:
                Spacer()
                ConnectButton(next: { go(.firstWin) })
            case .firstWin:
                back(s, flow)
                Spacer()
                Button("Skip for now") { advance(from: s, skipping: true) }.buttonStyle(SecondaryButtonStyle())
                Button("Continue") { advance(from: s, skipping: false) }
                    .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            case .away:
                Button("Back") {
                    if awayChoice != nil { awayChoice = nil } else if let p = flow.previous(before: s) { go(p) }
                }
                .buttonStyle(.plain).foregroundStyle(Theme.muted)
                Spacer()
                Button("Skip for now") { advance(from: s, skipping: true) }.buttonStyle(SecondaryButtonStyle())
                if flow.facts.awayConfigured {
                    Button("Continue") { advance(from: s, skipping: false) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            case .done:
                back(s, flow)
                Spacer()
                Button("Finish", action: finish).buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .font(.system(size: 13))
    }

    @ViewBuilder private func back(_ s: SetupStage, _ flow: SetupFlow) -> some View {
        if let p = flow.previous(before: s) {
            Button("Back") { go(p) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
        }
    }
}

/// Connect's one button: Connect, then a disabled "Connecting…", "Try again" on a failure, Continue once it worked.
private struct ConnectButton: View {
    @Environment(AppModel.self) private var model
    let next: () -> Void

    var body: some View {
        let flow = model.setupFlow
        if flow.connectReady, !model.setup.connectRunning {
            Button("Continue", action: next).buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        } else if model.setup.connectRunning, flow.connectFailure == nil {
            HStack(spacing: Space.s) {
                ProgressView().controlSize(.small)
                Text("Connecting…").font(Typo.body).foregroundStyle(Theme.muted)
            }
        } else if flow.connectFailure != nil {
            Button("Try again") { model.startConnect() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        } else {
            Button("Connect") { model.startConnect() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        }
    }
}

/// The brand anchor and where you are in the five screens.
private struct SetupBrandRail: View {
    let stage: SetupStage?
    let flow: SetupFlow

    private var railTitle: String {
        switch stage {
        case .welcome, nil: "A clearer view of work in motion."
        case .connect: "One quick connection."
        case .firstWin: "Your agents, in the menu bar."
        case .away: "Stay close from afar."
        case .done: "All set."
        }
    }

    private var railDetail: String {
        switch stage {
        case .welcome, nil: "A small duck. A little more peace of mind."
        case .connect: "Squeak links to your agents and keeps watch."
        case .firstWin: "See a session appear, then choose how it tells you."
        case .away: "Get pinged when you're not at your Mac."
        case .done: "Squeak keeps watch from your menu bar."
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.height < 610
            VStack(alignment: .leading, spacing: 0) {
                LogoLockup(height: 24)
                Spacer(minLength: compact ? 14 : 40)
                Text(railTitle)
                    .font(.system(size: 23, weight: .semibold)).tracking(-0.5).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(railDetail)
                    .font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                Spacer(minLength: compact ? 12 : 16)
                if !compact { stageList }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, compact ? 18 : 24)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(Theme.sidebar)
        }
    }

    private var stageList: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(SetupStage.allCases) { item in
                HStack(spacing: 8) {
                    Circle().fill(color(item)).frame(width: item == stage ? 7 : 5, height: item == stage ? 7 : 5)
                    Text(item.title).font(.system(size: 11, weight: item == stage ? .semibold : .regular))
                        .foregroundStyle(item == stage ? Theme.ink : Theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if item != .welcome, item != .done, flow.state(item) == .done {
                        Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.working)
                    }
                }
                .accessibilityHidden(true)
            }
        }
    }

    private func color(_ s: SetupStage) -> Color {
        if s == stage { return Theme.duck }
        switch flow.state(s) {
        case .done: return Theme.working
        case .skipped: return Theme.offline
        case .todo: return Theme.lineStrong
        }
    }
}
