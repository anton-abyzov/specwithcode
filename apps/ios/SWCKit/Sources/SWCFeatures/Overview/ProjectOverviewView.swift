import SwiftUI
import SWCSync
import Weave

/// A project's threads grouped by what they need: you, time, or nothing.
struct ProjectOverviewView: View {
  let project: ProjectRef

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(StackNavigator.self) private var nav
  @State private var searching = false
  @State private var query = ""
  @State private var showResolved = false
  @FocusState private var searchFocused: Bool

  var body: some View {
    let groups = ThreadGroups(model.threads(in: project), query: searching ? query : "")
    List {
      if searching { searchField.plainListRow() }
      if let machine = model.machine(project.environmentId), machine.isStale {
        Banner("Catching up with \(machine.label). Threads may be a little behind for a moment.", kind: .info)
          .padding(.horizontal, WeaveSpacing.gutter)
          .padding(.vertical, WeaveSpacing.s2)
          .plainListRow()
      }
      if groups.isEmpty {
        emptyState.plainListRow()
      } else {
        section("Needs you", groups.needsYou)
        section("Working", groups.working)
        section("Idle", groups.idle)
        if !groups.resolved.isEmpty {
          resolvedToggle(count: groups.resolved.count).plainListRow()
          if showResolved || searching {
            ForEach(groups.resolved) { row($0) }
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
        HeaderTitle(title: "Threads", subtitle: model.project(project)?.title)
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

  @ViewBuilder private func section(_ title: String, _ threads: [ThreadSummary]) -> some View {
    if !threads.isEmpty {
      SectionHeader(title, count: threads.count)
        .padding(.horizontal, WeaveSpacing.s6)
        .padding(.top, WeaveSpacing.s3)
        .plainListRow()
      ForEach(threads) { row($0) }
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

  private func row(_ thread: ThreadSummary) -> some View {
    WeaveRow(thread.title, subtitle: meta(thread), titleLineLimit: 1, subtitleLineLimit: 1, insets: WeaveRowInsets.list, action: { nav.push(.chat(.thread(thread.ref))) }) {
      EmptyView()
    } trailing: {
      HStack(spacing: WeaveSpacing.s2) {
        if thread.isPinned {
          Image(systemName: "pin.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.weave.control)
            .accessibilityHidden(true)
        }
        if thread.isUnread { UnreadDot() }
        if thread.activity == .failed, !thread.isResolved {
          Image(systemName: "exclamationmark.triangle")
            .font(.system(size: 14, weight: .regular))
            .foregroundStyle(Color.weave.fail)
            .accessibilityHidden(true)
        }
        MachineBadge(status: thread.machineOnline ? .online : .offline)
          .accessibilityHidden(true)
      }
    }
    .accessibilityLabel(Self.spokenLabel(thread))
    .accessibilityValue(Self.spoken(thread))
    .plainListRow()
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        perform(thread.isPinned ? .unpin : .pin, on: thread.ref)
      } label: {
        Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin")
      }
      .tint(Color.weave.iris)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button {
        perform(thread.isResolved ? .unresolve : .resolve, on: thread.ref)
      } label: {
        Label(thread.isResolved ? "Reopen" : "Resolve", systemImage: thread.isResolved ? "arrow.uturn.backward.circle" : "checkmark.circle")
      }
      .tint(Color.weave.pass)
    }
  }

  private func meta(_ thread: ThreadSummary) -> String {
    switch thread.activity {
    case .working where !thread.isResolved:
      var parts = [Elapsed.short(since: thread.workStartedAt ?? thread.updatedAt)]
      if let plan = thread.planProgress { parts.append("\(plan.completed)/\(plan.total) tasks") }
      return parts.joined(separator: " · ")
    case .failed where !thread.isResolved:
      return "Failed" + (thread.preview.map { " · \($0)" } ?? "")
    default:
      return thread.preview ?? Elapsed.short(since: thread.updatedAt)
    }
  }

  /// The title plus any preview. The visual meta abbreviates ("2m", "3/5
  /// tasks"), which speech reads as units and fractions; status and time are
  /// spoken in full in the value instead.
  static func spokenLabel(_ thread: ThreadSummary) -> String {
    if thread.activity == .working, !thread.isResolved { return thread.title }
    guard let preview = thread.preview, !preview.isEmpty else { return thread.title }
    return "\(thread.title), \(preview)"
  }

  static func spoken(_ thread: ThreadSummary, now: Date = .now) -> String {
    var parts = [thread.isResolved ? "Resolved" : thread.activity.label]
    if thread.activity == .working, !thread.isResolved {
      parts.append("for \(Elapsed.spoken(since: thread.workStartedAt ?? thread.updatedAt, now: now))")
      if let plan = thread.planProgress { parts.append("\(plan.completed) of \(plan.total) tasks done") }
    } else if thread.preview?.isEmpty ?? true {
      parts.append("updated \(Elapsed.spoken(since: thread.updatedAt, now: now)) ago")
    }
    if thread.isUnread { parts.append("Unread") }
    if thread.isPinned { parts.append("Pinned") }
    parts.append("\(thread.machineLabel) \(thread.machineOnline ? "online" : "offline")")
    return parts.joined(separator: ", ")
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
      EmptyState(systemName: "magnifyingglass", title: "No matches", message: "No thread matches \u{201C}\(query)\u{201D}.")
        .frame(maxWidth: .infinity)
        .padding(.top, WeaveSpacing.s8)
    } else {
      EmptyState(systemName: "bubble.left.and.bubble.right", title: "No threads yet", message: "Threads this project starts show up here.")
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
