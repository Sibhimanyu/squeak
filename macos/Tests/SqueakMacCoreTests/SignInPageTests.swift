import Testing
@testable import SqueakMacCore

@Suite struct SignInPageTests {
    @Test func startsChoosing() {
        let p = SignInPage(origin: .settings)
        #expect(p.phase == .choose && !p.isWaiting && p.waitingLine == nil)
    }

    @Test func beginWaitsOnceAndSaysWhatToPick() {
        var p = SignInPage(origin: .dashboard)
        let r3559 = p.begin(.google)
        #expect(r3559)
        #expect(p.phase == .waiting(.google))
        #expect(p.waitingLine == "Finish signing in in your browser. Choose Google there.")
        let r30 = p.begin(.zoho)
        #expect(!r30)
        #expect(p.phase == .waiting(.google))
    }

    @Test func successShowsTheAccountAndNothingStartsAgain() {
        var p = SignInPage(origin: .pond("blume"))
        p.begin(.zoho)
        p.finish(.linked(email: "a@b.co"))
        #expect(p.phase == .signedIn(email: "a@b.co") && p.isSignedIn)
        let r8189 = p.begin(.email)
        #expect(!r8189)
    }

    @Test func cancelReturnsToChoices() {
        var p = SignInPage(origin: .setup)
        let r8219 = p.cancel()
        #expect(!r8219)
        p.begin(.email)
        let r7355 = p.cancel()
        #expect(r7355)
        #expect(p.phase == .choose)
    }

    @Test func browserCancelIsQuietAndErrorOffersTryAgain() {
        var p = SignInPage(origin: .settings)
        p.begin(.zoho); p.finish(.cancelled)
        #expect(p.phase == .choose)
        p.begin(.zoho); p.finish(.failed("Sign-in didn't finish. Try again."))
        #expect(p.phase == .failed("Sign-in didn't finish. Try again."))
        let r3559 = p.begin(.google)
        #expect(r3559)   // Try again picks a way straight away
        p.finish(.failed("x")); p.retry()
        #expect(p.phase == .choose)
    }

    @Test func aResultWhenNothingWaitsIsIgnored() {
        var p = SignInPage(origin: .settings)
        p.finish(.linked(email: "a@b.co"))
        #expect(p.phase == .choose)
        p.begin(.zoho); p.cancel(); p.finish(.linked(email: "late@b.co"))
        #expect(p.phase == .choose)
    }

    @Test func backTitlesNameTheOrigin() {
        #expect(SignInOrigin.settings.backTitle == "Settings")
        #expect(SignInOrigin.pond("blume").backTitle == "blume")
        #expect(SignInOrigin.pond("").backTitle == "Dashboard")
        #expect(SignInOrigin.setup.backTitle == "Setup")
    }

    @Test func threeButtons() {
        #expect(SignInProvider.allCases.map(\.buttonTitle) == ["Continue with Zoho", "Continue with Google", "Email"])
    }
}
