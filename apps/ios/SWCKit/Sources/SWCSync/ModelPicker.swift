import Foundation
import SWCWire

/// How the phone's model picker lays a thread's models out and what a search
/// finds. Pure data and string functions, as the desktop picker's
/// `modelSearchIntents` and `modelSearchGroups`: the model the thread runs on
/// and its family come first, then recent picks, then every provider.
public enum ModelPicker {
  /// A model apart from who serves it: "Claude Opus 5.5" and "Opus 5.5" are
  /// one family, as are "Wonder 1.0" and "Wonder Full 1.0".
  public struct Identity: Hashable, Sendable {
    /// The name without version, vendor or variant words ("opus", "gpt sol").
    public var family: String
    public var version: [Int]
  }

  /// One provider's models, as a section of the list.
  public struct ProviderGroup: Identifiable, Hashable, Sendable {
    public var id: String { instanceId }
    public var instanceId: String
    public var provider: String
    public var brand: String?
    public var models: [ModelChoice]
  }

  public struct Layout: Hashable, Sendable {
    /// "Opus", or nil when the picked model is the only one of its family.
    public var familyTitle: String?
    /// The picked model first, then its family: this provider's, then others'.
    public var family: [ModelChoice]
    public var recent: [ModelChoice]
    /// The picked model's provider first, the rest in catalog order.
    public var providers: [ProviderGroup]
  }

  public struct SearchResult: Hashable, Sendable {
    public var matches: [ModelChoice]
    /// Nothing matched as typed; these are within a typo of it.
    public var isClosest: Bool
    /// The words matched against names and providers, for highlighting.
    public var words: [String]
    /// Capability filters the query named ("Fast", "1M context").
    public var filters: [String]
  }

  /// How many recent picks the list offers.
  public static let recentLimit = 3
  /// How many rows lead the list, the picked model included; the rest of a
  /// large family stays under its providers and in search.
  public static let familyLimit = 4

  // MARK: Identity

  /// Vendor words providers put before a model name ("Anthropic: Claude Opus 5.5").
  private static let vendorWords: Set<String> = ["anthropic", "claude", "openai", "google", "xai", "x-ai", "meta"]
  /// A stronger variant of the same line sits with its base ("Wonder Full").
  private static let variantWords: Set<String> = ["full", "max", "pro"]

  private static func isVersion(_ word: String) -> Bool {
    !word.isEmpty && word.first!.isNumber && word.allSatisfy { $0.isNumber || $0 == "." }
  }

  /// Lowercased name words: runs of letters and digits, versions kept whole ("5.5").
  static func nameWords(_ name: String) -> [String] {
    name.lowercased()
      .split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == ".") })
      .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
      .filter { !$0.isEmpty }
  }

  /// The words of a name that say which family it is, lowercased.
  private static func familyWords(_ words: [String]) -> [String] {
    let named = words.filter { !isVersion($0) }
    // "Claude" alone stays a name; only a vendor in front of another name is dropped.
    let withoutVendor = named.filter { !vendorWords.contains($0) }
    let base = withoutVendor.isEmpty ? named : withoutVendor
    let withoutVariant = base.filter { !variantWords.contains($0) }
    return withoutVariant.isEmpty ? base : withoutVariant
  }

  public static func identity(of choice: ModelChoice) -> Identity {
    let words = nameWords(choice.name)
    let family = familyWords(words).joined(separator: " ")
    var version = words.first(where: isVersion)?.split(separator: ".").compactMap { Int($0) } ?? []
    // "5" and "5.0" are one release.
    while version.last == 0 { version.removeLast() }
    return Identity(family: family.isEmpty ? choice.slug.lowercased() : family, version: version)
  }

  /// The family as the name writes it: "Opus", "GPT Sol".
  static func familyTitle(of choice: ModelChoice) -> String {
    let keep = Set(familyWords(nameWords(choice.name)))
    let written = choice.name.split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == ".") }).map(String.init)
    let title = written.filter { keep.contains($0.lowercased()) }.joined(separator: " ")
    return title.isEmpty ? choice.name : title
  }

  private static func newer(_ a: [Int], than b: [Int]) -> Bool {
    for index in 0..<max(a.count, b.count) {
      let left = index < a.count ? a[index] : 0
      let right = index < b.count ? b[index] : 0
      if left != right { return left > right }
    }
    return false
  }

  // MARK: Layout

  public static func layout(_ choices: [ModelChoice], selectedId: String?, recentIds: [String] = []) -> Layout {
    let selected = choices.first { $0.id == selectedId }
    var family: [ModelChoice] = []
    var title: String?
    if let selected {
      let own = identity(of: selected)
      let relatives = choices.enumerated().filter { $0.element.id != selected.id && identity(of: $0.element).family == own.family }
      // This provider's own first, then newer versions first, then catalog order.
      let ordered = relatives.sorted { a, b in
        let aHere = a.element.instanceId == selected.instanceId, bHere = b.element.instanceId == selected.instanceId
        if aHere != bHere { return aHere }
        let aVersion = identity(of: a.element).version, bVersion = identity(of: b.element).version
        if aVersion != bVersion { return newer(aVersion, than: bVersion) }
        return a.offset < b.offset
      }
      family = Array(([selected] + ordered.map(\.element)).prefix(familyLimit))
      if family.count > 1 { title = familyTitle(of: selected) }
    }
    let shown = Set(family.map(\.id))
    var recent: [ModelChoice] = []
    for id in recentIds where !shown.contains(id) {
      guard recent.count < recentLimit, !recent.contains(where: { $0.id == id }), let choice = choices.first(where: { $0.id == id }) else { continue }
      recent.append(choice)
    }
    var groups = ModelChoice.grouped(choices).map {
      ProviderGroup(instanceId: $0.instanceId, provider: $0.provider, brand: $0.models.first?.brand, models: $0.models)
    }
    if let selected, let index = groups.firstIndex(where: { $0.instanceId == selected.instanceId }), index > 0 {
      groups.insert(groups.remove(at: index), at: 0)
    }
    return Layout(familyTitle: title, family: family, recent: recent, providers: groups)
  }

  /// A pick put at the front of the recent list, which keeps a few more than it shows.
  public static func remembering(_ id: String, in recentIds: [String]) -> [String] {
    Array(([id] + recentIds.filter { $0 != id }).prefix(recentLimit * 2))
  }

  // MARK: Search

  private enum Capability: String {
    case cheap, fast, smart, long, latest

    var label: String {
      switch self {
      case .cheap: "Cheap"
      case .fast: "Fast"
      case .smart: "Smartest"
      case .long: "1M context"
      case .latest: "Latest"
      }
    }
  }

  /// The capability words the phone can answer from a model's name and
  /// options. The desktop's "local", "free", "images" and "new" need billing
  /// and capability facts the phone is not sent, so here they are plain text.
  private static let capabilityWords: [String: Capability] = [
    "cheap": .cheap, "fast": .fast, "smart": .smart, "best": .smart, "1m": .long, "long": .long, "latest": .latest,
  ]
  private static let smallWords: Set<String> = ["haiku", "mini", "nano", "flash", "lite", "small", "tiny", "spark"]
  private static let largeWords: Set<String> = ["opus", "fable", "sol", "max", "ultra", "carbon", "pro", "heavy"]
  /// Vendor names that stand for the families the vendor makes.
  private static let vendorFamilies: [String: [String]] = [
    "anthropic": ["claude", "opus", "sonnet", "haiku", "fable"],
    "openai": ["gpt", "codex", "sol", "o3", "o4"],
    "google": ["gemini", "carbon", "gemma"],
    "xai": ["grok"],
    "meta": ["llama", "wonder"],
    "deepseek": ["deepseek"],
    "mistral": ["mistral", "codestral", "devstral"],
  ]
  /// Vendor names that stand for a provider ("github" for a Copilot instance).
  private static let vendorProviders: [String: [String]] = [
    "github": ["copilot"], "microsoft": ["copilot"], "anthropic": ["claude"], "openai": ["codex"],
    "google": ["gemini", "antigravity"], "xai": ["grok"], "meta": ["muse"],
  ]

  private struct Entry {
    var choice: ModelChoice
    var index: Int
    var words: [String]
    var providerWords: [String]
    var haystacks: [String]
    var identity: Identity
    var isLatest: Bool
  }

  private static func entries(_ choices: [ModelChoice]) -> [Entry] {
    let identities = choices.map(identity(of:))
    var newest: [String: [Int]] = [:]
    for id in identities {
      if let known = newest[id.family], !newer(id.version, than: known) { continue }
      newest[id.family] = id.version
    }
    return choices.enumerated().map { index, choice in
      Entry(
        choice: choice,
        index: index,
        words: nameWords("\(choice.name) \(choice.slug)"),
        providerWords: nameWords("\(choice.provider) \(choice.instanceId)"),
        haystacks: ([choice.name, choice.slug] + choice.aliases).map { $0.lowercased() },
        identity: identities[index],
        isLatest: newest[identities[index].family] == identities[index].version
      )
    }
  }

  private static func has(_ capability: Capability, _ entry: Entry) -> Bool {
    let small = entry.words.contains(where: smallWords.contains)
    let large = !small && entry.words.contains(where: largeWords.contains)
    switch capability {
    case .cheap: return small
    case .fast: return small || entry.choice.descriptors.contains { $0.id.lowercased().contains("fast") }
    case .smart: return large && entry.isLatest
    case .latest: return entry.isLatest
    case .long:
      if entry.words.contains("1m") { return true }
      return entry.choice.descriptors.contains { descriptor in
        guard case let .select(options) = descriptor.kind else { return false }
        return options.contains { nameWords("\($0.id) \($0.label)").contains("1m") }
      }
    }
  }

  /// Whether one typed word finds a model: inside its name, slug or an alias,
  /// at the start of a provider word, or as the vendor of either.
  private static func matches(_ word: String, _ entry: Entry) -> Bool {
    if entry.haystacks.contains(where: { $0.contains(word) }) { return true }
    if entry.providerWords.contains(where: { $0.hasPrefix(word) }) { return true }
    guard word.count >= 3 else { return false }
    for (vendor, families) in vendorFamilies where vendor.hasPrefix(word) {
      if families.contains(where: entry.words.contains) { return true }
    }
    for (vendor, names) in vendorProviders where vendor.hasPrefix(word) {
      if names.contains(where: { name in entry.providerWords.contains { $0.contains(name) } }) { return true }
    }
    return false
  }

  /// What a query finds, the picked model's provider first among equals. An
  /// empty query finds nothing: the picker shows its sections instead.
  public static func search(_ query: String, in choices: [ModelChoice], selectedId: String? = nil) -> SearchResult {
    let tokens = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    guard !tokens.isEmpty else { return SearchResult(matches: [], isClosest: false, words: [], filters: []) }
    let all = entries(choices)
    var words: [String] = []
    var capabilities: [(word: String, capability: Capability)] = []
    for token in tokens {
      if let capability = capabilityWords[token] {
        if !capabilities.contains(where: { $0.capability == capability }) { capabilities.append((token, capability)) }
      } else if !words.contains(token) {
        words.append(token)
      }
    }
    let home = choices.first { $0.id == selectedId }?.instanceId
    // A capability word also finds a model that carries the word in its name ("Grok 4.7 Fast").
    let capable = all.filter { entry in
      capabilities.allSatisfy { has($0.capability, entry) || entry.words.contains($0.word) }
    }
    func ranked(_ found: [(entry: Entry, score: Int)]) -> [ModelChoice] {
      found.sorted { a, b in
        if a.score != b.score { return a.score < b.score }
        let aHome = a.entry.choice.instanceId == home, bHome = b.entry.choice.instanceId == home
        if aHome != bHome { return aHome }
        return a.entry.index < b.entry.index
      }.map(\.entry.choice)
    }
    let filters = capabilities.map(\.capability.label)
    let exact = capable.filter { entry in words.allSatisfy { matches($0, entry) } }.map { entry in
      // A word that starts a name word outranks one found inside it.
      (entry: entry, score: words.allSatisfy { word in entry.words.contains { $0.hasPrefix(word) } } ? 0 : 1)
    }
    if !exact.isEmpty || words.isEmpty {
      return SearchResult(matches: ranked(exact), isClosest: false, words: words, filters: filters)
    }
    var close: [(entry: Entry, score: Int)] = []
    for entry in capable {
      var total = 0
      var near = true
      for word in words where !matches(word, entry) {
        guard let distance = closestWordDistance(word, entry.words + entry.providerWords) else { near = false; break }
        total += distance
      }
      if near { close.append((entry, total)) }
    }
    return SearchResult(matches: ranked(close), isClosest: !close.isEmpty, words: words, filters: filters)
  }

  /// The parts of a name or provider a search matched, for highlighting.
  public static func highlights(in text: String, words: [String]) -> [Range<String.Index>] {
    var ranges: [Range<String.Index>] = []
    for word in words where !word.isEmpty {
      var start = text.startIndex
      while start < text.endIndex, let range = text.range(of: word, options: [.caseInsensitive], range: start..<text.endIndex) {
        ranges.append(range)
        start = range.upperBound
      }
    }
    return ranges
  }

  // MARK: Typos

  /// Damerau-Levenshtein distance (adjacent transpositions count once), or nil
  /// once it exceeds `max`.
  static func boundedEditDistance(_ a: String, _ b: String, max: Int) -> Int? {
    let a = Array(a), b = Array(b)
    if abs(a.count - b.count) > max { return nil }
    var twoBack: [Int] = []
    var previous = Array(0...b.count)
    for i in stride(from: 1, through: a.count, by: 1) {
      var current = [i]
      var rowMin = i
      for j in stride(from: 1, through: b.count, by: 1) {
        let cost = a[i - 1] == b[j - 1] ? 0 : 1
        var value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
        if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1] {
          value = min(value, twoBack[j - 2] + 1)
        }
        current.append(value)
        rowMin = min(rowMin, value)
      }
      if rowMin > max { return nil }
      twoBack = previous
      previous = current
    }
    return previous[b.count] <= max ? previous[b.count] : nil
  }

  /// The distance from a typed word to the closest of a model's words, within
  /// one edit, or two for seven or more characters. Words under three
  /// characters and versions are never guessed at.
  static func closestWordDistance(_ word: String, _ candidates: [String]) -> Int? {
    guard word.count >= 3, !isVersion(word) else { return nil }
    let budget = word.count >= 7 ? 2 : 1
    var best: Int?
    for candidate in candidates where candidate.count >= 3 {
      // A typed prefix of a longer word is compared against the same length.
      let target = candidate.count > word.count + budget ? String(candidate.prefix(word.count)) : candidate
      if let distance = boundedEditDistance(word, target, max: budget), best.map({ distance < $0 }) ?? true { best = distance }
    }
    return best
  }
}
