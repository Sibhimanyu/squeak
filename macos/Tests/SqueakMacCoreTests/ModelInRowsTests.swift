import Foundation
import Testing
@testable import SqueakMacCore

@Suite("The model in the working row and subagent rows")
struct ModelInRowsTests {
    private static let catalogue = [
        DaemonChatModel(id: "claude-opus-5-1", agent: "claude", label: "Opus 5.1", levels: []),
        DaemonChatModel(id: "claude-opus-5-5[1m]", agent: "claude", label: "Opus 5.5 · 1M", levels: []),
        DaemonChatModel(id: "claude-opus-5-5", agent: "claude", label: "Opus 5.5", levels: []),
        DaemonChatModel(id: "claude-sonnet-5-5", agent: "claude", label: "Sonnet 5.5", levels: []),
        DaemonChatModel(id: "gpt-6.1-sol", agent: "codex", label: "GPT 6.1 Sol", levels: []),
    ]

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

    @Test("A subagent alias is the newest plain model of its family; unknowns and inherit")
    func alias() {
        let c = Self.catalogue
        #expect(ModelNames.subagentLabel(alias: "opus", in: c) == "Opus 5.5")
        #expect(ModelNames.subagentLabel(alias: "Sonnet", in: c) == "Sonnet 5.5")
        #expect(ModelNames.subagentLabel(alias: "haiku", in: c) == "Haiku")
        #expect(ModelNames.subagentLabel(alias: "haiku", in: []) == "Haiku")
        #expect(ModelNames.subagentLabel(alias: "claude-sonnet-4-5", in: c) == "Sonnet 4.5")
        #expect(ModelNames.subagentLabel(alias: "inherit", in: c) == nil)
        #expect(ModelNames.subagentLabel(alias: nil, in: c) == nil)
        #expect(ModelNames.subagentLabel(alias: "", in: c) == nil)
    }

    @Test("A native Agent call names its model in the row's text, and the row reads it back")
    func nativeLabel() {
        let input = NativeJSON.object(["description": .string("Ship 2.23.9"), "model": .string("sonnet")])
        #expect(NativeTranscript.claudeLabel("Agent", input) == "Start [sonnet] Ship 2.23.9")
        let bare = NativeJSON.object(["description": .string("Ship 2.23.9")])
        #expect(NativeTranscript.claudeLabel("Task", bare) == "Start Ship 2.23.9")
    }

    @Test("Agent row label with and without a model")
    func agentRow() {
        let c = Self.catalogue
        let own = ToolCallLabel.preview("Start [sonnet] Ship 2.23.9 (daemon + host)")
        #expect(own.modelAlias == "sonnet")
        #expect(own.target == "Ship 2.23.9 (daemon + host)")
        #expect(own.agentRowLabel(chatModelName: "Opus 5.5 · 1M", in: c) == "Agent · Sonnet 5.5 Ship 2.23.9 (daemon + host)")
        // No model on the call: it runs on the chat's.
        let same = ToolCallLabel.preview("Start Ship it")
        #expect(same.agentRowLabel(chatModelName: "Opus 5.5 · 1M", in: c) == "Agent · Opus 5.5 · 1M Ship it")
        // Neither known: no model at all.
        #expect(same.agentRowLabel(chatModelName: nil, in: c) == "Agent Ship it")
        #expect(ToolCallLabel.preview("Start [inherit] x").agentModel(chatModelName: "Opus 5.5", in: c) == "Opus 5.5")
        // Other rows never carry one.
        #expect(ToolCallLabel.preview("Read a.swift").agentModel(chatModelName: "Opus 5.5", in: c) == nil)
        #expect(ToolCallLabel.preview("Start Ship it").shownVerb == "Duckling")
    }
}
