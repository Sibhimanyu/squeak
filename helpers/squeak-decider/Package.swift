// swift-tools-version: 6.0
import PackageDescription

// squeak-decider: the on-device helper the session host calls (stdin/stdout JSON, one request per run).
// `embed` = Apple NaturalLanguage sentence embeddings; `decide` = Apple FoundationModels. The Mac app bundles it.
let package = Package(
    name: "squeak-decider",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "DeciderCore"),
        .executableTarget(name: "squeak-decider", dependencies: ["DeciderCore"]),
        .testTarget(name: "DeciderCoreTests", dependencies: ["DeciderCore"]),
    ],
    swiftLanguageModes: [.v6]
)
