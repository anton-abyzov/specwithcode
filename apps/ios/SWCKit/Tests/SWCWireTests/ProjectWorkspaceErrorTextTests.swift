import Testing
import SWCWire

@Suite struct ProjectWorkspaceErrorTextTests {
  private func error(_ fields: [String: JSONValue]) -> ServerError {
    ServerError.from(causes: [.fail(.object(["_tag": .string("ProjectWorkspaceError")].merging(fields) { $1 }))])
  }

  @Test func showsTheReasonTheServerSent() {
    let refused = error(["code": .string("provider_unavailable"), "detail": .string("Copilot is not installed on this machine.")])
    #expect(refused.kind == .projectWorkspace(code: "provider_unavailable"))
    #expect(refused.message == "Copilot is not installed on this machine.")
  }

  @Test func aServerWithoutDetailStillGetsASentence() {
    let refused = error(["code": .string("provider_unavailable")])
    #expect(refused.message.hasPrefix("The coordinator's model can't run on that machine."))
    #expect(!refused.message.contains("provider_unavailable"))
  }
}
