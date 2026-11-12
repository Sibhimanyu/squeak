import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Sign in page: "Sign in to Squeak" is a page in the workbench centre (like Pond settings), opened by every
// sign-in entry. Its state machine is `SignInPage` in SqueakMacCore. The browser sheet is anchored to the window showing it.

struct SignInPageView: View {
    @Environment(AppModel.self) private var model
    @State private var window: NSWindow?
    private var account: AccountModel { model.account }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("Sign in to Squeak").font(Typo.title).foregroundStyle(Theme.ink)
                        Text("Optional. Signed in, you can see this Mac from your browser and iPhone without a QR code. Your Mac still approves each device.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    card
                }
                .padding(.horizontal, Space.xl).padding(.vertical, Space.l)
                .frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity)
            }
        }
        .background(WindowCapture(window: $window))
        .task { await account.refresh() }
    }

    private var topBar: some View {
        HStack(spacing: Space.m) {
            Button { account.closeSignInPage() } label: {
                HStack(spacing: 4) {
                    Lucide(.arrowLeft, size: 14, color: Theme.muted)
                    Text(verbatim: account.page?.origin.backTitle ?? "Back").font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).keyboardShortcut(.cancelAction)
            .accessibilityLabel("Back to \(account.page?.origin.backTitle ?? "where you were")")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l).frame(height: 40)
    }

    @ViewBuilder private var card: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            switch account.page?.phase {
            case .waiting?:
                waiting
            case .signedIn(let phaseEmail)?:
                signedIn(account.email ?? phaseEmail)
            case .failed(let sentence)?:
                Text(verbatim: sentence).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isStaticText)
                HStack(spacing: Space.s) {
                    Button("Try again") { account.retrySignIn() }.buttonStyle(PrimaryButtonStyle())
                    ReportProblemButton(problem: sentence, place: "Sign in", title: "Report")
                }
            default:
                if account.canSignIn { choices } else {
                    Text("Squeak's cloud isn't reachable right now.").font(Typo.body).foregroundStyle(Theme.muted)
                    Button("Retry") { Task { await account.refresh(); await AppModel.shared.cloud.refresh() } }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(SignInProvider.allCases, id: \.self) { p in
                Button { account.start(p, in: window) } label: {
                    Text(p.buttonTitle).frame(maxWidth: .infinity)
                }
                .buttonStyle(p == .email ? AnyButtonStyle(SecondaryButtonStyle()) : AnyButtonStyle(PrimaryButtonStyle()))
                .accessibilityLabel(p == .email ? "Sign in with email" : p.buttonTitle)
            }
            Text("Your browser opens to finish. Squeak comes back here when it's done.").font(Typo.meta).foregroundStyle(Theme.subtle)
        }
    }

    private var waiting: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                ProgressView().controlSize(.small)
                Text("Finish signing in in your browser").font(Typo.label).foregroundStyle(Theme.ink)
            }
            if let hint = account.page?.waitingLine?.replacingOccurrences(of: "Finish signing in in your browser. ", with: "") {
                Text(verbatim: hint).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Button("Cancel") { account.cancelSignIn() }.buttonStyle(SecondaryButtonStyle())
        }
        .accessibilityElement(children: .combine)
    }

    private func signedIn(_ email: String?) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.m) {
                AccountAvatar(image: account.avatar, email: email ?? "?", size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Signed in").font(Typo.label).foregroundStyle(Theme.ink)
                    if let email { Text(verbatim: email).font(Typo.body).foregroundStyle(Theme.muted).textSelection(.enabled) }
                }
            }
            Button("Done") { account.closeSignInPage() }.buttonStyle(PrimaryButtonStyle())
        }
    }
}

private struct AnyButtonStyle: ButtonStyle {
    private let make: @MainActor (ButtonStyleConfiguration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

/// The window this view is in, so the browser sheet is anchored to it exactly.
private struct WindowCapture: NSViewRepresentable {
    @Binding var window: NSWindow?
    func makeNSView(context: Context) -> NSView { Probe(set: { window = $0 }) }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class Probe: NSView {
        let set: (NSWindow?) -> Void
        init(set: @escaping (NSWindow?) -> Void) { self.set = set; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); let w = window; DispatchQueue.main.async { self.set(w) } }
    }
}
