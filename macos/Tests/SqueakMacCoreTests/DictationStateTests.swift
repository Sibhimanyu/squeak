import Testing
@testable import SqueakMacCore

@Suite struct DictationStateTests {
    @Test func startsOnlyWhenIdle() {
        var s = DictationState()
        let first = s.start()
        #expect(first)
        #expect(s.phase == .requesting)
        let second = s.start()
        #expect(!second)
        s.permissionGranted()
        #expect(s.phase == .recording)
        let third = s.start()
        #expect(!third)
        #expect(s.showsMeter)
    }

    @Test func deniedShowsItsPaneAndCanRetry() {
        var s = DictationState()
        s.start()
        s.permissionDenied(.microphone)
        #expect(s.phase == .denied(.microphone))
        #expect(s.notice == DictationPermission.microphone.message)
        #expect(DictationPermission.microphone.settingsURL.hasSuffix("Privacy_Microphone"))
        #expect(DictationPermission.speechRecognition.settingsURL.hasSuffix("Privacy_SpeechRecognition"))
        let again = s.start()
        #expect(again)
    }

    @Test func partialsReplaceAndFinishReturnsFinalText() {
        var s = DictationState()
        s.start(); s.permissionGranted()
        s.gotPartial("hello"); s.gotPartial("hello wor")
        #expect(s.partial == "hello wor")
        s.stop()
        #expect(s.phase == .finishing)
        let out = s.finish(finalText: " hello world ")
        #expect(out == "hello world")
        #expect(s.phase == .idle)
        #expect(s.partial.isEmpty)
    }

    @Test func finishFallsBackToPartialAndEmptyIsNil() {
        var s = DictationState()
        s.start(); s.permissionGranted(); s.gotPartial("kept"); s.stop()
        let kept = s.finish(finalText: nil)
        #expect(kept == "kept")
        s.start(); s.permissionGranted(); s.stop()
        let none = s.finish(finalText: "  ")
        #expect(none == nil)
    }

    @Test func cancelKeepsNothingAndLateEventsAreIgnored() {
        var s = DictationState()
        s.start(); s.permissionGranted(); s.gotPartial("secret")
        s.cancel()
        #expect(s.phase == .idle)
        s.gotPartial("late")
        #expect(s.partial.isEmpty)
        let late = s.finish(finalText: "late")
        #expect(late == nil)
        s.permissionGranted()
        #expect(s.phase == .idle)
    }

    @Test func failureNeedsAnActiveSessionAndDismisses() {
        var s = DictationState()
        s.fail("x")
        #expect(s.phase == .idle)
        s.start(); s.permissionGranted(); s.fail("The recogniser stopped.")
        #expect(s.phase == .failed("The recogniser stopped."))
        s.dismiss()
        #expect(s.phase == .idle)
    }

    @Test func serverRecognitionIsNoted() {
        var s = DictationState()
        s.start(); s.recognitionRunsOnServer(); s.permissionGranted()
        #expect(s.notice == DictationState.serverNote)
    }

    @Test func stopWhileRequestingCancels() {
        var s = DictationState()
        s.start(); s.stop()
        #expect(s.phase == .idle)
    }

    @Test func appendAndLevel() {
        #expect(DictationState.append("hi", to: "") == "hi")
        #expect(DictationState.append("hi", to: "a") == "a hi")
        #expect(DictationState.append("hi", to: "a ") == "a hi")
        #expect(DictationState.append("", to: "a") == "a")
        #expect(DictationState.level(decibels: -80) == 0)
        #expect(DictationState.level(decibels: 0) == 1)
        #expect(DictationState.level(decibels: -30) == 0.5)
        #expect(DictationState.level(decibels: -.infinity) == 0)
    }
}
