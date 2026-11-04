import SwiftUI
import SWCSync
import Weave

private nonisolated struct ThreadsPaneKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// The list fills the screen beside a coordinator in the wide column.
  nonisolated var isThreadsPane: Bool {
    get { self[ThreadsPaneKey.self] }
    set { self[ThreadsPaneKey.self] = newValue }
  }
}

/// The expanded layout's navigation column, a native sidebar list on two
/// levels: all projects with Aide, recent threads and machines, or one
/// project's coordinator and threads. Going into a project brings its
/// coordinator up beside the list unless one of its chats is already there, so
/// both columns are about the same project. Every thread row leads with its
/// status. Selection reads from and writes to the router, the same state the
/// compact drawer uses.
struct SidebarView: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.headerTopPadding) private var headerTopPadding
  @Environment(\.isThreadsPane) private var isThreadsPane
  @Environment(\.isNavigationSidebarVisible) private var columnVisible
  @State private var showAllProjects = false
  @State private var showAllRecents = false
  @State private var showAutomated = false
  @State private var showArchived = false
  @State private var settingUpAide = false
  @State private var statusFilter = StatusFilter.all
  /// The machine a project's threads are narrowed to, by name; ends with the project.
  @State private var threadMachine: String?

  private static let collapsedProjectCount = 8
  private static let recentCount = 12

  private enum StatusFilter { case all, needsYou, working, offline }

  var body: some View {
    @Bindable var router = router
    Group {
      if router.isDrawerSearching {
        DrawerSearchView(isPresented: $router.isDrawerSearching)
          .padding(.top, max(WeaveSpacing.s2, headerTopPadding))
      } else {
        list
      }
    }
    .hideNavigationBar()
    .safeAreaInset(edge: .top, spacing: 0) {
      if !router.isDrawerSearching { header }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if !router.isDrawerSearching { bottomBar }
    }
    .background((isThreadsPane ? Color.weave.canvas : Color.weave.sunken).ignoresSafeArea())
    .overlay(alignment: .trailing) {
      // Hairline between the sidebar and the chat, as in iPad split views.
      if !isThreadsPane {
        Rectangle()
          .fill(Color.weave.line)
          .frame(width: 1 / 3)
          .ignoresSafeArea()
          .accessibilityHidden(true)
      }
    }
    .tint(Color.weave.iris)
  }

  // MARK: Header

  private var header: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if isThreadsPane {
        threadsPaneTitle
      } else {
        ColumnHeader {
          ColumnActions()
        } modeTrailing: {
          EmptyView()
        }
      }
      if model.machines.count > 1, router.sidebarScope(in: model) == nil { machineChips }
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.top, headerTopPadding)
    .padding(.bottom, WeaveSpacing.s2)
    .background(isThreadsPane ? Color.weave.canvas : Color.weave.sunken)
  }

  /// Beside the coordinator the column header already names the project,
  /// leads back to all of them and holds search and New chat, so this pane
  /// only says what it lists.
  private var threadsPaneTitle: some View {
    HStack(spacing: WeaveSpacing.s2) {
      // Alone on screen, the list brings the coordinator back.
      if !columnVisible { MenuButton() }
      Text(router.sidebarScope(in: model) == nil ? "All projects" : "Threads")
        .font(.weave(.headline, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .lineLimit(1)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("threads-pane.header")
      Spacer(minLength: 0)
    }
    .frame(minHeight: WeaveSize.minTap)
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }

  /// All, then one chip per machine with its status. When they don't all fit
  /// the column, one menu names the machine in force and lists them all, so
  /// no machine hides past the edge.
  private var machineChips: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: WeaveSpacing.s1) {
        machineChip(nil) {
          Text("All").font(.weave(.callout, weight: .medium))
        }
        ForEach(model.machines) { machine in
          machineChip(machine.id) {
            HStack(spacing: WeaveSpacing.s1) {
              MachineBadge(status: machine.displayStatus, size: 15)
              Text(machine.displayName).font(.weave(.callout, weight: .medium))
            }
          }
          .accessibilityLabel("\(machine.displayName), \(machine.statusLabel)")
        }
      }
      .fixedSize()
      .accessibilityIdentifier("sidebar.machine-chips")
      machineMenu
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var machineMenu: some View {
    let current = router.activeSidebarMachine(in: model).flatMap { model.machine($0) }
    return Menu {
      Picker("Machine", selection: Binding(get: { router.activeSidebarMachine(in: model) }, set: { id in withAnimation(.snappy) { router.sidebarMachine = id } })) {
        Text("All machines").tag(String?.none)
        ForEach(model.machines) { machine in
          Text("\(machine.displayName) · \(machine.statusLabel)").tag(String?.some(machine.id))
        }
      }
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        if let current { MachineBadge(status: current.displayStatus, size: 15) }
        Text(current?.displayName ?? "All machines")
          .font(.weave(.callout, weight: .medium))
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .accessibilityHidden(true)
      }
      .foregroundStyle(Color.weave.ink)
      .padding(.horizontal, WeaveSpacing.s3)
      .frame(minHeight: WeaveSize.minTap)
      .background(Color.weave.line, in: Capsule())
      .contentShape(Capsule())
    }
    .accessibilityLabel("Machine")
    .accessibilityValue(current.map { "\($0.displayName), \($0.statusLabel)" } ?? "All machines")
    .accessibilityIdentifier("sidebar.machine-menu")
  }

  private func machineChip<Label: View>(_ machine: String?, @ViewBuilder label: () -> Label) -> some View {
    ColumnChip(selected: router.activeSidebarMachine(in: model) == machine) {
      withAnimation(.snappy) { router.sidebarMachine = machine }
    } label: {
      label()
    }
  }

  private var list: some View {
    List {
      if let scope = router.sidebarScope(in: model).flatMap({ model.project($0) }) {
        projectSections(scope)
      } else {
        aideSection
        projectsSection
        recentsSection
        if router.activeSidebarMachine(in: model) == nil { machinesSection }
      }
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .environment(\.defaultMinListRowHeight, WeaveSize.minTap)
    // A filter ends with what it filtered, so the list never narrows by itself.
    .onChange(of: router.sidebarScope(in: model)) {
      statusFilter = .all
      threadMachine = nil
    }
    .onChange(of: statusFilterIsEmpty) { _, empty in
      if empty { statusFilter = .all }
    }
  }

  private var statusFilterIsEmpty: Bool {
    let groups = ThreadGroups(scopedThreads)
    return switch statusFilter {
    case .all: false
    case .needsYou: groups.needsYou.isEmpty
    case .working: groups.working.isEmpty
    case .offline: groups.offline.isEmpty
    }
  }

  // MARK: One project

  /// The project's threads on the machine picked above, or on all of them.
  private var scopedThreads: [ThreadSummary] {
    let threads = router.sidebarThreads(in: model)
    guard let machine = activeThreadMachine(threads) else { return threads }
    return threads.filter { $0.runs(on: machine) }
  }

  /// The picked machine while its chip is still offered, so a chip that
  /// goes away never leaves the list empty with no way back.
  private func activeThreadMachine(_ threads: [ThreadSummary]) -> String? {
    guard let project = router.sidebarScope(in: model).flatMap({ model.project($0) }) else { return nil }
    return ThreadMachineFilter.active(threadMachine, in: model.threadMachines(of: project, threads: threads))
  }

  /// The project's coordinator, then its threads in a steady order, with what
  /// needs attention one tap away.
  @ViewBuilder private func projectSections(_ project: ProjectSummary) -> some View {
    // With a thread open, the switch above already leads to the coordinator.
    let hasModes = router.openThreadCoordinator(in: model) != nil || isThreadsPane
    if !hasModes {
      Section {
        SidebarRow(title: project.title, subtitle: "Coordinator") {
          ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 24, style: .plain)
        } trailing: {
          ProjectStatusGlyphs(project: project)
        }
        .accessibilityValue(ProjectStatusGlyphs.spoken(project))
        .sidebarItem(.chat(.project(project.ref)))
      }
    }
    let allThreads = router.sidebarThreads(in: model)
    let threadMachines = model.threadMachines(of: project, threads: allThreads)
    let threads = scopedThreads
    let groups = ThreadGroups(threads)
    let filter = statusFilterIsEmpty ? StatusFilter.all : statusFilter
    let shown: [ThreadSummary] = switch filter {
    case .all: threads
    case .needsYou: threads.filter { groups.needsYou.map(\.ref).contains($0.ref) }
    case .working: threads.filter { groups.working.map(\.ref).contains($0.ref) }
    case .offline: threads.filter { groups.offline.map(\.ref).contains($0.ref) }
    }
    let machines = Set(allThreads.map(\.ref.environmentId))
    Section {
      if threadMachines.count > 1 {
        ThreadMachineFilter(machines: threadMachines, selection: Binding(get: { activeThreadMachine(allThreads) }, set: { threadMachine = $0 }))
          .sidebarRowStyle(selected: false)
      }
      if !groups.needsYou.isEmpty || !groups.working.isEmpty || !groups.offline.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: WeaveSpacing.s1) {
            statusChip("All", count: threads.count, value: .all, current: filter)
            if !groups.needsYou.isEmpty { statusChip("Needs you", count: groups.needsYou.count, value: .needsYou, current: filter) }
            if !groups.working.isEmpty { statusChip("Working", count: groups.working.count, value: .working, current: filter) }
            if !groups.offline.isEmpty { statusChip("Offline", count: groups.offline.count, value: .offline, current: filter) }
          }
        }
        .sidebarRowStyle(selected: false)
      }
      // A thread waiting for access says what it asks for: "Asking to use apps on your computer".
      let details: (ThreadSummary) -> (String?, String?) = { thread in (thread.accessWaitLine, machines.count > 1 ? thread.placement.owner : nil) }
      // All of them come grouped by what they need, as on the desktop; a
      // chip shows its group alone.
      if filter == .all, !threads.isEmpty {
        groupedRows(groups, details: details)
      } else {
        threadRows(shown, details: details)
      }
    } header: {
      if !hasModes { Text("Threads") }
    }
  }

  private func statusChip(_ title: String, count: Int, value: StatusFilter, current: StatusFilter) -> some View {
    ColumnChip(selected: current == value) {
      withAnimation(.snappy) { statusFilter = value }
    } label: {
      Text("\(title) \(count)").font(.weave(.callout, weight: .medium))
    }
  }

  /// Needs you, Working, Offline, then Idle, each under its header and in the
  /// list's steady order, folded to a screenful across the groups.
  @ViewBuilder private func groupedRows(_ groups: ThreadGroups, details: @escaping (ThreadSummary) -> (String?, String?)) -> some View {
    let all = [("Needs you", groups.needsYou), ("Working", groups.working), ("Offline", groups.offline), ("Idle", groups.idle)]
    let total = all.reduce(0) { $0 + $1.1.count }
    ForEach(Self.fold(all, to: showAllRecents ? total : Self.recentCount), id: \.title) { group in
      SectionHeader(group.title, count: group.count)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("sidebar.thread-group")
        .sidebarRowStyle(selected: false)
      ForEach(group.shown) { thread in
        let (detail, machine) = details(thread)
        ThreadLine(thread: thread, detail: detail, machine: machine)
          .accessibilityIdentifier("sidebar.thread")
          .sidebarItem(.chat(.thread(thread.ref)))
          .threadRowActions(thread)
      }
    }
    if total > Self.recentCount {
      foldButton(showAllRecents ? "Show fewer chats" : "Show all \(total) chats") { showAllRecents.toggle() }
    }
  }

  /// The groups with threads, keeping the first `limit` threads in order.
  static func fold(_ groups: [(String, [ThreadSummary])], to limit: Int) -> [(title: String, count: Int, shown: [ThreadSummary])] {
    var left = limit
    return groups.compactMap { title, threads in
      guard !threads.isEmpty, left > 0 else { return nil }
      let shown = Array(threads.prefix(left))
      left -= shown.count
      return (title, threads.count, shown)
    }
  }

  /// Thread rows folded to a screenful. `details` gives each row's second line and trailing machine.
  @ViewBuilder private func threadRows(_ threads: [ThreadSummary], details: @escaping (ThreadSummary) -> (String?, String?)) -> some View {
    let visible = showAllRecents ? threads : Array(threads.prefix(Self.recentCount))
    ForEach(visible) { thread in
      let (detail, machine) = details(thread)
      ThreadLine(thread: thread, detail: detail, machine: machine)
        .accessibilityIdentifier("sidebar.thread")
        .sidebarItem(.chat(.thread(thread.ref)))
        .threadRowActions(thread)
    }
    if threads.count > Self.recentCount {
      foldButton(showAllRecents ? "Show fewer chats" : "Show all \(threads.count) chats") { showAllRecents.toggle() }
    }
    if threads.isEmpty {
      Text("No threads here")
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .sidebarRowStyle(selected: false)
    }
  }

  // MARK: Aide

  @ViewBuilder private var aideSection: some View {
    // Aide stays hidden, set-up offer included, until its switch is on.
    if !model.aideEnabled {
      EmptyView()
    } else if let aide = model.aide, !aide.archived {
      Section {
        SidebarRow(title: "Aide", subtitle: aide.machineLabel.isEmpty ? nil : aide.machineLabel) {
          ProjectAvatar(icon: aide.icon.avatarIcon, title: aide.title, size: 24, style: .plain)
        } trailing: {
          ProjectStatusGlyphs(project: aide)
        }
        .accessibilityValue(ProjectStatusGlyphs.spoken(aide))
        .sidebarItem(.chat(.aide(aide.ref)))
      }
    } else if model.allMachinesLoaded {
      Section {
        Button(action: setUpAide) {
          SidebarRow(title: "Set up Aide", subtitle: "Your personal assistant") {
            ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Aide", size: 24, style: .plain)
          } trailing: {
            if settingUpAide { ProgressView().controlSize(.small) }
          }
        }
        .buttonStyle(.plain)
        .disabled(settingUpAide)
        .sidebarRowStyle(selected: false)
      }
    }
  }

  private func setUpAide() {
    settingUpAide = true
    Task {
      do {
        let ref = try await model.engine.setupAide()
        router.open(.aide(ref))
      } catch {
        router.showError(error)
      }
      settingUpAide = false
    }
  }

  // MARK: Projects

  @ViewBuilder private var projectsSection: some View {
    // A machine chip keeps the projects with a copy on that machine.
    let machine = router.activeSidebarMachine(in: model)
    let projects = model.projectsOn(machine, among: model.pinnedProjects + model.otherProjects)
    let automated = model.projectsOn(machine, among: model.automatedProjects)
    let archived = model.projectsOn(machine, among: model.archivedProjects)
    if projects.isEmpty, automated.isEmpty, archived.isEmpty, let machine = machine.flatMap({ model.machine($0) }) {
      Section("Projects") {
        Text("No projects on \(machine.displayName)")
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .accessibilityIdentifier("sidebar.no-projects-on-machine")
      }
    } else if !projects.isEmpty || !automated.isEmpty || !archived.isEmpty {
      let shared = DrawerView.sharedTitles(projects + automated + archived)
      Section("Projects") {
        let visible = showAllProjects ? projects : Array(projects.prefix(Self.collapsedProjectCount))
        ForEach(visible) { projectRow($0, shared: shared) }
        if projects.count > Self.collapsedProjectCount {
          foldButton(showAllProjects ? "Show less" : "Show all \(projects.count)") { showAllProjects.toggle() }
        }
        if !automated.isEmpty {
          let open = showAutomated || automated.contains { isSelected(.project($0.ref)) }
          foldButton(open ? "Hide automated" : "Automated (\(automated.count))") { showAutomated = !open }
          if open { ForEach(automated) { projectRow($0, shared: shared) } }
        }
        if !archived.isEmpty {
          let open = showArchived || archived.contains { isSelected(.project($0.ref)) }
          foldButton(open ? "Hide archived" : "Archived (\(archived.count))") { showArchived = !open }
          if open { ForEach(archived) { projectRow($0, shared: shared) } }
        }
      }
    }
  }

  /// One project: what needs you and what is running, then the way in.
  private func projectRow(_ project: ProjectSummary, shared: Set<String>) -> some View {
    let selected = router.followedProject(in: model) == project.ref
    let waiting = ThreadGroups(model.threads(in: project.ref).filter { !$0.isResolved }).needsYou.count
    // With more than one machine, every row says which ones it is on.
    let machines = model.machines.count > 1 ? model.machines(of: project) : []
    return Button {
      withAnimation(.snappy) { router.showProject(project.ref, in: model) }
    } label: {
      SidebarRow(title: project.title, subtitle: machines.isEmpty && shared.contains(project.title.lowercased()) ? project.machineLabel : nil, machines: machines) {
        ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 24, style: .plain)
      } trailing: {
        HStack(spacing: WeaveSpacing.s2) {
          if waiting > 0 {
            HStack(spacing: 3) {
              Image(systemName: "bubble.left.fill").font(.system(size: 12, weight: .semibold))
              Text("\(waiting)").font(.weave(.caption, weight: .semibold))
            }
            .foregroundStyle(Color.weave.warn)
            .accessibilityHidden(true)
          }
          ProjectStatusGlyphs(project: project)
          Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityValue(([machines.spoken, waiting > 0 ? needsYouLabel(waiting) : nil, ProjectStatusGlyphs.spoken(project)] as [String?]).compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityHint("Opens it and shows its threads")
    .sidebarRowStyle(selected: selected)
    .projectRowActions(project)
  }

  private func foldButton(_ title: String, toggle: @escaping () -> Void) -> some View {
    Button {
      withAnimation(.snappy) { toggle() }
    } label: {
      Text(title)
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .padding(.leading, 28 + WeaveSpacing.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sidebarRowStyle(selected: false)
  }

  // MARK: Recents

  @ViewBuilder private var recentsSection: some View {
    Section {
      threadRows(router.sidebarThreads(in: model)) { thread in
        ([thread.accessWaitLine, thread.projectTitle, thread.placement.subtitle()].compactMap(\.self).joined(separator: " · "), nil)
      }
    } header: {
      SidebarRecentsHeader(updating: !model.staleMachines.isEmpty)
    }
  }

  // MARK: Machines

  @ViewBuilder private var machinesSection: some View {
    if !model.machines.isEmpty {
      Section("Machines") {
        ForEach(model.machines) { machine in
          SidebarRow(title: machine.displayName, subtitle: machine.statusLabel) {
            MachineBadge(status: machine.displayStatus, size: 18)
          } trailing: {
            EmptyView()
          }
          .accessibilityValue(machine.statusLabel)
          .accessibilityIdentifier("drawer.machine")
          .sidebarItem(.machine(machine.id))
        }
      }
    }
  }

  // MARK: Bottom bar

  private var bottomBar: some View {
    HStack(spacing: WeaveSpacing.s3) {
      WeaveIconButton("gearshape", label: "Settings", size: 44) {
        router.sheet = .globalSettings
      }
      Spacer(minLength: 0)
    }
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s2)
    .background(isThreadsPane ? Color.weave.canvas : Color.weave.sunken)
  }

  private func isSelected(_ target: ChatTarget) -> Bool {
    router.sidebarSelection(in: model) == .chat(target)
  }
}

extension View {
  /// A sidebar row that shows `item` in the detail column when tapped and
  /// carries the selection pill while that item is showing.
  fileprivate func sidebarItem(_ item: SidebarItem) -> some View {
    modifier(SidebarItemRow(item: item))
  }

  fileprivate func sidebarRowStyle(selected: Bool) -> some View {
    self
      .listRowInsets(EdgeInsets(top: 0, leading: WeaveSpacing.s4, bottom: 0, trailing: WeaveSpacing.s3))
      .listRowSeparator(.hidden)
      .listRowBackground(
        RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous)
          .fill(selected ? Color.weave.iris.opacity(0.14) : Color.clear)
          .padding(.horizontal, WeaveSpacing.s2)
      )
  }
}

private struct SidebarItemRow: ViewModifier {
  let item: SidebarItem
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  func body(content: Content) -> some View {
    let selected = router.sidebarSelection(in: model) == item
    Button { router.select(item) } label: { content }
      .buttonStyle(.plain)
      .accessibilityAddTraits(selected ? .isSelected : [])
      .sidebarRowStyle(selected: selected)
  }
}

/// One sidebar row: a 28-point icon, a title with an optional second line and
/// trailing status. VoiceOver reads it as one element.
private struct SidebarRow<Icon: View, Trailing: View>: View {
  let title: String
  var subtitle: String?
  var machines: [ProjectMachine] = []
  @ViewBuilder let icon: Icon
  @ViewBuilder let trailing: Trailing

  var body: some View {
    HStack(spacing: WeaveSpacing.s3) {
      icon
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.weave(.body))
          .lineLimit(1)
        if let subtitle {
          Text(subtitle)
            .font(.weave(.footnote))
            .foregroundStyle(Color.weave.muted)
            .lineLimit(3)
        }
        if !machines.isEmpty {
          ProjectMachinesLine(machines: machines)
            .accessibilityIdentifier("sidebar.project-machines")
        }
      }
      Spacer(minLength: 0)
      trailing
    }
    .padding(.vertical, WeaveSpacing.s1)
    .frame(minHeight: WeaveSize.minTap)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title)
  }
}

/// One thread: its status first, then the title using the whole row.
private struct ThreadLine: View {
  let thread: ThreadSummary
  var detail: String?
  var machine: String?

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      ThreadStatusMark(thread: thread)
      VStack(alignment: .leading, spacing: 1) {
        Text(thread.title)
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.ink)
          .lineLimit(1)
          .truncationMode(.tail)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(.weave(.footnote))
            .foregroundStyle(Color.weave.muted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      if let machine {
        Text(machine)
          .font(.weave(.footnote))
          .foregroundStyle(Color.weave.muted)
          .lineLimit(1)
      }
      if thread.isUnread { UnreadDot() }
    }
    .frame(minHeight: 36)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(thread.title)
    .accessibilityValue(([ThreadStatusMark.state(of: thread).label, machine ?? detail, thread.isUnread ? "Unread" : nil] as [String?]).compactMap { $0 }.joined(separator: ", "))
  }
}

/// The recents header and a sync note.
private struct SidebarRecentsHeader: View {
  let updating: Bool

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Text("Recents")
      Spacer(minLength: 0)
      if updating {
        ProgressView().controlSize(.mini)
        Text("Updating")
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(updating ? "Recents, Updating" : "Recents")
  }
}
