import Foundation
import Testing
@testable import SqueakMacCore

@Suite("The model in the working row and subagent rows")
struct ModelInRowsTests {
    @Test("The working row carries the model after the state's words; unknown is omitted")
    func line() {
        #expect(ChatIndicator.working.line(workingLabel: "Working…", model: "Opus 5.5 · 1M") == "Working… · Opus 5.5 · 1M")
        #expect(ChatIndicator.idle.line(workingLabel: "Running tests…", model: "Opus 5.5") == nil)
        #expect(ChatIndicator.waitingApproval.line(workingLabel: "x", model: "Opus 5.5") == "Waiting for you to allow a command · Opus 5.5")
        #expect(ChatIndicator.background(3).line(workingLabel: "x", model: "Opus 5.5") == "Waiting for 3 background tasks · Opus 5.5")
        #expect(ChatIndicator.background(1).line(workingLabel: "x", model: nil) == "Waiting for 1 background task")
        #expect(ChatIndicator.working.line(workingLabel: "Working…", model: "  ") == "Working…")
        #expect(ChatIndicator.sending.line(workingLabel: "Working…", model: "Opus 5.5") == "Sending…")
        #expect(ChatIndicator.idle.line(workingLabel: "Working…", model: "Opus 5.5") == nil)
    }

    @Test("A native Agent call's row text carries no model: the host's duckling record does")
    func nativeLabel() {
        let input = NativeJSON.object(["description": .string("Ship 2.23.9"), "model": .string("haiku")])
        #expect(NativeTranscript.claudeLabel("Agent", input) == "Start Ship 2.23.9")
        let bare = NativeJSON.object(["description": .string("Ship 2.23.9")])
        #expect(NativeTranscript.claudeLabel("Task", bare) == "Start Ship 2.23.9")
    }

    @Test("The timeline row and the strip chip draw the one model field of the duckling, never the chat's")
    func oneModel() throws {
        // The host's record: the call named haiku while the chat runs Opus 5.5 · 1M.
        let json = #"{"id":"toolu_1","kind":"agent","title":"Build and deploy to Firebase","model":"Haiku 5.5","status":"running","startedAt":"2026-11-25T04:16:46.705Z"}"#
        let duck = try JSONDecoder().decode(Duckling.self, from: Data(json.utf8))
        let row = ToolCallLabel.preview("Start Build and deploy to Firebase")
        #expect(row.agentModel(duckling: duck) == "Haiku 5.5")
        #expect(row.agentModel(duckling: duck) == duck.shownModel)
        #expect(duck.chipText(now: duck.startedAt!.addingTimeInterval(21)) == "Build and deploy to Firebase · Haiku 5.5 · 21s")
        #expect(row.agentRowLabel(duckling: duck) == "Agent · Haiku 5.5 Build and deploy to Firebase")
    }

    @Test("No duckling record or no model: the row shows none (no guess from the chat); other rows never carry one")
    func noGuess() {
        let row = ToolCallLabel.preview("Start Ship it")
        #expect(row.agentModel(duckling: nil) == nil)
        #expect(row.agentRowLabel(duckling: nil) == "Agent Ship it")
        #expect(row.agentModel(duckling: Duckling(id: "a", title: "Ship it")) == nil)
        #expect(ToolCallLabel.preview("Read a.swift").agentModel(duckling: Duckling(id: "a", title: "x", model: "Haiku")) == nil)
        #expect(row.shownVerb == "Duckling")
    }

    @Test("An inherited model decodes and is still the one drawn")
    func inherited() throws {
        let json = #"{"id":"t","kind":"agent","title":"d","model":"Opus 5.5","modelInherited":true,"status":"running"}"#
        let duck = try JSONDecoder().decode(Duckling.self, from: Data(json.utf8))
        #expect(duck.modelInherited)
        #expect(duck.shownModel == "Opus 5.5")
        #expect(Duckling(id: "s", kind: .shell, title: "c", model: "x").shownModel == nil)
    }
}
