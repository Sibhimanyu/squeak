import Foundation
import NaturalLanguage
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device pieces: NLEmbedding sentence vectors and the FoundationModels system model.
public struct AppleBackend: Backend {
    public init() {}

    /// Raw sentence-embedding cosines sit high even for unrelated text; this maps them onto the 0..1 scale the decider's
    /// bands read (about 0.5 = clearly related).
    public static func scale(_ cosine: Double) -> Double { max(0, min(1, (cosine - floorCosine) / (ceilingCosine - floorCosine))) }
    static let floorCosine = 0.5
    static let ceilingCosine = 0.9

    public func embed(task: String, texts: [String]) -> [Double]? {
        guard let model = NLEmbedding.sentenceEmbedding(for: .english), let t = model.vector(for: task) else { return nil }
        return texts.map { text in
            guard let v = model.vector(for: text) else { return 0 }
            return Self.scale(Handler.cosine(t, v))
        }
    }

    public func generate(system: String, prompt: String) async -> Result<String, Unavailable> {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            let model = SystemLanguageModel.default
            guard case .available = model.availability else {
                return .failure(Unavailable("Apple Intelligence is not available on this Mac"))
            }
            do {
                let session = LanguageModelSession(model: model, instructions: system)
                let out = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0, maximumResponseTokens: 20))
                return .success(out.content)
            } catch {
                return .failure(Unavailable("on-device model failed: \(error.localizedDescription)"))
            }
        }
        #endif
        return .failure(Unavailable("on-device model needs macOS 26"))
    }
}
