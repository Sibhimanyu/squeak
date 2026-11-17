import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct EmailInviteListTests {
    @Test func validatesLikeTheHostAndRelay() {
        for ok in ["a@b.co", "pat.lee+x@example.com", "A@B.CO", " pat@example.com "] { #expect(EmailAddress.isValid(ok), "\(ok)") }
        for bad in ["", "nope", "a@b", "a b@c.com", "a@@b.com", "@b.com", "a@.com", "a@b..com", "a@-b.com", "\"a\"@b.com",
                    String(repeating: "a", count: 65) + "@b.com", "a@" + String(repeating: "b", count: 250) + ".com"] {
            #expect(!EmailAddress.isValid(bad), "\(bad)")
        }
    }

    @Test func splitsOnCommaSpaceSemicolonAndReturn() {
        var list = EmailInviteList()
        let added = list.add("a@x.com, b@x.com;c@x.com\nd@x.com   e@x.com")
        #expect(added)
        #expect(list.addresses == ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"])
        #expect(list.rejected.isEmpty)
    }

    @Test func lowerCasesTrimsAndDropsDuplicates() {
        var list = EmailInviteList()
        list.add(" Bea@Example.COM ")
        list.add("bea@example.com")
        #expect(list.addresses == ["bea@example.com"])
    }

    @Test func keepsWhatIsNotAnAddressVisibleAndSendsOnlyTheRest() {
        var list = EmailInviteList()
        list.add("a@x.com, oops, b@x")
        #expect(list.addresses == ["a@x.com"])
        #expect(list.rejected == ["oops", "b@x"])
        #expect(list.canSend)
        list.dismissRejected()
        #expect(list.rejected.isEmpty)
    }

    @Test func capsAtTenAndSaysSo() {
        var list = EmailInviteList()
        list.add((0..<12).map { "u\($0)@x.com" }.joined(separator: " "))
        #expect(list.count == 10)
        #expect(list.overflow)
        list.remove("u0@x.com")
        #expect(!list.overflow)
    }

    @Test func nothingToSendUntilThereIsAnAddress() {
        var list = EmailInviteList()
        #expect(!list.canSend)
        list.add("   ,  ")
        #expect(!list.canSend)
    }

    @Test func masksLikeTheRelay() {
        #expect(EmailAddress.masked("Pat.Lee@Example.com") == "p***@e***.com")
        #expect(EmailAddress.masked("nope") == "***")
    }

    @Test func resultRowsSayWhatHappened() throws {
        let json = #"{"sent":["a@x.com"],"failed":[{"email":"b@x.com","reason":"Too many invitations just now. Try again in a while."}]}"#
        let result = try JSONDecoder().decode(PondEmailInviteResult.self, from: Data(json.utf8))
        let rows = EmailInviteRow.rows(from: result)
        #expect(rows.map(\.line) == ["Sent", "Couldn\u{2019}t send: Too many invitations just now. Try again in a while."])
        #expect(rows.map(\.sent) == [true, false])
    }
}
