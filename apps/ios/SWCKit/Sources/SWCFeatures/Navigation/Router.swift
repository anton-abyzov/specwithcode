import Observation
import SwiftUI
import SWCSync
import Weave

/// A screen pushed onto a navigation stack.
public nonisolated enum Route: Hashable, Codable, Sendable {
  case chat(ChatTarget)
  case overview(ProjectRef)
  case machines
  case machine(String)
  case pair
  /// "Pair again" for a known machine: a link to any other machine is refused.
  case repair(String)
}

/// A sheet presented over the main screen.
nonisolated enum SheetRoute: Hashable, Identifiable, Sendable {
  case globalSettings
  case projectSettings(ProjectRef)
  case threadInfo(ThreadRef)

  var id: Self { self }
}

/// The path of one navigation stack. The main screen and the settings sheet
/// each have their own; views push through whichever is in the environment.
@Observable
final class StackNavigator {
  var path: [Route] = []

  func push(_ route: Route) { path.append(route) }

  func pop() {
    if !path.isEmpty { path.removeLast() }
  }
}

/// App-wide navigation state: the chat at the root of the main stack, the
/// drawer, sheets, toasts and composer drafts.
@Observable
final class AppRouter {
  let main = StackNavigator()
  /// The chat at the root of the main stack. nil means the default landing.
  var root: ChatTarget?
  var isDrawerOpen = false {
    didSet { if !isDrawerOpen { isDrawerSearching = false } }
  }
  /// Search replaces the drawer list. Closing the drawer ends it.
  var isDrawerSearching = false
  var sheet: SheetRoute?
  var toast: WeaveToastMessage?
  /// Unsent composer text per conversation.
  var drafts: [ChatTarget: String] = [:]
  /// A pairing link from a deep link, picked up by the pairing screen.
  var pairPrefill: String?
  /// Set by a launch argument; cleared when the person picks an appearance.
  var appearanceOverride: AppearancePreference?
  /// Waits until the model has data, then opens the screen.
  var pendingLaunchRoute: LaunchRoute?
  /// The chat whose composer takes focus when it appears.
  var pendingComposerFocus: ChatTarget?

  /// Shows a chat at the root of the main stack and closes the drawer.
  func open(_ target: ChatTarget) {
    root = target
    main.path = []
    isDrawerOpen = false
  }

  /// Pushes a screen onto the main stack and closes the drawer.
  func push(_ route: Route) {
    main.path.append(route)
    isDrawerOpen = false
  }

  func showError(_ error: any Error) {
    toast = WeaveToastMessage(error.localizedDescription, kind: .fail)
  }

  /// The chat to show at the root right now.
  func landing(in model: AppModel) -> ChatTarget? {
    if let root, Self.isValid(root, in: model) { return root }
    return Self.defaultLanding(aide: model.aide, projects: model.projects)
  }

  /// Aide when it exists, otherwise the first project.
  static func defaultLanding(aide: ProjectSummary?, projects: [ProjectSummary]) -> ChatTarget? {
    if let aide, !aide.archived { return .aide(aide.ref) }
    if let first = projects.first(where: { !$0.archived }) { return .project(first.ref) }
    return nil
  }

  static func isValid(_ target: ChatTarget, in model: AppModel) -> Bool {
    switch target {
    case let .aide(ref): model.aide?.ref == ref && model.aide?.archived == false
    case let .project(ref): model.projects.contains { $0.contains(ref) && !$0.archived }
    case let .thread(ref): model.machine(ref.environmentId) != nil
    }
  }

  func handle(_ link: DeepLink) {
    sheet = nil
    isDrawerOpen = false
    switch link {
    case let .pair(prefill):
      pairPrefill = prefill
      main.path = [.pair]
    case let .thread(ref):
      main.path = [.chat(.thread(ref))]
    }
  }

  /// Opens the launch-argument screen once the model can back it. Returns
  /// true when there is nothing left to do.
  @discardableResult
  func applyLaunchRoute(in model: AppModel) -> Bool {
    guard let route = pendingLaunchRoute else { return true }
    switch route {
    case .settings:
      sheet = .globalSettings
    case .pair:
      main.path = [.pair]
    case .machines:
      guard !model.machines.isEmpty || !model.isLoading else { return false }
      main.path = [.machines]
    case .drawer, .search:
      guard !model.isLoading else { return false }
      if !model.machines.isEmpty {
        isDrawerOpen = true
        isDrawerSearching = route == .search
      }
    case .overview, .projectSettings, .thread, .coordinator, .orchestrator:
      guard !model.isLoading else { return false }
      let first = model.projects.first { !$0.archived }
      let project = first?.ref ?? model.aide?.ref
      switch route {
      case .overview:
        if let project { main.path = [.overview(project)] }
      case .projectSettings:
        if let project { sheet = .projectSettings(project) }
      // Switching orchestrators changes the root chat, as the switcher does.
      case .coordinator:
        if let first { open(.project(first.ref)) }
      case .orchestrator:
        if let first { open(.project(first.members.first { !$0.isCoordinator }?.ref ?? first.ref)) }
      default:
        let threads = model.recentThreads
        if let thread = threads.first(where: { $0.activity == .needsYou }) ?? threads.first {
          main.path = [.chat(.thread(thread.ref))]
        }
      }
    }
    pendingLaunchRoute = nil
    return true
  }
}
