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

/// A row of the expanded sidebar. Chats replace the root of the main stack;
/// a machine replaces the whole stack with its detail screen.
nonisolated enum SidebarItem: Hashable, Sendable {
  case chat(ChatTarget)
  case machine(String)
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
  /// The person hid the wide layout's navigation column. Remembered across
  /// launches, as in the iPad and desktop apps.
  var isSidebarCollapsed = UserDefaults.standard.bool(forKey: AppRouter.sidebarCollapsedKey) {
    didSet { UserDefaults.standard.set(isSidebarCollapsed, forKey: AppRouter.sidebarCollapsedKey) }
  }
  static let sidebarCollapsedKey = "swc.sidebarCollapsed"
  /// Beside an open thread, the wide column holds the thread's coordinator
  /// rather than the project's threads. The person's last choice stays.
  var showsCoordinatorBeside = UserDefaults.standard.object(forKey: AppRouter.coordinatorBesideKey) == nil
    || UserDefaults.standard.bool(forKey: AppRouter.coordinatorBesideKey) {
    didSet { UserDefaults.standard.set(showsCoordinatorBeside, forKey: AppRouter.coordinatorBesideKey) }
  }
  static let coordinatorBesideKey = "swc.coordinatorBeside"
  /// The machine picked in the column's switcher. It changes only the column,
  /// so the thread beside it stays open.
  var chosenCoordinator: ProjectRef?
  /// The person went back to all projects. Opening a chat ends it, so the
  /// column and the screen beside it are always about the same project.
  var sidebarShowsAllProjects = false
  /// The machine chip chosen in the wide list; nil shows every machine.
  var sidebarMachine: String?
  /// The thread a link opened directly. Nothing opened it, so the root chat
  /// says nothing about whose coordinator belongs beside it.
  private var linkedThread: ThreadRef?
  /// Search replaces the drawer list. Closing the drawer ends it.
  var isDrawerSearching = false
  var sheet: SheetRoute?
  var toast: WeaveToastMessage?
  /// Unsent composer text per conversation.
  var drafts: [ChatTarget: String] = [:]
  /// Pictures waiting in each chat's composer. They survive leaving the chat, as text does.
  var attachmentDrafts: [ChatTarget: [OutgoingImage]] = [:]
  /// A pairing link from a deep link, picked up by the pairing screen.
  var pairPrefill: String?
  /// Set by a launch argument; cleared when the person picks an appearance.
  var appearanceOverride: AppearancePreference?
  /// Waits until the model has data, then opens the screen.
  var pendingLaunchRoute: LaunchRoute?
  /// The chat whose composer takes focus when it appears.
  var pendingComposerFocus: ChatTarget?
  /// A device viewer a launch argument opens over its thread.
  var pendingDeviceViewer: DeviceViewerRoute?

  /// Shows a chat at the root of the main stack and closes the drawer.
  func open(_ target: ChatTarget) {
    sidebarShowsAllProjects = false
    linkedThread = nil
    if target.threadRef == nil { chosenCoordinator = nil }
    root = target
    main.path = []
    isDrawerOpen = false
  }

  /// Pushes a screen onto the main stack and closes the drawer.
  func push(_ route: Route) {
    if case .chat = route { sidebarShowsAllProjects = false }
    main.path.append(route)
    isDrawerOpen = false
  }

  /// The sidebar row of the screen that is showing, if it has one.
  func sidebarSelection(in model: AppModel) -> SidebarItem? {
    if main.path.isEmpty { return landing(in: model).map(SidebarItem.chat) }
    if main.path.count == 1, case let .machine(id) = main.path[0] { return .machine(id) }
    if case let .chat(target)? = main.path.last { return .chat(target) }
    return nil
  }

  /// The coordinator beside the thread on screen. A subagent's child or an
  /// archived thread is in no list, so the walk falls back to the chat it was
  /// opened from. A screen that is not about a project, or a link with no
  /// opener, ends the walk with no coordinator.
  func openThreadCoordinator(in model: AppModel) -> ChatTarget? {
    guard case .chat(.thread)? = sidebarSelection(in: model) else { return nil }
    for route in main.path.reversed() {
      switch route {
      case let .chat(target):
        if let coordinator = coordinator(openedFrom: target, in: model) { return coordinator }
      case let .overview(ref):
        return coordinator(openedFrom: model.aide?.ref == ref ? .aide(ref) : .project(ref), in: model)
      default:
        return nil
      }
    }
    if let linkedThread, main.path.first == .chat(.thread(linkedThread)) { return nil }
    return landing(in: model).flatMap { coordinator(openedFrom: $0, in: model) }
  }

  private func coordinator(openedFrom target: ChatTarget, in model: AppModel) -> ChatTarget? {
    switch target {
    case let .thread(ref):
      return coordinator(ofThread: ref, in: model)
    case let .project(ref):
      if let chosen = chosenCoordinator, model.project(ref)?.contains(chosen) == true { return .project(chosen) }
      return target
    case .aide:
      return target
    }
  }

  /// Aide for Aide's threads; otherwise the machine picked in the switcher, the
  /// project's active coordinator, or the thread's own machine. A group's
  /// leading copy is not used: it follows activity, so the chat could change
  /// machines under someone typing.
  private func coordinator(ofThread ref: ThreadRef, in model: AppModel) -> ChatTarget? {
    guard let projectRef = model.thread(ref)?.projectRef,
          let project = model.project(projectRef),
          !project.archived else { return nil }
    if model.aide?.ref == project.ref { return .aide(project.ref) }
    if let chosen = chosenCoordinator, project.contains(chosen) { return .project(chosen) }
    if case let .project(chosen)? = root, project.contains(chosen) { return .project(chosen) }
    if let active = project.members.first(where: \.isCoordinator) { return .project(active.ref) }
    return .project(projectRef)
  }

  /// Opens a thread from a chat, unless it is already the one on screen: a
  /// coordinator's transcript now sits beside the threads it links to.
  func pushThread(_ ref: ThreadRef, on nav: StackNavigator, in model: AppModel) {
    if nav === main, sidebarSelection(in: model) == .chat(.thread(ref)) { return }
    if nav === main { sidebarShowsAllProjects = false }
    nav.push(.chat(.thread(ref)))
  }

  /// The coordinator the wide column shows right now; nil shows the project list.
  func besideCoordinator(in model: AppModel) -> ChatTarget? {
    guard showsCoordinatorBeside, !sidebarShowsAllProjects, !isDrawerSearching else { return nil }
    return openThreadCoordinator(in: model)
  }

  /// The project the wide list is scoped to; nil shows every project. A screen
  /// that belongs to no project, or a thread in no list, keeps the scope of the
  /// chat it was opened from.
  func sidebarScope(in model: AppModel) -> ProjectRef? {
    guard !sidebarShowsAllProjects else { return nil }
    return followedProject(in: model)
  }

  /// The project of the chat on screen.
  func followedProject(in model: AppModel) -> ProjectRef? {
    for route in main.path.reversed() {
      switch route {
      case let .chat(.thread(thread)):
        if let project = model.thread(thread)?.projectRef { return listScope(of: project, in: model) }
      case .chat(.aide):
        return nil
      case let .chat(.project(project)), let .overview(project):
        return listScope(of: project, in: model)
      default:
        continue
      }
    }
    switch landing(in: model) {
    case let .project(project)?: return listScope(of: project, in: model)
    case let .thread(thread)?: return model.thread(thread)?.projectRef.flatMap { listScope(of: $0, in: model) }
    case .aide?, nil: return nil
    }
  }

  /// The row a project's chats scope the list to. Aide is no project in the picker, so its chats show the whole tree.
  private func listScope(of project: ProjectRef, in model: AppModel) -> ProjectRef? {
    guard let row = model.project(project), row.ref != model.aide?.ref else { return nil }
    return row.ref
  }

  /// The machine chip in force: nil once its machine is gone or is the only one
  /// left, so no filter outlives the chips that clear it.
  func activeSidebarMachine(in model: AppModel) -> String? {
    guard let sidebarMachine, model.machines.count > 1, model.machine(sidebarMachine) != nil else { return nil }
    return sidebarMachine
  }

  /// The threads the wide list shows, by the last thing asked of them, so a
  /// status change or streamed update never moves a row. The machine chip
  /// belongs to the top level.
  func sidebarThreads(in model: AppModel) -> [ThreadSummary] {
    let scope = sidebarScope(in: model)
    let threads = scope.map { model.threads(in: $0) } ?? model.recentThreads
    let machine = scope == nil ? activeSidebarMachine(in: model) : nil
    return threads
      .filter { !$0.isResolved && (machine == nil || $0.ref.environmentId == machine) }
      .sorted {
        if $0.isPinned != $1.isPinned { return $0.isPinned }
        if $0.activityAt != $1.activityAt { return $0.activityAt > $1.activityAt }
        return ($0.ref.environmentId, $0.ref.threadId) < ($1.ref.environmentId, $1.ref.threadId)
      }
  }

  /// Goes into a project from the list. Its coordinator comes up beside it,
  /// unless one of its chats is already there.
  func showProject(_ project: ProjectRef, in model: AppModel) {
    sidebarShowsAllProjects = false
    guard followedProject(in: model) != project else { return }
    open(.project(project))
  }

  /// Shows a sidebar row in the detail column.
  func select(_ item: SidebarItem) {
    switch item {
    case let .chat(target): open(target)
    case let .machine(id):
      main.path = [.machine(id)]
      isDrawerOpen = false
    }
  }

  /// Opens Aide, or the composer of the current project when there is no
  /// Aide, with the composer focused.
  func startNewChat(in model: AppModel) {
    let target: ChatTarget?
    if let aide = model.aide, !aide.archived {
      target = .aide(aide.ref)
    } else if let current = landing(in: model), current.projectRef != nil {
      target = current
    } else {
      target = model.projects.first(where: { !$0.archived && !$0.isAutomated }).map { .project($0.ref) }
    }
    guard let target else {
      isDrawerOpen = false
      return
    }
    pendingComposerFocus = target
    open(target)
  }

  func showError(_ error: any Error) {
    toast = WeaveToastMessage(error.localizedDescription, kind: .fail)
  }

  /// The chat to show at the root right now.
  func landing(in model: AppModel) -> ChatTarget? {
    if let root, Self.isValid(root, in: model) { return root }
    return Self.defaultLanding(aide: model.aide, projects: model.projects)
  }

  /// Aide when it exists, otherwise the first of the person's own projects.
  static func defaultLanding(aide: ProjectSummary?, projects: [ProjectSummary]) -> ChatTarget? {
    if let aide, !aide.archived { return .aide(aide.ref) }
    if let first = projects.first(where: { !$0.archived && !$0.isAutomated }) {
      return .project(first.ref)
    }
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
      openLink(to: ref)
    }
  }

  private func openLink(to ref: ThreadRef) {
    sidebarShowsAllProjects = false
    linkedThread = ref
    main.path = [.chat(.thread(ref))]
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
    case .device:
      guard !model.isLoading else { return false }
      guard let (machineId, devices) = model.devices.first(where: { !$0.value.sessions.isEmpty }) else { return !model.devices.isEmpty }
      let session = devices.sessions[0]
      if let threadId = session.threadIds.first {
        openLink(to: ThreadRef(environmentId: machineId, threadId: threadId))
      }
      pendingDeviceViewer = DeviceViewerRoute(machineId: machineId, key: session.id)
    case .overview, .projectSettings, .thread, .coordinator, .orchestrator:
      guard !model.isLoading else { return false }
      let first = model.projects.first { !$0.archived && !$0.isAutomated }
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
          openLink(to: thread.ref)
        }
      }
    }
    pendingLaunchRoute = nil
    return true
  }
}
