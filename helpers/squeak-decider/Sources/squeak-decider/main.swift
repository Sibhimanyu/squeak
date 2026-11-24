import DeciderCore
import Foundation

// One request on stdin, one response on stdout. Always exits 0: the host reads `ok` / `unavailable`.
let input = FileHandle.standardInput.readDataToEndOfFile()
let response = await Handler.handle(input, backend: AppleBackend())
FileHandle.standardOutput.write(response.encoded())
FileHandle.standardOutput.write(Data("\n".utf8))
