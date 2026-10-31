import SwiftUI
import SWCSync
import Weave

/// The expanded layout's navigation column: Aide, projects, recent threads and
/// machines in a native sidebar list. Selection reads from and writes to the
/// router, the same state the compact drawer uses.
struct SidebarView: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var showAllProjects = false
  @State private var showAllRecents = false
  @State private var showAutomated = false
  @State private var showArchived = false
  @State private var settingUpAide = false

  private static let collapsedProjectCount = 8
  private static let recentCount = 12

  var body: some View {
    @Bindable var router = router
    Group {
      if router.isDrawerSearching {
        DrawerSearchView(isPresented: $router.isDrawerSearching)
          .padding(.top, WeaveSpacing.s2)
      } else {
        list
      }
    }
    .navigationTitle("SpecWithCode")
    #if os(iOS)
    .navigationBarTitleDisplayMode(.large)
    .toolbar(router.isDrawerSearching ? .hidden : .automatic, for: .navigationBar)
    #endif
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          withAnimation(.snappy) { router.isDrawerSearching = true }
        } label: {
          Label("Search projects and threads", systemImage: "magnifyingglass")
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if !router.isDrawerSearching { bottomBar }
    }
    .background(Color.weave.sunken.ignoresSafeArea())
    .overlay(alignment: .trailing) {
      // Hairline between the sidebar and the chat, as in iPad split views.
      Rectangle()
        .fill(Color.weave.line)
        .frame(width: 1 / 3)
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
    .tint(Color.weave.iris)
  }

  private var list: some View {
    List {
      aideSection
      projectsSection
      recentsSection
      machinesSection
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .environment(\.defaultMinListRowHeight, WeaveSize.minTap)
  }

  // MARK: Aide

  @ViewBuilder private var aideSection: some View {
    if let aide = model.aide, !aide.archived {
      Section {
        SidebarRow(title: "Aide") {
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
    let projects = model.pinnedProjects + model.otherProjects
    let automated = model.automatedProjects
    let archived = model.archivedProjects
    if !projects.isEmpty || !automated.isEmpty || !archived.isEmpty {
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

  private func projectRow(_ project: ProjectSummary, shared: Set<String>) -> some View {
    SidebarRow(title: project.title, subtitle: shared.contains(project.title.lowercased()) ? project.machineLabel : nil) {
      ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 24, style: .plain)
    } trailing: {
      ProjectStatusGlyphs(project: project)
    }
    .accessibilityValue(ProjectStatusGlyphs.spoken(project))
    .sidebarItem(.chat(.project(project.ref)))
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
    let grouped = RecentChatGroups(model.recentThreads)
    let all = grouped.groups.flatMap(\.threads)
    let visible = Set((showAllRecents ? all : Array(all.prefix(Self.recentCount))).map(\.ref))
    ForEach(Array(grouped.groups.enumerated()), id: \.element.label) { index, group in
      let rows = group.threads.filter { visible.contains($0.ref) }
      if !rows.isEmpty {
        Section {
          ForEach(rows) { thread in
            SidebarRow(title: thread.title, subtitle: thread.projectTitle.map { "\($0) · \(thread.identity.label)" } ?? thread.identity.label) {
              ThreadIdentityMarks(identity: thread.identity)
            } trailing: {
              RecentThreadGlyph(thread: thread)
            }
            .accessibilityValue(RecentThreadGlyph.spoken(thread))
            .sidebarItem(.chat(.thread(thread.ref)))
          }
          if group.label == grouped.groups.last(where: { g in g.threads.contains { visible.contains($0.ref) } })?.label,
             model.recentThreads.count > Self.recentCount {
            foldButton(showAllRecents ? "Show fewer chats" : "Show all \(model.recentThreads.count) chats") { showAllRecents.toggle() }
          }
        } header: {
          if index == 0 {
            SidebarRecentsHeader(group: group.label, updating: !model.staleMachines.isEmpty)
          } else {
            Text(group.label)
          }
        }
      }
    }
  }

  // MARK: Machines

  @ViewBuilder private var machinesSection: some View {
    if !model.machines.isEmpty {
      Section("Machines") {
        ForEach(model.machines) { machine in
          SidebarRow(title: machine.displayName) {
            MachineBadge(status: machine.displayStatus, size: 18)
          } trailing: {
            Text(machine.statusLabel)
              .font(.weave(.footnote))
              .foregroundStyle(Color.weave.muted)
          }
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
      Button { router.startNewChat(in: model) } label: {
        Label("New chat", systemImage: "square.and.pencil")
          .font(.weave(.headline, weight: .medium))
          .foregroundStyle(Color.weave.canvas)
          .lineLimit(1)
          .padding(.horizontal, WeaveSpacing.s4)
          .frame(minHeight: 44)
          .background(Color.weave.ink, in: Capsule())
          .contentShape(Capsule())
      }
      .buttonStyle(PressableStyle())
      .disabled(model.machines.isEmpty)
    }
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s2)
    .background {
      VStack(spacing: 0) {
        LinearGradient(colors: [Color.weave.sunken.opacity(0), Color.weave.sunken], startPoint: .top, endPoint: .bottom)
          .frame(height: WeaveSpacing.s4)
        Color.weave.sunken
      }
      .padding(.top, -WeaveSpacing.s4)
      .ignoresSafeArea(edges: .bottom)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
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
      .listRowInsets(EdgeInsets(top: 0, leading: WeaveSpacing.s4, bottom: 0, trailing: WeaveSpacing.s4))
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
            .lineLimit(1)
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

/// The first recents header: "Recents", the day group and a sync note.
private struct SidebarRecentsHeader: View {
  let group: String
  let updating: Bool

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Text("Recents · \(group)")
      Spacer(minLength: 0)
      if updating {
        ProgressView().controlSize(.mini)
        Text("Updating")
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(updating ? "Recents, \(group), Updating" : "Recents, \(group)")
  }
}
