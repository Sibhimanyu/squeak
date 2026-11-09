import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct NativeHistoryTests {
    private func turn(_ n: Int, seq: Int, files: [NativeFileChange] = [], start: Bool = true) -> NativeTurn {
        let json = """
        {"turn":\(n),"text":"t","startSeq":\(seq),"endSeq":null,
         "startCheckpoint":\(start ? "{\"ref\":\"r\",\"commit\":\"c\"}" : "null"),"endCheckpoint":null,"files":[],"working":false}
        """
        return try! JSONDecoder().decode(NativeTurn.self, from: Data(json.utf8))
    }

    @Test func decodesTheHostsShape() throws {
        let json = #"{"turns":[{"turn":1,"text":"hi","startSeq":3,"endSeq":9,"startCheckpoint":{"ref":"a","commit":"b"},"endCheckpoint":null,"files":[{"path":"x.ts","status":"M"}],"working":false}]}"#
        struct W: Decodable { var turns: [NativeTurn] }
        let t = try JSONDecoder().decode(W.self, from: Data(json.utf8)).turns[0]
        #expect(t.files == [NativeFileChange(status: "M", path: "x.ts")])
        #expect(t.startCheckpoint?.commit == "b")
    }

    @Test func mapsAMessageToItsTurn() {
        let turns = [turn(1, seq: 2), turn(2, seq: 11)]
        #expect(NativeHistory.turn(forMessageId: "native-11", in: turns)?.turn == 2)
        #expect(NativeHistory.turn(forMessageId: "native-5", in: turns) == nil)
        #expect(NativeHistory.turn(forMessageId: "local-abc", in: turns) == nil)
        #expect(NativeHistory.latestTurn(in: turns)?.turn == 2)
    }

    @Test func words() {
        #expect(NativeHistory.filesChangedLine([]) == nil)
        #expect(NativeHistory.filesChangedLine([NativeFileChange(status: "A", path: "a")]) == "1 file changed")
        #expect(NativeHistory.filesChangedLine([NativeFileChange(status: "A", path: "a"), NativeFileChange(status: "D", path: "b")]) == "2 files changed")
        #expect(NativeHistory.fileLine(NativeFileChange(status: "D", path: "b")) == "Deleted  b")
        #expect(NativeHistory.disabledReason(working: true) != nil)
        #expect(NativeHistory.disabledReason(working: false) == nil)
        #expect(NativeHistory.canRestore(turn(1, seq: 1, start: false)) == false)
        #expect(NativeHistory.canRestore(turn(1, seq: 1)))
        #expect(NativeHistory.trimmedEdit("  \n") == nil)
        #expect(NativeHistory.trimmedEdit(" x ") == "x")
    }
}
