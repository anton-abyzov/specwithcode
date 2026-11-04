import SwiftUI
import SWCSync
import Weave

/// Swipe and long-press actions for a thread row in the sidebar or drawer,
/// as in Mail and Messages: swipe right to pin, swipe left to resolve or mark
/// unread, press and hold for the full menu. Destructive actions stay in the
/// thread's own menu, where they ask first.
struct ThreadRowActions: ViewModifier {
  let thread: ThreadSummary

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  func body(content: Content) -> some View {
    content
      .swipeActions(edge: .leading, allowsFullSwipe: true) {
        Button { perform(thread.isPinned ? .unpin : .pin) } label: {
          Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash.fill" : "pin.fill")
            .labelStyle(.iconOnly)
        }
        .tint(Color.weave.iris)
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: true) {
        Button { perform(thread.isResolved ? .unresolve : .resolve) } label: {
          Label(thread.isResolved ? "Reopen" : "Resolve", systemImage: thread.isResolved ? "arrow.uturn.backward.circle.fill" : "checkmark.circle.fill")
            .labelStyle(.iconOnly)
        }
        .tint(Color.weave.pass)
        Button { perform(.markUnread) } label: {
          Label("Unread", systemImage: "envelope.badge.fill")
            .labelStyle(.iconOnly)
        }
        .tint(WeaveTint.color("sky"))
      }
      .contextMenu {
        Button("Open", systemImage: "arrow.up.forward") { router.open(.thread(thread.ref)) }
        Button(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin") {
          perform(thread.isPinned ? .unpin : .pin)
        }
        Button("Mark unread", systemImage: "envelope.badge") { perform(.markUnread) }
        Button(thread.isResolved ? "Reopen" : "Resolve", systemImage: thread.isResolved ? "arrow.uturn.backward.circle" : "checkmark.circle") {
          perform(thread.isResolved ? .unresolve : .resolve)
        }
        Divider()
        Button("Copy ID", systemImage: "doc.on.doc") {
          WeaveClipboard.copy(thread.ref.threadId)
          router.toast = WeaveToastMessage("Copied", kind: .pass, systemImage: "doc.on.doc")
        }
      }
  }

  private func perform(_ action: ThreadAction) {
    Task {
      do {
        try await model.engine.perform(action, on: thread.ref)
        switch action {
        case .markUnread: router.toast = WeaveToastMessage("Marked unread", kind: .info, systemImage: "envelope.badge")
        case .resolve: router.toast = WeaveToastMessage("Resolved", kind: .pass)
        default: break
        }
      } catch {
        router.showError(error)
      }
    }
  }
}

/// Long-press menu and swipe for a project row: open it, see its threads, or
/// rename it and change its icon in one sheet.
struct ProjectRowActions: ViewModifier {
  let project: ProjectSummary

  @Environment(AppRouter.self) private var router

  func body(content: Content) -> some View {
    content
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button { router.sheet = .projectSettings(project.ref) } label: {
          Label("Edit", systemImage: "pencil")
            .labelStyle(.iconOnly)
        }
        .tint(Color.weave.iris)
        Button { router.push(.overview(project.ref)) } label: {
          Label("Threads", systemImage: "bubble.left.and.bubble.right.fill")
            .labelStyle(.iconOnly)
        }
        .tint(WeaveTint.color("sky"))
      }
      .contextMenu {
        Button("Open coordinator", systemImage: "arrow.up.forward") { router.open(.project(project.ref)) }
        Button("Threads", systemImage: "bubble.left.and.bubble.right") { router.push(.overview(project.ref)) }
        Divider()
        Button("Rename or change icon…", systemImage: "pencil") { router.sheet = .projectSettings(project.ref) }
      } preview: {
        HStack(spacing: WeaveSpacing.s3) {
          ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(project.title)
              .font(.weave(.headline, weight: .semibold))
              .foregroundStyle(Color.weave.ink)
            Text(project.machineLabel)
              .font(.weave(.footnote))
              .foregroundStyle(Color.weave.muted)
          }
        }
        .padding(WeaveSpacing.s4)
        .frame(minWidth: 240, alignment: .leading)
        .background(Color.weave.canvas)
      }
  }
}

extension View {
  func threadRowActions(_ thread: ThreadSummary) -> some View { modifier(ThreadRowActions(thread: thread)) }
  func projectRowActions(_ project: ProjectSummary) -> some View { modifier(ProjectRowActions(project: project)) }
}
