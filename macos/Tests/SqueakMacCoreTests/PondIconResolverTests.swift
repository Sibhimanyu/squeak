import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondIconResolverTests {
    @Test func customBeatsRepositoryBeatsLetter() {
        #expect(PondIconResolver.source(custom: true, repository: true) == .custom)
        #expect(PondIconResolver.source(custom: false, repository: true) == .repository)
        #expect(PondIconResolver.source(custom: false, repository: false) == .letter)
    }

    @Test func cacheDropsTheOldVersionWhenTheStampChanges() {
        var cache = VersionedCache<String>()
        let one = PondIconResolver.stamp(id: "p", version: "100", url: "/u")!
        let two = PondIconResolver.stamp(id: "p", version: "200", url: "/u")!
        cache.store("old", id: "p", stamp: one)
        #expect(cache.value(id: "p", stamp: one) == "old")
        #expect(cache.value(id: "p", stamp: two) == nil)
        cache.store("new", id: "p", stamp: two)
        #expect(cache.value(id: "p", stamp: one) == nil)
        #expect(cache.value(id: "p", stamp: two) == "new")
        #expect(PondIconResolver.stamp(id: "p", version: nil, url: nil) == nil)
    }

    @Test func hostSendsTheVersionAsANumber() throws {
        let json = #"{"id":"p","name":"n","rootPath":"/r","defaultBranch":"main","iconUrl":"/native/projects/p/icon","iconUpdatedAt":1762899780123}"#
        let p = try JSONDecoder().decode(NativeProject.self, from: Data(json.utf8))
        #expect(p.iconUpdatedAt == "1762899780123")
    }
}
