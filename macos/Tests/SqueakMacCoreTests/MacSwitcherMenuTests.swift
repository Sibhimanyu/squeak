import Testing
@testable import SqueakMacCore

@Suite struct MacSwitcherMenuTests {
    @Test func signedInHealthy() {
        #expect(MacSwitcherMenu.items(signedInEmail: "ann@x.com", cloudAvailable: true, daemonHealthy: true)
            == [.account(email: "ann@x.com", initial: "A"), .usage, .divider, .settings])
    }
    @Test func signedOutWithCloud() {
        #expect(MacSwitcherMenu.items(signedInEmail: nil, cloudAvailable: true, daemonHealthy: true) == [.signIn, .usage, .divider, .settings])
    }
    @Test func signedOutWithoutCloud() {
        #expect(MacSwitcherMenu.items(signedInEmail: nil, cloudAvailable: false, daemonHealthy: true) == [.signInInSettings, .usage, .divider, .settings])
    }
    @Test func serviceDownLeadsAndNoConnectedItem() {
        let i = MacSwitcherMenu.items(signedInEmail: "b@x.com", cloudAvailable: true, daemonHealthy: false)
        #expect(i.first == .serviceDown)
        #expect(i.count == 5)
        #expect(MacSwitcherMenu.showsConnectionPopover(daemonHealthy: false))
        #expect(!MacSwitcherMenu.showsConnectionPopover(daemonHealthy: true))
    }
    @Test func initials() {
        #expect(MacSwitcherMenu.initial(of: "zed@x.com") == "Z")
        #expect(MacSwitcherMenu.initial(of: "") == "?")
    }
}
