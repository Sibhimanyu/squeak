import CryptoKit
import XCTest

@testable import SqueakMacCore

final class RelayCryptoTests: XCTestCase {
    func testHChaCha20Vector() throws {
        let v = try RelayVectors.load().dict("hchacha20")
        XCTAssertEqual(hexString(RelayCrypto.hchacha20(key: v.h("key"), nonce16: v.h("nonce16"))), v.s("output"))
    }

    func testHChaCha20DraftVector() {
        // draft-irtf-cfrg-xchacha-03 §2.2.1
        let key = hexData("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        let nonce = hexData("000000090000004a0000000031415927")
        XCTAssertEqual(
            hexString(RelayCrypto.hchacha20(key: key, nonce16: nonce)),
            "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc")
    }

    func testRecordNonceVectors() throws {
        for v in try RelayVectors.load().root["recordNonce"] as! [[String: Any]] {
            let n = RelayCrypto.recordNonce(direction: UInt8(v["direction"] as! Int), counter: UInt64(v["counter"] as! Int))
            XCTAssertEqual(hexString(n), v["nonce"] as! String)
        }
    }

    func testXChaChaSealMatchesNodeVector() throws {
        let v = try RelayVectors.load().dict("xchachaSeal")
        let box = try RelayCrypto.xchachaSeal(key: v.h("key"), nonce24: v.h("nonce24"), aad: v.h("aad"), plaintext: v.h("plaintext"))
        XCTAssertEqual(hexString(box), v.s("box"))
        XCTAssertEqual(try RelayCrypto.xchachaOpen(key: v.h("key"), nonce24: v.h("nonce24"), aad: v.h("aad"), box: box), v.h("plaintext"))
    }

    func testXChaChaDraftTestVector() throws {
        // draft-irtf-cfrg-xchacha-03 A.3.1 (same vector as crypto.test.ts)
        let key = Data((0..<32).map { UInt8(0x80 + $0) })
        let nonce = Data((0..<24).map { UInt8(0x40 + $0) })
        let aad = hexData("50515253c0c1c2c3c4c5c6c7")
        let plaintext = Data("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let expected =
            "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e"
            + "c0875924c1c7987947deafd8780acf49"
        let out = try RelayCrypto.xchachaSeal(key: key, nonce24: nonce, aad: aad, plaintext: plaintext)
        XCTAssertEqual(hexString(out), expected)
        XCTAssertEqual(try RelayCrypto.xchachaOpen(key: key, nonce24: nonce, aad: aad, box: out), plaintext)
    }

    func testTamperedBoxIsRejected() throws {
        let key = Data(repeating: 7, count: 32), nonce = Data(repeating: 9, count: 24), aad = Data(repeating: 1, count: 32)
        let sealed = try RelayCrypto.xchachaSeal(key: key, nonce24: nonce, aad: aad, plaintext: Data("hi".utf8))
        XCTAssertEqual(sealed.startIndex, 0)  // regression: sealed box must be zero-based (byte-0 flip used to trap)
        for index in [0, 3] {
            var box = sealed
            box[index] ^= 1
            XCTAssertThrowsError(try RelayCrypto.xchachaOpen(key: key, nonce24: nonce, aad: aad, box: box)) {
                XCTAssertEqual($0 as? RelayError, .decryptFailed)
            }
        }
    }

    func testHostileFramesAlwaysThrowNeverCrash() throws {
        let host = RelayHostSession(), phone = RelayPhoneSession()
        try phone.acceptReady(try host.ready(hello: phone.hello()), expectedHostStaticKey: host.staticKey.publicKey)
        let valid = try host.encrypt(.obj(["type": "pong", "id": "1"]))
        let raw = try XCTUnwrap(RelayCrypto.b64urlDecode(valid.c))
        var rng = SystemRandomNumberGenerator()
        var mutated = 0
        for i in 0..<200 {
            var box = raw
            if i % 2 == 0 {
                box = Data(box.prefix(Int.random(in: 0..<box.count, using: &rng)))  // truncation, incl. empty
            } else {
                box[Int.random(in: 0..<box.count, using: &rng)] ^= UInt8(1 << Int.random(in: 0..<8, using: &rng))
            }
            let frame = RelayJSON.obj(["t": "e", "n": 0, "c": .string(RelayCrypto.b64urlEncode(box))])
            XCTAssertThrowsError(try phone.decrypt(frame), "mutation \(i)")
            mutated += 1
        }
        XCTAssertEqual(mutated, 200)
        // hostile envelope shapes
        for bad: RelayJSON in [.null, .obj(["t": "e"]), .obj(["t": "e", "n": -1, "c": "x"]), .obj(["t": "e", "n": 0, "c": "!!"]),
                               .obj(["t": "x", "n": 0, "c": "AA"]), .obj(["t": "e", "n": .int(Int64.max), "c": "AA"])] {
            XCTAssertThrowsError(try phone.decrypt(bad))
        }
        // the genuine frame still opens afterwards (failed attempts must not advance the counter)
        XCTAssertEqual(try phone.decrypt(valid.json)["type"]?.stringValue, "pong")
    }

    private func fixedKeys(_ h: [String: Any]) throws -> (RelayCrypto.X25519KeyPair, RelayCrypto.X25519KeyPair, RelayCrypto.X25519KeyPair) {
        (try .init(privateRaw: h.h("clientEphemeralPrivate")), try .init(privateRaw: h.h("hostStaticPrivate")), try .init(privateRaw: h.h("hostEphemeralPrivate")))
    }

    func testHandshakeVectorsBothSides() throws {
        let h = try RelayVectors.load().dict("handshake")
        let (c, hs, he) = try fixedKeys(h)
        XCTAssertEqual(hexString(c.publicKey), h.s("clientEphemeralPublic"))
        XCTAssertEqual(hexString(hs.publicKey), h.s("hostStaticPublic"))
        XCTAssertEqual(hexString(he.publicKey), h.s("hostEphemeralPublic"))
        XCTAssertEqual(RelayCrypto.hostId(fromStaticKey: hs.publicKey), h.s("hostId"))

        let th = RelayCrypto.transcriptHash(
            hostId: h.s("hostId"), clientEphemeralPublicKey: c.publicKey, clientNonce: h.h("clientNonce"),
            hostStaticPublicKey: hs.publicKey, hostEphemeralPublicKey: he.publicKey, hostNonce: h.h("hostNonce"))
        XCTAssertEqual(hexString(th), h.s("transcriptHash"))

        let dhS = try RelayCrypto.x25519(c.privateKey, peer: hs.publicKey)
        let dhE = try RelayCrypto.x25519(c.privateKey, peer: he.publicKey)
        XCTAssertEqual(hexString(dhS), h.s("dhStatic"))
        XCTAssertEqual(hexString(dhE), h.s("dhEphemeral"))
        let keys = RelayCrypto.deriveKeys(dhStatic: dhS, dhEphemeral: dhE, clientNonce: h.h("clientNonce"), hostNonce: h.h("hostNonce"), transcriptHash: th)
        XCTAssertEqual(hexString(keys.clientToHostKey), h.s("clientToHostKey"))
        XCTAssertEqual(hexString(keys.hostToClientKey), h.s("hostToClientKey"))

        // HKDF with the exact salt/info recorded by Node.
        let okm = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: dhS + dhE), salt: h.h("hkdfSalt"), info: h.h("hkdfInfo"), outputByteCount: 64).withUnsafeBytes { Data($0) }
        XCTAssertEqual(hexString(okm.prefix(32)), h.s("clientToHostKey"))

        // Host side, from the same fixed secrets, reproduces the same messages and keys.
        let phone = RelayPhoneSession(ephemeral: c, clientNonce: h.h("clientNonce"))
        XCTAssertEqual(phone.hello().serialized(), h.s("helloJson"))
        let host = RelayHostSession(staticKey: hs, ephemeral: he, hostNonce: h.h("hostNonce"))
        let ready = try host.ready(hello: phone.hello())
        XCTAssertEqual(ready.serialized(), h.s("readyJson"))
        XCTAssertEqual(host.sessionKeys, keys)
        try phone.acceptReady(ready, expectedHostStaticKey: hs.publicKey)
        XCTAssertTrue(phone.established)
    }

    func testFramedRequestAndHostFrameVectors() throws {
        let vectors = try RelayVectors.load()
        let h = vectors.dict("handshake"), fr = vectors.dict("framedRequest"), hf = vectors.dict("hostFrames")
        let (c, hs, he) = try fixedKeys(h)
        let phone = RelayPhoneSession(ephemeral: c, clientNonce: h.h("clientNonce"))
        let host = RelayHostSession(staticKey: hs, ephemeral: he, hostNonce: h.h("hostNonce"))
        try phone.acceptReady(try host.ready(hello: phone.hello()), expectedHostStaticKey: hs.publicKey)

        let message = try XCTUnwrap(RelayJSON.parse(fr.s("messageJson")))
        XCTAssertEqual(message.serialized(), fr.s("messageJson"))  // ordered, JS-identical serialization
        XCTAssertEqual(try phone.encrypt(message).json.serialized(), fr.s("frameJson"))
        XCTAssertEqual(try phone.encrypt(.obj(["type": "ping", "id": "1"])).json.serialized(), fr.s("secondFrameJson"))

        let head = try XCTUnwrap(RelayJSON.parse(hf.s("responseHeadMessageJson")))
        XCTAssertEqual(try host.encrypt(head).json.serialized(), hf.s("responseHeadFrameJson"))
        // and the phone can open Node's host frame
        let phone2 = RelayPhoneSession(ephemeral: c, clientNonce: h.h("clientNonce"))
        try phone2.acceptReady(try XCTUnwrap(RelayJSON.parse(h.s("readyJson"))), expectedHostStaticKey: hs.publicKey)
        let opened = try phone2.decrypt(try XCTUnwrap(RelayJSON.parse(hf.s("responseHeadFrameJson"))))
        XCTAssertEqual(opened["status"]?.intValue, 200)
    }

    func testPhoneClientProducesNodeFrameBytes() async throws {
        let vectors = try RelayVectors.load()
        let h = vectors.dict("handshake"), fr = vectors.dict("framedRequest")
        let (c, hs, he) = try fixedKeys(h)
        let transport = CapturingTransport()
        let client = PhoneClient(
            transport: transport, expectedHostStaticKey: hs.publicKey,
            session: RelayPhoneSession(ephemeral: c, clientNonce: h.h("clientNonce")),
            idGenerator: { "11111111-2222-3333-4444-555555555555" })
        let host = RelayHostSession(staticKey: hs, ephemeral: he, hostNonce: h.h("hostNonce"))

        let hs_ = Task { try await client.handshake() }
        let hello = try await transport.waitForFrame(0)
        client.handleData(try host.ready(hello: hello))
        try await hs_.value

        let req = Task {
            try await client.request(
                method: "POST", target: "/workspaces/ws%201/sessions/s-1/pending-messages/send",
                headers: ["content-type": "application/json"], rawBody: "{\"message\":\"hi \\\"there\\\"\"}")
        }
        let sent = try await transport.waitForFrame(1)
        XCTAssertEqual(sent.serialized(), fr.s("frameJson"))
        client.handleData(try host.encrypt(.obj(["type": "responseHead", "id": "11111111-2222-3333-4444-555555555555", "status": 200, "headers": .obj([:])])).json)
        client.handleData(try host.encrypt(.obj(["type": "responseBody", "id": "11111111-2222-3333-4444-555555555555", "body": .obj(["encoding": "utf8", "data": "ok"]), "final": true])).json)
        let res = try await req.value
        XCTAssertEqual(res.status, 200)
        XCTAssertEqual(res.body, "ok")
    }

    func testHandshakeRejectsWrongHostKeyAndCounterGap() throws {
        let host = RelayHostSession()
        let phone = RelayPhoneSession()
        let ready = try host.ready(hello: phone.hello())
        XCTAssertThrowsError(try phone.acceptReady(ready, expectedHostStaticKey: RelayCrypto.X25519KeyPair.generate().publicKey)) {
            XCTAssertTrue(($0 as? RelayError)?.message.hasPrefix("invalid_handshake") == true)
        }
        try phone.acceptReady(ready, expectedHostStaticKey: host.staticKey.publicKey)
        _ = try host.encrypt(.obj(["a": 1]))  // counter 0 dropped on the wire
        let f1 = try host.encrypt(.obj(["b": 2]))
        XCTAssertThrowsError(try phone.decrypt(f1.json)) { XCTAssertEqual($0 as? RelayError, .counterMismatch) }
    }

    func testRoundTripBothDirections() throws {
        let host = RelayHostSession(), phone = RelayPhoneSession()
        try phone.acceptReady(try host.ready(hello: phone.hello()), expectedHostStaticKey: host.staticKey.publicKey)
        let m = RelayJSON.obj(["type": "request", "id": "2", "method": "GET", "target": "/x", "headers": .obj([:])])
        XCTAssertEqual(try host.decrypt(try phone.encrypt(m).json), m)
        let p = RelayJSON.obj(["type": "pong", "id": "1"])
        XCTAssertEqual(try phone.decrypt(try host.encrypt(p).json), p)
    }
}
