import SwiftUI
import SWCSync
import Weave

/// The Agent replies and Show sections of a chat's menu. Show is kept on this
/// phone: under "This thread" a level is the open thread's own, under "Every
/// thread" it is the phone's default. Agent replies is the project's setting
/// on its machine, shown read-only when the phone cannot change it there.
/// The rule is docs/transcript-detail.md.
struct ChatDetailMenuSections: View {
  let target: ChatTarget

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    let detail = model.timelineDetail(for: target)
    let scope = model.timelineDetailScope(for: target)
    if let project = model.replyStyleProject(for: target), let reply = model.replyStyle(for: target) {
      let title = model.project(project)?.title
      Section(title.map { "Agent replies in \($0)" } ?? "Agent replies") {
        Picker("Agent replies", selection: Binding(get: { reply.style }, set: { choose($0, current: reply, for: project) })) {
          ForEach(ReplyStyle.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.menu)
        .disabled(!reply.canChange)
        .accessibilityLabel("Agent replies, \(reply.style.label)")
        .accessibilityHint(reply.readOnlyReason ?? "Tells this project's agents how to write")
        .accessibilityIdentifier("chat.reply-style")
        if let reason = reply.readOnlyReason {
          Text(reason)
        }
      }
    }
    Section("Show") {
      Picker("Show", selection: Binding(get: { detail }, set: { model.chooseTimelineDetail($0, scope: scope, in: target) })) {
        ForEach(TimelineDetail.allCases) { Text($0.label).tag($0) }
      }
      .pickerStyle(.menu)
      .accessibilityLabel("Show, \(detail.label)")
      .accessibilityIdentifier("chat.show")
      Picker("Applies to", selection: Binding(get: { scope }, set: { model.chooseTimelineDetailScope($0, in: target) })) {
        ForEach(TimelineDetailScope.allCases) { Text($0.label).tag($0) }
      }
      .pickerStyle(.menu)
      .accessibilityLabel("Applies to, \(scope.label)")
      .accessibilityIdentifier("chat.show-scope")
    }
  }

  private func choose(_ style: ReplyStyle, current: ReplyStyleState, for project: ProjectRef) {
    guard current.canChange, style != current.style else { return }
    Task {
      do {
        try await model.engine.setReplyStyle(style, for: project)
        router.toast = WeaveToastMessage("Agent replies: \(style.label)", kind: .pass)
      } catch {
        router.showError(error)
      }
    }
  }
}

/// The Show menu in a coordinator's or Percy's header, which has no thread
/// menu: the same sections as a thread's menu.
struct ChatShowMenuButton: View {
  let target: ChatTarget

  @Environment(AppModel.self) private var model

  /// "Agent replies: Concise. Show: Folded steps (this thread)", as the
  /// desktop's control reads; without a known reply style, Show alone.
  static func spokenLabel(reply: ReplyStyleState?, detail: TimelineDetail, scope: TimelineDetailScope) -> String {
    let show = "Show: \(detail.label)" + (scope == .thisThread ? " (this thread)" : "")
    guard let reply else { return show }
    return "Agent replies: \(reply.style.label). \(show)"
  }

  var body: some View {
    let detail = model.timelineDetail(for: target)
    let scope = model.timelineDetailScope(for: target)
    Menu {
      ChatDetailMenuSections(target: target)
    } label: {
      Image(systemName: "list.bullet.indent")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .menuIndicator(.hidden)
    .buttonStyle(.plain)
    .accessibilityLabel(Self.spokenLabel(reply: model.replyStyle(for: target), detail: detail, scope: scope))
    .accessibilityHint("Chooses how much of the agent's work this chat shows")
    .accessibilityIdentifier("chat.show-menu")
  }
}
