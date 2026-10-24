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
let (lidId, lidDocument) = try channel.lidActionsDocument(.init(mute: false, freezeApps: true), signer: signer, now: madeAt)
let (controlsId, controlsDocument) = try channel.controlsDocument(.fans("60"), signer: signer, now: madeAt)
let (imageId, imageDocument) = try channel.imageDocument(sessionId: "s1", source: "/w/.context/shot.png", signer: signer, now: madeAt)
let (diffId, diffDocument) = try channel.diffDocument(sessionId: "s1", file: 0, signer: signer, now: madeAt)
let (stopId, stopDocument) = try channel.stopDocument(to: session, signer: signer, now: madeAt)
let (startId, startDocument) = try channel.startDocument(workspaceId: "w1", agent: .codex, text: "Add a timer", signer: signer, now: madeAt)
// ANSWER-CARD: an answer to question 0 of the pending call toolu_fixture in chat s1: "Red", plus its own words.
let (answerId, answerDocument) = try channel.answerDocument(
    sessionId: "s1", toolUseId: "toolu_fixture",
    answers: [.init(question: 0, picked: ["Red"], other: "and a bit of blue")], signer: signer, now: madeAt)
// RasanAI: a film waiting at its look call, as the Mac showed it.
let film = Workflow(provider: "rasanai", call: "look", step: "look", revision: "look@2026-10-14T16:56:23.780Z",
                    title: "Quotidian", prompt: "Pick a look")
let (chooseId, chooseDocument) = try channel.workflowDocument(
    sessionKey: "claude-transcript:d1", workflow: film, type: "choose", value: .id("wild"), signer: signer, now: madeAt)
let (moreId, moreDocument) = try channel.workflowDocument(
    sessionKey: "claude-transcript:d1", workflow: film, type: "more", value: .more(near: "bold"), signer: signer, now: madeAt)
let (askId, askDocument) = try channel.workflowDocument(
    sessionKey: "claude-transcript:d1", workflow: film, type: "answer", value: .answer(choice: nil, text: "Warmer, please"),
    signer: signer, now: madeAt)
let (posterId, posterDocument) = try channel.imageDocument(
    sessionId: "", sessionKey: "claude-transcript:d1", source: ".rasanai/run-1/design/Wild/specimen.png", signer: signer, now: madeAt)
// RasanAI, the same film at its animatic: a note at 3.5 s pinned to a spot, applying the notes,
// and the animatic's soundtrack.
let animatic = Workflow(provider: "rasanai", call: "animatic", step: "animatic", revision: "animatic@1",
                        title: "Quotidian", prompt: "Give notes on the animatic")
let (noteId, noteDocument) = try channel.workflowDocument(
    sessionKey: "claude-transcript:d1", workflow: animatic, type: "comment",
    value: .note(t: 3.5, scene: "b1", x: 0.25, y: 0.5, quick: "Slower"), note: "Hold the title longer",
    signer: signer, now: madeAt)
let (applyId, applyDocument) = try channel.workflowDocument(
    sessionKey: "claude-transcript:d1", workflow: animatic, type: "apply", value: WorkflowCommand.Value.none,
    signer: signer, now: madeAt)
let (mediaId, mediaDocument) = try channel.mediaDocument(
    sessionKey: "claude-transcript:d1", source: ".rasanai/run-1/animatic-mix.wav", signer: signer, now: madeAt)
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
    // What a closed lid does: mute off, pause chat apps on.
    "lidActionsCommandId": lidId,
    "lidActionsCommand": ["box": lidDocument.box, "sig": lidDocument.sig!, "device": lidDocument.device!],
    // A live control from the Mac controls page: fans to 60%.
    "controlsCommandId": controlsId,
    "controlsCommand": ["box": controlsDocument.box, "sig": controlsDocument.sig!, "device": controlsDocument.device!],
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
    // RasanAI, film claude-transcript:d1 at look@2026-10-14T16:56:23.780Z: pick "wild"; three more near "bold";
    // an answer in words only; and the Wild look's poster.
    "workflowChooseCommandId": chooseId,
    "workflowChooseCommand": ["box": chooseDocument.box, "sig": chooseDocument.sig!, "device": chooseDocument.device!],
    "workflowMoreCommandId": moreId,
    "workflowMoreCommand": ["box": moreDocument.box, "sig": moreDocument.sig!, "device": moreDocument.device!],
    "workflowAnswerCommandId": askId,
    "workflowAnswerCommand": ["box": askDocument.box, "sig": askDocument.sig!, "device": askDocument.device!],
    "workflowNoteCommandId": noteId,
    "workflowNoteCommand": ["box": noteDocument.box, "sig": noteDocument.sig!, "device": noteDocument.device!],
    "workflowApplyCommandId": applyId,
    "workflowApplyCommand": ["box": applyDocument.box, "sig": applyDocument.sig!, "device": applyDocument.device!],
    "mediaCommandId": mediaId,
    "mediaCommand": ["box": mediaDocument.box, "sig": mediaDocument.sig!, "device": mediaDocument.device!],
    "workflowImageCommandId": posterId,
    "workflowImageCommand": ["box": posterDocument.box, "sig": posterDocument.sig!, "device": posterDocument.device!],
]
let data = try JSONSerialization.data(withJSONObject: fixture, options: [.prettyPrinted, .sortedKeys])
FileManager.default.createFile(atPath: CommandLine.arguments[1], contents: data)
print("wrote \(CommandLine.arguments[1])")
