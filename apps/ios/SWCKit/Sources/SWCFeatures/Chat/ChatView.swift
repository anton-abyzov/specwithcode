import SwiftUI
import SWCSync
import Weave

/// A conversation with Aide, a project coordinator or a thread.
struct ChatView: View {
  let target: ChatTarget
  var isPushed = false
  @Environment(AppModel.self) private var model

  var body: some View {
    ChatScreen(target: target, session: model.session(for: target), isPushed: isPushed)
      .id(target)
  }
}

private struct ChatScreen: View {
  let target: ChatTarget
  let session: ChatSession
  let isPushed: Bool

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(StackNavigator.self) private var nav
  @Environment(\.dismiss) private var dismiss

  @FocusState private var composerFocused: Bool
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var isNearBottom = true
  @State private var busyRequests: Set<String> = []
  @State private var renaming = false
  @State private var renameText = ""
  @State private var confirmArchive = false
  @State private var confirmDelete = false

  var body: some View {
    transcript
      .edgeBar(.bottom) { composerArea }
      .screenChrome { header }
      .onAppear { model.openSession(session) }
      .onDisappear { model.closeSession(session) }
      .task(id: router.pendingComposerFocus) {
        guard router.pendingComposerFocus == target else { return }
        // Let the drawer finish closing before the keyboard comes up.
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        router.pendingComposerFocus = nil
        composerFocused = true
      }
      .alert("Rename thread", isPresented: $renaming) {
        TextField("Name", text: $renameText)
        Button("Rename") {
          let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
          if let thread = target.threadRef, !name.isEmpty { perform(.rename(name), on: thread) }
        }
        Button("Cancel", role: .cancel) {}
      }
      .confirmationDialog("Archive this thread?", isPresented: $confirmArchive, titleVisibility: .visible) {
        Button("Archive thread") { if let thread = target.threadRef { perform(.archive, on: thread) } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("It leaves your lists. You can find it again in SpecWithCode on \(session.machineLabel).")
      }
      .confirmationDialog("Delete this thread?", isPresented: $confirmDelete, titleVisibility: .visible) {
        Button("Delete thread", role: .destructive) { if let thread = target.threadRef { perform(.delete, on: thread) } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This removes the thread and its history from \(session.machineLabel). It can't be undone.")
      }
  }

  // MARK: Transcript

  private var transcript: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: WeaveSpacing.s4) {
        if !session.isLoaded {
          if showsOfflineTranscript {
            offlineTranscript
          } else {
            ProgressView()
              .frame(maxWidth: .infinity)
              .padding(.top, WeaveSpacing.s8)
              .accessibilityLabel("Loading messages")
          }
        } else if session.rows.isEmpty {
          if let error = session.loadError {
            loadFailedTranscript(error)
          } else {
            emptyTranscript
          }
        }
        ForEach(session.rows) { row in
          TranscriptRowView(
            row: row,
            busyRequests: busyRequests,
            onDecision: { requestId, decision in respond(requestId, decision) },
            onOpenThread: { nav.push(.chat(.thread($0))) }
          )
          .id(row.id)
        }
        if showsTyping {
          TypingIndicator()
            .padding(.leading, WeaveSpacing.contentInset - WeaveSpacing.gutter)
            .id(Self.typingId)
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s4)
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.visibleRect.maxY >= geometry.contentSize.height - 120
    } action: { _, nearBottom in
      isNearBottom = nearBottom
    }
    .onChange(of: tailSignature) {
      guard isNearBottom else { return }
      withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) }
    }
  }

  private static let typingId = "typing-indicator"

  private var emptyTranscript: some View {
    transcriptPlaceholder(title: emptyTitle, message: emptyMessage)
  }

  private var machineLabel: String { session.machineLabel.isEmpty ? "This machine" : session.machineLabel }

  /// The machine answered, but not with this conversation.
  private func loadFailedTranscript(_ error: String) -> some View {
    transcriptPlaceholder(
      title: "Couldn't load messages",
      message: error,
      actionTitle: "Try again",
      action: { model.engine.reload(session) }
    )
  }

  /// The machine is down and nothing has loaded: a spinner would spin until
  /// it comes back, so say so instead.
  private var showsOfflineTranscript: Bool {
    guard !session.isLoaded, session.rows.isEmpty else { return false }
    if let status = model.machine(target.environmentId)?.status { return !status.isOnline && !status.isConnecting }
    return !session.machineOnline
  }

  @ViewBuilder private var offlineTranscript: some View {
    let machineId = target.environmentId
    let machine = model.machine(machineId)
    switch machine?.status {
    case .needsRepair where machine?.needsSignIn == true:
      transcriptPlaceholder(
        title: "Sign in again",
        message: "This conversation loads once you sign in to SpecWithCode on this phone.",
        actionTitle: "Show machine",
        action: { nav.push(.machine(machineId)) }
      )
    case .needsRepair:
      transcriptPlaceholder(
        title: "Pair \(machineLabel) again",
        message: "This conversation loads once this phone is paired with it again.",
        actionTitle: "Show machine",
        action: { nav.push(.machine(machineId)) }
      )
    case .unsupported:
      transcriptPlaceholder(
        title: "Update SpecWithCode on \(machineLabel)",
        message: "This conversation loads once the machine runs a version this phone supports.",
        actionTitle: "Show machine",
        action: { nav.push(.machine(machineId)) }
      )
    default:
      if let other = reachableOrchestrator {
        // One machine being out never stops a project on several machines.
        transcriptPlaceholder(
          title: "\(machineLabel) is offline",
          message: "This orchestrator loads when \(machineLabel) reconnects. \(other.machineLabel)'s orchestrator for this project is available now.",
          actionTitle: "View on \(other.machineLabel)",
          action: { router.open(.project(other.ref)) }
        )
      } else {
        transcriptPlaceholder(
          title: "\(machineLabel) is offline",
          message: "This conversation loads when \(session.machineLabel.isEmpty ? "the machine" : session.machineLabel) reconnects.",
          actionTitle: "Reconnect",
          action: { model.engine.reconnect(machineId: machineId) }
        )
      }
    }
  }

  /// Another machine's copy of this project whose orchestrator is reachable.
  private var reachableOrchestrator: ProjectMember? {
    guard case let .project(ref) = target else { return nil }
    return model.project(ref)?.members.first { $0.ref != ref && $0.machineOnline }
  }

  private func transcriptPlaceholder(title: String, message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) -> some View {
    VStack(spacing: WeaveSpacing.s3) {
      Text(title)
        .weaveFont(.title)
        .foregroundStyle(Color.weave.ink)
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
      Text(message)
        .weaveFont(.callout)
        .foregroundStyle(Color.weave.muted)
        .multilineTextAlignment(.center)
      if let actionTitle, let action {
        WeaveButton(actionTitle, kind: .secondary, action: action)
          .padding(.top, WeaveSpacing.s2)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, WeaveSpacing.s6)
    .padding(.top, WeaveSpacing.s8 * 3)
  }

  private var emptyTitle: String {
    switch target {
    case .aide: "How can I help?"
    case .project: session.title
    case .thread: "No messages yet"
    }
  }

  private var emptyMessage: String {
    switch target {
    case .aide: "Ask a question or tell Aide what to start on your machines."
    case .project: "Tell the coordinator what to work on. It plans the work and starts threads."
    case .thread: "Messages you send here go to this thread on \(session.machineLabel)."
    }
  }

  /// Typing dots while a run is active and no reply is streaming yet.
  private var showsTyping: Bool {
    guard session.isRunning else { return false }
    if case let .assistant(_, streaming) = session.rows.last?.kind, streaming { return false }
    return true
  }

  /// Changes whenever the bottom of the transcript changes.
  private var tailSignature: String {
    var length = 0
    if let last = session.rows.last {
      switch last.kind {
      case let .assistant(markdown, _): length = markdown.count
      case let .reasoning(text, _): length = text.count
      case let .plan(steps): length = steps.filter { $0.status == .completed }.count
      default: length = 0
      }
    }
    return "\(session.rows.count)-\(session.rows.last?.id ?? "")-\(length)-\(showsTyping)"
  }

  // MARK: Header

  private var header: some View {
    ScreenHeader(alignment: target.threadRef == nil ? .center : .leading) {
      if isPushed { BackButton() } else { MenuButton() }
    } center: {
      titleCapsule
    } trailing: {
      switch target {
      case let .aide(project), let .project(project):
        let needsYou = model.threads(in: project).contains { $0.needsAttention }
        HStack(spacing: 0) {
          if case .project = target { OrchestratorSwitcher(current: project) }
          WeaveIconButton("checklist", label: "Threads", badge: needsYou) {
            nav.push(.overview(project))
          }
        }
      case let .thread(thread):
        threadControls(thread)
      }
    }
  }

  @ViewBuilder private var titleCapsule: some View {
    switch target {
    case let .aide(ref), let .project(ref):
      let project = model.project(ref)
      TitleCapsule(title: project?.title ?? session.title, subtitle: session.subtitle, action: { router.sheet = .projectSettings(ref) }) {
        ProjectAvatar(icon: project?.icon.avatarIcon ?? .none, title: project?.title ?? session.title, size: WeaveSize.titleTile)
      }
      .accessibilityHint("Opens project settings")
    case let .thread(ref):
      TitleCapsule(title: model.thread(ref)?.title ?? session.title, subtitle: session.subtitle, action: { router.sheet = .threadInfo(ref) })
        .accessibilityHint("Shows thread details")
    }
  }

  private func threadControls(_ ref: ThreadRef) -> some View {
    let summary = model.thread(ref)
    let machine = model.machine(ref.environmentId)
    let status = machine?.status.weaveStatus ?? (session.machineOnline ? .online : .offline)
    return HStack(spacing: 0) {
      Button {
        nav.push(.machine(ref.environmentId))
      } label: {
        MachineBadge(status: status, size: 17)
          .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("\(session.machineLabel), \(status.label)")
      .accessibilityHint("Shows the machine")

      Menu {
        threadMenu(ref, summary: summary)
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
    .padding(.horizontal, 2)
    .weaveGlass(in: Capsule(), interactive: true)
  }

  @ViewBuilder private func threadMenu(_ ref: ThreadRef, summary: ThreadSummary?) -> some View {
    let pinned = summary?.isPinned ?? false
    let resolved = summary?.isResolved ?? false
    Section {
      Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") {
        perform(pinned ? .unpin : .pin, on: ref)
      }
    }
    Section {
      Button("Copy ID", systemImage: "doc.on.doc") {
        WeaveClipboard.copy(ref.threadId)
        router.toast = WeaveToastMessage("Copied", kind: .pass, systemImage: "doc.on.doc")
      }
    }
    Section {
      Button("Rename…", systemImage: "pencil") {
        renameText = summary?.title ?? session.title
        renaming = true
      }
      Button(resolved ? "Reopen" : "Resolve", systemImage: resolved ? "arrow.uturn.backward.circle" : "checkmark.circle") {
        perform(resolved ? .unresolve : .resolve, on: ref)
      }
      Button("Mark unread", systemImage: "envelope.badge") {
        perform(.markUnread, on: ref)
      }
    }
    Section {
      Button("Archive", systemImage: "archivebox") { confirmArchive = true }
      Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
    }
  }

  // MARK: Composer

  private var composerArea: some View {
    VStack(spacing: WeaveSpacing.s2) {
      ZStack {
        if let plan = session.plan {
          TasksChip(completed: plan.completed, total: plan.total) { scrollToPlan() }
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
        if !isNearBottom {
          HStack {
            Spacer()
            WeaveIconButton("arrow.down", label: "Scroll to latest") {
              withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
            }
          }
          .transition(.opacity)
        }
      }
      if let notice = connectionNotice {
        Banner(notice.message, kind: notice.kind, actionTitle: notice.action == nil ? nil : notice.actionTitle, action: notice.action)
      }
      if let error = session.lastError {
        Banner(error, kind: .fail, onDismiss: { session.lastError = nil })
      }
      ComposerBar(
        text: draft,
        isRunning: session.isRunning && !session.isStale,
        placeholder: session.isRunning ? nil : placeholder,
        blockedReason: session.sendBlockedReason,
        focus: $composerFocused,
        onSend: { send() },
        onStop: session.isStale ? nil : { stop() }
      )
    }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.top, WeaveSpacing.s2)
    // Sits right on the home indicator area; leaves a gap above the keyboard.
    .padding(.bottom, composerFocused ? WeaveSpacing.s2 : 0)
    .animation(.snappy, value: session.plan)
    .animation(.snappy, value: isNearBottom)
    .animation(.snappy, value: session.lastError)
  }

  private var placeholder: String {
    switch target {
    case .aide: "Ask Aide anything…"
    case .project: "Message the coordinator…"
    case .thread: "Message…"
    }
  }

  private struct ConnectionNotice {
    let message: String
    let kind: WeaveNoticeKind
    var actionTitle = "Reconnect"
    let action: (() -> Void)?
  }

  private var connectionNotice: ConnectionNotice? {
    let label = machineLabel
    let machineId = target.environmentId
    if !session.machineOnline {
      // The transcript itself says the machine is offline and offers Reconnect.
      if showsOfflineTranscript { return nil }
      // The composer already explains a blocked send; the banner adds the way
      // out, and only mentions saved messages when there are some.
      let message = session.rows.isEmpty
        ? "\(label) is offline."
        : (session.sendBlockedReason == nil ? "\(label) is offline. Showing saved messages." : "Showing saved messages.")
      if let other = reachableOrchestrator {
        return ConnectionNotice(message: "\(message) \(other.machineLabel)'s orchestrator is available.", kind: .warn, actionTitle: "View on \(other.machineLabel)", action: { router.open(.project(other.ref)) })
      }
      return ConnectionNotice(message: message, kind: .warn, action: { model.engine.reconnect(machineId: machineId) })
    }
    if session.isStale {
      return ConnectionNotice(message: "Showing saved messages. Live updates resume when \(label) reconnects.", kind: .info, action: nil)
    }
    return nil
  }

  private var draft: Binding<String> {
    Binding(
      get: { router.drafts[target] ?? "" },
      set: { router.drafts[target] = $0 }
    )
  }

  // MARK: Actions

  private func send() {
    let original = router.drafts[target] ?? ""
    let text = original.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    router.drafts[target] = ""
    session.lastError = nil
    isNearBottom = true
    let target = target
    Task {
      do {
        try await model.engine.send(text, to: target)
      } catch {
        if (router.drafts[target] ?? "").isEmpty { router.drafts[target] = original }
        session.lastError = error.localizedDescription
      }
    }
  }

  private func stop() {
    let target = target
    Task {
      do {
        try await model.engine.stop(target)
      } catch {
        session.lastError = error.localizedDescription
      }
    }
  }

  private func respond(_ requestId: String, _ decision: ApprovalDecision) {
    guard !busyRequests.contains(requestId) else { return }
    busyRequests.insert(requestId)
    let target = target
    Task {
      do {
        try await model.engine.respond(to: requestId, in: target, decision: decision)
      } catch {
        router.showError(error)
      }
      busyRequests.remove(requestId)
    }
  }

  private func perform(_ action: ThreadAction, on thread: ThreadRef) {
    Task {
      do {
        try await model.engine.perform(action, on: thread)
        switch action {
        case .archive, .delete: leave()
        case .markUnread: router.toast = WeaveToastMessage("Marked unread", kind: .info, systemImage: "envelope.badge")
        case .resolve: router.toast = WeaveToastMessage("Resolved", kind: .pass)
        default: break
        }
      } catch {
        router.showError(error)
      }
    }
  }

  private func leave() {
    if isPushed {
      dismiss()
    } else {
      router.root = nil
    }
  }

  private func scrollToPlan() {
    guard let row = session.rows.last(where: { if case .plan = $0.kind { true } else { false } }) else { return }
    withAnimation(.easeOut(duration: 0.3)) { position.scrollTo(id: row.id, anchor: .top) }
  }
}
