import SwiftUI
import SWCSync
import Weave

/// Details of one thread, opened from its title.
struct ThreadInfoSheet: View {
  let thread: ThreadRef

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var copied = false

  var body: some View {
    let summary = model.thread(thread)
    let machine = model.machine(thread.environmentId)
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        Text(summary?.title ?? "Thread")
          .weaveFont(.title)
          .foregroundStyle(Color.weave.ink)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, WeaveSpacing.s4)
          .accessibilityAddTraits(.isHeader)
        GroupedCard(separatorInset: WeaveSpacing.s4) {
          if let project = summary?.projectTitle {
            WeaveRow("Project", trailingText: project)
          }
          WeaveRow("Machine", stacksTrailing: true) {
            EmptyView()
          } trailing: {
            MachineBadge(status: machine?.status.weaveStatus ?? .offline, label: machine?.label ?? summary?.machineLabel)
          }
          if let summary {
            WeaveRow("Status", trailingText: summary.isResolved ? "Resolved" : summary.activity.label)
            if let plan = summary.planProgress {
              WeaveRow("Tasks", trailingText: "\(plan.completed) of \(plan.total) done")
            }
            WeaveRow("Updated", trailingText: summary.updatedAt.formatted(.relative(presentation: .named)))
          }
          WeaveRow("ID", subtitle: thread.threadId, action: copyId) {
            EmptyView()
          } trailing: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
              .font(.system(size: 15, weight: .regular))
              .foregroundStyle(copied ? Color.weave.pass : Color.weave.muted)
              .accessibilityHidden(true)
          }
          .accessibilityHint("Copies the thread ID")
          .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
          }
        }
        if let preview = summary?.preview {
          VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
            FieldLabel("Latest")
            Text(preview)
              .weaveFont(.body)
              .foregroundStyle(Color.weave.ink)
              .textSelection(.enabled)
              .padding(WeaveSpacing.s4)
              .frame(maxWidth: .infinity, alignment: .leading)
              .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
          }
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .screenChrome {
      ScreenHeader {
        CloseButton()
      } center: {
        HeaderTitle(title: "Thread")
      } trailing: {
        EmptyView()
      }
    }
  }

  /// Announces the copy itself: the root toast draws beneath this sheet.
  private func copyId() {
    WeaveClipboard.copyAnnounced(thread.threadId)
    copied = true
  }
}
