import SwiftUI
import SWCSync
import Weave

/// The side drawer: Aide, projects, recent threads, machines, settings and a
/// new chat button.
struct DrawerView: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var showAllProjects = false
  @State private var showAllRecents = false
  @State private var showAutomated = false
  @State private var showArchived = false
  @State private var settingUpAide = false

  private static let collapsedProjectCount = 6
  private static let recentCount = 8

  var body: some View {
    @Bindable var router = router
    VStack(spacing: 0) {
      header
      if router.isDrawerSearching {
        DrawerSearchView(isPresented: $router.isDrawerSearching)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            aideRow
            projectsSection
            recentsSection
            machinesSection
          }
          .padding(.bottom, 112)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .bottom) { bottomBar }
      }
    }
    .foregroundStyle(Color.weave.ink)
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Text("SpecWithCode")
        .weaveFont(.title, weight: .bold)
        .foregroundStyle(Color.weave.ink)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
      if !router.isDrawerSearching {
        WeaveIconButton("magnifyingglass", label: "Search projects and threads") {
          withAnimation(.snappy) { router.isDrawerSearching = true }
        }
      }
    }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.top, WeaveSpacing.s2)
    .padding(.bottom, WeaveSpacing.s2)
  }

  // MARK: Aide

  @ViewBuilder private var aideRow: some View {
    if let aide = model.aide, !aide.archived {
      let target = ChatTarget.aide(aide.ref)
      WeaveRow("Aide", titleLineLimit: 1, action: { router.open(target) }) {
        ProjectAvatar(icon: aide.icon.avatarIcon, title: aide.title, size: 24, style: .plain)
          .frame(width: 28)
          .accessibilityHidden(true)
      } trailing: {
        ProjectStatusGlyphs(project: aide)
      }
      .accessibilityValue(ProjectStatusGlyphs.spoken(aide))
      .drawerSelection(isSelected(target))
    } else if model.allMachinesLoaded {
      // Only once every machine has answered: an offline one may hold Aide.
      WeaveRow("Set up Aide", subtitle: "Your personal assistant", action: setUpAide) {
        ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Aide", size: 24, style: .plain)
          .frame(width: 28)
          .accessibilityHidden(true)
      } trailing: {
        if settingUpAide {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "plus")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
        }
      }
      .disabled(settingUpAide)
    } else if !model.machines.isEmpty, !model.isLoading, model.aide == nil {
      HStack(spacing: WeaveSpacing.s3) {
        ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Aide", size: 24, style: .plain)
          .frame(width: 28)
          .opacity(0.5)
          .accessibilityHidden(true)
        Text("Aide appears when your machines reconnect")
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(WeaveRowInsets.standard)
      .frame(minHeight: 52)
      .accessibilityElement(children: .combine)
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
    let projects = model.pinnedProjects + model.otherProjects
    let automated = model.automatedProjects
    let archived = model.archivedProjects
    if !projects.isEmpty || !automated.isEmpty || !archived.isEmpty {
      DrawerSectionLabel("Projects")
      let visible = showAllProjects ? projects : Array(projects.prefix(Self.collapsedProjectCount))
      let shared = Self.sharedTitles(projects + automated + archived)
      ForEach(visible) { project in projectRow(project, shared: shared) }
      if projects.count > Self.collapsedProjectCount {
        foldButton(showAllProjects ? "Show less" : "Show all \(projects.count)", open: showAllProjects) {
          showAllProjects.toggle()
        }
      }
      if !automated.isEmpty {
        // Checks and agents make these for themselves; they stay folded until asked for.
        let open = showAutomated || automated.contains { isSelected(.project($0.ref)) }
        foldButton(open ? "Hide automated" : "Automated (\(automated.count))", open: open) {
          showAutomated = !open
        }
        if open {
          ForEach(automated) { project in projectRow(project, shared: shared) }
        }
      }
      if !archived.isEmpty {
        let open = showArchived || archived.contains { isSelected(.project($0.ref)) }
        foldButton(open ? "Hide archived" : "Archived (\(archived.count))", open: open) {
          showArchived = !open
        }
        if open {
          ForEach(archived) { project in projectRow(project, shared: shared) }
        }
      }
    }
  }

  private func projectRow(_ project: ProjectSummary, shared: Set<String>) -> some View {
    let target = ChatTarget.project(project.ref)
    // The machine name only tells apart projects with the same name.
    return WeaveRow(project.title, subtitle: shared.contains(project.title.lowercased()) ? project.machineLabel : nil, titleLineLimit: 1, subtitleLineLimit: 1, action: { router.open(target) }) {
      ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 24, style: .plain)
        .frame(width: 28)
        .accessibilityHidden(true)
    } trailing: {
      ProjectStatusGlyphs(project: project)
    }
    .accessibilityValue(ProjectStatusGlyphs.spoken(project))
    .drawerSelection(isSelected(target))
  }

  private func foldButton(_ title: String, open: Bool, toggle: @escaping () -> Void) -> some View {
    Button {
      withAnimation(.snappy) { toggle() }
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        Text(title)
        Image(systemName: open ? "chevron.up" : "chevron.down")
          .font(.system(size: 12, weight: .semibold))
          .accessibilityHidden(true)
      }
      .font(.weave(.callout))
      .foregroundStyle(Color.weave.muted)
      .padding(.horizontal, WeaveSpacing.s4)
      .frame(minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(.isButton)
  }

  static func sharedTitles(_ projects: [ProjectSummary]) -> Set<String> {
    let counts = Dictionary(grouping: projects) { $0.title.lowercased() }
    return Set(counts.filter { $0.value.count > 1 }.keys)
  }

  // MARK: Recents

  @ViewBuilder private var recentsSection: some View {
    let grouped = RecentChatGroups(model.recentThreads)
    let visible = Set((showAllRecents ? grouped.groups.flatMap(\.threads) : Array(grouped.groups.flatMap(\.threads).prefix(Self.recentCount))).map(\.ref))
    if !grouped.groups.isEmpty {
      DrawerSectionLabel("Recents", detail: model.staleMachines.isEmpty ? nil : "Updating")
      ForEach(grouped.groups, id: \.label) { group in
        let rows = group.threads.filter { visible.contains($0.ref) }
        if !rows.isEmpty {
          SectionHeader(group.label, count: rows.count)
            .padding(.horizontal, WeaveSpacing.s4)
          ForEach(rows) { thread in
            let target = ChatTarget.thread(thread.ref)
            WeaveRow(thread.title, subtitle: thread.identity.label + "\n" + thread.placement.subtitle(), titleLineLimit: 1, subtitleLineLimit: 2, action: { router.open(target) }) {
              ThreadIdentityMarks(identity: thread.identity)
            } trailing: {
              RecentThreadGlyph(thread: thread)
            }
            .accessibilityValue(RecentThreadGlyph.spoken(thread))
            .drawerSelection(isSelected(target))
          }
        }
      }
      if model.recentThreads.count > Self.recentCount {
        foldButton(showAllRecents ? "Show fewer chats" : "Show all \(model.recentThreads.count) chats", open: showAllRecents) { showAllRecents.toggle() }
      }
    }
  }

  // MARK: Machines

  @ViewBuilder private var machinesSection: some View {
    if !model.machines.isEmpty {
      DrawerSectionLabel("Machines")
      ForEach(model.machines) { machine in
        WeaveRow(machine.displayName, titleLineLimit: 1, action: { router.push(.machine(machine.id)) }) {
          MachineBadge(status: machine.displayStatus, size: 18)
            .frame(width: 28)
            .accessibilityHidden(true)
        } trailing: {
          WeaveRowTrailingText(machine.statusLabel)
        }
        .accessibilityIdentifier("drawer.machine")
      }
    }
  }

  // MARK: Bottom bar

  private var bottomBar: some View {
    HStack(spacing: WeaveSpacing.s3) {
      WeaveIconButton("gearshape", label: "Settings", size: 48) {
        router.sheet = .globalSettings
      }
      Spacer(minLength: 0)
      Button(action: newChat) {
        Label("New chat", systemImage: "plus")
          .font(.weave(.headline, weight: .medium))
          .foregroundStyle(Color.weave.canvas)
          .lineLimit(1)
          .padding(.horizontal, WeaveSpacing.s4 + 2)
          .frame(minHeight: 48)
          .background(Color.weave.ink, in: Capsule())
          .contentShape(Capsule())
      }
      .buttonStyle(PressableStyle())
      .disabled(model.machines.isEmpty)
    }
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.top, WeaveSpacing.s6)
    .padding(.bottom, WeaveSpacing.s2)
    .background {
      // Fades in over the top padding and is solid behind the buttons, so rows
      // scrolling underneath never show between them.
      VStack(spacing: 0) {
        LinearGradient(colors: [Color.weave.sunken.opacity(0), Color.weave.sunken], startPoint: .top, endPoint: .bottom)
          .frame(height: WeaveSpacing.s6)
        Color.weave.sunken
      }
      .ignoresSafeArea(edges: .bottom)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  /// Opens Aide, or the composer of the current project when there is no Aide.
  private func newChat() {
    let target: ChatTarget?
    if let aide = model.aide, !aide.archived {
      target = .aide(aide.ref)
    } else if let current = router.landing(in: model), current.projectRef != nil {
      target = current
    } else {
      target = model.projects.first(where: { !$0.archived && !$0.isAutomated }).map { .project($0.ref) }
    }
    guard let target else {
      router.isDrawerOpen = false
      return
    }
    router.pendingComposerFocus = target
    router.open(target)
  }

  private func isSelected(_ target: ChatTarget) -> Bool {
    router.main.path.isEmpty && router.landing(in: model) == target
  }
}

/// A drawer group label in sentence case, with an optional note after it.
struct DrawerSectionLabel: View {
  let title: String
  let detail: String?

  init(_ title: String, detail: String? = nil) {
    self.title = title
    self.detail = detail
  }

  var body: some View {
    Group {
      if let detail {
        HStack(spacing: WeaveSpacing.s2) {
          Text(title)
          Spacer(minLength: 0)
          HStack(spacing: WeaveSpacing.s1) {
            ProgressView()
              .controlSize(.mini)
            Text(detail)
              .font(.weave(.caption))
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(detail)")
      } else {
        Text(title)
      }
    }
    .font(.weave(.callout))
    .foregroundStyle(Color.weave.muted)
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.top, WeaveSpacing.s6)
    .padding(.bottom, WeaveSpacing.s1)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityAddTraits(.isHeader)
  }
}

/// Working spinner, unread dot and offline ring for a project row.
struct ProjectStatusGlyphs: View {
  let project: ProjectSummary

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      if project.workingCount > 0 {
        ProgressView()
          .controlSize(.small)
          .tint(Color.weave.iris)
          .accessibilityHidden(true)
      }
      if project.hasUnread { UnreadDot() }
      if !project.machineOnline {
        StatusDot(.offline)
          .accessibilityHidden(true)
      }
    }
  }

  static func spoken(_ project: ProjectSummary) -> String {
    var parts: [String] = []
    if project.workingCount > 0 { parts.append("\(project.workingCount) working") }
    if project.hasUnread { parts.append("Unread") }
    if project.paused { parts.append("Paused") }
    if !project.machineOnline { parts.append("\(project.machineLabel) offline") }
    return parts.joined(separator: ", ")
  }
}

/// The leading icon and trailing status of a recent thread.
struct RecentThreadGlyph: View {
  let thread: ThreadSummary

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      if thread.isUnread, thread.activity == .idle || thread.isUnknown { UnreadDot() }
      switch thread.isUnknown ? .idle : thread.activity {
      case .needsYou: StatusDot(.needsYou).accessibilityHidden(true)
      case .working: StatusDot(.working).accessibilityHidden(true)
      case .failed:
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(Color.weave.fail)
          .accessibilityHidden(true)
      case .idle: EmptyView()
      }
    }
  }

  static func symbol(for thread: ThreadSummary) -> String {
    if thread.isUnknown { return "questionmark.circle" }
    return switch thread.activity {
    case .needsYou: "hand.raised"
    case .working: "ellipsis.bubble"
    case .failed: "exclamationmark.bubble"
    case .idle: thread.isPinned ? "pin" : "bubble.left"
    }
  }

  static func tint(for thread: ThreadSummary) -> Color? {
    thread.activity == .idle || thread.isUnknown ? Color.weave.muted : Color.weave.ink
  }

  static func spoken(_ thread: ThreadSummary) -> String {
    var parts = [thread.isUnknown ? "Unknown" : thread.activity.label]
    parts.append(ProjectOverviewView.spokenPlacement(thread.placement))
    if let project = thread.projectTitle { parts.append(project) }
    if thread.isUnread { parts.append("Unread") }
    if thread.isPinned { parts.append("Pinned") }
    return parts.joined(separator: ", ")
  }
}

extension View {
  /// Marks the drawer row of the screen that is showing.
  func drawerSelection(_ isSelected: Bool) -> some View {
    self
      .background {
        if isSelected {
          RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous)
            .fill(Color.weave.panel)
            .padding(.horizontal, WeaveSpacing.s2)
        }
      }
      .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}
