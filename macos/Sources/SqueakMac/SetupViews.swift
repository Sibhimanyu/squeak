import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings › Setup: every walk-through step with its state. A skipped or unfinished one reopens its own
/// screen of the walk-through.
struct SetupSettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false

    var body: some View {
        let w = model.walkthrough
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline) {
                    Text(w.isFinished ? "Ready when you are" : "Set up Squeak").font(Typo.title).foregroundStyle(Theme.ink)
                    Spacer()
                    Text("\(w.doneSteps.count) of \(w.total)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                }
                Text("Go through the steps one at a time. Anything you skip stays here.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Open the walk-through") { OnboardingController.shared.show(at: .step(w.firstOpen ?? .service)) }
                        .buttonStyle(PrimaryButtonStyle())
                }
                .padding(.vertical, Space.xs)
                ForEach(w.steps) { step in row(step, w) }
                if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                    Button("Remove agent hooks…") { confirmRemove = true }
                        .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.s)
                }
            }
            .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
        }
        .task { await model.setup.poll(model) }
        .confirmationDialog("Remove Squeak's agent hooks?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.setup.uninstallHooks() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Squeak stops hearing when Claude Code and Codex need you. Your other settings are left alone.")
        }
    }

    private func row(_ step: WalkStep, _ w: SetupWalkthrough) -> some View {
        let state = w.state(step)
        return HStack(spacing: Space.s) {
            switch state {
            case .done: Lucide(.check, size: 14, color: Theme.working)
            case .skipped: Circle().strokeBorder(Theme.offline, lineWidth: 1.5).frame(width: 10, height: 10)
            case .todo: Circle().fill(Theme.muted).frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(Typo.label).foregroundStyle(state == .done ? Theme.muted : Theme.ink)
                if state != .done { Text(step.why).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
            switch state {
            case .done: Text("Done").font(Typo.meta).foregroundStyle(Theme.muted)
            case .skipped:
                Text("Skipped").font(Typo.meta).foregroundStyle(Theme.muted)
                Button("Set up") { OnboardingController.shared.show(at: .step(step)) }.buttonStyle(SecondaryButtonStyle())
            case .todo:
                Button(step.isRequired ? "Set up" : "Open") { OnboardingController.shared.show(at: .step(step)) }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// Where the walk-through is: one step's screen, or the closing summary.
enum WalkScreen: Equatable {
    case step(WalkStep)
    case summary
}

/// The guided setup: one screen per step, each doing its setup right there, with Continue and Skip for now,
/// ending on a summary. The order, skip state and what is done come from `SetupWalkthrough` (SqueakMacCore);
/// every screen embeds the settings page or checklist row that already does that setup.
struct SetupWalkthroughView: View {
    @Environment(AppModel.self) private var model
    @State private var screen: WalkScreen
    /// Called on the summary's Finish.
    var finish: () -> Void
    /// "Finish later": leave with the state as it is; the next launch resumes.
    var later: () -> Void

    init(start: WalkScreen, finish: @escaping () -> Void, later: @escaping () -> Void) {
        _screen = State(initialValue: start)
        self.finish = finish
        self.later = later
    }

    var body: some View {
        let w = model.walkthrough
        GeometryReader { available in
            let contentHeight = max(120, available.size.height - 176)
            VStack(alignment: .leading, spacing: Space.m) {
                switch screen {
                case .step(let s):
                    header(s, w)
                    if hasNativeSetupForm(s) || s == .telegram {
                        // Native Form owns its scrolling; bound it to the reserved region.
                        content(s, w)
                            .frame(width: available.size.width, height: contentHeight, alignment: .topLeading)
                            .clipped()
                    } else {
                        // Long custom setup stacks scroll in this fixed viewport.
                        ScrollView {
                            content(s, w).frame(width: available.size.width, alignment: .topLeading)
                        }
                        .frame(width: available.size.width, height: contentHeight, alignment: .top)
                        .scrollIndicators(.automatic)
                        .clipped()
                    }
                case .summary:
                    SetupSummaryView(walk: w, openStep: { s in
                        model.unskipWalkStep(s)
                        screen = .step(s)
                    })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
            }
            .frame(width: available.size.width, height: available.size.height, alignment: .topLeading)
        }
        .task {
            async let a: Void = model.channels.refreshVoice()
            async let b: Void = model.readAwake()
            _ = await (a, b)
        }
        .task { await model.setup.poll(model) }
        // Esc must never close the window or quit setup by accident.
        .onExitCommand {}
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .bottom) {
            Group {
                switch screen {
                case .step(let s): footer(s, w)
                case .summary: summaryFooter(w)
                }
            }
            .padding(.top, 10)
            .background(Theme.bg)
        }
    }

    // MARK: Chrome

    private func header(_ s: WalkStep, _ w: SetupWalkthrough) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline) {
                Text(s.title).font(Typo.title).foregroundStyle(Theme.ink)
                Spacer()
                Text(w.progressLabel(s)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    .accessibilityLabel("Step \(w.index(s) + 1) of \(w.total)")
            }
            HStack(spacing: 5) {
                ForEach(w.steps) { d in
                    Circle().fill(dotColor(w.state(d), current: d == s))
                        .frame(width: d == s ? 9 : 6, height: d == s ? 9 : 6)
                }
                Spacer()
                Button("Finish later", action: later).buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            .accessibilityHidden(true)
            Text(s.why).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func dotColor(_ st: WalkState, current: Bool) -> Color {
        if current { return Theme.ink }
        switch st {
        case .done: return Theme.working
        case .skipped: return Theme.offline
        case .todo: return Theme.line
        }
    }

    private func footer(_ s: WalkStep, _ w: SetupWalkthrough) -> some View {
        HStack {
            if let p = w.previous(before: s) {
                Button("Back") { screen = .step(p) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
            }
            Spacer()
            if w.canSkip(s), !w.isDone(s) {
                Button("Skip for now") { advance(s, w, skipping: true) }.buttonStyle(SecondaryButtonStyle())
            }
            Button("Continue") { advance(s, w, skipping: w.canSkip(s) && !w.isDone(s)) }
                .buttonStyle(PrimaryButtonStyle())
                .keyboardShortcut(.defaultAction)
                .disabled(!w.canContinue(s))
        }
        .font(.system(size: 13))
    }

    private func advance(_ s: WalkStep, _ w: SetupWalkthrough, skipping: Bool) {
        // Moving on from a step still undone counts as skipping it, so it shows in the summary and Settings.
        if skipping { model.skipWalkStep(s) } else if w.skipped.contains(s.rawValue) { model.unskipWalkStep(s) }
        screen = w.next(after: s).map { .step($0) } ?? .summary
    }

    private func summaryFooter(_ w: SetupWalkthrough) -> some View {
        HStack {
            Button("Back") { screen = .step(w.steps.last ?? .service) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
            Spacer()
            Button("Finish", action: finish)
                .buttonStyle(PrimaryButtonStyle())
                .keyboardShortcut(.defaultAction)
                .disabled(!w.isFinished)
        }
        .font(.system(size: 13))
    }

    // MARK: Step content

    private func hasNativeSetupForm(_ step: WalkStep) -> Bool {
        switch step {
        case .iphone, .cliq, .voice, .awake: true
        default: false
        }
    }

    @ViewBuilder private func content(_ s: WalkStep, _ w: SetupWalkthrough) -> some View {
        switch s {
        case .service: rowScroll(.service, w)
        case .hooks: rowScroll(.hooks, w)
        case .conductor: rowScroll(.conductor, w)
        case .hands: rowScroll(.hands, w)
        case .hotkey: rowScroll(.hotkey, w)
        case .notifications:
            NotificationsSettings(
                walkthrough: true,
                permissionStep: w.checklist.step(.notifications),
                runSetupAction: model.perform)
        case .iphone: IPhoneSettings()
        case .telegram: TelegramSettings()
        case .cliq: CliqSettings()
        case .voice: VoiceSettingsPage()
        case .awake: AwakeSettings(short: true)
        }
    }

    private func rowScroll(_ id: SetupStepID, _ w: SetupWalkthrough) -> some View {
        checklistCard(id, w)
    }

    @ViewBuilder private func checklistCard(_ id: SetupStepID, _ w: SetupWalkthrough) -> some View {
        let step = w.checklist.step(id)
        if w.isDone(WalkStep(rawValue: id.rawValue) ?? .service) {
            doneRow(step)
        } else {
            SetupStepRow(step: step, isPrimary: true, run: model.perform)
        }
    }

    private func doneRow(_ s: SetupStep) -> some View {
        HStack(spacing: Space.s) {
            Lucide(.check, size: 14, color: Theme.working)
            Text(s.state == .done ? s.why : s.title).font(Typo.body).foregroundStyle(Theme.muted)
            Spacer()
        }
        .padding(.horizontal, Space.m).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(s.title), done")
    }
}

/// The closing screen: what is set up, and every skipped or unreached step with "Set up".
struct SetupSummaryView: View {
    let walk: SetupWalkthrough
    let openStep: (WalkStep) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.m) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(walk.isFinished ? "You're set" : "Almost there").font(Typo.title).foregroundStyle(Theme.ink)
                    Text(walk.isFinished
                         ? "Click the duck in your menu bar to see your agents. Anything skipped stays in Settings › Setup."
                         : "Squeak still needs its service and agent hooks before it can work.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                if !walk.doneSteps.isEmpty {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("Set up").font(Typo.label).foregroundStyle(Theme.ink)
                        ForEach(walk.doneSteps) { s in
                            HStack(spacing: Space.s) {
                                Lucide(.check, size: 14, color: Theme.working)
                                Text(s.title).font(Typo.body).foregroundStyle(Theme.muted)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(s.title), done")
                        }
                    }
                }
                let open = walk.steps.filter { walk.state($0) != .done }
                if !open.isEmpty {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("Not set up yet").font(Typo.label).foregroundStyle(Theme.ink)
                        ForEach(open) { s in
                            HStack(spacing: Space.s) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.title).font(Typo.body).foregroundStyle(Theme.ink)
                                    Text(walk.state(s) == .skipped ? "Skipped" : "Not done").font(Typo.meta).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                Button("Set up") { openStep(s) }.buttonStyle(SecondaryButtonStyle())
                            }
                            .accessibilityElement(children: .contain)
                        }
                    }
                }
            }
            .padding(.bottom, Space.m)
        }
    }
}

struct SetupStepRow: View {
    let step: SetupStep
    let isPrimary: Bool
    let run: (SetupAction) -> Void
    @Environment(AppModel.self) private var model

    private var busy: Bool {
        switch step.id {
        case .service: model.daemon.busy || model.setupFacts.service == .installing
        case .hooks: model.setup.hooksBusy
        case .conductor: model.relay.busy
        default: false
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Circle().fill(dot).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(step.id == .hooks ? "Connect Claude Code & Codex" : step.title).font(Typo.label).foregroundStyle(step.state == .blocked ? Theme.muted : Theme.ink)
                    Spacer(minLength: 0)
                    if step.state == .blocked {
                        Text("Waiting").font(Typo.meta).foregroundStyle(Theme.muted)
                    } else if step.state == .error {
                        Text("Needs attention").font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
                Text(verbatim: step.why).font(Typo.body).foregroundStyle(step.state == .error ? Theme.error : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if step.id == .conductor, step.state == .todo || step.state == .error {
                    ConductorRelayCard()
                } else {
                    buttons
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: Space.s) {
            if let action = step.action, let title = step.actionTitle {
                if isPrimary {
                    Button(title) { run(action) }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                } else {
                    Button(title) { run(action) }.buttonStyle(SecondaryButtonStyle()).disabled(busy || step.state == .blocked)
                }
            }
            if busy { ProgressView().controlSize(.small); Text("Working…").font(Typo.meta).foregroundStyle(Theme.muted) }
        }
    }

    private var dot: Color {
        switch step.state {
        case .done: Theme.working
        case .todo: Theme.muted
        case .error: Theme.error
        case .blocked, .optional: Theme.offline
        }
    }
}
