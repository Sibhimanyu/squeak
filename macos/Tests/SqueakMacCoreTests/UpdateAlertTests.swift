import Testing
@testable import SqueakMacCore

@Suite("Update alert")
struct UpdateAlertTests {
    @Test func badgeFollowsUpdateAndSwitch() {
        #expect(UpdateAlert.badgeShown(available: "2.7.0", ready: nil, switchOn: true))
        #expect(UpdateAlert.badgeShown(available: nil, ready: "2.7.0", switchOn: true))
        #expect(!UpdateAlert.badgeShown(available: nil, ready: nil, switchOn: true))
        #expect(!UpdateAlert.badgeShown(available: "2.7.0", ready: "2.7.0", switchOn: false))
    }

    @Test func notifiesOncePerVersion() {
        func go(_ v: String?, last: String? = nil, skipped: String? = nil, sw: Bool = true, on: Bool = true) -> Bool {
            UpdateAlert.shouldNotify(version: v, lastNotified: last, skipped: skipped, switchOn: sw, notificationsOn: on)
        }
        #expect(go("2.7.0"))
        #expect(go("2.7.1", last: "2.7.0"))
        #expect(!go("2.7.0", last: "2.7.0"))
        #expect(!go("2.7.0", skipped: "2.7.0"))
        #expect(!go("2.7.0", sw: false))
        #expect(!go("2.7.0", on: false))
        #expect(!go(nil))
        #expect(!go(""))
    }

    @Test func readyWinsOverAvailable() {
        #expect(UpdateAlert.pendingVersion(available: "2.7.0", ready: "2.6.9") == "2.6.9")
        #expect(UpdateAlert.pendingVersion(available: "2.7.0", ready: nil) == "2.7.0")
        #expect(UpdateAlert.pendingVersion(available: nil, ready: nil) == nil)
    }

    @Test func payloadForFoundAndDownloaded() {
        let found = UpdateAlert.payload(version: "2.7.0", downloaded: false, notes: ["Faster panel", "Other"])
        #expect(found.title == "Squeak 2.7.0 is available")
        #expect(found.body == "Faster panel")
        #expect(found.identifier == "update-2.7.0")
        let bare = UpdateAlert.payload(version: "2.7.0", downloaded: false, notes: [])
        #expect(bare.body == "Open Settings to install it.")
        let ready = UpdateAlert.payload(version: "2.7.0", downloaded: true, notes: ["Faster panel"])
        #expect(ready.body == "Restart to update")
    }

    @Test func updateClickIsNeverASessionOpen() {
        let info: [AnyHashable: Any] = UpdateAlert.payload(version: "2.7.0", downloaded: false, notes: []).userInfo
        #expect(UpdateAlert.isUpdate(info))
        #expect(NotificationRouting.openRequest(dismissed: false, session: info["session"] as? String, anchor: NotificationAnchor.parse(info)) == nil)
        #expect(!UpdateAlert.isUpdate(["session": "conductor:abc"]))
    }
}
