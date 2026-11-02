// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "streams",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "streams", path: "Sources/streams")]
)
