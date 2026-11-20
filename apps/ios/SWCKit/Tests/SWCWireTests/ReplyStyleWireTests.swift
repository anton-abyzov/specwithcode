import Foundation
import Testing
@testable import SWCWire

/// `responseStyle` and its per-project overrides in `server.getSettings`, and
/// the per-key project edit in `server.updateSettings`
/// (packages/contracts/src/settings.ts).
@Suite struct ReplyStyleWireTests {
  func settings(_ json: String) throws -> ServerSettings {
    try JSONDecoder().decode(ServerSettings.self, from: Data(json.utf8))
  }

  @Test func decodesTheMachinesStyleAndEachProjectsOwn() throws {
    let decoded = try settings(#"""
    {"providerInstances":{},"responseStyle":"detailed",
     "projectSettingsOverrides":{"p1":{"responseStyle":"concise","defaultAutoPull":true},"p2":{"defaultRuntimeMode":"auto"}}}
    """#)
    #expect(decoded.responseStyle == .detailed)
    #expect(decoded.projectSettingsOverrides["p1"]?.responseStyle == .concise)
    #expect(decoded.projectSettingsOverrides["p2"] == ProjectSettingsOverrides())
  }

  @Test func anOlderServerOrAnUnknownValueLeavesItUnknown() throws {
    let old = try settings(#"{"providerInstances":{}}"#)
    #expect(old.responseStyle == nil)
    #expect(old.projectSettingsOverrides.isEmpty)
    let newer = try settings(#"{"providerInstances":{},"responseStyle":"verbose","projectSettingsOverrides":{"p1":{"responseStyle":"poetic"},"p2":7}}"#)
    #expect(newer.responseStyle == nil)
    #expect(newer.projectSettingsOverrides["p1"]?.responseStyle == nil)
    #expect(newer.projectSettingsOverrides["p2"] == nil)
  }

  @Test func encodesAPerKeyProjectChange() throws {
    let patch = ServerSettingsPatch(projectSettingsOverrideChanges: [
      "p1": ProjectSettingsOverrideChange(set: ProjectSettingsOverrides(responseStyle: .detailed)),
    ])
    #expect(!patch.isEmpty)
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let json = String(decoding: try encoder.encode(UpdateServerSettingsInput(patch: patch)), as: UTF8.self)
    #expect(json == #"{"patch":{"projectSettingsOverrideChanges":{"p1":{"set":{"responseStyle":"detailed"}}}}}"#)
    let clear = ServerSettingsPatch(projectSettingsOverrideChanges: ["p1": ProjectSettingsOverrideChange(clear: ["responseStyle"])])
    #expect(String(decoding: try encoder.encode(clear), as: UTF8.self) == #"{"projectSettingsOverrideChanges":{"p1":{"clear":["responseStyle"]}}}"#)
  }

  @Test func thePatchRoundTrips() throws {
    let patch = ServerSettingsPatch(projectSettingsOverrideChanges: ["p1": ProjectSettingsOverrideChange(set: ProjectSettingsOverrides(responseStyle: .concise))])
    let decoded = try JSONDecoder().decode(ServerSettingsPatch.self, from: JSONEncoder().encode(patch))
    #expect(decoded == patch)
  }
}
