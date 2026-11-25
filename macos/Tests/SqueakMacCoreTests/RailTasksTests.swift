import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RailTasksTests {
    private func thread(_ sid: String, name: String, duckId: String) -> RoomThread {
        let json = #"{"sessionId":"\#(sid)","title":"t","state":"idle","name":"\#(name)","duckId":"\#(duckId)"}"#
        return try! JSONDecoder().decode(RoomThread.self, from: Data(json.utf8))
    }

    @Test func listsBlockedThenWorkingThenWaitingAndSkipsFinished() {
        let tasks = [
            RoomTask(id: "a", messageId: "m", text: "Wait", state: .waiting),
            RoomTask(id: "b", messageId: "m", text: "Work", state: .working, handedTo: RoomTaskHandedTo(sessionId: "s1", title: "x")),
            RoomTask(id: "c", messageId: "m", text: "Stuck", state: .blocked),
            RoomTask(id: "d", messageId: "m", text: "Over", state: .done),
            RoomTask(id: "e", messageId: "m", text: "Gone", state: .dropped),
        ]
        let rows = RailTasks.rows(tasks, threads: [thread("s1", name: "Pip", duckId: "d1")])
        #expect(rows.map(\.id) == ["c", "b", "a"])
        #expect(rows[1].duckSessionId == "s1")
        #expect(rows[1].detail == "Working · Pip")
        #expect(rows[2].detail == "Waiting")
        #expect(rows[2].duckSessionId == nil)
    }

    @Test func aRoutedWaitingTaskOpensTheDuckRoutingChose() {
        let task = RoomTask(id: "a", messageId: "m", text: "Wait", state: .waiting, routing: RoomTaskRouting(kind: "duck", duckId: "d1", name: "Pip"))
        let rows = RailTasks.rows([task], threads: [thread("s1", name: "Pip", duckId: "d1")])
        #expect(rows[0].duckSessionId == "s1")
    }
}
