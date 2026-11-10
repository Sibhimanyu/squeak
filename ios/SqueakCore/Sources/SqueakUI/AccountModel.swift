#if os(iOS)
import AuthenticationServices
import CryptoKit
import SqueakCore
import SwiftUI
import UIKit

/// Squeak account on the phone: sign in (Zoho, Google or email, through the web page), your Macs, and asking one to let this
/// iPhone in without a QR code. Signing in never opens a Mac by itself.
@MainActor
@Observable
final class AccountModel {
    enum Step: Equatable {
        case idle
        case signingIn
        case loadingMacs
        /// Waiting for the Mac: both screens show `code`.
        case waiting(mac: String, code: String)
    }

    private(set) var session: AccountSession?
    private(set) var macs: [AccountMac] = []
    private(set) var step: Step = .idle
    private(set) var message: String?

    @ObservationIgnored private let tokens = AccountTokenStore(
        load: { KeyStore.load(account: "squeak-account") },
        save: { KeyStore.save($0, account: "squeak-account") },
        delete: { KeyStore.delete(account: "squeak-account") })
    @ObservationIgnored private var auth: ASWebAuthenticationSession?
    @ObservationIgnored private let anchor = PresentationAnchor()
    @ObservationIgnored private var task: Task<Void, Never>?

    init() { session = tokens.current() }

    private func api(_ app: AppModel, _ session: AccountSession) -> AccountAPI {
        AccountAPI(appURL: AccountEndpoints.appURL(fromRelay: app.pairedRelayURL), token: session.token)
    }

    /// A 401 from any account call: forget the sign-in and say so.
    private func fail(_ error: Error) {
        if let error = error as? AccountError {
            if error == .signedOut { signOut(); message = error.sentence } else { message = error.sentence }
        } else {
            message = AccountError.network.sentence
        }
        step = .idle
    }

    func signOut() {
        task?.cancel()
        tokens.signOut()
        session = nil
        macs = []
        step = .idle
    }

    func clearMessage() { message = nil }

    func signIn(_ app: AppModel) {
        guard step == .idle else { return }
        message = nil
        let appURL = AccountEndpoints.appURL(fromRelay: app.pairedRelayURL)
        let state = AccountEndpoints.newState()
        guard let url = AccountEndpoints.signInURL(appURL: appURL, state: state) else { return }
        step = .signingIn
        let web = ASWebAuthenticationSession(url: url, callbackURLScheme: "squeak") { [weak self] callback, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.auth = nil
                guard let callback, error == nil,
                      let signed = try? AccountEndpoints.parseSignedIn(callback, state: state) else {
                    self.step = .idle
                    if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { return }
                    self.message = "Sign-in did not finish. Try again."
                    return
                }
                self.tokens.store(signed)
                self.session = signed
                self.step = .idle
                self.loadMacs(app)
            }
        }
        web.presentationContextProvider = anchor
        web.prefersEphemeralWebBrowserSession = false
        auth = web
        if !web.start() { auth = nil; step = .idle; message = "Sign-in could not open. Try again." }
    }

    func loadMacs(_ app: AppModel) {
        guard let session else { return }
        step = .loadingMacs
        let api = api(app, session)
        task?.cancel()
        task = Task { [weak self] in
            do {
                let list = try await api.macs()
                self?.macs = list
                self?.step = .idle
            } catch { self?.fail(error) }
        }
    }

    /// Asks `mac`; polls every 2 s; on approval the app opens exactly as after a scanned code.
    func add(_ mac: AccountMac, _ app: AppModel) {
        guard let session, case .idle = step else { return }
        message = nil
        let api = api(app, session)
        let boxKey = P256.KeyAgreement.PrivateKey()
        let name = UIDevice.current.name
        let publicKey = app.devicePublicKey
        step = .loadingMacs
        task?.cancel()
        task = Task { [weak self] in
            do {
                let request = try await AccountPairing.request(api: api, mac: mac, deviceName: name, publicKeyX963: publicKey, boxKey: boxKey)
                self?.step = .waiting(mac: mac.name, code: request.code)
                let outcome = try await AccountPairing.await(api: api, request: request, boxKey: boxKey)
                guard let self else { return }
                self.step = .idle
                switch outcome {
                case let .approved(pairing, deviceId): app.adopt(pairing, deviceId: deviceId)
                case .denied: self.message = AccountError.deniedSentence(mac.name)
                case .gone: self.message = AccountError.gone.sentence
                case .expired: self.message = AccountError.expiredSentence
                case .cancelled: break
                case let .failed(sentence): self.message = sentence
                }
            } catch { self?.fail(error) }
        }
    }

    func cancelRequest() {
        task?.cancel()
        step = .idle
    }
}

private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

/// The pairing screen's account part: sign in, or your Macs, or the code to approve.
struct AccountPairSection: View {
    @Environment(AppModel.self) private var app
    var account: AccountModel { app.account }

    var body: some View {
        VStack(spacing: 14) {
            switch account.step {
            case let .waiting(mac, code):
                ProgressView()
                Text("Adding this iPhone to \(mac)\u{2026}").font(.headline).multilineTextAlignment(.center)
                VStack(spacing: 4) {
                    Text("If your Mac asks, check it shows")
                    Text("\(code.prefix(3)) \(code.suffix(3))")
                        .font(.system(size: 20, weight: .semibold, design: .rounded).monospacedDigit()).tracking(2)
                        .foregroundStyle(Theme.ink)
                        .accessibilityLabel("code \(code.map(String.init).joined(separator: " "))")
                }
                .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                Button("Cancel") { Haptics.play(.tap); account.cancelRequest() }.foregroundStyle(Theme.muted).frame(minHeight: 44)
            default:
                if let session = account.session { macsList(session) } else { signedOut }
            }
            if let message = account.message {
                Text(message).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
        }
    }

    private var signedOut: some View {
        VStack(spacing: 8) {
            Button("Sign in to see your Macs") { Haptics.play(.tap); account.signIn(app) }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(account.step != .idle)
            Text("Continue with Zoho, Google or email. Signing in never opens a Mac by itself.")
                .font(.footnote).foregroundStyle(Theme.subtle).multilineTextAlignment(.center)
        }
    }

    private func macsList(_ session: AccountSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your Macs").font(.headline)
            if account.step == .loadingMacs {
                ProgressView().frame(maxWidth: .infinity)
            } else if account.macs.isEmpty {
                Text("No Mac is linked to \(session.email.isEmpty ? "this account" : session.email) yet. Link one in Squeak on your Mac, under Settings.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            ForEach(account.macs) { mac in
                Button { Haptics.play(.tap); account.add(mac, app) } label: {
                    HStack {
                        Text(mac.name).font(.body)
                        Spacer()
                        Text("Add").font(.subheadline).foregroundStyle(Theme.muted)
                    }
                    .padding(12).frame(minHeight: 44)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
                }
                .buttonStyle(.press)
            }
            HStack {
                Text(session.email).font(.footnote).foregroundStyle(Theme.muted)
                Spacer()
                Button("Sign out") { account.signOut() }.font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .onAppear { if account.macs.isEmpty && account.step == .idle { account.loadMacs(app) } }
    }
}
#endif

#if os(iOS)
/// Settings: who is signed in. Signing out forgets the sign-in only; paired Macs stay.
struct AccountSettingsSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let account = app.account
        Section {
            if let session = account.session {
                LabeledContent("Account", value: session.email.isEmpty ? session.name : session.email)
                Button("Sign out", role: .destructive) { account.signOut() }
            } else {
                Button("Sign in to Squeak") { Haptics.play(.tap); account.signIn(app) }
                    .disabled(account.step != .idle)
            }
            if let message = account.message { Text(message).font(.footnote).foregroundStyle(Theme.muted) }
        } footer: {
            Text("Your Squeak account lists your Macs so this iPhone can ask one to let it in. Signing out keeps the Macs you already paired.")
        }
    }
}
#endif
