import Foundation
import XCTest
@testable import SqueakCore

final class FilmTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func object(_ any: Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(AnyEncodable(any))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private struct AnyEncodable: Encodable {
        let value: Encodable
        init(_ value: Encodable) { self.value = value }
        func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
    }

    private let fullFilm = #"""
    {"id":"film:0123456789abcdef","title":"Quotidian","updatedAt":"2026-10-26T07:19:52.480Z",
     "progress":{"provider":"rasanai","title":"Quotidian","step":"brief","call":"brief","calls":[{"call":"brief","state":"now"}],"waiting":true,"activity":null,"activityAt":null},
     "director":{"state":"stopped","since":"2026-10-26T07:00:00Z","detail":"Exited with code 0"},
     "card":{"provider":"rasanai","call":"brief","step":"brief","revision":"brief@1","title":"Quotidian","prompt":"Confirm the brief",
       "canDecide":true,
       "tool":{"tool":"ffmpeg","label":"FFmpeg"},
       "brief":{"fields":[
          {"key":"length_s","label":"Length","kind":"number","value":60,"min":5,"max":600},
          {"key":"aspect","label":"Shape","kind":"choice","value":"16:9","options":[{"id":"16:9","label":"Wide"},{"id":"9:16","label":"Tall"}]},
          {"key":"use_brand","label":"Use brand","kind":"bool","value":true},
          {"key":"weird","label":"Weird","kind":"hologram","value":null}],
        "format":{"tile":"launch","option":"hero","label":"Launch film"},
        "formats":[{"tile":"launch","title":"Launch","options":[{"id":"hero","label":"Hero","lengthS":60,"aspect":"16:9"},{"id":"short","label":"Short","lengthS":null,"aspect":null}]}],
        "findings":[{"text":"It is a bakery","source":"site"},{"text":"No source"}],
        "captures":[{"image":"c1.png","caption":"Home"},{"image":"c2.png","caption":null}]},
       "styleframes":{"frames":[{"id":"f1","image":"f1.png","ref":"r1.png","shot":"Wide","verdict":"ok"},{"id":"f2","image":"f2.png","ref":null,"shot":null,"verdict":null}],"sheet":"sheet.png"}},
     "pending":[{"id":"p1","type":"submit","said":"Brief sent","t":"2026-10-26T07:20:00Z"}],
     "chat":[{"id":"c1","who":"you","text":"Hello","t":"2026-10-26T07:21:00Z","state":"pending"},{"id":"c2","who":"rasan","text":"Hi","t":null,"state":null}],
     "canChat":true,"canResume":true,"canStop":false,"sessionKey":"claude-transcript:d1","poster":"poster.png",
     "engineNote":"Update RasanAI Studio to resume from your phone."}
    """#

    func testDecodesEveryFieldOfAFilm() throws {
        let film = try decode(PhoneFilm.self, fullFilm)
        XCTAssertEqual(film.id, "film:0123456789abcdef")
        XCTAssertEqual(film.director, .init(state: "stopped", since: "2026-10-26T07:00:00Z", detail: "Exited with code 0"))
        XCTAssertEqual(film.progress?.call, "brief")
        XCTAssertEqual(film.pending.first?.said, "Brief sent")
        XCTAssertEqual(film.chat.map(\.who), ["you", "rasan"])
        XCTAssertEqual(film.chat.first?.state, "pending")
        XCTAssertNil(film.chat.last?.t)
        XCTAssertTrue(film.canChat); XCTAssertTrue(film.canResume); XCTAssertFalse(film.canStop)
        XCTAssertEqual(film.sessionKey, "claude-transcript:d1")
        XCTAssertEqual(film.poster, "poster.png")
        XCTAssertEqual(film.engineNote, "Update RasanAI Studio to resume from your phone.")
        XCTAssertEqual(film.stateWord, "Waiting on you")
        XCTAssertEqual(film.currentCall, "Brief")
    }

    func testDecodesTheBriefStyleframesToolAndDecide() throws {
        let card = try XCTUnwrap(try decode(PhoneFilm.self, fullFilm).card)
        XCTAssertEqual(card.canDecide, true)
        XCTAssertEqual(card.tool, .init(tool: "ffmpeg", label: "FFmpeg"))
        let brief = try XCTUnwrap(card.brief)
        XCTAssertEqual(brief.fields.map(\.key), ["length_s", "aspect", "use_brand", "weird"])
        XCTAssertEqual(brief.fields[0].value, .number(60))
        XCTAssertEqual(brief.fields[0].min, 5); XCTAssertEqual(brief.fields[0].max, 600)
        XCTAssertEqual(brief.fields[1].options?.map(\.id), ["16:9", "9:16"])
        XCTAssertEqual(brief.fields[2].value, .bool(true))
        XCTAssertEqual(brief.fields[3].kind, "hologram")
        XCTAssertEqual(brief.fields[3].value, .null)
        XCTAssertEqual(brief.format, .init(tile: "launch", option: "hero", label: "Launch film"))
        XCTAssertEqual(brief.formats.first?.options.map(\.id), ["hero", "short"])
        XCTAssertEqual(brief.formats.first?.options.first?.lengthS, 60)
        XCTAssertNil(brief.formats.first?.options.last?.aspect)
        XCTAssertEqual(brief.findings.map(\.text), ["It is a bakery", "No source"])
        XCTAssertNil(brief.findings.last?.source)
        XCTAssertEqual(brief.captures.map(\.image), ["c1.png", "c2.png"])
        let frames = try XCTUnwrap(card.styleframes)
        XCTAssertEqual(frames.frames.map(\.id), ["f1", "f2"])
        XCTAssertEqual(frames.frames[0].ref, "r1.png")
        XCTAssertNil(frames.frames[1].verdict)
        XCTAssertEqual(frames.sheet, "sheet.png")
    }

    func testAnEmptyOrOddFilmStillDecodes() throws {
        let bare = try decode(PhoneFilm.self, #"{"id":"film:1"}"#)
        XCTAssertEqual(bare.title, "Film")
        XCTAssertEqual(bare.director.state, "none")
        XCTAssertNil(bare.card); XCTAssertNil(bare.progress)
        XCTAssertEqual(bare.pending, []); XCTAssertEqual(bare.chat, [])
        XCTAssertFalse(bare.canChat)
        XCTAssertEqual(bare.stateWord, "Idle")
        // Wrong types inside never fail the film.
        let odd = try decode(PhoneFilm.self, #"{"id":"film:2","title":7,"director":{"state":5},"card":"nope","chat":[{"id":"x","who":9,"text":null}],"pending":[{"nope":1}],"canChat":"yes"}"#)
        XCTAssertEqual(odd.title, "Film")
        XCTAssertEqual(odd.director.state, "none")
        XCTAssertNil(odd.card)
        XCTAssertEqual(odd.chat.first?.who, "rasan")
        XCTAssertFalse(odd.canChat)
        // A film card of an older Mac has none of the new parts.
        let old = try decode(Workflow.self, #"{"provider":"rasanai","call":"look","step":"look","revision":"r","title":null,"prompt":"Pick a look"}"#)
        XCTAssertNil(old.brief); XCTAssertNil(old.styleframes); XCTAssertNil(old.canDecide); XCTAssertNil(old.tool)
        // A brief with no lists reads as empty ones.
        let thin = try decode(Workflow.Brief.self, #"{"fields":[{"key":"k"}]}"#)
        XCTAssertEqual(thin.fields.first?.kind, "text")
        XCTAssertEqual(thin.fields.first?.label, "k")
        XCTAssertEqual(thin.formats, []); XCTAssertNil(thin.format)
    }

    func testStateWordsAndWaiting() {
        func film(_ state: String, card: Bool = false) -> PhoneFilm {
            PhoneFilm(id: "film:x", title: "T", updatedAt: "", director: .init(state: state),
                      card: card ? Workflow(provider: "rasanai", call: "look", step: "look", revision: "r", title: nil, prompt: "p") : nil)
        }
        XCTAssertEqual(film("running").stateWord, "Working")
        XCTAssertEqual(film("frozen").stateWord, "Paused")
        XCTAssertEqual(film("stopped").stateWord, "Stopped")
        XCTAssertEqual(film("crashed").stateWord, "Stopped unexpectedly")
        XCTAssertEqual(film("finished").stateWord, "Finished")
        XCTAssertEqual(film("stopped", card: true).stateWord, "Waiting on you")
        XCTAssertTrue(film("running", card: true).waitingOnYou)
        XCTAssertFalse(film("finished", card: true).waitingOnYou)
    }

    func testTheSnapshotCarriesFilmsAndAnOldOneHasNone() throws {
        let base = #"{"v":1,"mac":"m","generatedAt":"2026-10-26T07:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]"#
        XCTAssertNil(try decode(PhoneSnapshot.self, base + "}").films)
        let snap = try decode(PhoneSnapshot.self, base + #","films":[{"id":"film:a"},{"id":"film:b","title":"B"}]}"#)
        XCTAssertEqual(snap.films?.map(\.id), ["film:a", "film:b"])
        XCTAssertEqual(snap.film("film:b")?.title, "B")
    }

    func testPresenceNamesFilms() {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("films"))
        XCTAssertTrue(ChannelCrypto.capabilities.contains("z"))
    }

    /* ---------- the command ---------- */

    func testJSONValueKeepsNumbersAsNumbers() throws {
        let value: JSONValue = .object(["n": .number(60), "x": .number(1.5), "s": .string("60"), "b": .bool(true), "z": .null, "a": .array([.string("f1")])])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]
        XCTAssertEqual(json?["n"] as? Int, 60)
        XCTAssertEqual(String(data: try JSONEncoder().encode(JSONValue.number(60)), encoding: .utf8), "60")
        XCTAssertEqual(json?["x"] as? Double, 1.5)
        XCTAssertEqual(json?["s"] as? String, "60")
        XCTAssertEqual(json?["b"] as? Bool, true)
        XCTAssertTrue(json?["z"] is NSNull)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
        // A bool is not read as a number, and a workflow answer converts as it encodes.
        XCTAssertEqual(try decode(JSONValue.self, "true"), .bool(true))
        XCTAssertEqual(JSONValue(.id("wild")), .string("wild"))
        XCTAssertEqual(JSONValue(.answer(choice: "added", text: "ok")), .object(["choice": .string("added"), "text": .string("ok")]))
        XCTAssertEqual(JSONValue(WorkflowCommand.Value.none), .null)
        XCTAssertEqual(JSONValue(nil), .null)
    }

    private func sealed(_ make: (Channel, CommandSigner) throws -> ChannelDocument) throws -> [String: Any] {
        let key = Data((0..<32).map { UInt8($0) }).base64EncodedString()
        let channel = Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "d")
        let document = try make(channel, SoftwareSigner())
        XCTAssertNotNil(document.sig)
        let opened = try ChannelCrypto.open(JSONValue.self, box: document.box, key: key)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(opened)) as? [String: Any])
    }

    func testABriefSubmitIsSignedWithTypedFields() throws {
        let command = try sealed { channel, signer in
            try channel.filmDocument(
                filmId: "film:abc", op: .answer, step: "brief", revision: "brief@1", type: "submit",
                value: FilmAnswer.briefSubmit(fields: ["length_s": .number(60), "use_brand": .bool(false), "subject": .string("x")],
                                              format: (tile: "launch", option: "hero")),
                signer: signer, now: Date(timeIntervalSince1970: 1_000)).document
        }
        XCTAssertEqual(command["v"] as? Int, 1)
        XCTAssertEqual(command["kind"] as? String, "film")
        XCTAssertEqual(command["filmId"] as? String, "film:abc")
        XCTAssertEqual(command["op"] as? String, "answer")
        XCTAssertEqual(command["step"] as? String, "brief")
        XCTAssertEqual(command["revision"] as? String, "brief@1")
        XCTAssertEqual(command["type"] as? String, "submit")
        let value = try XCTUnwrap(command["value"] as? [String: Any])
        let fields = try XCTUnwrap(value["fields"] as? [String: Any])
        XCTAssertEqual(fields["length_s"] as? Int, 60)
        XCTAssertEqual(fields["use_brand"] as? Bool, false)
        XCTAssertEqual(value["format"] as? [String: String], ["tile": "launch", "option": "hero"])
        XCTAssertEqual(command["expiresAt"] as? Int64, Int64((1_000 + Channel.commandLifetime) * 1000))
        XCTAssertEqual((command["nonce"] as? String)?.count, 32)
        // Nothing the op does not use is sent.
        XCTAssertNil(command["text"]); XCTAssertNil(command["askId"]); XCTAssertNil(command["tool"]); XCTAssertNil(command["note"])
    }

    func testEveryOpEncodesOnlyItsOwnFields() throws {
        let chat = try sealed { c, s in try c.filmDocument(filmId: "film:a", op: .chat, text: "Hold the title", signer: s).document }
        XCTAssertEqual(chat["op"] as? String, "chat"); XCTAssertEqual(chat["text"] as? String, "Hold the title")
        XCTAssertNil(chat["step"]); XCTAssertNil(chat["value"])
        let resume = try sealed { c, s in try c.filmDocument(filmId: "film:a", op: .resume, signer: s).document }
        XCTAssertEqual(resume["op"] as? String, "resume"); XCTAssertEqual(resume.keys.sorted(), ["expiresAt", "filmId", "kind", "nonce", "op", "v"])
        let stop = try sealed { c, s in try c.filmDocument(filmId: "film:a", op: .stop, signer: s).document }
        XCTAssertEqual(stop["op"] as? String, "stop")
        let install = try sealed { c, s in try c.filmDocument(filmId: "film:a", op: .installTool, askId: "2", tool: "ffmpeg", signer: s).document }
        XCTAssertEqual(install["op"] as? String, "installTool")
        XCTAssertEqual(install["askId"] as? String, "2"); XCTAssertEqual(install["tool"] as? String, "ffmpeg")
        let rest = try sealed { c, s in try c.filmDocument(filmId: "film:a", op: .answer, step: "brief", revision: "r", type: "decide-rest", signer: s).document }
        XCTAssertEqual(rest["type"] as? String, "decide-rest"); XCTAssertNil(rest["value"])
        let comment = try sealed { c, s in
            try c.filmDocument(filmId: "film:a", op: .answer, step: "styleframes", revision: "r", type: "comment",
                               value: FilmAnswer.frameComment(frame: "f2", text: "Warmer"), signer: s).document }
        XCTAssertEqual((comment["value"] as? [String: Any])?["frame"] as? String, "f2")
        XCTAssertEqual((comment["value"] as? [String: Any])?["text"] as? String, "Warmer")
        let redo = try sealed { c, s in
            try c.filmDocument(filmId: "film:a", op: .answer, step: "styleframes", revision: "r", type: "redo",
                               value: FilmAnswer.redo(ids: ["f1", "f3"], note: "Less busy"), signer: s).document }
        XCTAssertEqual((redo["value"] as? [String: Any])?["ids"] as? [String], ["f1", "f3"])
        XCTAssertEqual((redo["value"] as? [String: Any])?["note"] as? String, "Less busy")
    }

    func testImageAndMediaNameTheFilmInsteadOfASession() throws {
        let image = try sealed { c, s in try c.imageDocument(sessionId: "", filmId: "film:a", source: "p.png", signer: s).document }
        XCTAssertEqual(image["kind"] as? String, "image"); XCTAssertEqual(image["filmId"] as? String, "film:a")
        XCTAssertNil(image["sessionKey"]); XCTAssertEqual(image["sessionId"] as? String, "")
        let media = try sealed { c, s in try c.mediaDocument(filmId: "film:a", source: "m.wav", signer: s).document }
        XCTAssertEqual(media["kind"] as? String, "media"); XCTAssertEqual(media["filmId"] as? String, "film:a")
        XCTAssertNil(media["sessionKey"])
        // A chat's own are unchanged: no filmId.
        let chatImage = try sealed { c, s in try c.imageDocument(sessionId: "s1", source: "p.png", signer: s).document }
        XCTAssertNil(chatImage["filmId"])
        let cardMedia = try sealed { c, s in try c.mediaDocument(sessionKey: "k", source: "m.wav", signer: s).document }
        XCTAssertEqual(cardMedia["sessionKey"] as? String, "k"); XCTAssertNil(cardMedia["filmId"])
    }

    /* ---------- the Ask Rasan thread ---------- */

    func testATypedLineShowsUntilTheMacsThreadHasIt() {
        let local = FilmChat.Local(text: "Hold the  title", at: Date(timeIntervalSince1970: 100))
        let before = FilmChat.rows(server: [.init(id: "1", who: "rasan", text: "Hi")], local: [local])
        XCTAssertEqual(before.map(\.text), ["Hi", "Hold the  title"])
        XCTAssertEqual(before.last?.status, "Sending…")
        XCTAssertTrue(before.last?.isYou == true)
        // The Mac's thread now has it, whitespace folded: one bubble, not two.
        let after = FilmChat.rows(server: [.init(id: "1", who: "rasan", text: "Hi"), .init(id: "2", who: "you", text: "Hold the title", state: "pending")], local: [local])
        XCTAssertEqual(after.map(\.text), ["Hi", "Hold the title"])
        XCTAssertEqual(after.last?.status, "Sent, waiting for Rasan to read it")
        XCTAssertEqual(FilmChat.settled(server: [.init(id: "2", who: "you", text: "Hold the title")], local: [local]), [])
    }

    func testTheSameWordsTwiceNeedTwoLinesOnTheMac() {
        let a = FilmChat.Local(text: "Slower", at: Date(timeIntervalSince1970: 1))
        let b = FilmChat.Local(text: "Slower", at: Date(timeIntervalSince1970: 2))
        let one = [PhoneFilm.ChatLine(id: "1", who: "you", text: "Slower")]
        XCTAssertEqual(FilmChat.rows(server: one, local: [a, b]).count, 2)
        XCTAssertEqual(FilmChat.settled(server: one, local: [a, b], now: Date(timeIntervalSince1970: 3)), [b])
    }

    func testAFailedLineStaysAndASilentOneExpires() {
        var failed = FilmChat.Local(text: "x", at: Date(timeIntervalSince1970: 0))
        failed.state = .failed("Your Mac didn't answer.")
        let silent = FilmChat.Local(text: "y", at: Date(timeIntervalSince1970: 0), state: .sent)
        let now = Date(timeIntervalSince1970: 10_000)
        XCTAssertEqual(FilmChat.settled(server: [], local: [failed, silent], now: now), [failed])
        let rows = FilmChat.rows(server: [], local: [failed])
        XCTAssertTrue(rows[0].failed)
        XCTAssertEqual(rows[0].status, "Your Mac didn't answer.")
        XCTAssertEqual(rows[0].local, failed.id)
    }
}
