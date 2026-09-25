import Foundation
import SqueakCore

// The phone's real channel code, driven from a terminal against real
// Firestore: pair with the Mac's link, wait for approval, read the snapshot,
// answer the first lettered question with its second option, and wait for
// the Mac's verdict. Usage: squeak-e2e <pairing-url> <code-out-file>
let args = CommandLine.arguments
let payload = try PairingPayload.parse(args[1])
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
let snapshot = try await poll("snapshot") { try await channel.snapshot() }
guard let session = snapshot.sessions.first(where: { $0.choices != nil }), let choices = session.choices else {
    print("phone: no question in the snapshot"); exit(1)
}
print("phone: sees \(snapshot.sessions.count) session(s); question: \(choices.question ?? "-")")
let letter = choices.options[1].letter
let (id, document) = try channel.replyDocument(to: session, text: letter, signer: signer)
try await channel.send(document, id: id)
print("phone: sent \(letter)")
let result = try await poll("result") { try await channel.result(for: id) }
print("phone: mac says \(result.status)\(result.reason.map { " — \($0)" } ?? "")")
exit(result.sent ? 0 : 1)
