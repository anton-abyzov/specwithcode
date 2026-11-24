import SwiftUI
import SWCSync
import Weave

/// What a thread's "…" menu can ask its chat to do.
enum ThreadMenuAction {
  case handoff, copyId, rename, archive, delete
  case perform(ThreadAction)
}

/// The "…" menu in a thread's header. Its own view with equal inputs skipping
/// the body: a menu rebuilt while it is open loses its scroll position, and
/// the chat around it redraws as a reply streams.
struct ThreadActionsMenu: View, Equatable {
  let thread: ThreadRef
  let isPinned: Bool
  let isResolved: Bool
  /// Percy's own threads stay on their machine.
  let offersHandoff: Bool
  let onAction: (ThreadMenuAction) -> Void

  nonisolated static func == (a: ThreadActionsMenu, b: ThreadActionsMenu) -> Bool {
    a.thread == b.thread && a.isPinned == b.isPinned && a.isResolved == b.isResolved && a.offersHandoff == b.offersHandoff
  }

  var body: some View {
    Menu {
      if offersHandoff {
        Button("Check handoff options…", systemImage: "arrow.right.arrow.left") { onAction(.handoff) }
          .accessibilityIdentifier("thread.handoff")
      }
      ChatDetailMenuSections(target: .thread(thread))
      Section {
        Button(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin") {
          onAction(.perform(isPinned ? .unpin : .pin))
        }
      }
      Section {
        Button("Copy ID", systemImage: "doc.on.doc") { onAction(.copyId) }
      }
      Section {
        Button("Rename…", systemImage: "pencil") { onAction(.rename) }
        Button(isResolved ? "Reopen" : "Resolve", systemImage: isResolved ? "arrow.uturn.backward.circle" : "checkmark.circle") {
          onAction(.perform(isResolved ? .unresolve : .resolve))
        }
        Button("Mark unread", systemImage: "envelope.badge") { onAction(.perform(.markUnread)) }
      }
      Section {
        Button("Archive", systemImage: "archivebox") { onAction(.archive) }
        Button("Delete", systemImage: "trash", role: .destructive) { onAction(.delete) }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .menuIndicator(.hidden)
    .buttonStyle(.plain)
    .accessibilityLabel("Thread actions")
  }
}
