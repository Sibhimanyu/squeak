import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Chat timeline")
struct ChatTimelineTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    typealias R = ChatTimeline.Row

    func user(_ id: String, _ state: MessageState?, ago: TimeInterval = 5) -> ChatMessage {
        ChatMessage(id: id, role: .user, text: "do it", at: now.addingTimeInterval(-ago), state: state)
    }
    func agent(_ id: String, ago: TimeInterval = 600) -> ChatMessage {
        ChatMessage(id: id, role: .assistant, text: "done", at: now.addingTimeInterval(-ago))
    }
    func step(_ text: String) -> ActivityStep { ActivityStep(kind: "tool", text: text) }

    @Test func emptyOnlyWhenNothingIsGoingOn() {
        #expect(ChatTimeline.rows(messages: [], state: .idle, activity: [], now: now) == [.empty])
        // Working with no transcript yet: a working row, never the empty state.
        #expect(ChatTimeline.rows(messages: [], state: .working, activity: [], now: now) == [.working(label: "Starting…")])
    }

    @Test func sendShowsYourMessageAndStartingImmediately() {
        let me = user("local-1", .pending)
        let rows = ChatTimeline.rows(messages: [agent("a"), me], state: .finished, activity: [], now: now)
        #expect(rows == [.message(agent("a"), muted: true), .message(me, muted: false), .working(label: "Starting…")])
    }

    @Test func liveStepReplacesStarting() {
        let me = user("u", .confirmed)
        let rows = ChatTimeline.rows(messages: [agent("a"), me], state: .working, activity: [step("Read src/a.ts"), step("Run npm test")], now: now)
        #expect(rows.last == .working(label: "Running tests…"))
        let reading = ChatTimeline.rows(messages: [me], state: .working, activity: [step("Read src/a.ts")], now: now)
        #expect(reading.last == .working(label: "Reading code…"))
    }

    @Test func previousAgentMessageIsMutedOnlyWhileTheNewTurnIsOpen() {
        let a = agent("a"), me = user("u", .confirmed)
        let working = ChatTimeline.rows(messages: [a, me], state: .working, activity: [], now: now)
        #expect(working.first == .message(a, muted: true))
        // The reply arrives: the working row goes, the reply is not muted, nothing jumps to empty.
        let reply = agent("b", ago: 1)
        let done = ChatTimeline.rows(messages: [a, me, reply], state: .finished, activity: [], now: now)
        #expect(done == [.message(a, muted: false), .message(me, muted: false), .message(reply, muted: false)])
        // A working turn that already wrote part of its answer keeps that answer at full strength.
        let partial = ChatTimeline.rows(messages: [a, me, reply], state: .working, activity: [], now: now)
        #expect(partial.contains(.message(reply, muted: false)))
    }

    @Test func workingFromConductorItselfShowsTheRowToo() {
        let rows = ChatTimeline.rows(messages: [agent("a")], state: .working, activity: [step("Edit a.ts")], now: now)
        #expect(rows == [.message(agent("a"), muted: false), .working(label: "Editing a file…")])
    }

    @Test func failedSendShowsNoWorkingRow() {
        for state in [MessageState.refused(reason: "busy"), .notSent(reason: "offline")] {
            let me = user("u", state)
            #expect(ChatTimeline.rows(messages: [agent("a"), me], state: .finished, activity: [], now: now)
                == [.message(agent("a"), muted: false), .message(me, muted: false)])
        }
    }

    @Test func staleUnansweredSendDoesNotSpinForever() {
        let old = user("u", .confirmed, ago: 3600)
        #expect(!ChatTimeline.isWorking(messages: [agent("a"), old], state: .idle, now: now))
        #expect(!ChatTimeline.isWorking(messages: [agent("a"), user("u", .pending)], state: .blocked, now: now))
    }
}

@Suite("Delivery line")
struct DeliveryLineTests {
    @Test func oneShortLinePerState() {
        #expect(MessageState.pending.deliveryLine == "Sending…")
        #expect(MessageState.accepted(via: "conductor").deliveryLine == "Sent")
        #expect(MessageState.confirmed.deliveryLine == "Sent")
        #expect(MessageState.uncertain(reason: "timeout").deliveryLine == "Not confirmed")
        #expect(MessageState.refused(reason: "busy").deliveryLine == "Not sent: busy")
        #expect(MessageState.notSent(reason: "offline").deliveryLine == "Not sent: offline")
        #expect(MessageState.draft.deliveryLine == nil)
    }
}
