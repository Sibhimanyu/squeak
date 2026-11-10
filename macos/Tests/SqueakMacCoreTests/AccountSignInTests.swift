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
}
