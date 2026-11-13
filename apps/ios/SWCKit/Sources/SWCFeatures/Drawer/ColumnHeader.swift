import SwiftUI
import SWCSync
import Weave

/// The top of the wide column, the same over the list and the coordinator:
/// hide the column, or over a coordinator choose which panes show; the
/// project you are in with a way back to all of them; and, with one of its
/// threads open, what the column holds beside it.
struct ColumnHeader<Actions: View, ModeTrailing: View>: View {
  @ViewBuilder let actions: Actions
  @ViewBuilder let modeTrailing: ModeTrailing
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      HStack(spacing: WeaveSpacing.s2) {
        if router.besideCoordinator(in: model) != nil {
          PaneSwitch()
        } else {
          WeaveIconButton("sidebar.left", label: "Hide sidebar") {
            router.isSidebarCollapsed = true
          }
          .accessibilityIdentifier("sidebar.collapse")
        }
        title
        Spacer(minLength: 0)
        actions
      }
      if router.openThreadCoordinator(in: model) != nil, !router.sidebarShowsAllProjects {
        // A narrow column scrolls the row rather than truncating the switch.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: WeaveSpacing.s2) {
            modes
            Spacer(minLength: 0)
            modeTrailing
          }
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: WeaveSpacing.s2) {
              modes
              modeTrailing
            }
          }
        }
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }

  private var currentTitle: String? {
    guard !router.sidebarShowsAllProjects else { return nil }
    if let scope = router.sidebarScope(in: model).flatMap({ model.project($0) }) { return scope.title }
    if case .aide? = router.besideCoordinator(in: model) { return "Percy" }
    return nil
  }

  @ViewBuilder private var title: some View {
    if let currentTitle {
      Button {
        withAnimation(.snappy) { router.sidebarShowsAllProjects = true }
      } label: {
        HStack(spacing: WeaveSpacing.s1) {
          Image(systemName: "chevron.left")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
          Text(currentTitle)
            .font(.weave(.headline, weight: .semibold))
            .foregroundStyle(Color.weave.ink)
            .lineLimit(1)
        }
        .frame(minHeight: WeaveSize.minTap)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("Back to all projects from \(currentTitle)")
      .accessibilityIdentifier("sidebar.all-projects")
    } else {
      Text("All projects")
        .font(.weave(.headline, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .lineLimit(1)
        .accessibilityAddTraits(.isHeader)
    }
  }

  private var waitingOnYou: Int {
    guard let scope = router.followedProject(in: model) else { return 0 }
    return ThreadGroups(model.threads(in: scope).filter { !$0.isResolved }).needsYou.count
  }

  private var modes: some View {
    HStack(spacing: WeaveSpacing.s1) {
      ColumnChip(selected: router.showsCoordinatorBeside) {
        withAnimation(.snappy) { router.showsCoordinatorBeside = true }
      } label: {
        Text("Coordinator").font(.weave(.callout, weight: .medium))
      }
      .accessibilityIdentifier("column.coordinator")
      ColumnChip(selected: !router.showsCoordinatorBeside) {
        withAnimation(.snappy) { router.showsCoordinatorBeside = false }
      } label: {
        HStack(spacing: WeaveSpacing.s1) {
          Text("Threads").font(.weave(.callout, weight: .medium))
          if waitingOnYou > 0 {
            Text("\(waitingOnYou)")
              .font(.weave(.caption, weight: .semibold))
              .foregroundStyle(Color.weave.warn)
          }
        }
      }
      .accessibilityValue(waitingOnYou > 0 ? needsYouLabel(waitingOnYou) : "")
      .accessibilityIdentifier("column.threads")
    }
  }
}

/// Coordinator only, both, or the screen beside it only, in one glass
/// capsule. The last choice is remembered; opening a thread brings both back.
struct PaneSwitch: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    let detail = router.landingCoordinator(in: model) == nil ? "Thread" : "Threads"
    HStack(spacing: 0) {
      choice(.column, symbol: "rectangle.lefthalf.inset.filled", label: "Coordinator only")
      choice(.both, symbol: "rectangle.split.2x1", label: "Coordinator and \(detail.lowercased())")
      choice(.detail, symbol: "rectangle.righthalf.inset.filled", label: "\(detail) only")
    }
    .padding(.horizontal, 2)
    .weaveGlass(in: Capsule(), interactive: true)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Panes")
    .accessibilityIdentifier("column.panes")
  }

  private func choice(_ panes: WidePanes, symbol: String, label: String) -> some View {
    // A thread that arrived while the coordinator had the whole width shows
    // beside it, so that choice no longer reads as selected.
    let current: WidePanes = router.showsColumnOnly(in: model) ? .column : router.widePanes == .detail ? .detail : .both
    let selected = current == panes
    return Button {
      withAnimation(.snappy) { router.choosePanes(panes, in: model) }
    } label: {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(selected ? Color.weave.iris : Color.weave.muted)
        .frame(width: 36, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(label)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("column.panes.\(panes.rawValue)")
  }
}

/// A capsule choice in the column: the machine, the status filter, the mode.
struct ColumnChip<Label: View>: View {
  let selected: Bool
  let action: () -> Void
  @ViewBuilder let label: Label

  var body: some View {
    Button(action: action) {
      label
        .foregroundStyle(selected ? Color.weave.ink : Color.weave.muted)
        .lineLimit(1)
        .padding(.horizontal, WeaveSpacing.s3)
        .frame(minHeight: WeaveSize.minTap)
        .background(selected ? Color.weave.line : Color.clear, in: Capsule())
        .contentShape(Capsule())
    }
    .buttonStyle(PressableStyle())
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// Search and New chat, in one glass capsule.
struct ColumnActions: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    HStack(spacing: 0) {
      action("magnifyingglass", label: "Search projects and threads") {
        withAnimation(.snappy) { router.isDrawerSearching = true }
      }
      action("plus", label: "New chat") { router.startNewChat(in: model) }
        .disabled(model.machines.isEmpty)
    }
    .padding(.horizontal, 2)
    .weaveGlass(in: Capsule(), interactive: true)
  }

  private func action(_ symbol: String, label: String, perform: @escaping () -> Void) -> some View {
    Button(action: perform) {
      Image(systemName: symbol)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(label)
  }
}
