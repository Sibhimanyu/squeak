import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct NewLayoutTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ms(_ ago: TimeInterval) -> Int64 { Int64((now.timeIntervalSince1970 - ago) * 1000) }

    func roster() -> DuckRoster {
        RoomRoster.roster([
            PondDuck(id: "ada", name: "Ada", colourSeed: "seed-ada", currentSessionId: "s-ada", state: .working, lastActiveAt: ms(10)),
            PondDuck(id: "bo", name: "Bo", currentSessionId: "s-bo", state: .waiting, lastActiveAt: ms(60)),
            PondDuck(id: "cy", name: "Cy", duty: .off, currentSessionId: "s-cy", lastActiveAt: ms(5)),
            PondDuck(id: "di", name: "Di", lastActiveAt: ms(7200)),
        ], now: now)
    }

    // MARK: The setting

    @MainActor @Test func settingIsOffByDefaultAndPersists() {
        let suite = "newlayout-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = MacLayoutPreference(defaults: defaults)
        #expect(first.isNew == false)
        first.isNew = true
        #expect(MacLayoutPreference(defaults: defaults).isNew == true)
        first.isNew = false
        #expect(MacLayoutPreference(defaults: defaults).isNew == false)
    }

    // MARK: The Duck row

    @Test func roomPageSelectsRoomAndListsOnDutyDucksInRosterOrder() {
        let m = DuckAvatarRow.build(roster: roster(), place: .room)
        #expect(m.roomSelected && m.selectedDuck == nil)
        #expect(m.ducks.map(\.id) == ["ada", "bo", "di"])
        #expect(m.ducks.allSatisfy { $0.onDuty })
    }

    @Test func dashboardShowsTheSameRowWithNothingSelected() {
        let m = DuckAvatarRow.build(roster: roster(), place: .dashboard)
        #expect(m.selection == .none)
        #expect(m.ducks.map(\.id) == ["ada", "bo", "di"])
    }

    @Test func openChatSelectsItsDuckBySession() {
        let m = DuckAvatarRow.build(roster: roster(), place: .chat(sessionId: "s-bo", duckId: nil))
        #expect(m.selectedDuck == "bo" && m.ducks.map(\.id) == ["ada", "bo", "di"])
    }

    @Test func hostDuckIdWinsWhenTheChatMovedOn() {
        // The Duck moved to a new chat: the session id no longer matches, the duck id still does.
        let m = DuckAvatarRow.build(roster: roster(), place: .chat(sessionId: "s-new", duckId: "ada"))
        #expect(m.selectedDuck == "ada")
    }

    @Test func offDutyDuckOpenedAppearsLastWhileOpenWithoutChangingDuty() {
        let r = roster()
        let m = DuckAvatarRow.build(roster: r, place: .chat(sessionId: "s-cy", duckId: nil))
        #expect(m.ducks.map(\.id) == ["ada", "bo", "di", "cy"])
        #expect(m.selectedDuck == "cy")
        #expect(m.ducks.last?.onDuty == false)
        // Leaving it (Room) drops it from the row; the roster itself is untouched.
        #expect(DuckAvatarRow.build(roster: r, place: .room).ducks.map(\.id) == ["ada", "bo", "di"])
        #expect(r.offDuty.map(\.id) == ["cy"])
    }

    @Test func unknownChatSelectsNothingAndAddsNothing() {
        let m = DuckAvatarRow.build(roster: roster(), place: .chat(sessionId: "elsewhere", duckId: nil))
        #expect(m.selection == .none && m.ducks.map(\.id) == ["ada", "bo", "di"])
    }

    @Test func glyphOnlyOnWorkingDucksAndTriangleOnlyOnWaiting() {
        let m = DuckAvatarRow.build(roster: roster(), place: .room)
        #expect(m.ducks.filter(\.showsWorkingGlyph).map(\.id) == ["ada"])
        #expect(m.ducks.filter(\.needsYou).map(\.id) == ["bo"])
        #expect(m.ducks.first { $0.id == "di" }?.opensChat == false)
        #expect(m.ducks.first { $0.id == "ada" }?.colourSeed == "seed-ada")
    }

    // MARK: Pond rows and the Pond panel

    @Test func pondRowMarks() {
        #expect(PondRowMarks.of(needsYou: 0, unread: 0) == PondRowMarks(needsYou: false, badge: nil))
        let m = PondRowMarks.of(needsYou: 2, unread: 3)
        #expect(m.needsYou && m.badge == 3 && m.badgeText == "3")
        #expect(PondRowMarks.of(needsYou: 0, unread: 140).badgeText == "99+")
        #expect(PondRowMarks.of(needsYou: 0, unread: 140).needsYou == false)
    }

    @Test func pondPanelGroupsPresentWorkingAndOpenTasks() throws {
        func member(_ id: String, _ name: String, online: Bool, you: Bool = false) throws -> FlockMember {
            let json = #"{"id":"\#(id)","name":"\#(name)","role":"owner","online":\#(online),"you":\#(you)}"#
            return try JSONDecoder().decode(FlockMember.self, from: Data(json.utf8))
        }
        let members = [try member("m1", "Zed", online: true), try member("m2", "Amy", online: false), try member("m3", "Me", online: false, you: true)]
        let tasks = [
            RoomTask(id: "t1", messageId: "a", state: .waiting), RoomTask(id: "t2", messageId: "b", state: .blocked),
            RoomTask(id: "t3", messageId: "c", state: .working), RoomTask(id: "t4", messageId: "d", state: .done),
        ]
        let p = RoomPondPanel.build(members: members, roster: roster(), tasks: tasks)
        #expect(p.present.map(\.id) == ["m3", "m1"])
        #expect(p.working.map(\.id) == ["ada"])
        #expect(p.waiting.map(\.id) == ["t1"] && p.blocked.map(\.id) == ["t2"] && p.tasksOpen == 2)
    }
}
