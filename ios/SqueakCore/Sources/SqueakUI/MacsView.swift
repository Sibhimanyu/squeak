#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// The screen of a phone with no Mac open: sign in, or (signed in) your Macs. The fallback for a Mac that is not on an
/// account yet is one small link at the bottom of the sign-in screen and nowhere else.
struct UnpairedView: View {
    @Environment(AppModel.self) private var model
    @State private var fallback = false

    var body: some View {
        Group {
            if fallback || model.pairingFailure != nil {
                PairView(onBack: { fallback = false })
            } else if model.account.session == nil {
                SignInView(onFallback: { fallback = true })
            } else {
                MacsHomeView()
            }
        }
        .animation(.easeOut(duration: 0.2), value: fallback)
    }
}

/// First run, and after signing out: one job.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    var onFallback: () -> Void

    var body: some View {
        let account = model.account
        ScrollView {
            VStack(spacing: 20) {
                PairingDuck(mood: .idle).padding(.top, 36)
                VStack(spacing: 8) {
                    Text(SignInScreen.title).font(.title2.bold()).multilineTextAlignment(.center)
                    Text(SignInScreen.detail).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                }
                VStack(spacing: 8) {
                    Button(SignInScreen.signInLabel) { Haptics.play(.tap); account.signIn(model) }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(account.step != .idle)
                        .accessibilityIdentifier("sign-in")
                    Text(SignInScreen.providers).font(.footnote).foregroundStyle(Theme.subtle)
                }
                if let message = account.message {
                    Text(message).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    ReportProblemButton(problem: message, place: "Sign in", title: "Report")
                }
                Button { Haptics.play(.tap); onFallback() } label: {
                    Text(SignInScreen.fallbackLabel).font(.footnote).foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
                .accessibilityIdentifier("mac-not-on-account")
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
    }
}

/// Signed in, no Mac open: every Mac on the account, to open one.
struct MacsHomeView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingSignOut = false

    var body: some View {
        let account = model.account
        ScrollView {
            VStack(spacing: 20) {
                PairingDuck(mood: .idle).padding(.top, 36)
                Text("Your Macs").font(.title2.bold())
                YourMacsList()
                if let session = account.session {
                    HStack {
                        Text(session.email.isEmpty ? session.name : session.email).font(.footnote).foregroundStyle(Theme.muted)
                        Spacer()
                        Button("Sign out") { Haptics.play(.tap); confirmingSignOut = true }.font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .confirmationDialog("Sign out of Squeak?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { model.signOutEverywhere() }
        } message: {
            Text("This iPhone stops seeing your Macs until you sign in again.")
        }
    }
}

/// The rows of "Your Macs": the account's Macs with how each is doing, and any Mac this phone holds that the account
/// does not list. Tapping one opens it (instantly when this phone already has it).
struct YourMacsList: View {
    @Environment(AppModel.self) private var model
    /// Called after a Mac is chosen (the switcher closes).
    var onOpen: () -> Void = {}

    var body: some View {
        let account = model.account
        VStack(alignment: .leading, spacing: 8) {
            switch account.step {
            case let .waiting(mac, needsApproval):
                VStack(spacing: 12) {
                    ProgressView()
                    Text(SignInScreen.opening(mac, needsApproval: needsApproval)).font(.headline).multilineTextAlignment(.center)
                    Button("Cancel") { Haptics.play(.tap); account.cancelRequest() }.foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
                .frame(maxWidth: .infinity)
            default:
                list(account)
            }
            if let message = account.message {
                Text(message).font(.footnote).foregroundStyle(Theme.muted)
                ReportProblemButton(problem: message, place: "Your Macs", title: "Report")
            }
        }
        .task { if account.session != nil, account.macs.isEmpty, account.step == .idle { account.loadMacs(model) } }
    }

    @ViewBuilder
    private func list(_ account: AccountModel) -> some View {
        // The clock ticks so "last seen" and online/asleep stay true while the list is open.
        TimelineView(.periodic(from: .now, by: 20)) { context in
            let rows = MacList.rows(account: account.macs, registry: model.registry, now: context.date)
            if account.step == .loadingMacs && rows.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if rows.isEmpty {
                Text("No Mac is signed in to \(account.session.map { $0.email.isEmpty ? "this account" : $0.email } ?? "this account") yet. Open Squeak on your Mac and sign in there.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            ForEach(rows) { row in
                MacRowButton(row: row, now: context.date) {
                    Haptics.play(.tap)
                    if row.isActive { onOpen(); return }
                    if let mac = account.macs.first(where: { $0.macId == row.macId }) {
                        account.open(mac, model)
                    } else {
                        model.switchTo(row.macId)
                    }
                    onOpen()
                }
            }
        }
    }
}

struct MacRowButton: View {
    let row: MacRow
    let now: Date
    let action: () -> Void

    private var tone: Color {
        switch row.presence {
        case .online: return Theme.success
        case .asleep: return Theme.needsYou
        case .offline: return Theme.offline
        case .unknown: return Theme.subtle
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                StatusDot(color: tone)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name).font(.body).lineLimit(1)
                    Text(row.presence.label(now: now)).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                    if let hint = row.presence.hint {
                        Text(hint).font(.caption).foregroundStyle(Theme.subtle).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if row.isActive {
                    Lucide(.check, size: 16, color: Theme.muted)
                } else if row.requiresApproval && !row.held {
                    Text("Asks first").font(.caption).foregroundStyle(Theme.subtle)
                }
            }
            .padding(12).frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
        }
        .buttonStyle(.press)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.name), \(row.presence.label(now: now))\(row.isActive ? ", open now" : "")")
    }
}

/// The switcher: a sheet over Home with every Mac, to move between them.
struct MacSwitcherSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                YourMacsList(onOpen: { dismiss() }).padding(20)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Your Macs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { Haptics.play(.tap); dismiss() } } }
        }
        .foregroundStyle(Theme.ink)
        .presentationDetents([.medium, .large])
    }
}

/// Top of Home: the open Mac's name, to switch. Hidden when there is nothing to switch to (one Mac, no account).
struct MacSwitcherButton: View {
    @Environment(AppModel.self) private var model
    @State private var showing = false

    var body: some View {
        if model.canSwitchMacs {
            Button { Haptics.play(.tap); showing = true } label: {
                Lucide(.monitor, size: 20, label: "Your Macs", color: Theme.muted)
            }
            .accessibilityIdentifier("mac-switcher")
            .sheet(isPresented: $showing) { MacSwitcherSheet() }
        }
    }
}

/// Settings: the same list as the switcher, as plain rows, with the open Mac ticked.
struct YourMacsSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.canSwitchMacs {
            let account = model.account
            Section {
                TimelineView(.periodic(from: .now, by: 20)) { context in
                    let rows = MacList.rows(account: account.macs, registry: model.registry, now: context.date)
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            Button {
                                Haptics.play(.tap)
                                if row.isActive { return }
                                if let mac = account.macs.first(where: { $0.macId == row.macId }) { account.open(mac, model) } else { model.switchTo(row.macId) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.name).foregroundStyle(Theme.ink)
                                        Text(row.presence.label(now: context.date)).font(.footnote).foregroundStyle(Theme.muted)
                                    }
                                    Spacer()
                                    if row.isActive { Image(systemName: "checkmark").foregroundStyle(Theme.muted) }
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            } header: { Text("Your Macs") } footer: {
                Text("Each Mac keeps its own chats on this iPhone. Switching never mixes them.")
            }
            .task { if account.session != nil, account.macs.isEmpty, account.step == .idle { account.loadMacs(model) } }
        }
    }
}
#endif
