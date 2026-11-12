import AppKit
import AuthenticationServices
import Foundation
import Observation
import SqueakMacCore

/// Settings › Account: signing this Mac in to a Squeak account. Everything works signed out.
@MainActor @Observable
final class AccountModel: NSObject, ASWebAuthenticationPresentationContextProviding {
    private(set) var state: AccountState? {
        didSet {
            // Linked tells Heresay who this is; an explicit unlinked answer (not a missing one) tells it they left.
            if let s = state, s.linked, let e = s.email { HeresayBridge.account(email: e) }
            else if let s = state, !s.linked { HeresayBridge.account(email: nil) }
        }
    }
    private(set) var busy = false
    /// A fixed sentence for the last attempt; nil when it went well.
    private(set) var notice: String?
    /// The sign-in page's state while it is open in the workbench centre; nil otherwise.
    private(set) var page: SignInPage?
    /// The window showing the page (or Settings): the browser sheet is anchored to exactly this one, and it is brought back after.
    @ObservationIgnored private weak var anchorWindow: NSWindow?

    /// The account photo, in memory only; nil shows the initial.
    private(set) var avatar: NSImage?
    @ObservationIgnored private var avatarLoadedAt: Double?
    @ObservationIgnored private var photoState: String?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private var session: ASWebAuthenticationSession?
    /// Memory only: the state of the sign-in in flight.
    @ObservationIgnored private var pendingState: String?
    /// Bumped per browser session, so a cancelled one's late callback cannot end the next.
    @ObservationIgnored private var generation = 0
    /// Called after a link or unlink so the Channels row reads the same account.
    @ObservationIgnored var onChanged: (() async -> Void)?
    /// One-shot: runs once after a sign-in that ended linked (the Invite button continues to its invite).
    @ObservationIgnored var afterSignIn: (() -> Void)?

    init(client: DaemonClient, demo: Bool) { self.client = client; self.demo = demo; super.init() }

    var email: String? { state?.linked == true ? state?.email : nil }
    var canSignIn: Bool { state?.signInUrl != nil }

    func refresh() async {
        guard !demo else { return }
        if let s = try? await client.remoteAccount() { state = s } else { state = nil }
        await syncAvatar()
    }

    /// Reloads only when `avatarAt` changed; no field or no account means the initial.
    private func syncAvatar(force: Bool = false, refresh: Bool = false) async {
        guard state?.linked == true, let at = state?.avatarAt else { avatar = nil; avatarLoadedAt = nil; return }
        if !force, at == avatarLoadedAt, avatar != nil { return }
        if let data = try? await client.remoteAccountAvatar(refresh: refresh), let img = NSImage(data: data) {
            avatar = img; avatarLoadedAt = at
        } else if avatarLoadedAt != at { avatar = nil }
    }

    /// Settings › Account "Change photo…": the web page ends at `squeak-mac://photo-updated`.
    func changePhoto() {
        guard !busy, !demo, let base = state?.signInUrl else { return }
        let s = AccountSignIn.makeState()
        guard let url = AccountSignIn.photoURL(signInUrl: base, state: s) else {
            notice = "Squeak's cloud gave an address Squeak can't use."; return
        }
        notice = nil
        photoState = s
        busy = true
        anchorWindow = AppModel.shared.conversationWindow
        let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: AccountSignIn.callbackScheme) { [weak self] callback, error in
            Task { @MainActor in await self?.finishPhoto(callback: callback, error: error) }
        }
        auth.prefersEphemeralWebBrowserSession = false
        auth.presentationContextProvider = self
        session = auth
        if !auth.start() { busy = false; photoState = nil; session = nil; notice = "Couldn't open the photo window." }
    }

    private func finishPhoto(callback: URL?, error: Error?) async {
        session = nil
        defer { returnToSqueak() }
        let expected = photoState
        photoState = nil
        defer { busy = false }
        if let error {
            afterSignIn = nil
            if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { notice = "The photo page didn't finish. Try again." }
            return
        }
        guard let callback, let expected, AccountSignIn.photoUpdated(callback: callback, expectedState: expected) else {
            notice = "The photo page didn't match this request, so Squeak ignored it. Try again."; return
        }
        if let s = try? await client.remoteAccount() { state = s }
        await syncAvatar(force: true, refresh: true)
    }

    var askOwnDevices: Bool { state?.askOwnDevices ?? false }

    func setAskOwnDevices(_ on: Bool) async {
        let before = state?.askOwnDevices
        state?.askOwnDevices = on
        if demo { return }
        do {
            if try await client.remoteAccountSettings(askOwnDevices: on) { notice = nil } else { state?.askOwnDevices = before; notice = "Couldn't save that. Update the Squeak service." }
        } catch { state?.askOwnDevices = before; notice = "Couldn't reach the Squeak service to save that." }
        await refresh()
    }

    // MARK: The sign-in page

    /// Every sign-in entry (Settings, an invite, setup, the Mac menu) opens the page in the workbench centre;
    /// nothing starts the browser until a button on it is pressed.
    func openSignIn(from origin: SignInOrigin) {
        guard !busy else { return }
        notice = nil
        page = SignInPage(origin: origin)
        let app = AppModel.shared
        NewChatController.shared.hide()
        app.closeSettings()
        PondsModel.shared.route = .signIn
        app.showConversationWindow()
    }

    /// The page's back button (and Esc): cancels a running sign-in, and goes back to where it was opened from.
    func closeSignInPage() {
        cancelSignIn()
        let origin = page?.origin
        let signedIn = state?.linked == true
        page = nil
        if !signedIn { afterSignIn = nil }
        let app = AppModel.shared
        if case .signIn? = PondsModel.shared.route { PondsModel.shared.route = nil }
        switch origin {
        case .settings?: app.openSettings(.account)
        case .setup?: OnboardingController.shared.show(at: .account)
        case .pond(let name)?: if !name.isEmpty { PondsModel.shared.route = .home(project: name) }
        case .dashboard?, nil: break
        }
        if signedIn, let next = afterSignIn { afterSignIn = nil; next() }
    }

    /// "Cancel" on the waiting view: ends the browser session; the page returns to its choices.
    func cancelSignIn() {
        guard page?.cancel() == true else { return }
        generation += 1
        session?.cancel()
        session = nil
        pendingState = nil
        busy = false
        returnToSqueak()
    }

    func retrySignIn() { page?.retry() }

    /// Settings › Account "Connect…": signs in on Squeak's cloud (the daemon's own relay) for an account token and hands
    /// it to the daemon, which provisions this Mac. No page in the workbench: the browser sheet is the whole flow.
    func connectCloud(signInUrl: String?) async {
        guard !busy, !demo, let base = signInUrl else { return }
        let s = AccountSignIn.makeState()
        guard let url = AccountSignIn.cloudURL(signInUrl: base, state: s) else {
            notice = "Squeak's cloud gave a sign-in address Squeak can't use."; return
        }
        notice = nil
        anchorWindow = AppModel.shared.conversationWindow
        busy = true
        generation += 1
        let mine = generation
        let callback: URL? = await withCheckedContinuation { cont in
            let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: AccountSignIn.callbackScheme) { [weak self] callback, error in
                Task { @MainActor in
                    guard let self, self.generation == mine else { cont.resume(returning: nil); return }
                    if let error, (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.notice = "Sign-in didn't finish. Try again." }
                    cont.resume(returning: error == nil ? callback : nil)
                }
            }
            auth.prefersEphemeralWebBrowserSession = false
            auth.presentationContextProvider = self
            session = auth
            if !auth.start() { session = nil; notice = "Couldn't open the sign-in window."; cont.resume(returning: nil) }
        }
        session = nil
        defer { busy = false; returnToSqueak() }
        guard let callback else { return }
        switch AccountSignIn.token(from: callback, expectedState: s) {
        case .failure(let f): notice = f.sentence
        case .success(let token):
            do {
                let r = try await client.cloudSignIn(token: token)
                if !r.ok { notice = r.reason ?? "Couldn't connect to Squeak's cloud." }
            } catch { notice = "Couldn't reach the Squeak service to connect." }
        }
        await onChanged?()
        await AppModel.shared.cloud.refresh()
        await AppModel.shared.cloud.pollWhileConnecting()
    }

    private func failSignIn(_ why: String) {
        page?.finish(.failed(why))
        HeresayBridge.trouble()
    }

    /// A page button. `window` is the window showing the page; the browser sheet is anchored to it, never to a guess.
    func start(_ provider: SignInProvider, in window: NSWindow?) {
        guard !busy, let base = state?.signInUrl, page?.begin(provider) == true else { return }
        let s = AccountSignIn.makeState()
        guard let url = AccountSignIn.startURL(signInUrl: base, state: s) else {
            failSignIn("Squeak's cloud gave a sign-in address Squeak can't use."); return
        }
        notice = nil
        if demo { state = AccountState(linked: true, email: "you@example.com", signInUrl: base); page?.finish(.linked(email: "you@example.com")); return }
        anchorWindow = window ?? AppModel.shared.conversationWindow
        pendingState = s
        busy = true
        generation += 1
        let mine = generation
        let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: AccountSignIn.callbackScheme) { [weak self] callback, error in
            Task { @MainActor in await self?.finish(callback: callback, error: error, generation: mine) }
        }
        auth.prefersEphemeralWebBrowserSession = false
        auth.presentationContextProvider = self
        session = auth
        if !auth.start() {
            busy = false; pendingState = nil; session = nil
            failSignIn("Couldn't open the sign-in window.")
        }
    }

    /// Success, cancel or error: Squeak comes forward with the window the page is in, so the result is what you see.
    private func returnToSqueak() {
        NSApp.activate(ignoringOtherApps: true)
        let w = anchorWindow ?? AppModel.shared.conversationWindow
        w?.makeKeyAndOrderFront(nil)
    }

    private func finish(callback: URL?, error: Error?, generation g: Int) async {
        guard g == generation else { return }
        session = nil
        let expected = pendingState
        pendingState = nil
        defer { busy = false; returnToSqueak() }
        guard page?.isWaiting == true else { return }   // cancelled or left meanwhile: nothing to show
        if let error {
            if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { page?.finish(.cancelled) }
            else { failSignIn("Sign-in didn't finish. Try again.") }
            return
        }
        guard let callback, let expected else { failSignIn("Sign-in didn't finish. Try again."); return }
        switch AccountSignIn.ticket(from: callback, expectedState: expected) {
        case .failure(let f): failSignIn(f.sentence)
        case .success(let ticket):
            do {
                let r = try await client.remoteAccountLink(ticket: ticket)
                if r.ok { AppLog.info("account linked"); page?.finish(.linked(email: r.email)) }
                else { failSignIn(r.reason ?? "Couldn't link the account.") }
            } catch { failSignIn("Couldn't reach the Squeak service to finish signing in.") }
            await refresh()
            await onChanged?()
            // One sign-in: the same account also connects this Mac to Squeak's cloud (the daemon provisions it, and
            // moves an older setup over with paired devices following).
            if state?.linked == true { Task { @MainActor in await self.connectCloudIfNeeded() } }
        }
    }

    /// After a sign-in, and by Retry: if the daemon is still waiting for an account token, get one and hand it over.
    func connectCloudIfNeeded() async {
        let cloud = AppModel.shared.cloud
        await cloud.refresh()
        guard let h = cloud.hosted, h.needsSignIn, let url = h.signInUrl ?? state?.signInUrl else { return }
        await connectCloud(signInUrl: url)
    }

    func signOut() async {
        if demo { state?.linked = false; state?.email = nil; return }
        busy = true
        defer { busy = false }
        do {
            let r = try await client.remoteAccountUnlink()
            notice = r.ok ? nil : (r.reason ?? "Couldn't sign out.")
        } catch { notice = "Couldn't reach the Squeak service to sign out." }
        await refresh()
        await onChanged?()
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            self.anchorWindow ?? AppModel.shared.conversationWindow ?? ASPresentationAnchor()
        }
    }
}
