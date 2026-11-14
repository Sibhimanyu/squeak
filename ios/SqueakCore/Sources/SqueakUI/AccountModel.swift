#if os(iOS)
import AuthenticationServices
import CryptoKit
import PhotosUI
import SqueakCore
import SwiftUI
import UIKit

/// Squeak account on the phone: sign in (Zoho, Google or email, through the web page), your Macs, and opening one. Under
/// the hood opening a Mac sends it this iPhone's device key; the Mac adds it (or asks its owner first) and answers with
/// what the phone needs. Nothing to scan, nothing to type. Signing in never opens a Mac by itself.
@MainActor
@Observable
final class AccountModel {
    enum Step: Equatable {
        case idle
        case signingIn
        case loadingMacs
        /// Opening a Mac. `needsApproval`: the account says it asks its owner first.
        case waiting(mac: String, needsApproval: Bool)
    }

    private(set) var session: AccountSession? {
        didSet { HostSignals.account(email: session?.email, name: session?.name) }
    }
    private(set) var macs: [AccountMac] = []
    private(set) var step: Step = .idle
    private(set) var message: String? {
        didSet { if message != nil { HostSignals.trouble() } }
    }
    /// The account photo, in memory only; nil shows the initial.
    private(set) var avatar: UIImage?
    private(set) var avatarPhase: AvatarPhase = .idle

    @ObservationIgnored private let tokens = AccountTokenStore(
        load: { KeyStore.load(account: "squeak-account") },
        save: { KeyStore.save($0, account: "squeak-account") },
        delete: { KeyStore.delete(account: "squeak-account") })
    @ObservationIgnored private var auth: ASWebAuthenticationSession?
    @ObservationIgnored private let anchor = PresentationAnchor()
    @ObservationIgnored private var task: Task<Void, Never>?

    init() { session = tokens.current(); HostSignals.account(email: session?.email, name: session?.name) }

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
        avatar = nil
        avatarPhase = .idle
        macs = []
        step = .idle
    }

    func clearMessage() { message = nil }

    /// A photo call's failure: a 401 drops the sign-in like every other account call.
    private func photoFail(_ error: Error) {
        if let error = error as? AccountError, error == .signedOut { signOut(); message = error.sentence; return }
        avatarPhase = .failed(AvatarPhase.network)
    }

    func loadAvatar(_ app: AppModel) {
        guard let session, avatar == nil else { return }
        let api = api(app, session)
        Task { [weak self] in
            do {
                if let data = try await api.avatar(), let image = UIImage(data: data) { self?.avatar = image }
            } catch { if (error as? AccountError) == .signedOut { self?.signOut(); self?.message = AccountError.signedOut.sentence } }
        }
    }

    /// Re-renders the picked data to 256x256 (no EXIF) and uploads it; the original never leaves the phone.
    func setAvatar(_ original: Data, _ app: AppModel) {
        guard let session, avatarPhase != .working else { return }
        guard let jpeg = AvatarImage.prepare(original) else { avatarPhase = .failed(AvatarPhase.unreadable); return }
        avatarPhase = .working
        let api = api(app, session)
        Task { [weak self] in
            do {
                if let sentence = try await api.putAvatar(jpeg) { self?.avatarPhase = .failed(sentence); return }
                self?.avatar = UIImage(data: jpeg)
                self?.avatarPhase = .idle
            } catch { self?.photoFail(error) }
        }
    }

    func unreadablePick() { avatarPhase = .failed(AvatarPhase.unreadable) }

    func removeAvatar(_ app: AppModel) {
        guard let session, avatarPhase != .working else { return }
        avatarPhase = .working
        let api = api(app, session)
        Task { [weak self] in
            do {
                if let sentence = try await api.deleteAvatar() { self?.avatarPhase = .failed(sentence); return }
                self?.avatar = nil
                self?.avatarPhase = .idle
            } catch { self?.photoFail(error) }
        }
    }

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

    /// Opens `mac`: a Mac this phone already holds opens at once; otherwise it is asked, polled every 2 s, and opens on its
    /// answer exactly as a scanned code once did.
    func open(_ mac: AccountMac, _ app: AppModel) {
        guard let session, case .idle = step else { return }
        message = nil
        if app.registry.entry(for: mac.macId) != nil { app.switchTo(mac.macId); return }
        let api = api(app, session)
        let boxKey = P256.KeyAgreement.PrivateKey()
        let name = UIDevice.current.name
        let publicKey = app.devicePublicKey
        step = .waiting(mac: mac.name, needsApproval: mac.requiresApproval == true)
        task?.cancel()
        task = Task { [weak self] in
            do {
                let request = try await AccountPairing.request(api: api, mac: mac, deviceName: name, publicKeyX963: publicKey, boxKey: boxKey)
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

#endif

#if os(iOS)
/// Settings: who is signed in. Signing out removes this iPhone from every Mac and forgets the sign-in.
struct AccountSettingsSection: View {
    @Environment(AppModel.self) private var app
    @State private var picked: PhotosPickerItem?
    @State private var confirmingSignOut = false

    var body: some View {
        let account = app.account
        Section {
            if let session = account.session {
                let label = session.email.isEmpty ? session.name : session.email
                HStack(spacing: 12) {
                    AccountAvatarView(image: account.avatar, seed: label)
                    Text(label).font(.body).foregroundStyle(Theme.ink)
                }
                .accessibilityElement(children: .combine)
                PhotosPicker(selection: $picked, matching: .images) { Text("Change photo") }
                    .disabled(account.avatarPhase == .working)
                if account.avatar != nil {
                    Button("Remove", role: .destructive) { account.removeAvatar(app) }
                        .disabled(account.avatarPhase == .working)
                }
                if case let .failed(sentence) = account.avatarPhase { Text(sentence).font(.footnote).foregroundStyle(Theme.muted) }
                Button("Sign out", role: .destructive) { Haptics.play(.tap); confirmingSignOut = true }
            } else {
                Button("Sign in to Squeak") { Haptics.play(.tap); account.signIn(app) }
                    .disabled(account.step != .idle)
            }
            if let message = account.message {
                Text(message).font(.footnote).foregroundStyle(Theme.muted)
                ReportProblemButton(problem: message, place: "Settings › Account", title: "Report")
            }
        } footer: {
            Text("Your Squeak account lists your Macs, so this iPhone can open any of them. Signing out removes this iPhone from all of them.")
        }
        .confirmationDialog("Sign out of Squeak?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { app.signOutEverywhere() }
        } message: {
            Text("This iPhone stops seeing your Macs until you sign in again.")
        }
        .task(id: account.session?.token) { account.loadAvatar(app) }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                picked = nil
                if let data { account.setAvatar(data, app) } else { account.unreadablePick() }
            }
        }
    }
}

/// The photo, else the first letter of the account, in a circle.
struct AccountAvatarView: View {
    let image: UIImage?
    let seed: String
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Theme.surface
                    Text(String(seed.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"))
                        .font(.system(size: size * 0.45, weight: .semibold, design: .rounded)).foregroundStyle(Theme.ink)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Theme.lineStrong))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your photo")
    }
}
#endif
