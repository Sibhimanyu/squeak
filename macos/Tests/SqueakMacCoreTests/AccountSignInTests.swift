import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct AccountSignInTests {
    private func cb(_ s: String) -> URL { URL(string: s)! }

    @Test func stateIs32BytesBase64urlAndFresh() {
        let a = AccountSignIn.makeState(), b = AccountSignIn.makeState()
        #expect(a.count == 43 && a != b)
        #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    @Test func startURLCarriesStateInFragment() {
        let u = AccountSignIn.startURL(signInUrl: "https://x.catalystserverless.in/app/index.html", state: "abc")
        #expect(u?.absoluteString == "https://x.catalystserverless.in/app/index.html#mac-signin=abc")
        #expect(AccountSignIn.startURL(signInUrl: "http://x.test/", state: "abc") == nil)
    }

    @Test func acceptsMatchingCallback() {
        let r = AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=T1&state=S1"), expectedState: "S1")
        #expect(r == .success("T1"))
    }

    @Test func rejectsWrongState() {
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=T&state=S2"), expectedState: "S1") == .failure(.stateMismatch))
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=T"), expectedState: "S1") == .failure(.stateMismatch))
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=T&state="), expectedState: "") == .failure(.stateMismatch))
    }

    @Test func rejectsWrongHostOrScheme() {
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://other?ticket=T&state=S1"), expectedState: "S1") == .failure(.wrongHost))
        #expect(AccountSignIn.ticket(from: cb("https://signed-in/?ticket=T&state=S1"), expectedState: "S1") == .failure(.wrongHost))
    }

    @Test func rejectsMissingOrLongTicket() {
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?state=S1"), expectedState: "S1") == .failure(.missingTicket))
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=&state=S1"), expectedState: "S1") == .failure(.missingTicket))
        let ok = String(repeating: "a", count: 512), long = String(repeating: "a", count: 513)
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=\(ok)&state=S1"), expectedState: "S1") == .success(ok))
        #expect(AccountSignIn.ticket(from: cb("squeak-mac://signed-in?ticket=\(long)&state=S1"), expectedState: "S1") == .failure(.ticketTooLong))
    }

    @Test func decodesAccountStateWithAndWithoutSignInUrl() {
        let a = AccountState.decode(Data(#"{"linked":true,"email":"a@b.c","signInUrl":"https://x.test/app/index.html"}"#.utf8))
        #expect(a == AccountState(linked: true, email: "a@b.c", signInUrl: "https://x.test/app/index.html"))
        let b = AccountState.decode(Data(#"{"linked":false}"#.utf8))
        #expect(b == AccountState(linked: false, email: nil, signInUrl: nil))
    }

    @Test func decodesLinkResult() {
        let ok = AccountLinkResult.decode(Data(#"{"ok":true,"email":"a@b.c"}"#.utf8))
        #expect(ok.ok && ok.email == "a@b.c")
        let no = AccountLinkResult.decode(Data(#"{"ok":false,"reason":"Ticket expired."}"#.utf8))
        #expect(!no.ok && no.reason == "Ticket expired.")
        #expect(!AccountLinkResult.decode(Data("junk".utf8)).ok)
    }

    @Test func photoURLAndCallback() {
        #expect(AccountSignIn.photoURL(signInUrl: "https://x.test/app/index.html", state: "S1")?.absoluteString == "https://x.test/app/index.html#photo=S1")
        #expect(AccountSignIn.photoURL(signInUrl: "http://x.test/", state: "S1") == nil)
        #expect(AccountSignIn.photoUpdated(callback: cb("squeak-mac://photo-updated?state=S1"), expectedState: "S1"))
        #expect(!AccountSignIn.photoUpdated(callback: cb("squeak-mac://photo-updated?state=S2"), expectedState: "S1"))
        #expect(!AccountSignIn.photoUpdated(callback: cb("squeak-mac://signed-in?state=S1"), expectedState: "S1"))
        #expect(!AccountSignIn.photoUpdated(callback: cb("squeak-mac://photo-updated"), expectedState: "S1"))
        #expect(!AccountSignIn.photoUpdated(callback: cb("squeak-mac://photo-updated?state="), expectedState: ""))
    }

    @Test func decodesAvatarAt() {
        #expect(AccountState.decode(Data(#"{"linked":true,"avatarAt":1730000000000}"#.utf8))?.avatarAt == 1730000000000)
        #expect(AccountState.decode(Data(#"{"linked":true}"#.utf8))?.avatarAt == nil)
    }

    @Test func cloudSignInAsksForATokenAndChecksState() {
        let u = AccountSignIn.cloudURL(signInUrl: "https://x.test/app/index.html", state: "abc")
        #expect(u?.absoluteString == "https://x.test/app/index.html#mac-cloud=abc")
        #expect(AccountSignIn.cloudURL(signInUrl: "http://x.test/", state: "abc") == nil)
        let cb = URL(string: "squeak-mac://signed-in?token=at.u.1.e.m&state=abc")!
        #expect(AccountSignIn.token(from: cb, expectedState: "abc") == .success("at.u.1.e.m"))
        #expect(AccountSignIn.token(from: cb, expectedState: "zzz") == .failure(.stateMismatch))
    }

    @Test func oneStepCallbackCarriesBoth() {
        #expect(AccountSignIn.startURL(signInUrl: "https://x.test/app/index.html", state: "abc", both: true)?.absoluteString == "https://x.test/app/index.html#mac-signin=abc&want=ticket,token")
        #expect(AccountSignIn.startURL(signInUrl: "https://x.test/app/index.html", state: "abc")?.absoluteString == "https://x.test/app/index.html#mac-signin=abc")
        let both = URL(string: "squeak-mac://signed-in?ticket=al.t.1&token=at.u.1&state=abc")!
        #expect(AccountSignIn.signedIn(from: both, expectedState: "abc") == .success(.init(ticket: "al.t.1", token: "at.u.1")))
        #expect(AccountSignIn.signedIn(from: both, expectedState: "zzz") == .failure(.stateMismatch))
        let old = URL(string: "squeak-mac://signed-in?ticket=al.t.1&state=abc")!
        #expect(AccountSignIn.signedIn(from: old, expectedState: "abc") == .success(.init(ticket: "al.t.1", token: nil)))
        let noTicket = URL(string: "squeak-mac://signed-in?token=at.u.1&state=abc")!
        #expect(AccountSignIn.signedIn(from: noTicket, expectedState: "abc") == .failure(.missingTicket))
    }
}
