import SwiftUI
import SWCSync
import Weave

private nonisolated struct BesideCoordinatorKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// This chat is the coordinator in the wide column, beside its thread.
  nonisolated var isBesideCoordinator: Bool {
    get { self[BesideCoordinatorKey.self] }
    set { self[BesideCoordinatorKey.self] = newValue }
  }
}

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
  @Environment(\.isNavigationSidebarVisible) private var sidebarVisible
  @Environment(\.isWideLayout) private var wide
  @Environment(\.isBesideCoordinator) private var isBesideCoordinator
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  @FocusState private var composerFocused: Bool
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var isNearBottom = true
  @State private var busyRequests: Set<String> = []
  @State private var renaming = false
  @State private var renameText = ""
  @State private var confirmArchive = false
  @State private var openingLink: Task<Void, Never>?
  @State private var confirmDelete = false
  @State private var showingHandoff = false
  @State private var showingIncrement = false
  @State private var deviceViewer: DeviceViewerRoute?
  @State private var headerWidth: CGFloat = 0
  @State private var railWidth: CGFloat = 0
  @State private var increment: IncrementProgress?
  @State private var choosingAttachment = false
  @State private var preparingPhotos = 0

  /// A thread's thinking rows carry its provider's mark; a coordinator chat has no single provider.
  private var thinkingBrand: String? {
    guard case let .thread(ref) = target else { return nil }
    return model.thread(ref)?.identity.providerBrand
  }

  var body: some View {
    transcript
      .edgeBar(.bottom) { composerArea }
      .screenChrome { header }
      .overlay(alignment: .topTrailing) { rail }
      .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.trailing } action: { railWidth = $0 }
      .sheet(isPresented: $showingHandoff) {
        if let thread = target.threadRef {
          HandoffSheet(thread: thread) { next in nav.push(.chat(.thread(next))) }
        }
      }
      .sheet(isPresented: $showingIncrement) { IncrementSheet(target: target) }
      .deviceViewer($deviceViewer)
      .attachmentPickers(isChoosing: $choosingAttachment) { addPhotos($0, failed: $1) }
      .task(id: router.pendingDeviceViewer) {
        // A launch route opens the viewer once this thread is on screen.
        guard let pending = router.pendingDeviceViewer, pending.machineId == target.threadRef?.environmentId else { return }
        router.pendingDeviceViewer = nil
        deviceViewer = pending
      }
      .task(id: incrementKey) { await loadIncrement() }
      .onAppear { model.openSession(session, startingCoordinator: !isBesideCoordinator) }
      .onDisappear {
        openingLink?.cancel()
        // Navigation must not restore a keyboard over a hidden safe-area bar.
        // The draft belongs to the router and survives losing focus.
        composerFocused = false
        model.closeSession(session)
      }
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

  /// Beside a thread, another machine's coordinator replaces only this column.
  private func showOrchestrator(_ ref: ProjectRef) {
    if isBesideCoordinator { router.chosenCoordinator = ref } else { router.open(.project(ref)) }
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
            recoveryButton
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
            thinkingBrand: thinkingBrand,
            onDecision: { requestId, decision in respond(requestId, decision) },
            onOpenThread: { router.pushThread($0, on: nav, in: model) },
            onOpenLink: { openThreadLink($0, in: row) },
            environmentId: target.environmentId
          )
          .id(row.id)
        }
        if showsTyping {
          TypingIndicator()
            .padding(.leading, WeaveSpacing.contentInset - WeaveSpacing.gutter)
            .id(Self.typingId)
        }
      }
      // Not containerRelativeFrame: on iPhone Duo it resolves against the scene,
      // so the transcript, header and composer spill past the chat column.
      // A readable column, centered, once the detail is wider than that.
      .frame(maxWidth: WeaveSize.readableColumn, alignment: .leading)
      .frame(maxWidth: .infinity)
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s4)
    }
    .scrollPosition($position)
    .defaultScrollAnchor(session.rows.isEmpty ? .top : .bottom)
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

  /// A new conversation: the spark and a serif question, as in Claude.
  private var emptyTranscript: some View {
    VStack(spacing: WeaveSpacing.s4) {
      WeaveSpark(size: 52)
      Text(emptyTitle)
        .font(.system(size: 28, weight: .regular, design: .serif))
        .foregroundStyle(Color.weave.ink)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      Text(emptyMessage)
        .weaveFont(.callout)
        .foregroundStyle(Color.weave.muted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, WeaveSpacing.s6)
    .padding(.top, WeaveSpacing.s8 * 3)
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
    if let machine = model.machine(machineId) {
      if let other = reachableOrchestrator, !machine.isDisconnected {
        transcriptPlaceholder(
          title: machine.recoveryTitle,
          message: "This machine is unavailable. \(other.machineLabel)'s coordinator for this project is available now.",
          actionTitle: "View on \(other.machineLabel)",
          action: { showOrchestrator(other.ref) }
        )
      } else {
        transcriptPlaceholder(
          title: machine.recoveryTitle,
          message: machine.recoveryMessage,
          actionTitle: model.connect != nil && (!machine.viaConnect || machine.needsSignIn) ? "SpecWithCode Connect" : machine.canRetryConnection ? "Reconnect" : nil,
          action: model.connect != nil && (!machine.viaConnect || machine.needsSignIn)
            ? { router.sheet = .globalSettings }
            : machine.canRetryConnection ? { model.engine.reconnect(machineId: machineId) } : nil
        )
      }
      recoveryButton
    } else {
      transcriptPlaceholder(title: "Machine unavailable", message: "Choose a machine or pair again.")
      WeaveButton("Machines", kind: .secondary) { nav.push(.machines) }
    }
  }

  private var recoveryButton: some View {
    WeaveButton("Connection options", systemImage: "laptopcomputer", kind: .secondary) {
      nav.push(.machine(target.environmentId))
    }
    .frame(maxWidth: .infinity)
    .accessibilityIdentifier("chat.connection-options-body")
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
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      Text(message)
        .weaveFont(.callout)
        .foregroundStyle(Color.weave.muted)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
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
    case .aide: "What should we build?"
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
      case let .reasoning(text, _, _): length = text.count
      case let .plan(steps): length = steps.filter { $0.status == .completed }.count
      default: length = 0
      }
    }
    return "\(session.rows.count)-\(session.rows.last?.id ?? "")-\(length)-\(showsTyping)"
  }

  // MARK: Header

  @ViewBuilder private var header: some View {
    if isBesideCoordinator {
      ColumnHeader {
        ColumnActions()
      } modeTrailing: {
        if case let .project(project) = target, OrchestratorSwitcher.choices(model.project(project)?.members ?? [], current: project).count > 1 {
          OrchestratorSwitcher(current: project)
            .weaveGlass(in: Capsule(), interactive: true)
        }
        if !session.machineOnline {
          WeaveIconButton("laptopcomputer", label: "Connection options") {
            nav.push(.machine(target.environmentId))
          }
          .accessibilityIdentifier("chat.connection-options")
        }
        switch target {
        case let .aide(ref), let .project(ref):
          WeaveIconButton("gearshape", label: "Project settings") { router.sheet = .projectSettings(ref) }
            .accessibilityIdentifier("column.project-settings")
        case .thread:
          EmptyView()
        }
      }
    } else {
      // On narrow phones (iPhone SE, mini, the 6.1-inch models) the Threads
      // label gives its width to the title, so the title and subtitle fit.
      header(threadsLabel: headerWidth >= 380)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { headerWidth = $0 }
    }
  }

  private func header(threadsLabel: Bool) -> some View {
    // Beside the sidebar the title leads the detail column, as on iPad.
    ScreenHeader(alignment: target.threadRef == nil && !sidebarVisible ? .center : .leading) {
      if isPushed {
        // A hidden column must come back from any thread, not only the root chat.
        if !sidebarVisible, !isBesideCoordinator, wide {
          HStack(spacing: WeaveSpacing.s2) {
            BackButton()
            MenuButton()
          }
        } else {
          BackButton()
        }
      } else if !sidebarVisible {
        MenuButton()
      } else if !isBesideCoordinator, target.threadRef != nil, let coordinator = router.besideCoordinator(in: model) {
        // The coordinator stays in the column; this returns the screen to its threads.
        Button {
          withAnimation(.snappy) { router.open(coordinator) }
        } label: {
          Label("Threads", systemImage: "chevron.left")
            .font(.weave(.callout, weight: .semibold))
            .foregroundStyle(Color.weave.ink)
            .padding(.horizontal, WeaveSpacing.s3)
            .frame(minHeight: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .weaveGlass(in: Capsule(), interactive: true)
        .accessibilityLabel("Back to threads")
        .accessibilityIdentifier("chat.back-to-threads")
      }
    } center: {
      titleCapsule
    } trailing: {
      if !session.machineOnline && target.threadRef == nil {
        WeaveIconButton("laptopcomputer", label: "Connection options") {
          nav.push(.machine(target.environmentId))
        }
        .accessibilityIdentifier("chat.connection-options")
      } else {
        switch target {
        case let .aide(project), let .project(project):
          let needsYou = model.threads(in: project).contains { $0.needsAttention }
          // One glass capsule: the machine this coordinator runs on, a
          // hairline, then the project's threads, which the list beside it
          // already shows on a wide screen.
          let switches: Bool = {
            guard case .project = target else { return false }
            return OrchestratorSwitcher.choices(model.project(project)?.members ?? [], current: project).count > 1
          }()
          let showsThreads = !threadsOnScreen(project)
          if switches || showsThreads {
            HStack(spacing: 0) {
              if switches {
                OrchestratorSwitcher(current: project)
                if showsThreads {
                  Rectangle()
                    .fill(Color.weave.line)
                    .frame(width: WeaveSize.hairline, height: 20)
                    .accessibilityHidden(true)
                }
              }
              if showsThreads {
                Button {
                  showThreads(of: project)
                } label: {
                  Label("Threads", systemImage: "bubble.left.and.bubble.right")
                    .labelStyle(ThreadsLabelStyle(showsTitle: threadsLabel))
                    .font(.weave(.callout, weight: .semibold))
                    .foregroundStyle(needsYou ? Color.weave.warn : Color.weave.ink)
                    .padding(.horizontal, WeaveSpacing.s3)
                    .frame(minHeight: WeaveSize.minTap)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Threads")
                .accessibilityIdentifier("chat.threads")
              }
            }
            .weaveGlass(in: Capsule(), interactive: true)
          }
        case let .thread(thread):
          if !usesRail { threadControls(thread) }
        }
      }
    }
  }

  private var isAide: Bool {
    if case .aide = target { return true }
    return false
  }

  /// The list beside this coordinator already holds its threads. Aide's
  /// threads are in every level of the list, so it counts once the list shows.
  private func threadsOnScreen(_ project: ProjectRef) -> Bool {
    guard sidebarVisible, !router.showsColumnOnly(in: model) else { return false }
    let scope = isAide ? nil : model.project(project)?.ref
    return router.sidebarScope(in: model) == scope
  }

  /// On a wide screen the threads come up beside the coordinator; on a
  /// phone they are their own screen.
  private func showThreads(of project: ProjectRef) {
    guard wide else {
      nav.push(.overview(project))
      return
    }
    withAnimation(.snappy) {
      router.isSidebarCollapsed = false
      if router.showsColumnOnly(in: model) { router.choosePanes(.both, in: model) }
      if !isAide, let row = model.project(project)?.ref { router.showProject(row, in: model) }
      router.sidebarShowsAllProjects = false
    }
  }

  /// Beside the list, a thread's controls move into the status rail, under
  /// the clock and Wi-Fi of an unfolded iPhone Duo and on the same centre.
  private var usesRail: Bool {
    sidebarVisible && !isBesideCoordinator && target.threadRef != nil && railWidth >= WeaveSize.statusRailMinWidth
  }

  @ViewBuilder private var rail: some View {
    if usesRail, let thread = target.threadRef {
      VStack(spacing: 0) { threadControlButtons(thread) }
        .padding(.vertical, 2)
        .weaveGlass(in: Capsule(), interactive: true)
        .padding(.top, WeaveSize.statusRailClearance)
        .padding(.trailing, railWidth / 2 + WeaveSize.statusRailCenterOffset - WeaveSize.minTap / 2)
        .ignoresSafeArea(.container, edges: .trailing)
        .accessibilityIdentifier("chat.rail")
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
      TitleCapsule(title: model.thread(ref)?.title ?? session.title, subtitle: session.subtitle, isPlain: sidebarVisible, action: { router.sheet = .threadInfo(ref) })
        .accessibilityHint("Shows thread details")
    }
  }

  private func threadControls(_ ref: ThreadRef) -> some View {
    HStack(spacing: 0) { threadControlButtons(ref) }
      .padding(.horizontal, 2)
      .weaveGlass(in: Capsule(), interactive: true)
  }

  @ViewBuilder private func threadControlButtons(_ ref: ThreadRef) -> some View {
    let summary = model.thread(ref)
    let machine = model.machine(ref.environmentId)
    let status = machine?.status.weaveStatus ?? (session.machineOnline ? .online : .offline)
    deviceButton(ref)
    Button {
      nav.push(.machine(ref.environmentId))
    } label: {
      MachineBadge(status: status, size: 17)
        .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(session.machineOnline ? "\(session.machineLabel), \(status.label)" : "Connection options")
    .accessibilityHint("Shows the machine")
    .accessibilityIdentifier(session.machineOnline ? "chat.machine" : "chat.connection-options")

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

  /// Opens the simulator or emulator this thread has open; a menu when it has several.
  @ViewBuilder private func deviceButton(_ ref: ThreadRef) -> some View {
    let sessions = model.deviceSessions(for: ref)
    let label = Image(systemName: sessions.first?.isAndroid == true && sessions.count == 1 ? "candybarphone" : "iphone")
      .font(.system(size: 17, weight: .semibold))
      .foregroundStyle(Color.weave.ink)
      .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
      .contentShape(Rectangle())
    if sessions.count == 1, let session = sessions.first {
      Button {
        deviceViewer = DeviceViewerRoute(machineId: ref.environmentId, key: session.id)
      } label: { label }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Device, \(session.name)")
        .accessibilityHint("Shows the device this thread opened")
        .accessibilityIdentifier("thread.device")
    } else if sessions.count > 1 {
      Menu {
        ForEach(sessions) { session in
          Button {
            deviceViewer = DeviceViewerRoute(machineId: ref.environmentId, key: session.id)
          } label: {
            Label(session.detail.isEmpty ? session.name : "\(session.name) · \(session.detail)", systemImage: session.isAndroid ? "candybarphone" : "iphone")
          }
        }
      } label: { label }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Devices, \(sessions.count)")
        .accessibilityIdentifier("thread.device")
    }
  }

  @ViewBuilder private func threadMenu(_ ref: ThreadRef, summary: ThreadSummary?) -> some View {
    let pinned = summary?.isPinned ?? false
    let resolved = summary?.isResolved ?? false
    if summary?.projectRef.flatMap({ model.project($0) })?.kind != .personal {
      Button("Check handoff options…", systemImage: "arrow.right.arrow.left") { showingHandoff = true }
        .accessibilityIdentifier("thread.handoff")
    }
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

  /// Landscape phones are short: notices take fewer lines, and while typing
  /// the increment row steps aside so the transcript stays in view.
  private var isShort: Bool { verticalSizeClass == .compact }

  /// Agents at work under this chat: a coordinator's threads, a thread's subagents.
  private var workingAgents: Int {
    switch target {
    case let .aide(project), let .project(project):
      return model.threads(in: project).count { $0.activity == .working }
    case .thread:
      return session.rows.count(where: \.isRunningSubagent)
    }
  }

  private func openAgents() {
    switch target {
    case let .aide(project), let .project(project):
      if isBesideCoordinator, router.showsThreadsBeside(in: model) {
        // The threads are already beside this coordinator; make sure they show.
        if router.showsColumnOnly(in: model) { withAnimation(.snappy) { router.choosePanes(.both, in: model) } }
      } else if isBesideCoordinator {
        withAnimation(.snappy) { router.showsCoordinatorBeside = false }
      } else {
        nav.push(.overview(project))
      }
    case .thread:
      if let first = session.rows.first(where: \.isRunningSubagent) { withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(id: first.id) } }
    }
  }

  private var composerArea: some View {
    VStack(spacing: WeaveSpacing.s2) {
      if sidebarVisible || isBesideCoordinator, !(isShort && composerFocused), workingAgents > 0 {
        Button(action: openAgents) {
          Label(workingAgents == 1 ? "1 agent" : "\(workingAgents) agents", systemImage: "person.2")
            .font(.weave(.caption, weight: .medium))
            .foregroundStyle(Color.weave.muted)
            .padding(.horizontal, WeaveSpacing.s3)
            .frame(minHeight: 32)
            .weaveGlass(in: Capsule(), interactive: true)
            .contentShape(Capsule())
        }
        .buttonStyle(PressableStyle())
        .frame(minHeight: WeaveSize.minTap)
        .accessibilityLabel(workingAgents == 1 ? "1 agent working" : "\(workingAgents) agents working")
        .accessibilityIdentifier("chat.agents")
      }
      // Only a chat with a bound SpecWeave increment shows it; a coordinator
      // or Aide chat without one shows nothing here.
      if !(isShort && composerFocused), increment != nil || session.plan != nil {
        HStack {
          if let increment {
            TaskProgressPill(settled: increment.settledCount, total: increment.tasks.count) { showingIncrement = true }
              .accessibilityIdentifier("chat.increment")
              .transition(.opacity.combined(with: .scale(scale: 0.9)))
          }
          Spacer()
          if let plan = session.plan {
            Button { scrollToPlan() } label: {
              Text("Provider checklist · \(plan.completed)/\(plan.total)")
                .font(.weave(.caption))
                .frame(minHeight: WeaveSize.minTap)
                .contentShape(Rectangle())
            }
              .transition(.opacity.combined(with: .scale(scale: 0.9)))
          }
        }
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
      if let notice = connectionNotice {
        Banner(notice.message, kind: notice.kind, actionTitle: notice.action == nil ? nil : notice.actionTitle, action: notice.action, lineLimit: isShort ? 2 : nil)
      }
      if let notice = session.teamRulesNotice {
        Banner(notice.message, title: notice.title, kind: .warn, actionTitle: notice.switchTitle, action: notice.switchTo == nil ? nil : { lowerMode(notice) }, lineLimit: isShort ? 2 : nil)
      }
      if let error = session.lastError {
        Banner(error, kind: .fail, onDismiss: { session.lastError = nil })
      }
      if !pendingImages.isEmpty || preparingPhotos > 0 {
        ComposerAttachmentStrip(images: pendingImages, isLoading: preparingPhotos > 0) { image in
          router.attachmentDrafts[target]?.removeAll { $0.id == image.id }
        }
      }
      ComposerBar(
        text: draft,
        isRunning: session.isRunning && !session.isStale,
        placeholder: session.isRunning ? nil : placeholder,
        blockedReason: session.machineOnline ? session.sendBlockedReason : "Machine unavailable. Your draft is kept.",
        hasAttachments: !pendingImages.isEmpty,
        focus: $composerFocused,
        onSend: { send() },
        onStop: session.isStale ? nil : { stop() },
        onAttach: { choosingAttachment = true }
      )
    }
    .frame(maxWidth: WeaveSize.readableColumn)
    .frame(maxWidth: .infinity)
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.top, WeaveSpacing.s2)
    // Sits right on the home indicator area; leaves a gap above the keyboard.
    .padding(.bottom, composerFocused ? WeaveSpacing.s2 : 0)
    .animation(.snappy, value: session.plan)
    .animation(.snappy, value: increment)
    .animation(.snappy, value: isNearBottom)
    .animation(.snappy, value: session.lastError)
    .animation(.snappy, value: composerFocused)
  }

  /// Reads the linked SpecWeave increment when the chat opens and again
  /// when a run ends, never on a timer.
  private var incrementKey: String { "\(target)-\(session.isRunning)-\(session.machineOnline)" }

  private func loadIncrement() async {
    guard session.machineOnline, !session.isRunning || increment == nil else { return }
    // A failed read keeps what is shown; a read that finds no binding clears it.
    switch try? await model.engine.incrementProgress(for: target) {
    case let .bound(progress)?: increment = progress
    case .unbound?: increment = nil
    default: break
    }
  }

  private var placeholder: String {
    switch target {
    case .aide: "Ask Aide anything…"
    case .project: "Message the coordinator…"
    case .thread: sidebarVisible && !session.machineLabel.isEmpty ? "Work on \(session.machineLabel)" : "Message…"
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
      if let machine = model.machine(machineId), machine.isDisconnected || !machine.canRetryConnection {
        return ConnectionNotice(message: machine.recoveryTitle, kind: .info, actionTitle: "Connection options", action: { nav.push(.machine(machineId)) })
      }
      // The composer already explains a blocked send; the banner adds the way
      // out, and only mentions saved messages when there are some.
      let message = session.rows.isEmpty
        ? "\(label) is offline."
        : (session.sendBlockedReason == nil ? "\(label) is offline. Showing saved messages." : "Showing saved messages.")
      if let other = reachableOrchestrator {
        return ConnectionNotice(message: "\(message) \(other.machineLabel)'s orchestrator is available.", kind: .warn, actionTitle: "View on \(other.machineLabel)", action: { showOrchestrator(other.ref) })
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

  private var pendingImages: [OutgoingImage] { router.attachmentDrafts[target] ?? [] }

  private func openThreadLink(_ url: URL, in row: TranscriptRow) {
    guard let route = MarkdownThreadLink.route(url) else {
      router.showError(SyncError.sendBlocked("This thread link is invalid."))
      return
    }
    let markdown: String? = switch row.kind {
    case let .user(text, _, _): text
    case let .assistant(text, _): text
    default: nil
    }
    let label = markdown.flatMap { MarkdownThreadLink.label(of: url, in: $0) }
    let origin = target.environmentId
    // The archived read can take a while: a new tap or leaving this chat replaces it.
    openingLink?.cancel()
    openingLink = Task {
      do {
        let thread = try await model.openThreadLink(threadId: route.threadId, environmentId: route.environmentId, threadIds: route.threadIds, title: route.title, label: label, from: origin)
        if !Task.isCancelled { router.pushThread(thread, on: nav, in: model) }
      } catch {
        if !Task.isCancelled { router.showError(error) }
      }
    }
  }

  private func addPhotos(_ photos: [Data], failed: Int) {
    if failed > 0 { session.lastError = failed == 1 ? "A photo could not be loaded. Try again." : "\(failed) photos could not be loaded. Try again." }
    guard !photos.isEmpty else { return }
    preparingPhotos += 1
    let target = target
    Task {
      defer { preparingPhotos -= 1 }
      let first = pendingImages.count
      let encoded = await Task.detached(priority: .userInitiated) {
        photos.enumerated().map { index, data in Result { try PhotoAttachmentEncoder.encode(data, index: first + index + 1) } }
      }.value
      for result in encoded {
        switch result {
        case let .success(image): router.attachmentDrafts[target, default: []].append(image)
        case let .failure(error): session.lastError = error.localizedDescription
        }
      }
    }
  }

  private func lowerMode(_ notice: ChatTeamRulesNotice) {
    guard let thread = notice.thread, let mode = notice.switchTo else { return }
    Task {
      do {
        try await model.engine.perform(.setRuntimeMode(mode), on: thread)
      } catch {
        session.lastError = error.localizedDescription
      }
    }
  }

  private func send() {
    let original = router.drafts[target] ?? ""
    let text = original.trimmingCharacters(in: .whitespacesAndNewlines)
    let images = pendingImages
    guard !text.isEmpty || !images.isEmpty else { return }
    router.drafts[target] = ""
    router.attachmentDrafts[target] = nil
    session.lastError = nil
    isNearBottom = true
    let target = target
    Task {
      do {
        try await model.engine.send(text, images: images, to: target)
      } catch {
        // Whatever was added while the upload ran stays, after what failed to send.
        let added = router.drafts[target] ?? ""
        router.drafts[target] = added.isEmpty ? original : "\(original)\n\(added)"
        router.attachmentDrafts[target] = images + (router.attachmentDrafts[target] ?? [])
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

/// The header's Threads button: icon and title, or only the icon when the
/// header is short of room. VoiceOver reads "Threads" either way.
private struct ThreadsLabelStyle: LabelStyle {
  let showsTitle: Bool

  func makeBody(configuration: Configuration) -> some View {
    if showsTitle {
      Label(configuration)
    } else {
      configuration.icon
        .frame(minWidth: WeaveSize.minTap)
        .accessibilityShowsLargeContentViewer { Label(configuration) }
    }
  }
}
