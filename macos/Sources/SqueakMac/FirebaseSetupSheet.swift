import SqueakIcons
import SqueakMacCore
import SwiftUI

/// "Set up the iPhone channel": your own Firebase (one click, or by hand) or Squeak's shared server.
struct FirebaseSetupSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: FirebaseSetupModel
    /// Set when the setup finished, so the caller can open pairing once this sheet is gone.
    @Binding var finished: Bool
    let movingFromShared: Bool

    init(channels: ChannelsModel, finished: Binding<Bool>, movingFromShared: Bool) {
        _model = State(initialValue: FirebaseSetupModel(channels: channels))
        _finished = finished
        self.movingFromShared = movingFromShared
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            switch model.screen {
            case .choose: chooser
            case .own: OwnFlow(model: model)
            case .manual: ManualFlow(model: model)
            case .shared: SharedConfirm(model: model)
            }
            if let e = model.saveError { Footnote(e) }
            footer
        }
        .padding(20)
        .frame(width: 480)
        .onChange(of: model.finished) { _, done in
            if done { finished = true; dismiss() }
        }
    }

    private var chooser: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Set up the iPhone channel").font(Typo.title).foregroundStyle(Theme.ink)
            Text("Squeak for iPhone reaches this Mac through Firebase. Choose where it lives.")
                .font(Typo.body).foregroundStyle(Theme.muted)
            if movingFromShared {
                Footnote("Your iPhone will need to be paired again after you move.")
            }
            choice(title: "Your own Firebase", tag: "Recommended",
                   text: "Free. Squeak makes a project in your Google account and sets it up. Fast, with every feature.",
                   action: "Set it up", primary: true) { model.beginOwn() }
            choice(title: "Squeak's shared server", tag: "Limited",
                   text: "Nothing to set up, but with limits. You can move to your own Firebase later.",
                   action: "Use shared server", primary: false) { model.screen = .shared }
        }
    }

    private func choice(title: String, tag: String, text: String, action: String, primary: Bool, run: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Space.s) {
                Text(title).font(Typo.heading).foregroundStyle(Theme.ink)
                Text(tag).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Text(text).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if primary {
                Button(action, action: run).buttonStyle(PrimaryButtonStyle())
            } else {
                Button(action, action: run).buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
    }

    private var footer: some View {
        HStack {
            if model.screen != .choose && !model.running {
                Button("Back") { model.screen = .choose }.buttonStyle(QuietButtonStyle())
            }
            Spacer()
            Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
        }
    }
}

// MARK: One-click flow

private struct OwnFlow: View {
    let model: FirebaseSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Your own Firebase").font(Typo.title).foregroundStyle(Theme.ink)
            if !started { account }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(FirebaseStep.allCases, id: \.self) { step in
                    row(step)
                    if step != FirebaseStep.allCases.last { Hairline() }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            if let (_, failure) = model.failedStep { failureActions(failure) }
            if !started {
                Button("Start") { model.start() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!model.checkedAccounts || model.addingAccount)
            }
            if model.running, model.state(.signIn) == .running(nil) {
                Footnote("Finish signing in in your browser.")
            }
        }
    }

    private var started: Bool { model.running || model.failedStep != nil || FirebaseStep.allCases.contains { model.state($0) != .pending } }

    @ViewBuilder private var account: some View {
        if !model.checkedAccounts {
            HStack(spacing: Space.s) { ProgressView().controlSize(.small); Text("Looking for your Google account").font(Typo.body).foregroundStyle(Theme.muted) }
        } else if model.accounts.isEmpty {
            Footnote("You'll sign in to Google in your browser. Squeak only creates its own project.")
        } else {
            VStack(alignment: .leading, spacing: Space.xs) {
                if model.accounts.count > 1 {
                    Picker("Google account", selection: Binding(get: { model.account ?? model.accounts[0] }, set: { model.chooseAccount($0) })) {
                        ForEach(model.accounts, id: \.self) { Text($0).tag($0) }
                    }
                } else {
                    Text("Signed in as \(model.accounts[0])").font(Typo.label).foregroundStyle(Theme.ink)
                }
                HStack {
                    Button(model.addingAccount ? "Waiting for your browser" : "Use another account") { model.useAnotherAccount() }
                        .buttonStyle(QuietButtonStyle()).disabled(model.addingAccount)
                }
            }
        }
    }

    private func row(_ step: FirebaseStep) -> some View {
        let state = model.state(step)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Space.s) {
                icon(state).frame(width: 18, height: 18)
                Text(step.title).font(Typo.body).foregroundStyle(state == .pending ? Theme.subtle : Theme.ink)
                Spacer()
                if case .running(let p?) = state {
                    ProgressView(value: p).frame(width: 110)
                }
            }
            if case .failed(let f) = state {
                Text(f.message).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 26)
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func icon(_ state: StepState) -> some View {
        switch state {
        case .pending: Lucide(.circle, size: 14, color: Theme.subtle)
        case .running: ProgressView().controlSize(.small)
        case .done: Lucide(.circleCheck, size: 16, color: Theme.done)
        case .failed: Lucide(.circleAlert, size: 16, color: Theme.needsYou)
        }
    }

    @ViewBuilder private func failureActions(_ failure: StepFailure) -> some View {
        switch failure.kind {
        case .terms:
            HStack {
                Button("Open Firebase console") { model.openConsole() }.buttonStyle(SecondaryButtonStyle())
                Button("Retry") { model.retry() }.buttonStyle(PrimaryButtonStyle())
            }
        case .quota(let projects):
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(projects.prefix(8)) { p in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.name).font(Typo.body).foregroundStyle(Theme.ink)
                            Text(p.id).font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        Button("Use this one") { model.pickExisting(p) }.buttonStyle(SecondaryButtonStyle())
                    }
                }
                handFallback
            }
        case .needsHandSetup:
            handFallback
        case .generic:
            HStack {
                Button("Retry") { model.retry() }.buttonStyle(PrimaryButtonStyle())
                handFallback
            }
        }
    }

    private var handFallback: some View {
        Button("Set it up by hand") { model.screen = .manual }.buttonStyle(QuietButtonStyle())
    }
}

// MARK: By hand

private struct ManualFlow: View {
    @Bindable var model: FirebaseSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Set it up by hand").font(Typo.title).foregroundStyle(Theme.ink)
            step("1", "Create a Firebase project. Any name works; you can skip Google Analytics.") {
                Button("Open Firebase console") { model.openConsole() }.buttonStyle(SecondaryButtonStyle())
            }
            step("2", "Open Realtime Database and create a database. Pick any location and start in locked mode.") {
                Button("Open Realtime Database") { FirebaseSetupModel.open(FirebaseSetup.databasePageURL) }.buttonStyle(SecondaryButtonStyle())
            }
            step("3", "On its Rules tab, replace everything with Squeak's rules, then Publish.") {
                Button(model.copiedRules ? "Copied" : "Copy rules") { model.copyRules() }.buttonStyle(SecondaryButtonStyle())
            }
            step("4", "Paste the database address from the top of the Data tab.") {
                VStack(alignment: .leading, spacing: Space.s) {
                    TextField("https://your-project-default-rtdb.firebaseio.com", text: $model.urlDraft)
                        .textFieldStyle(.roundedBorder).font(Typo.code)
                        .onChange(of: model.urlDraft) { _, _ in model.resetVerification() }
                    if !model.urlDraft.isEmpty && !model.urlLooksValid {
                        Text("That isn't a Firebase database address.").font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                    HStack {
                        Button(model.verifying ? "Checking" : "Check") { model.verifyManual() }
                            .buttonStyle(SecondaryButtonStyle()).disabled(!model.urlLooksValid || model.verifying)
                        if model.verified {
                            HStack(spacing: 4) { Lucide(.circleCheck, size: 14, color: Theme.done); Text("Works").font(Typo.meta).foregroundStyle(Theme.muted) }
                        }
                    }
                    if let e = model.manualError { Text(e).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                }
            }
            Button("Save and pair my iPhone") { model.saveManual() }
                .buttonStyle(PrimaryButtonStyle()).disabled(!model.verified)
        }
    }

    private func step<C: View>(_ n: String, _ text: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Text(n).font(Typo.label).foregroundStyle(Theme.muted).frame(width: 14, alignment: .trailing)
            VStack(alignment: .leading, spacing: Space.s) {
                Text(text).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                content()
            }
        }
    }
}

// MARK: Shared

private struct SharedConfirm: View {
    let model: FirebaseSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Squeak's shared server").font(Typo.title).foregroundStyle(Theme.ink)
            Text("It works with nothing to set up, but it is limited:").font(Typo.body).foregroundStyle(Theme.muted)
            VStack(alignment: .leading, spacing: 6) {
                bullet("Slower updates, about every 10 seconds.")
                bullet("No live thinking, no films, and no phone calls or Cliq.")
                bullet("A daily limit. When it runs out, your iPhone pauses until midnight. On the same Wi-Fi it keeps working.")
                bullet("Moving to your own Firebase later means pairing your iPhone again.")
            }
            Button("Use the shared server") { model.useShared() }.buttonStyle(PrimaryButtonStyle())
        }
    }

    private func bullet(_ s: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text("•").foregroundStyle(Theme.subtle)
            Text(s).fixedSize(horizontal: false, vertical: true)
        }
        .font(Typo.body).foregroundStyle(Theme.ink)
    }
}
