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
let (steerId, steerDocument) = try channel.replyDocument(to: session, text: "Use the timer instead", mode: .steer, signer: signer, now: madeAt)
let (queuedId, queuedDocument) = try channel.replyDocument(
    to: session, text: "Then add tests", messageId: "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31", signer: signer, now: madeAt)
let (promoteId, promoteDocument) = try channel.queueDocument(
    sessionId: "s1", messageId: "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31", action: .promote, signer: signer, now: madeAt)
let (hotspotId, hotspotDocument) = try channel.hotspotDocument(
    action: .configure, ssid: "Sibhi's iPhone", password: "secret-pass", enabled: true, signer: signer, now: madeAt)
let (imageId, imageDocument) = try channel.imageDocument(sessionId: "s1", source: "/w/.context/shot.png", signer: signer, now: madeAt)
let (diffId, diffDocument) = try channel.diffDocument(sessionId: "s1", file: 0, signer: signer, now: madeAt)
let (stopId, stopDocument) = try channel.stopDocument(to: session, signer: signer, now: madeAt)
let (startId, startDocument) = try channel.startDocument(workspaceId: "w1", agent: .codex, text: "Add a timer", signer: signer, now: madeAt)
// ANSWER-CARD: an answer to question 0 of the pending call toolu_fixture in chat s1: "Red", plus its own words.
let (answerId, answerDocument) = try channel.answerDocument(
    sessionId: "s1", toolUseId: "toolu_fixture",
    answers: [.init(question: 0, picked: ["Red"], other: "and a bit of blue")], signer: signer, now: madeAt)
let fixture: [String: Any] = [
    "madeAt": Int64(madeAt.timeIntervalSince1970 * 1000),
    "key": key,
    "channelId": pairing.c,
    "deviceId": channel.deviceId,
    "publicKey": signer.publicKeyX963.base64EncodedString(),
    "commandId": id,
    "command": ["box": document.box, "sig": document.sig!, "device": document.device!],
    // The same reply with `mode: "steer"` signed in.
    "steerCommandId": steerId,
    "steerCommand": ["box": steerDocument.box, "sig": steerDocument.sig!, "device": steerDocument.device!],
    // A reply carrying the phone's own message id (Conductor's queue id): "Then add tests".
    "queuedCommandId": queuedId,
    "queuedCommand": ["box": queuedDocument.box, "sig": queuedDocument.sig!, "device": queuedDocument.device!],
    // Steer that queued message now.
    // Hotspot failover set up from the phone.
    "hotspotCommandId": hotspotId,
    "hotspotCommand": ["box": hotspotDocument.box, "sig": hotspotDocument.sig!, "device": hotspotDocument.device!],
    // An image chat s1's agent showed.
    "imageCommandId": imageId,
    "imageCommand": ["box": imageDocument.box, "sig": imageDocument.sig!, "device": imageDocument.device!],
    // What chat s1 changed, with the first file's patch.
    "diffCommandId": diffId,
    "diffCommand": ["box": diffDocument.box, "sig": diffDocument.sig!, "device": diffDocument.device!],
    // Stop the chat's turn (turn-1).
    "stopCommandId": stopId,
    "stopCommand": ["box": stopDocument.box, "sig": stopDocument.sig!, "device": stopDocument.device!],
    "promoteCommandId": promoteId,
    "promoteCommand": ["box": promoteDocument.box, "sig": promoteDocument.sig!, "device": promoteDocument.device!],
    // A new chat in workspace w1 with codex: "Add a timer".
    "startCommandId": startId,
    "startCommand": ["box": startDocument.box, "sig": startDocument.sig!, "device": startDocument.device!],
    // An answer to question 0 of toolu_fixture in s1: picked "Red", other "and a bit of blue".
    "answerCommandId": answerId,
    "answerCommand": ["box": answerDocument.box, "sig": answerDocument.sig!, "device": answerDocument.device!],
]
let data = try JSONSerialization.data(withJSONObject: fixture, options: [.prettyPrinted, .sortedKeys])
FileManager.default.createFile(atPath: CommandLine.arguments[1], contents: data)
print("wrote \(CommandLine.arguments[1])")
