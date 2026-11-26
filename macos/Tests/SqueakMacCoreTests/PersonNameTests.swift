import Testing
import Foundation
@testable import SqueakMacCore

// A person's name has one source: their Squeak account (name, else email).
@Suite struct PersonNameTests {
    static func detail(_ members: [FlockMember]) -> PondDetail {
        PondDetail(pond: PondSummary(id: "p", name: "Site"), members: members)
    }

    @Test func decodesTheEmailAndStaysCompatibleWithoutIt() throws {
        let with = #"{"id":"a","name":"Aarav","email":"aarav@example.com","role":"member","online":true,"you":false}"#
        let without = #"{"id":"b","name":"Bea","role":"member","online":false,"you":false}"#
        #expect(try JSONDecoder().decode(FlockMember.self, from: Data(with.utf8)).email == "aarav@example.com")
        #expect(try JSONDecoder().decode(FlockMember.self, from: Data(without.utf8)).email == nil)
    }

    @Test func aNameIsTheAccountsAndFallsBackToTheEmail() {
        #expect(PersonName.shown(FlockMember(id: "a", name: "Aarav", email: "a@x.com")) == "Aarav")
        #expect(PersonName.shown(FlockMember(id: "a", name: "", email: "a@x.com")) == "a@x.com")
        #expect(PersonName.shown(FlockMember(id: "a", name: " ")) == "Someone")
    }

    @Test func theEmailLineShowsUnderANameButNeverRepeatsIt() {
        #expect(PersonName.emailLine(FlockMember(id: "a", name: "Aarav", email: "a@x.com")) == "a@x.com")
        #expect(PersonName.emailLine(FlockMember(id: "a", name: "a@x.com", email: "a@x.com")) == nil)
        #expect(PersonName.emailLine(FlockMember(id: "a", name: "Aarav")) == nil)
    }

    @Test func myNameIsTheAccountsNeverTheMacsUserName() {
        let d = Self.detail([FlockMember(id: "me", name: "Sib M", you: true, email: "sib@x.com"), FlockMember(id: "a", name: "Aarav")])
        #expect(PersonName.mine(in: [d]) == "Sib M")
        let emailOnly = Self.detail([FlockMember(id: "me", name: "", you: true, email: "sib@x.com")])
        #expect(PersonName.mine(in: [emailOnly]) == "sib@x.com")
        // No pond has said who "you" is: empty, so views say "You"; the Mac's login name is never used.
        #expect(PersonName.mine(in: []) == "")
    }

    @Test func aRoomNameFindsItsEmailOnlyWhenOneMemberHasIt() {
        let members = [FlockMember(id: "a", name: "Aarav", email: "a@x.com"), FlockMember(id: "b", name: "Bea", email: "b@x.com"),
                       FlockMember(id: "c", name: "Bea", email: "b2@x.com")]
        #expect(PersonName.email(forName: "Aarav", in: members) == "a@x.com")
        #expect(PersonName.email(forName: "Bea", in: members) == nil)
        #expect(PersonName.email(forName: "Zed", in: members) == nil)
    }
}
