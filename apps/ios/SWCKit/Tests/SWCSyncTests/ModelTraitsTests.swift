import Foundation
import Testing
@testable import SWCSync
import SWCWire

@Suite struct ModelTraitsTests {
  /// Opus's options as the server lists them in `providers[].models[].capabilities`.
  static let modelJSON = """
  {"slug":"claude-opus-5-5","name":"Claude Opus 5.5","isCustom":false,"capabilities":{"optionDescriptors":[
    {"id":"contextWindow","label":"Context window","type":"select","options":[{"id":"200k","label":"200K"},{"id":"1m","label":"1M","isDefault":true}]},
    {"id":"effort","label":"Reasoning","type":"select","options":[{"id":"low","label":"Low"},{"id":"high","label":"High","isDefault":true},{"id":"xhigh","label":"xhigh"}]},
    {"id":"ultracode","label":"Ultracode","description":"Multi-agent workflows on every task, at any effort","type":"boolean"},
    {"id":"thinking","label":"Thinking","type":"boolean","currentValue":true},
    {"id":"fastMode","label":"Fast Mode","type":"boolean"},
    {"id":"future","label":"Future","type":"slider"}
  ]}}
  """

  static func descriptors() throws -> [ProviderOptionDescriptor] {
    try JSONDecoder().decode(ServerProviderModel.self, from: Data(modelJSON.utf8)).optionDescriptors
  }

  @Test func decodesTheModelsOptionsAndSkipsUnknownKinds() throws {
    let descriptors = try Self.descriptors()
    #expect(descriptors.map(\.id) == ["contextWindow", "effort", "ultracode", "thinking", "fastMode"])
    #expect(descriptors[3].currentValue == .bool(true))
  }

  @Test func summaryReadsAsTheDesktopChip() throws {
    let selection = ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5", options: [
      ModelOption(id: "effort", value: .string("xhigh")),
      ModelOption(id: "ultracode", value: .bool(true)),
      ModelOption(id: "fastMode", value: .bool(true)),
    ])
    let traits = ModelTraits(selection: selection, descriptors: try Self.descriptors())
    // The raw "xhigh" label gets its display name; Fast joins the effort.
    #expect(traits.summary == "1M · Extra High Fast · Ultracode · Thinking On")
  }

  @Test func unsetOptionsFallBackToTheDefaults() throws {
    let traits = ModelTraits(selection: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5"), descriptors: try Self.descriptors())
    #expect(traits.summary == "1M · High · Thinking On")
    let ultracode = traits.controls.first { $0.id == "ultracode" }
    #expect(ultracode?.kind == .toggle(current: nil))
  }

  @Test func choosingAnOptionKeepsTheOthers() throws {
    let base = ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5", options: [ModelOption(id: "effort", value: .string("low"))])
    let traits = ModelTraits(selection: base, descriptors: try Self.descriptors()).setting("ultracode", to: .bool(true))
    #expect(traits.selection.option("effort") == .string("low"))
    #expect(traits.selection.option("ultracode") == .bool(true))
    let merged = ModelTraits.merging(base, with: [ModelOption(id: "effort", value: .string("high")), ModelOption(id: "fastMode", value: .bool(true))])
    #expect(merged.options == [ModelOption(id: "effort", value: .string("high")), ModelOption(id: "fastMode", value: .bool(true))])
    #expect(merged.instanceId == "claudeAgent" && merged.model == "claude-opus-5-5")
  }
}
