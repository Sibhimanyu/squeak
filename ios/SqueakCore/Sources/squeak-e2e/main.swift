import Foundation
import SqueakCore

// The phone's real channel code, driven from a terminal against real
// Firestore: pair with the Mac's link, wait for approval, read the snapshot,
// answer the first lettered question with its second option, and wait for
// the Mac's verdict. Usage: squeak-e2e <pairing-url> <code-out-file>
let args = CommandLine.arguments
let parsed = try PairingPayload.parse(args[1])
// SQUEAK_E2E_DATABASE_URL points the phone at a Realtime Database the code
// does not name (the emulator, which is http and so never in a real code).
let payload = ProcessInfo.processInfo.environment["SQUEAK_E2E_DATABASE_URL"].map {
    PairingPayload(v: parsed.v, p: parsed.p, c: parsed.c, k: parsed.k, n: parsed.n, r: $0)
} ?? parsed
let channel = Channel(pairing: payload, deviceId: "e2e-" + UUID().uuidString.prefix(8).lowercased())
let signer = SoftwareSigner()
let code = ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963)
FileManager.default.createFile(atPath: args[2], contents: Data(code.utf8))
print("phone: requesting pairing, code \(code)")
try await channel.requestPairing(name: "E2E iPhone", signer: signer)

func poll<T>(_ label: String, seconds: Int = 60, _ body: () async throws -> T?) async throws -> T {
    for _ in 0..<(seconds * 2) {
        if let value = try await body() { return value }
        try await Task.sleep(for: .milliseconds(500))
    }
    throw NSError(domain: "e2e", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out waiting for \(label)"])
}

let answer = try await poll("approval") { try await channel.pairingAnswer() }
print("phone: approved=\(answer.approved) by \(answer.mac ?? "?")")
guard answer.approved else { exit(1) }
try await channel.touchPresence()
let snapshot: PhoneSnapshot
if let snapshots = await channel.snapshots() {
    // Streamed: the view arrives in the stream's first event.
    var first: PhoneSnapshot?
    for try await next in snapshots where next != nil { first = next; break }
    if let first { snapshot = first } else { snapshot = try await poll("snapshot") { try await channel.snapshot() } }
    print("phone: view decoded from the stream")
} else {
    snapshot = try await poll("snapshot") { try await channel.snapshot() }
}
guard let session = snapshot.sessions.first(where: { $0.choices != nil }), let choices = session.choices else {
    print("phone: no question in the snapshot"); exit(1)
}
print("phone: sees \(snapshot.sessions.count) session(s); question: \(choices.question ?? "-")")
let letter = choices.options[1].letter
let (id, document) = try channel.replyDocument(to: session, text: letter, signer: signer)
try await channel.send(document, id: id)
print("phone: sent \(letter)")
/// The Mac's verdict: on the stream when there is one, else polled.
func verdict(_ id: String, _ label: String) async throws -> CommandResult {
    if let changes = await channel.resultChanges() {
        for await _ in changes { if let result = try await channel.result(for: id) { return result } }
    }
    return try await poll(label) { try await channel.result(for: id) }
}
let streamed = await channel.streams
print("phone: channel is \(streamed ? "streamed (Realtime Database)" : "polled (Firestore)")")
let sentAt = Date()
let result = try await verdict(id, "result")
print("phone: round trip \(Int(Date().timeIntervalSince(sentAt) * 1000)) ms")
print("phone: mac says \(result.status)\(result.reason.map { " — \($0)" } ?? "") delivery=\(result.delivery ?? "-")")
guard result.sent else { exit(1) }

// A steered reply: the mode is signed in, the Mac carries it to the replier and reports "steered".
let (steerId, steerDocument) = try channel.replyDocument(to: session, text: "Use the timer instead", mode: .steer, signer: signer)
try await channel.send(steerDocument, id: steerId)
print("phone: sent a steer")
let steerAt = Date()
let steered = try await verdict(steerId, "steer result")
print("phone: steer round trip \(Int(Date().timeIntervalSince(steerAt) * 1000)) ms")
print("phone: mac says \(steered.status) delivery=\(steered.delivery ?? "-")")

// A new chat: the Mac lists workspaces in the snapshot, the phone signs a start, the Mac's (fake) relay answers.
guard let workspace = snapshot.workspaces?.first else { print("phone: no workspaces in the snapshot"); exit(1) }
print("phone: workspaces \(snapshot.workspaces!.map(\.label))")
let (startId, startDocument) = try channel.startDocument(workspaceId: workspace.id, agent: workspace.agent, text: "Add a timer", signer: signer)
try await channel.send(startDocument, id: startId)
let startAt = Date()
let started = try await verdict(startId, "start result")
print("phone: start round trip \(Int(Date().timeIntervalSince(startAt) * 1000)) ms")
print("phone: mac says \(started.status) sessionId=\(started.sessionId ?? "-")")
// A second start inside 15 s is refused by the Mac's rate limit.
let (againId, againDocument) = try channel.startDocument(workspaceId: workspace.id, agent: workspace.agent, text: "Again", signer: signer)
try await channel.send(againDocument, id: againId)
let again = try await verdict(againId, "second start result")
print("phone: second start \(again.status) — \(again.reason ?? "-")")
let startOk = started.sent && started.sessionId == "e2e-new-session" && again.status == "refused"

// Verbose (Realtime Database only): presence names the session, the Mac streams its whole turn, and deletes it after.
var liveOk = true
if streamed {
    let watchAt = Date()
    try await channel.touchPresence(watching: session.key)
    var turn: LiveTurn?
    // Decoded from the stream's own events: no second download.
    if let turns = await channel.liveTurns(for: session.key) {
        for await next in turns where next != nil {
            turn = next
            break
        }
    }
    let longest = turn?.steps.map(\.text.count).max() ?? 0
    print("phone: live turn \(turn?.steps.count ?? 0) step(s), longest \(longest) chars, after \(Int(Date().timeIntervalSince(watchAt) * 1000)) ms")
    try await channel.touchPresence(watching: nil)
    let gone = try await poll("live turn deleted", seconds: 10) { try await channel.liveTurn(for: session.key) == nil ? true : nil }
    print("phone: live turn deleted after leaving: \(gone)")
    liveOk = longest > 200 && gone
}
print("phone: usage claude=\(snapshot.usage?.claude?.fiveHour?.usedPercent.description ?? "-") codex=\(snapshot.usage?.codex == nil ? "-" : "seen")")
exit(liveOk && startOk && steered.sent && steered.delivery == "steered" && snapshot.usage?.claude?.fiveHour?.usedPercent == 42 ? 0 : 1)
