import Foundation
import SWCSync

/// Short "2m" style durations for list rows, plus a spoken form for VoiceOver.
nonisolated enum Elapsed {
  static func short(since date: Date, now: Date = .now) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    switch seconds {
    case ..<60: return "<1m"
    case ..<3_600: return "\(seconds / 60)m"
    case ..<86_400: return "\(seconds / 3_600)h"
    case ..<604_800: return "\(seconds / 86_400)d"
    default: return "\(seconds / 604_800)w"
    }
  }

  static func spoken(since date: Date, now: Date = .now) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    func unit(_ value: Int, _ name: String) -> String { "\(value) \(name)\(value == 1 ? "" : "s")" }
    switch seconds {
    case ..<60: return "less than a minute"
    case ..<3_600: return unit(seconds / 60, "minute")
    case ..<86_400: return unit(seconds / 3_600, "hour")
    case ..<604_800: return unit(seconds / 86_400, "day")
    default: return unit(seconds / 604_800, "week")
    }
  }
}

/// A project's threads split the way the overview shows them.
nonisolated struct ThreadGroups: Equatable {
  /// Waiting for an answer, or failed.
  var needsYou: [ThreadSummary] = []
  var working: [ThreadSummary] = []
  var idle: [ThreadSummary] = []
  var resolved: [ThreadSummary] = []

  init(_ threads: [ThreadSummary], query: String = "") {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let order: (ThreadSummary, ThreadSummary) -> Bool = {
      if $0.isPinned != $1.isPinned { return $0.isPinned }
      if $0.activityAt != $1.activityAt { return $0.activityAt > $1.activityAt }
      return ($0.ref.environmentId, $0.ref.threadId) < ($1.ref.environmentId, $1.ref.threadId)
    }
    for thread in threads.sorted(by: order) where needle.isEmpty || thread.matches(needle) {
      if thread.isUnknown || !thread.machineOnline {
        if thread.isResolved { resolved.append(thread) } else { idle.append(thread) }
      }
      else if thread.activity == .needsYou { needsYou.append(thread) }
      else if thread.activity == .working { working.append(thread) }
      else if thread.waitsOnUser { needsYou.append(thread) }
      else if thread.isResolved { resolved.append(thread) }
      else {
        switch thread.activity {
        case .needsYou, .failed: needsYou.append(thread)
        case .working: working.append(thread)
        case .idle: idle.append(thread)
        }
      }
    }
  }

  var isEmpty: Bool { needsYou.isEmpty && working.isEmpty && idle.isEmpty && resolved.isEmpty }
}

/// Drawer search over projects and threads.
nonisolated struct SearchResults: Equatable {
  var projects: [ProjectSummary]
  var threads: [ThreadSummary]

  init(query: String, projects: [ProjectSummary], threads: [ThreadSummary], threadLimit: Int = 30) {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else {
      self.projects = []
      self.threads = []
      return
    }
    self.projects = projects.filter { !$0.archived && $0.title.localizedStandardContains(needle) }
    self.threads = Array(threads.filter { $0.matches(needle) }.prefix(threadLimit))
  }

  var isEmpty: Bool { projects.isEmpty && threads.isEmpty }
}

extension ThreadSummary {
  nonisolated func matches(_ needle: String) -> Bool {
    title.localizedStandardContains(needle)
      || identity.label.localizedStandardContains(needle)
      || (preview?.localizedStandardContains(needle) ?? false)
      || (projectTitle?.localizedStandardContains(needle) ?? false)
  }
}

/// Fixed web addresses the app links to.
nonisolated enum AppLinks {
  /// The privacy policy (App Store Guideline 5.1.1(i)); the same URL goes in
  /// App Store Connect.
  static let privacyPolicy = URL(string: "https://spec-weave.com/privacy")!
}

/// User defaults the screens and the app shell share.
nonisolated enum AppDefaults {
  /// The name computers list this phone by; the app reads it at each pairing.
  static let deviceLabel = "deviceLabel"
}

/// A specwithcode:// link the app was opened with.
nonisolated enum DeepLink: Equatable, Sendable {
  /// specwithcode://pair?link=<encoded pairing link>
  case pair(link: String?)
  /// specwithcode://thread/<environmentId>/<threadId>
  case thread(ThreadRef)

  init?(url: URL) {
    guard url.scheme?.lowercased() == "specwithcode" else { return nil }
    let parts = url.pathComponents.filter { $0 != "/" }
    switch url.host()?.lowercased() {
    case "pair":
      // `pairingUrl` is the name the desktop's wrapper links use.
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let link = (items.first { $0.name == "link" } ?? items.first { $0.name == "pairingUrl" })?.value?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      self = .pair(link: link?.isEmpty == false ? link : nil)
    case "thread":
      guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
      self = .thread(ThreadRef(environmentId: parts[0], threadId: parts[1]))
    default:
      return nil
    }
  }
}

/// Screens a launch argument can open, for screenshots and UI tests.
nonisolated enum LaunchRoute: String, Sendable, CaseIterable {
  case overview, settings, projectSettings, machines, pair, thread
  /// The drawer, open over the home screen.
  case drawer
  /// The drawer with search open.
  case search
  /// The first project's coordinator chat.
  case coordinator
  /// The first project's orchestrator on a machine other than its
  /// coordinator's, as picked in the switcher.
  case orchestrator
}

/// Options read from launch arguments:
/// `-SWCFixture [default|empty|running|fleet|m4-blip|minis-blip]`, `-SWCAppearance light|dark|system`,
/// `-SWCRoute overview|settings|projectSettings|machines|pair|thread|drawer|search|coordinator|orchestrator`.
nonisolated struct LaunchOptions: Equatable, Sendable {
  var fixture: FixtureScenario?
  var appearance: AppearancePreference?
  var route: LaunchRoute?

  static func parse(_ arguments: [String]) -> LaunchOptions {
    var options = LaunchOptions()
    for (index, argument) in arguments.enumerated() {
      let next = index + 1 < arguments.count ? arguments[index + 1] : nil
      switch argument {
      case "-SWCFixture":
        options.fixture = next.flatMap { FixtureScenario(rawValue: $0.lowercased()) } ?? .default
      case "-SWCAppearance":
        options.appearance = next.flatMap { AppearancePreference(rawValue: $0.lowercased()) }
      case "-SWCRoute":
        options.route = next.flatMap { value in LaunchRoute.allCases.first { $0.rawValue.lowercased() == value.lowercased() } }
      default:
        break
      }
    }
    return options
  }
}
