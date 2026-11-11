import SwiftUI
import SWCSync
import Weave

/// A project's threads grouped by what they need: you, time, or nothing.
struct ProjectOverviewView: View {
  let project: ProjectRef
  /// The personal assistant says topics; a project says threads.
  private var isAssistant: Bool { model.project(project)?.kind == .personal }

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(StackNavigator.self) private var nav
  @State private var searching = false
  @State private var query = ""
  @State private var showResolved = false
  /// The machine the threads are narrowed to, by name, or nil for all of them.
  @State private var machine: String?
  @FocusState private var searchFocused: Bool

  var body: some View {
    let all = model.threads(in: project)
    let machines = model.project(project).map { model.threadMachines(of: $0, threads: all) } ?? []
    let picked = ThreadMachineFilter.active(machine, in: machines)
    let groups = ThreadGroups(picked.map { name in all.filter { $0.runs(on: name) } } ?? all, query: searching ? query : "")
    List {
      if searching { searchField.plainListRow() }
      LinkedCoordinatorBanner(project: project)
        .padding(.horizontal, WeaveSpacing.gutter)
        .plainListRow()
      if machines.count > 1 {
        ThreadMachineFilter(machines: machines, selection: Binding(get: { picked }, set: { machine = $0 }))
          .padding(.horizontal, WeaveSpacing.gutter)
          .padding(.vertical, WeaveSpacing.s1)
          .plainListRow()
      }
      if let machine = model.machine(project.environmentId), machine.isStale {
        Banner("Catching up with \(machine.label). \(isAssistant ? "Topics" : "Threads") may be a little behind for a moment.", kind: .info)
          .padding(.horizontal, WeaveSpacing.gutter)
          .padding(.vertical, WeaveSpacing.s2)
          .plainListRow()
      }
      if groups.isEmpty {
        emptyState.plainListRow()
      } else {
        // One machine says nothing a row needs; several make it the question.
        let showsMachine = machines.count > 1
        section("Needs you", groups.needsYou, showsMachine: showsMachine)
        section("Working", groups.working, showsMachine: showsMachine)
        section("Offline", groups.offline, showsMachine: showsMachine)
        section("Idle", groups.idle, showsMachine: showsMachine)
        if !groups.resolved.isEmpty {
          resolvedToggle(count: groups.resolved.count).plainListRow()
          if showResolved || searching {
            ForEach(groups.resolved) { row($0, showsMachine: showsMachine) }
          }
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .scrollDismissesKeyboard(.interactively)
    .environment(\.defaultMinListRowHeight, 0)
    .refreshable {
      // Pulling only asks the machine connection to come back if it dropped.
      model.wakeMachine(project.environmentId)
      try? await Task.sleep(for: .milliseconds(600))
    }
    .screenChrome {
      ScreenHeader {
        BackButton()
      } center: {
        HeaderTitle(title: isAssistant ? "Topics" : "Threads", subtitle: model.project(project)?.title)
      } trailing: {
        WeaveIconButton(searching ? "xmark" : "magnifyingglass", label: searching ? "Close search" : "Search threads") {
          withAnimation(.snappy) {
            searching.toggle()
            if !searching { query = "" }
          }
          searchFocused = searching
        }
      }
    }
  }

  // MARK: Sections

  @ViewBuilder private func section(_ title: String, _ threads: [ThreadSummary], showsMachine: Bool) -> some View {
    if !threads.isEmpty {
      SectionHeader(title, count: threads.count)
        .padding(.horizontal, WeaveSpacing.s6)
        .padding(.top, WeaveSpacing.s3)
        .plainListRow()
      ForEach(threads) { row($0, showsMachine: showsMachine) }
    }
  }

  private func resolvedToggle(count: Int) -> some View {
    Button {
      withAnimation(.snappy) { showResolved.toggle() }
    } label: {
      HStack(spacing: WeaveSpacing.s2) {
        Text("Resolved (\(count))")
          .font(.weave(.callout))
          .lineLimit(1)
        Image(systemName: showResolved || searching ? "chevron.up" : "chevron.down")
          .font(.system(size: 12, weight: .semibold))
          .accessibilityHidden(true)
        WeaveDivider()
      }
      .foregroundStyle(Color.weave.muted)
      .padding(.horizontal, WeaveSpacing.s6)
      .padding(.top, WeaveSpacing.s3)
      .frame(minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Resolved, \(count)")
    .accessibilityValue(showResolved ? "Expanded" : "Collapsed")
    .accessibilityAddTraits(.isHeader)
  }

  private func row(_ thread: ThreadSummary, showsMachine: Bool) -> some View {
    WeaveRow(thread.title, subtitle: thread.identity.label, note: Self.note(thread, showsMachine: showsMachine), titleLineLimit: 1, subtitleLineLimit: 1, insets: WeaveRowInsets.list, action: { nav.push(.chat(.thread(thread.ref))) }) {
      ThreadIdentityMarks(identity: thread.identity)
    } trailing: {
      HStack(spacing: WeaveSpacing.s2) {
        if let age = Self.age(thread) {
          Text(age)
            .font(.weave(.caption))
            .monospacedDigit()
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
        }
        if thread.isPinned {
          Image(systemName: "pin.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.weave.control)
            .accessibilityHidden(true)
        }
        if thread.isUnread { UnreadDot() }
        if thread.asksForAccess, thread.activity == .needsYou, !thread.isUnknown {
          Image(systemName: "hand.raised")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Color.weave.warn)
            .accessibilityHidden(true)
        }
        if thread.activity == .failed, !thread.isResolved, !thread.isUnknown {
          Image(systemName: "exclamationmark.triangle")
            .font(.system(size: 14, weight: .regular))
            .foregroundStyle(Color.weave.fail)
            .accessibilityHidden(true)
        }
        // Offline when the machine that answers for the thread is out, even if it lives elsewhere.
        MachineBadge(status: thread.machineOnline && !thread.isUnknown ? .online : thread.machineSettling ? .connecting : .offline)
          .accessibilityHidden(true)
      }
    }
    .accessibilityLabel(Self.spokenLabel(thread) + ", " + thread.identity.label)
    .accessibilityValue(Self.spoken(thread))
    .plainListRow()
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        perform(thread.isPinned ? .unpin : .pin, on: thread.ref)
      } label: {
        Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash.fill" : "pin.fill")
          .labelStyle(.iconOnly)
      }
      .tint(Color.weave.iris)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button {
        perform(thread.isResolved ? .unresolve : .resolve, on: thread.ref)
      } label: {
        Label(thread.isResolved ? "Reopen" : "Resolve", systemImage: thread.isResolved ? "arrow.uturn.backward.circle.fill" : "checkmark.circle.fill")
          .labelStyle(.iconOnly)
      }
      .tint(Color.weave.pass)
    }
  }

  /// The line under "Claude Code · Opus 5.5", only when the thread has
  /// something to say: where it runs when that tells threads apart (the
  /// project spans machines, the thread runs away from home, or its machine is
  /// unreachable), then its plan while it works, why it failed or what it
  /// waits for. A quiet thread on the project's only machine has none.
  static func note(_ thread: ThreadSummary, showsMachine: Bool, now: Date = .now) -> String? {
    let machine = showsMachine || thread.placement.runsOn != nil || thread.isUnknown ? thread.placement.label : nil
    let parts = [machine, status(thread, now: now)].compactMap(\.self).filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private static func status(_ thread: ThreadSummary, now: Date) -> String? {
    if thread.isUnknown { return thread.placement.unknownLabel(now: now) }
    switch thread.activity {
    case .working where !thread.isResolved:
      return thread.planProgress.map { "\($0.completed)/\($0.total) tasks" }
    case .failed where !thread.isResolved:
      return "Failed" + (thread.preview.map { " · \($0)" } ?? "")
    default:
      return thread.preview
    }
  }

  /// "28m" at the row's edge: how long it has worked, else how long since it
  /// last changed. Nothing while its machine is unreachable; the note says when it was last seen.
  static func age(_ thread: ThreadSummary, now: Date = .now) -> String? {
    if thread.isUnknown { return nil }
    let working = thread.activity == .working && !thread.isResolved
    return Elapsed.short(since: working ? thread.workStartedAt ?? thread.updatedAt : thread.updatedAt, now: now)
  }

  /// The title plus any preview. The visual row abbreviates ("2m", "3/5
  /// tasks"), which speech reads as units and fractions; status and time are
  /// spoken in full in the value instead.
  static func spokenLabel(_ thread: ThreadSummary) -> String {
    if thread.isUnknown || (thread.activity == .working && !thread.isResolved) { return thread.title }
    guard let preview = thread.preview, !preview.isEmpty else { return thread.title }
    return "\(thread.title), \(preview)"
  }

  static func spoken(_ thread: ThreadSummary, now: Date = .now) -> String {
    if !thread.isResolved, let unknown = thread.placement.unknownLabel(now: now) {
      return [Self.spokenPlacement(thread.placement), unknown.replacingOccurrences(of: " · ", with: ", ")].joined(separator: ", ")
    }
    var parts = [thread.isResolved ? "Resolved" : thread.activity.label]
    if thread.activity == .working, !thread.isResolved {
      parts.append("for \(Elapsed.spoken(since: thread.workStartedAt ?? thread.updatedAt, now: now))")
      if let plan = thread.planProgress { parts.append("\(plan.completed) of \(plan.total) tasks done") }
    } else if thread.preview?.isEmpty ?? true {
      parts.append("updated \(Elapsed.spoken(since: thread.updatedAt, now: now)) ago")
    }
    if thread.isUnread { parts.append("Unread") }
    if thread.isPinned { parts.append("Pinned") }
    parts.append(Self.spokenPlacement(thread.placement) + (thread.machineOnline ? " online" : thread.machineSettling ? " connecting" : " offline"))
    return parts.joined(separator: ", ")
  }

  /// "M4", or "M4, running on Minis".
  static func spokenPlacement(_ placement: ThreadPlacement) -> String {
    guard let runsOn = placement.runsOn else { return placement.owner }
    return "\(placement.owner), running on \(runsOn)"
  }

  // MARK: Search and empty

  private var searchField: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(Color.weave.muted)
        .accessibilityHidden(true)
      TextField("Search threads", text: $query, prompt: .weavePlaceholder("Search threads"))
        .font(.weave(.body))
        .foregroundStyle(Color.weave.ink)
        .focused($searchFocused)
        .submitLabel(.search)
        .autocorrectionDisabled()
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .frame(minHeight: WeaveSize.control)
    .weaveGlass(in: Capsule())
    // The whole capsule focuses the field, not just its text line, so it can
    // be refocused after scrolling dismissed the keyboard.
    .contentShape(Capsule())
    .onTapGesture { searchFocused = true }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.vertical, WeaveSpacing.s2)
  }

  @ViewBuilder private var emptyState: some View {
    if searching, !query.isEmpty {
      EmptyState(systemName: "magnifyingglass", title: "No matches", message: "No \(isAssistant ? "topic" : "thread") matches \u{201C}\(query)\u{201D}.")
        .frame(maxWidth: .infinity)
        .padding(.top, WeaveSpacing.s8)
    } else {
      EmptyState(systemName: "bubble.left.and.bubble.right", title: isAssistant ? "No topics yet" : "No threads yet", message: isAssistant ? "Topics you ask \(model.project(project)?.title ?? "your assistant") for show up here." : "Threads this project starts show up here.")
        .frame(maxWidth: .infinity)
        .padding(.top, WeaveSpacing.s8)
    }
  }

  private func perform(_ action: ThreadAction, on thread: ThreadRef) {
    Task {
      do {
        try await model.engine.perform(action, on: thread)
      } catch {
        router.showError(error)
      }
    }
  }
}

extension View {
  /// A list row without insets, separators or a background.
  func plainListRow() -> some View {
    self
      .listRowInsets(EdgeInsets())
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
  }
}
