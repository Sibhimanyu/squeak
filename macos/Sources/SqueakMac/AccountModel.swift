import AppKit
import AuthenticationServices
import Foundation
import Observation
import SqueakMacCore

/// Settings › Account: signing this Mac in to a Squeak account. Everything works signed out.
@MainActor @Observable
final class AccountModel: NSObject, ASWebAuthenticationPresentationContextProviding {
    private(set) var state: AccountState?
    private(set) var busy = false
    /// A fixed sentence for the last attempt; nil when it went well.
    private(set) var notice: String?

    /// The account photo, in memory only; nil shows the initial.
    private(set) var avatar: NSImage?
    @ObservationIgnored private var avatarLoadedAt: Double?
    @ObservationIgnored private var photoState: String?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private var session: ASWebAuthenticationSession?
    /// Memory only: the state of the sign-in in flight.
    @ObservationIgnored private var pendingState: String?
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

    func signIn() {
        guard !busy, let base = state?.signInUrl else { return }
        let s = AccountSignIn.makeState()
        guard let url = AccountSignIn.startURL(signInUrl: base, state: s) else {
            notice = "Squeak's cloud gave a sign-in address Squeak can't use."; return
        }
        notice = nil
        if demo { state = AccountState(linked: true, email: "you@example.com", signInUrl: base); return }
        pendingState = s
        busy = true
        let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: AccountSignIn.callbackScheme) { [weak self] callback, error in
            Task { @MainActor in await self?.finish(callback: callback, error: error) }
        }
        auth.prefersEphemeralWebBrowserSession = false
        auth.presentationContextProvider = self
        session = auth
        if !auth.start() { busy = false; pendingState = nil; session = nil; notice = "Couldn't open the sign-in window." }
    }

    private func finish(callback: URL?, error: Error?) async {
        session = nil
        let expected = pendingState
        pendingState = nil
        defer { busy = false }
        if let error {
            if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { notice = "Sign-in didn't finish. Try again." }
            return
        }
        guard let callback, let expected else { notice = "Sign-in didn't finish. Try again."; return }
        switch AccountSignIn.ticket(from: callback, expectedState: expected) {
        case .failure(let f): notice = f.sentence
        case .success(let ticket):
            do {
                let r = try await client.remoteAccountLink(ticket: ticket)
                if r.ok { AppLog.info("account linked"); notice = nil } else { notice = r.reason ?? "Couldn't link the account." }
            } catch { notice = "Couldn't reach the Squeak service to finish signing in." }
            await refresh()
            await onChanged?()
            if state?.linked == true, let next = afterSignIn { afterSignIn = nil; next() }
        }
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
            NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? ASPresentationAnchor()
        }
    }
}
