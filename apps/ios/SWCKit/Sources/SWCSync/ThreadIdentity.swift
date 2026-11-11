import Foundation
import SWCWire

/// Saved provider/model identity, enriched by that machine's catalog when available.
/// Unknown/custom ids stay visible; display names never determine a brand.
public struct ThreadIdentity: Hashable, Sendable {
  public var provider: String
  public var model: String
  public var providerBrand: String?
  public var modelBrand: String?
  public var label: String { "\(provider) · \(model)" }
  public static let unknown = ThreadIdentity(provider: "Unknown provider", model: "Unknown model")

  /// The agent's short name for sentences such as "Claude wants to use Notes":
  /// the provider without a trailing "Code" or "CLI". Nil when the provider is unknown.
  public var agentName: String? {
    var name = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name != Self.unknown.provider else { return nil }
    for suffix in [" Code", " CLI"] where name.hasSuffix(suffix) && name.count > suffix.count {
      name.removeLast(suffix.count)
    }
    return name
  }

  public init(provider: String, model: String, providerBrand: String? = nil, modelBrand: String? = nil) {
    self.provider = provider
    self.model = model
    self.providerBrand = providerBrand
    self.modelBrand = modelBrand
  }

  public init(selection: ModelSelection, providers: [ServerProviderSummary]) {
    let catalog = providers.first { $0.instanceId == selection.instanceId }
    let id = catalog?.driver ?? selection.instanceId
    let brand = id == "acpRegistry"
      ? Self.registryBrand(catalog?.iconUrl) ?? Self.localAcpBrand(selection.instanceId)
      : Self.providerBrand(id)
    let names = ["githubCopilot": "GitHub Copilot", "copilot": "GitHub Copilot", "gemini": "Gemini CLI"]
    provider = Self.harnessNames[id]
      ?? catalog?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
      ?? names[id] ?? selection.instanceId
    let catalogued = catalog?.models.first { $0.slug == selection.model || ($0.aliases ?? []).contains(selection.model) }?.name
    var named = catalogued ?? Self.modelName(selection.model)
    // A short name drops "Claude"; through another harness the maker is the point.
    if catalogued == nil, Self.maker(of: provider).caseInsensitiveCompare("Claude") != .orderedSame,
       selection.model.range(of: #"^\s*claude[-_ ]"#, options: [.regularExpression, .caseInsensitive]) != nil,
       !named.lowercased().hasPrefix("claude") {
      named = "Claude " + named
    }
    model = Self.withoutMaker(named, harness: provider)
    providerBrand = brand
    modelBrand = Self.modelBrand(selection.model)
  }

  /// The harness that runs a thread, by its driver, as the desktop names it:
  /// "Claude" alone reads as the model's maker, and a second Claude Code
  /// instance someone named "Claude Max" is still Claude Code in a row.
  static let harnessNames = [
    "claudeAgent": "Claude Code", "codex": "Codex", "cursor": "Cursor", "grok": "Grok", "muse": "Muse Code",
    "pi": "Pi", "opencode": "OpenCode", "antigravity": "Antigravity",
  ]

  /// "Claude Code" is made by Claude, "Gemini CLI" by Gemini.
  static func maker(of harness: String) -> String {
    var maker = harness
    for suffix in [" Code", " CLI"] where maker.hasSuffix(suffix) && maker.count > suffix.count {
      maker.removeLast(suffix.count)
    }
    return maker
  }

  /// "Claude Code · Claude Opus 5.5" says Claude twice: the model drops the
  /// maker its harness already names. "Grok 5" stays whole, since a bare "5"
  /// is a version and not a model.
  static func withoutMaker(_ model: String, harness: String) -> String {
    let maker = Self.maker(of: harness)
    guard !maker.isEmpty, model.count > maker.count + 1,
          model.prefix(maker.count).caseInsensitiveCompare(maker) == .orderedSame,
          model[model.index(model.startIndex, offsetBy: maker.count)] == " " else { return model }
    let rest = model.dropFirst(maker.count + 1).trimmingCharacters(in: .whitespaces)
    return rest.contains(where: \.isLetter) ? rest : model
  }

  static func registryBrand(_ icon: String?) -> String? {
    guard let icon, let url = URLComponents(string: icon), url.scheme == "https",
      url.host == "cdn.agentclientprotocol.com", url.user == nil, url.password == nil, url.port == nil,
      url.path.hasPrefix("/registry/v1/latest/"), url.path.hasSuffix(".svg") else { return nil }
    let agent = String(url.path.dropFirst("/registry/v1/latest/".count).dropLast(4))
    if agent == "github-copilot" || agent == "github-copilot-cli" { return "copilot" }
    if agent == "droid" || agent == "factory-droid" { return "factory" }
    for (prefix, brand) in [("claude", "claude"), ("codex", "openai"), ("openai", "openai"), ("gemini", "gemini"), ("grok", "grok"), ("cursor", "cursor"), ("qwen", "qwen"), ("kimi", "kimi"), ("mistral", "mistral"), ("kiro", "kiro"), ("deepseek", "deepseek")] {
      if agent == prefix || agent.hasPrefix(prefix + "-") { return brand }
    }
    return ["opencode", "goose", "cline", "auggie", "amp", "junie"].contains(agent) ? agent : nil
  }

  /// DeepSeek Harness is not in the ACP Registry, so a local `dsh` instance has no
  /// icon URL; its instance id is all that names it. Copilot never matches here.
  static func localAcpBrand(_ instanceId: String) -> String? {
    instanceId.lowercased().hasPrefix("acpregistry_deepseek") ? "deepseek" : nil
  }

  public static func providerBrand(_ id: String) -> String? {
    switch id.lowercased() {
    case "claudeagent", "claude", "claude-code", "acpregistry_claude-acp": "claude"
    case "codex", "openai": "openai"
    case "githubcopilot", "githubcopilotacp", "copilot", "acpregistry_github-copilot": "copilot"
    case "gemini", "acpregistry_gemini": "gemini"
    case "grok", "acpregistry_grok": "grok"
    case "opencode", "acpregistry_opencode": "opencode"
    case "pi": "pi"
    case "muse": "meta"
    case "cursor", "antigravity", "ollama": id.lowercased()
    default: nil
    }
  }

  public static func modelBrand(_ slug: String) -> String? {
    let value = slug.lowercased().split(separator: "/").last.map(String.init) ?? slug.lowercased()
    if value.hasPrefix("claude") || value.hasPrefix("opus") || value.hasPrefix("sonnet") || value.hasPrefix("haiku") || value.hasPrefix("fable") { return "claude" }
    if value.hasPrefix("gpt-") || value.hasPrefix("o3") || value.hasPrefix("o4") { return "openai" }
    if value.hasPrefix("gemini") { return "gemini" }
    if value.hasPrefix("grok") { return "grok" }
    return nil
  }

  /// A model the machine's catalog does not list, as the desktop's `shortModelName`
  /// reads it: `claude-opus-5-5[1m]` is "Opus 5.5", `claude-sonnet-4-5-20250929`
  /// is "Sonnet 4.5", `gpt-6.1-sol` is "GPT-6.1 Sol". Only the Claude and GPT
  /// families are read this way; a custom model keeps its exact identifier.
  static func modelName(_ slug: String) -> String {
    let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "Unknown model" }
    if trimmed.lowercased() == "auto" { return "Auto" }
    var cleaned = trimmed
    // A context-window suffix, a host prefix and a date are noise in a list row.
    for noise in [#"\[[^\]]*\]$"#, #"^[a-z0-9.-]+/"#, #"-(20\d{6}|latest|preview)$"#] {
      if let range = cleaned.range(of: noise, options: [.regularExpression, .caseInsensitive]) { cleaned.removeSubrange(range) }
    }
    var parts: [String] = []
    for part in cleaned.split(whereSeparator: { "-_ ".contains($0) }).map(String.init) {
      // Adjacent bare numbers are one version: 5-5 reads 5.5.
      if let last = parts.last, isDigits(part), isDigits(last) { parts[parts.count - 1] = last + "." + part } else { parts.append(part) }
    }
    guard let head = parts.first?.lowercased(), parts.count > 1 else { return slug }
    let rest = Array(parts.dropFirst())
    if head == "claude" {
      guard let family = rest.first(where: { ["opus", "sonnet", "haiku", "fable"].contains($0.lowercased()) }) else {
        return rest.map(titleWord).joined(separator: " ")
      }
      let version = rest.first { $0.range(of: #"^\d+(\.\d+)?$"#, options: .regularExpression) != nil }
      return [titleWord(family), version].compactMap { $0 }.joined(separator: " ")
    }
    if head == "gpt", rest[0].first?.isNumber == true {
      return (["GPT-" + rest[0]] + rest.dropFirst().map(titleWord)).joined(separator: " ")
    }
    return slug
  }

  private static func isDigits(_ text: String) -> Bool {
    !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
  }

  private static func titleWord(_ word: String) -> String {
    ["gpt", "xl", "ai", "oss"].contains(word.lowercased()) ? word.uppercased() : word.prefix(1).uppercased() + word.dropFirst()
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
