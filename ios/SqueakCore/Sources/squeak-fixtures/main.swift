import CryptoKit
import Foundation
import SqueakCore

// A pairing, a device key, and one signed reply — all made by the phone's own
// code — for the Mac's RemoteBridge tests to accept (src/remote/fixtures).
let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64EncodedString()
let pairing = PairingPayload(v: 1, p: "squeak-test", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Test Mac")
let channel = Channel(pairing: pairing, deviceId: "iphone-fixture")
let signer = SoftwareSigner()
let session = PhoneSnapshot.Session(
    key: "k", conductorSessionId: "s1", label: "farm · arm", agent: "claude", state: "finished",
    lastActivityAt: "2026-09-25T03:00:00Z", detail: nil, git: nil, contextPercent: nil,
    turnId: "turn-1", message: nil, choices: nil
)
let madeAt = Date()
let (id, document) = try channel.replyDocument(to: session, text: "B", signer: signer, now: madeAt)
let fixture: [String: Any] = [
    "madeAt": Int64(madeAt.timeIntervalSince1970 * 1000),
    "key": key,
    "channelId": pairing.c,
    "deviceId": channel.deviceId,
    "publicKey": signer.publicKeyX963.base64EncodedString(),
    "commandId": id,
    "command": ["box": document.box, "sig": document.sig!, "device": document.device!],
]
let data = try JSONSerialization.data(withJSONObject: fixture, options: [.prettyPrinted, .sortedKeys])
FileManager.default.createFile(atPath: CommandLine.arguments[1], contents: data)
print("wrote \(CommandLine.arguments[1])")
