import Foundation
import Testing
@testable import SqueakMacCore

// The fixture is made by the TypeScript side (scripts/make-join-words-fixture.ts); these tests make Swift agree byte for byte.
private struct Fixture: Decodable {
    struct Vector: Decodable { var ownerKey: String; var joinerKey: String; var pondId: String; var words: [String] }
    struct Code: Decodable { var input: String; var normal: String? }
    var wordlist: [String]
    var vectors: [Vector]
    var codes: [Code]
}

private func fixture() throws -> Fixture {
    let url = try #require(Bundle.module.url(forResource: "join-words", withExtension: "json", subdirectory: "ponds"))
    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
}

@Suite struct JoinWordsTests {
    @Test func theListIsTheSameFixedList() throws {
        let f = try fixture()
        #expect(JoinWords.list.count == 256)
        #expect(Set(JoinWords.list).count == 256)
        #expect(JoinWords.list == f.wordlist)
    }

    @Test func derivationMatchesTheTypeScriptVectors() throws {
        for v in try fixture().vectors {
            #expect(JoinWords.derive(ownerKey: v.ownerKey, joinerKey: v.joinerKey, pondId: v.pondId) == v.words)
        }
        #expect(String(decoding: JoinWords.input(ownerKey: "o", joinerKey: "j", pondId: "p"), as: UTF8.self) == "squeak-pond-words-v1\no\nj\np")
    }

    @Test func aSwappedKeyShowsOtherWords() {
        let honest = JoinWords.derive(ownerKey: "owner", joinerKey: "joiner", pondId: "pond")
        #expect(honest != JoinWords.derive(ownerKey: "relay", joinerKey: "joiner", pondId: "pond"))
        #expect(JoinWords.line(honest).contains("\u{00B7}"))
    }

    @Test func codeNormalisationMatchesTheTypeScriptVectors() throws {
        for c in try fixture().codes { #expect(ShortCode.normalize(c.input) == c.normal, "\(c.input)") }
        #expect(ShortCode.normalize("k7p 4qd") == "K7P-4QD")
        #expect(PondInviteText.cleaned(" k7p4qd ") == "K7P-4QD")
        #expect(PondInviteText.cleaned("squeak-pond:abc") == "squeak-pond:abc")
        #expect(PondInviteText.canJoin(code: "K7P 4QD"))
    }

    @Test func theCountdownRunsDownToNothing() {
        let end = Date(timeIntervalSince1970: 1000)
        #expect(ShortCode.countdown(until: end, now: end.addingTimeInterval(-600)) == "10:00")
        #expect(ShortCode.countdown(until: end, now: end.addingTimeInterval(-61)) == "1:01")
        #expect(ShortCode.countdown(until: end, now: end.addingTimeInterval(-5)) == "0:05")
        #expect(ShortCode.countdown(until: end, now: end) == nil)
        #expect(InviteSheetText.shortExpiry(end, now: end.addingTimeInterval(1)) == "Code expired")
    }

    @Test func aShortInviteAndItsStateDecode() throws {
        let json = #"{"id":"i1","short":"K7P-4QD","expiresAt":1700000600000}"#.data(using: .utf8)!
        let invite = try JSONDecoder().decode(PondInvite.self, from: json)
        #expect(invite.short == "K7P-4QD" && invite.code.isEmpty)
        var state = InviteSheetState()
        state.created(invite)
        #expect(state.showsShort && state.shareText == "K7P-4QD")
        state.linkCreated(PondInvite(code: "squeak-pond:x", expiresAt: nil, link: "https://h/join#x"))
        #expect(!state.showsShort && state.shareText == "https://h/join#x")
        let summary = try JSONDecoder().decode(PondSummary.self, from: #"{"id":"a","status":"pending","words":["amber","anchor","apple"]}"#.data(using: .utf8)!)
        #expect(summary.words == ["amber", "anchor", "apple"])
        let join = try JSONDecoder().decode(JoinRequest.self, from: #"{"requestId":"r","name":"n","words":["amber","anchor","apple"]}"#.data(using: .utf8)!)
        #expect(join.words.count == 3)
    }
}
