import Foundation
import SWCTransport
import SWCWire

/// What a closed conversation keeps so that reopening it resumes.
struct RetainedThread {
  let sync: ThreadSync
  /// The last projection of a thread target, shown as stale until the resume lands.
  let projection: ThreadProjection?
}

/// One open conversation: its thread subscription and the rows shown so far.
@MainActor
final class SessionController {
  /// A sent message shown until the machine echoes it.
  struct Pending {
    let rowId: String
    /// Matched against the echoed user message on thread sends.
    let messageId: String?
    let text: String
    /// User items present when a coordinator message was sent; a new one with the same text is its echo.
    let knownUserItems: Set<String>
  }

  let target: ChatTarget
  let session: ChatSession
  var threadId: String?
  let sync: ThreadSync
  var projection: ThreadProjection?
  var isSynchronized = false
  var task: Task<Void, Never>?
  /// The socket the current or last subscription used.
  var subscribedSocket: RpcSocket?
  /// A subscription that ended on this socket is not retried until a new socket arrives.
  var endedSocket: RpcSocket?
  var resolving = false
  /// A coordinator thread the machine did not have when subscribed; it is
  /// subscribed again once the shell shows it.
  var missingThread: String?
  var pending: [Pending] = []
  var rowsTask: Task<Void, Never>?
  /// `latestRunCompletedAt` of the last visit sent, so each finished run is visited once.
  var visitedRun: Date??
  /// The thread list's `updatedAt` this chat last subscribed again to catch up
  /// with, so one stale reading resubscribes once.
  var caughtUpTo: Date?
  /// Waits out `staleThreadGrace` before deciding the chat trails the list.
  var lagTask: Task<Void, Never>?
  /// The stream stopped for a reason a resubscribe on the same socket cannot
  /// fix (authorization, defect, interrupt); only a new socket retries it.
  var heldUntilNewSocket = false
  /// When the current subscription started, to throttle catch-ups on reopen.
  var subscribedAt: ContinuousClock.Instant?
  /// The coordinator thread the project named when last read, so the chat
  /// follows a change of that name rather than any difference from it.
  var namedCoordinator: String?

  init(target: ChatTarget, session: ChatSession, sync: ThreadSync = ThreadSync()) {
    self.target = target
    self.session = session
    self.sync = sync
    if case let .thread(ref) = target { threadId = ref.threadId }
  }

  var environmentId: String { target.environmentId }

  /// Aide or a project: the session shows a coordinator thread.
  var isCoordinator: Bool {
    if case .thread = target { return false }
    return true
  }

  var projectId: String? {
    switch target {
    case let .aide(p), let .project(p): p.projectId
    case .thread: projection?.thread.projectId
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
    rowsTask?.cancel()
    rowsTask = nil
    lagTask?.cancel()
    lagTask = nil
  }
}

extension LiveEngine {
  // MARK: - Sessions

  public func open(_ session: ChatSession) {
    let target = session.id
    let controller: SessionController
    if let existing = controllers[target], existing.session === session {
      controller = existing
      // Opening a chat again catches it up, in case its stream stalled; not
      // while its subscription is still loading or has only just started.
      if controller.isSynchronized, controller.subscribedAt.map({ ContinuousClock.now - $0 >= options.resyncInterval }) ?? true {
        resync(controller)
      }
    } else {
      controllers[target]?.cancel()
      let retained = retainedThreads.removeValue(forKey: target)
      retainedOrder.removeAll { $0 == target }
      controller = SessionController(target: target, session: session, sync: retained?.sync ?? ThreadSync())
      if case .thread = target { controller.projection = retained?.projection }
      controllers[target] = controller
    }
    refreshMeta(controller)
    pump(controller)
    visitIfUnread(controller)
  }

  public func reload(_ session: ChatSession) {
    guard let controller = controllers[session.id], controller.session === session else {
      open(session)
      return
    }
    assign(session, \.loadError, nil)
    controller.task?.cancel()
    controller.task = nil
    controller.endedSocket = nil
    controller.subscribedSocket = nil
    if let entry = machines[controller.environmentId] {
      let connection = entry.connection
      Task { await connection.networkChanged() }
    }
    pump(controller)
  }

  /// Subscribes the chat again on its machine's socket, resuming from the last
  /// sequence it applied. The server replays what was missed or sends a snapshot.
  func resync(_ controller: SessionController) {
    guard controllers[controller.target] === controller, let threadId = controller.threadId,
          !isHeld(controller, threadId) else { return }
    controller.task?.cancel()
    controller.task = nil
    controller.subscribedSocket = nil
    controller.endedSocket = nil
    pump(controller)
  }

  public func close(_ session: ChatSession) {
    guard let controller = controllers[session.id], controller.session === session else { return }
    controller.cancel()
    controllers[session.id] = nil
    guard machines[controller.environmentId] != nil else { return }
    retainedThreads[session.id] = RetainedThread(sync: controller.sync, projection: controller.projection)
    retainedOrder.removeAll { $0 == session.id }
    retainedOrder.append(session.id)
    while retainedOrder.count > Self.retainedThreadLimit {
      retainedThreads[retainedOrder.removeFirst()] = nil
    }
  }

  func pumpSessions(on env: String) {
    for controller in controllers.values where controller.environmentId == env {
      pump(controller)
    }
  }

  /// Resolves the thread and subscribes when there is a socket to subscribe on.
  func pump(_ controller: SessionController) {
    guard controllers[controller.target] === controller, let entry = machines[controller.environmentId], let socket = entry.socket else { return }
    guard let threadId = controller.threadId else {
      resolveCoordinator(controller, entry)
      return
    }
    if controller.task != nil, controller.subscribedSocket === socket { return }
    if controller.task == nil, controller.endedSocket === socket { return }
    controller.task?.cancel()
    controller.subscribedSocket = socket
    controller.endedSocket = nil
    controller.heldUntilNewSocket = false
    controller.subscribedAt = .now
    controller.task = Task { [weak self] in
      await self?.subscribeThread(controller, socket, threadId)
    }
  }

  func resolveCoordinator(_ controller: SessionController, _ entry: MachineEntry) {
    guard !controller.resolving, let projectId = controller.projectId, let project = entry.project(projectId) else { return }
    switch CoordinatorRouting.resolve(project) {
    case let .known(id):
      controller.namedCoordinator = id
      bind(controller, to: id)
    case let .needsStart(fallback):
      guard entry.canOperate else {
        bind(controller, to: fallback)
        return
      }
      controller.resolving = true
      let commandId = Self.newId()
      Task { [weak self] in
        guard let self else { return }
        let input = CoordinatorStartInput(projectId: projectId, commandId: commandId)
        let result = try? await self.withRetry(entry.environmentId) { socket in
          try await Self.decode(CoordinatorResult.self, from: socket.call(tag: RpcMethod.coordinatorStart.rawValue, payload: JSONValue.from(input)))
        }
        controller.resolving = false
        // Without a started thread the default id still subscribes; a send creates it.
        self.bind(controller, to: result?.threadId ?? fallback)
      }
    }
  }

  func bind(_ controller: SessionController, to threadId: String) {
    controller.missingThread = nil
    assign(controller.session, \.loadError, nil)
    if controller.threadId != threadId {
      controller.task?.cancel()
      controller.task = nil
      controller.threadId = threadId
      controller.projection = nil
      controller.isSynchronized = false
      controller.caughtUpTo = nil
      controller.lagTask?.cancel()
      controller.lagTask = nil
    }
    controller.endedSocket = nil
    pump(controller)
  }

  /// Streams one thread on this socket. A typed server failure subscribes
  /// again on the same socket with backoff, inside this task, so `pump` keeps
  /// treating the subscription as live; a new socket, `close` or `bind`
  /// cancels the wait. A stream that ends otherwise while the socket stays
  /// open subscribes again the same way. Authorization failures, defects,
  /// interrupts, a missing thread and a closed socket stop here until a new socket.
  func subscribeThread(_ controller: SessionController, _ socket: RpcSocket, _ threadId: String) async {
    let sync = controller.sync
    var failures = 0
    /// Streams that ended without a typed failure; reset only once a stream
    /// synchronizes, so a server that keeps ending it at once backs off.
    var ends = 0
    retrying: while !Task.isCancelled {
      let after = await sync.begin(threadId: threadId)
      let input = SubscribeThreadInput(threadId: threadId, afterSequence: after, requestCompletionMarker: true, acceptBoundedSnapshot: true)
      let payload = (try? JSONValue.from(input)) ?? .object([:])
      let stream = await socket.stream(tag: RpcMethod.subscribeThread.rawValue, payload: payload)
      do {
        for try await chunk in stream {
          failures = 0
          let update = await sync.apply(chunk.values)
          chunk.ack()
          // A cancelled task (resync, bind) must not write over the new subscription.
          if Task.isCancelled { return }
          if update?.isSynchronized == true { ends = 0 }
          if let update, controller.threadId == threadId { threadUpdated(controller, update) }
        }
      } catch is CancellationError {
        return
      } catch let error as ServerError {
        Self.log.error("Thread subscription failed: \(error.message, privacy: .public)")
        if let entry = machines[controller.environmentId] {
          verifySessionIfUnauthorized(entry, error)
          // A coordinator that does not exist yet appears once a message starts it.
          if controller.isCoordinator, entry.thread(threadId) == nil, controller.threadId == threadId {
            controller.missingThread = threadId
          }
        }
        // Stop the spinner. A coordinator that does not exist yet is an empty
        // conversation; any other thread that never loaded says so.
        assign(controller.session, \.isLoaded, true)
        if controller.projection == nil, controller.missingThread != threadId, controller.threadId == threadId {
          assign(controller.session, \.loadError, error.message)
        }
        guard isRetryable(error, controller, threadId) else {
          controller.heldUntilNewSocket = true
          break retrying
        }
        guard !Task.isCancelled, controller.subscribedSocket === socket, controller.threadId == threadId else { return }
        controller.isSynchronized = false
        refreshMeta(controller)
        let delay = resubscribeDelay(afterFailures: failures)
        failures += 1
        try? await Task.sleep(for: delay)
        guard !Task.isCancelled, controller.subscribedSocket === socket, controller.threadId == threadId,
              controllers[controller.target] === controller, !(await socket.isClosed) else { return }
        // Subscribe again on the same socket; `begin` resumes from the last sequence.
        continue retrying
      } catch {
        // The socket closed, or the stream broke while it may still be open.
      }
      // A stream that ended on a socket that stays open would leave the chat
      // frozen until the next socket, so subscribe again with backoff; a
      // closed socket waits for the next one.
      guard !Task.isCancelled, controller.subscribedSocket === socket, controller.threadId == threadId,
            controllers[controller.target] === controller, !isGone(controller, threadId),
            !(await socket.isClosed), !Task.isCancelled else { break retrying }
      controller.isSynchronized = false
      refreshMeta(controller)
      ends += 1
      try? await Task.sleep(for: resubscribeDelay(afterFailures: max(failures, ends)))
      failures += 1
      guard !Task.isCancelled, controller.subscribedSocket === socket, !(await socket.isClosed) else { break retrying }
    }
    guard !Task.isCancelled, controller.subscribedSocket === socket, controller.threadId == threadId else { return }
    controller.task = nil
    controller.endedSocket = socket
    controller.isSynchronized = false
    refreshMeta(controller)
  }

  /// A typed failure of the thread stream that is worth subscribing again for
  /// on the same socket, like client-runtime's retry of expected failures.
  func isRetryable(_ error: ServerError, _ controller: SessionController, _ threadId: String) -> Bool {
    switch error.kind {
    case .authorization, .defect, .interrupted: return false
    default: break
    }
    if controller.missingThread == threadId { return false }
    return !isGone(controller, threadId)
  }

  /// A thread the shell no longer lists is gone; do not loop on it.
  func isGone(_ controller: SessionController, _ threadId: String) -> Bool {
    guard let entry = machines[controller.environmentId], entry.snapshot != nil else { return false }
    return entry.thread(threadId) == nil
  }

  /// A project's chat follows the coordinator thread the project names now,
  /// for example after the coordinator was handed to a fresh thread.
  /// Only a change of the name counts: a send can bind to a new thread before
  /// the project names it, and must not be pulled back to the old one.
  func followCoordinator(_ controller: SessionController) {
    guard controller.isCoordinator, !controller.resolving, let current = controller.threadId,
          let projectId = controller.projectId, let entry = machines[controller.environmentId],
          let project = entry.project(projectId), case let .known(id) = CoordinatorRouting.resolve(project),
          id != controller.namedCoordinator else { return }
    let previous = controller.namedCoordinator
    controller.namedCoordinator = id
    guard previous != nil, id != current else { return }
    bind(controller, to: id)
  }

  /// A stop that only a new socket or the shell listing the thread may lift.
  func isHeld(_ controller: SessionController, _ threadId: String) -> Bool {
    if controller.missingThread == threadId { return true }
    guard controller.heldUntilNewSocket, controller.task == nil, let socket = machines[controller.environmentId]?.socket else { return false }
    return controller.endedSocket === socket
  }

  /// The thread list says the thread changed after what the open chat shows.
  /// Events can trail the list briefly, so after `staleThreadGrace` a chat
  /// still behind subscribes again, once per list value. This heals a stream
  /// that stalled on an open socket, whatever stalled it.
  func checkBehind(_ controller: SessionController) {
    guard controller.lagTask == nil, isBehind(controller) else { return }
    let grace = options.staleThreadGrace
    controller.lagTask = Task { [weak self] in
      try? await Task.sleep(for: grace)
      guard !Task.isCancelled, let self else { return }
      controller.lagTask = nil
      guard self.controllers[controller.target] === controller, self.isBehind(controller),
            let threadId = controller.threadId,
            let listed = self.machines[controller.environmentId]?.thread(threadId)?.updatedAt else { return }
      controller.caughtUpTo = listed
      Self.log.notice("Chat trails the thread list; subscribing again")
      self.resync(controller)
    }
  }

  func isBehind(_ controller: SessionController) -> Bool {
    guard let threadId = controller.threadId, let projection = controller.projection,
          let entry = machines[controller.environmentId], entry.isOnline, entry.isSynchronized,
          !isHeld(controller, threadId), let listed = entry.thread(threadId)?.updatedAt else { return false }
    if let caughtUpTo = controller.caughtUpTo, listed <= caughtUpTo { return false }
    // A visit moves the thread's own `updatedAt` but not the projection's.
    return listed > max(projection.updatedAt, projection.thread.updatedAt)
  }

  func threadUpdated(_ controller: SessionController, _ update: ThreadSync.Update) {
    controller.projection = update.projection
    controller.isSynchronized = update.isSynchronized
    if let projection = update.projection { reconcilePending(controller, projection) }
    scheduleRows(controller)
  }

  /// Subscribes again to a coordinator thread that was missing, once the
  /// shell shows it (for example after a message from another device).
  func retryMissingCoordinator(_ controller: SessionController) {
    guard let missing = controller.missingThread, controller.task == nil,
          let entry = machines[controller.environmentId], let projectId = controller.projectId,
          let project = entry.project(projectId) else { return }
    let named = project.workspaceSettings?.coordinatorThreadId.flatMap { $0.isEmpty ? nil : $0 }
    let target = named ?? missing
    // The same missing thread is tried again only once the shell lists it.
    guard target != missing || entry.thread(missing) != nil else { return }
    bind(controller, to: target)
  }

  /// Drops optimistic rows whose message the machine has. A queued message
  /// has no turn item until its run starts, so the projection's messages count
  /// too; the queued row then takes over.
  func reconcilePending(_ controller: SessionController, _ projection: ThreadProjection) {
    guard !controller.pending.isEmpty else { return }
    var users = TranscriptMapper.receivedUserMessages(projection)
    controller.pending.removeAll { pending in
      let index: Int?
      if let messageId = pending.messageId {
        index = users.firstIndex { $0.messageId == messageId }
      } else {
        let text = pending.text.trimmingCharacters(in: .whitespacesAndNewlines)
        index = users.firstIndex { !pending.knownUserItems.contains($0.id) && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text }
      }
      guard let index else { return false }
      users.remove(at: index)
      return true
    }
  }

  func scheduleRows(_ controller: SessionController) {
    guard controller.rowsTask == nil else { return }
    let interval = options.publishInterval
    controller.rowsTask = Task { [weak self] in
      try? await Task.sleep(for: interval)
      guard !Task.isCancelled, let self else { return }
      controller.rowsTask = nil
      self.renderRows(controller)
    }
  }

  func renderRows(_ controller: SessionController) {
    let session = controller.session
    var rows: [TranscriptRow] = []
    if let projection = controller.projection {
      rows = TranscriptMapper.rows(for: projection, environmentId: controller.environmentId)
      assign(session, \.isRunning, TranscriptMapper.isRunning(projection))
      assign(session, \.queuedCount, TranscriptMapper.queuedCount(projection))
      assign(session, \.plan, TranscriptMapper.planProgress(projection))
      assign(session, \.isLoaded, true)
      assign(session, \.loadError, nil)
    }
    rows += controller.pending.map { TranscriptRow(id: $0.rowId, kind: .user(text: $0.text, state: .sending)) }
    if !rows.isEmpty { assign(session, \.isLoaded, true) }
    assign(session, \.rows, rows)
    refreshMeta(controller)
  }

  /// Title, machine state and whether the composer is enabled.
  func refreshMeta(_ controller: SessionController) {
    let session = controller.session
    guard let entry = machines[controller.environmentId] else {
      assign(session, \.machineOnline, false)
      assign(session, \.sendBlockedReason, SyncError.unknownMachine.localizedDescription)
      assign(session, \.isStale, controller.projection != nil)
      return
    }
    let online = entry.isOnline
    let name = displayName(entry)
    assign(session, \.machineLabel, name)
    assign(session, \.machineOnline, online)
    assign(session, \.isStale, controller.projection != nil && (!online || !controller.isSynchronized))

    let shell = controller.threadId.flatMap(entry.thread)
    let project = (controller.projectId ?? shell?.projectId).flatMap(entry.project)
    switch controller.target {
    case .aide, .project:
      if let project {
        let title = project.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { assign(session, \.title, title) }
      }
      assign(session, \.subtitle, "Coordinator · \(name)")
    case .thread:
      let title = (shell?.title ?? controller.projection?.thread.title)?.trimmingCharacters(in: .whitespacesAndNewlines)
      if let title, !title.isEmpty { assign(session, \.title, title) }
      if let projectTitle = project?.displayTitle, !projectTitle.isEmpty { assign(session, \.subtitle, projectTitle) }
    }
    // The shell drops a deleted thread at once, so the projection is what still knows.
    let threadDeleted = controller.projection?.thread.deletedAt != nil
    let threadArchived = shell?.isArchived ?? (controller.projection?.thread.archivedAt != nil)
    assign(session, \.sendBlockedReason, blockedReason(controller.target, entry: entry, project: project, threadArchived: threadArchived, threadDeleted: threadDeleted))
  }

  /// Why the composer is disabled, or nil when sending is possible.
  func blockedReason(_ target: ChatTarget, entry: MachineEntry, project: ProjectShell?, threadArchived: Bool, threadDeleted: Bool = false) -> String? {
    // A coordinator send starts a new thread, so only a thread target is blocked.
    if case .thread = target, threadDeleted { return Self.deletedReason }
    if case .thread = target, controllers[target]?.projection?.thread.movedTo?.isHandoff == true { return Self.handedOffReason }
    if case let .thread(ref) = target, let reason = Self.handoffBlock(entry.thread(ref.threadId)) { return reason }
    if !entry.isOnline { return SyncError.machineOffline(label: displayName(entry)).localizedDescription }
    if !entry.canOperate { return Self.readOnlyReason }
    if let project, case .thread = target {
      if project.isArchived { return "This project is archived." }
    } else if let project {
      if project.isArchived { return "This project is archived." }
      if project.isPaused { return "This project is paused. Resume it to send messages." }
    }
    if threadArchived { return "This thread is archived." }
    return nil
  }

  static let readOnlyReason = "This computer was paired without permission to make changes. Pair it again to send messages."
  static let deletedReason = "This thread was deleted."

  /// Marks an open thread read once per finished run, like the web app does on view.
  func visitIfUnread(_ controller: SessionController) {
    guard let threadId = controller.threadId, let entry = machines[controller.environmentId], entry.isOnline, entry.canOperate,
          let shell = entry.thread(threadId), shell.isUnread else { return }
    let run = shell.latestRunCompletedAt
    if let visited = controller.visitedRun, visited == run { return }
    controller.visitedRun = .some(run)
    // A server-clock watermark, as the web and Expo clients send: never the
    // device clock, which may run ahead of the machine and hide later runs.
    let visitedAt = max(shell.updatedAt, run ?? shell.updatedAt)
    let command = OrchestrationCommand.visit(commandId: Self.newId(), threadId: threadId, at: visitedAt)
    Task { [weak self] in
      _ = try? await self?.dispatch(command, on: entry.environmentId)
    }
  }

  // MARK: - Commands

  public func send(_ text: String, to target: ChatTarget) async throws {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw SyncError.emptyMessage }
    guard let entry = machines[target.environmentId] else { throw SyncError.unknownMachine }
    guard entry.canOperate else { throw SyncError.sendBlocked(Self.readOnlyReason) }
    let controller = controllers[target]
    controller?.session.lastError = nil

    do {
      switch target {
      case let .thread(ref):
        if controller?.projection?.thread.movedTo?.isHandoff == true { throw SyncError.sendBlocked(Self.handedOffReason) }
        if let reason = Self.handoffBlock(entry.thread(ref.threadId)) { throw SyncError.sendBlocked(reason) }
        if controller?.projection?.thread.deletedAt != nil { throw SyncError.sendBlocked(Self.deletedReason) }
        let messageId = Self.newId()
        let running = controller?.projection.map(TranscriptMapper.isRunning) ?? (entry.thread(ref.threadId)?.activeRunId != nil)
        let command = OrchestrationCommand.messageDispatch(MessageDispatchCommand(
          commandId: Self.newId(),
          threadId: ref.threadId,
          messageId: messageId,
          text: text,
          dispatchMode: running ? .queueAfterActive : .startImmediately
        ))
        addPending(controller, text: text, messageId: messageId)
        do {
          try await dispatch(command, on: ref.environmentId)
        } catch {
          removePending(controller, messageId: messageId)
          throw error
        }

      case let .aide(project), let .project(project):
        if let shell = entry.project(project.projectId) {
          if shell.isArchived { throw SyncError.sendBlocked("This project is archived.") }
          if shell.isPaused { throw SyncError.sendBlocked("This project is paused. Resume it to send messages.") }
        }
        let rowId = addPending(controller, text: text, messageId: nil)
        let input = CoordinatorSendInput(projectId: project.projectId, commandId: Self.newId(), prompt: text)
        let result: CoordinatorResult
        do {
          result = try await withRetry(project.environmentId) { socket in
            try await Self.decode(CoordinatorResult.self, from: socket.call(tag: RpcMethod.coordinatorSend.rawValue, payload: JSONValue.from(input)))
          }
        } catch {
          controller?.pending.removeAll { $0.rowId == rowId }
          if let controller { renderRows(controller) }
          throw error
        }
        if let controller = controllers[target] { bind(controller, to: result.threadId) }
      }
    } catch {
      let error = SyncError.wrap(error)
      controllers[target]?.session.lastError = error.localizedDescription
      throw error
    }
  }

  @discardableResult
  func addPending(_ controller: SessionController?, text: String, messageId: String?) -> String {
    let rowId = "pending:\(messageId ?? Self.newId())"
    guard let controller else { return rowId }
    let known = Set(controller.projection.map { TranscriptMapper.receivedUserMessages($0).map(\.id) } ?? [])
    controller.pending.append(.init(rowId: rowId, messageId: messageId, text: text, knownUserItems: known))
    renderRows(controller)
    return rowId
  }

  func removePending(_ controller: SessionController?, messageId: String) {
    guard let controller else { return }
    controller.pending.removeAll { $0.messageId == messageId }
    renderRows(controller)
  }

  public func stop(_ target: ChatTarget) async throws {
    guard let entry = machines[target.environmentId] else { throw SyncError.unknownMachine }
    let controller = controllers[target]
    guard let threadId = threadId(for: target, entry: entry) else { throw SyncError.nothingRunning }
    let runId = controller?.projection?.activeRun?.id ?? entry.thread(threadId)?.activeRunId
    guard let runId else { throw SyncError.nothingRunning }
    let command = OrchestrationCommand.runInterrupt(RunInterruptCommand(commandId: Self.newId(), threadId: threadId, runId: runId, holdQueue: true))
    try await dispatch(command, on: target.environmentId)
  }

  public func respond(to requestId: String, in target: ChatTarget, decision: ApprovalDecision) async throws {
    guard let entry = machines[target.environmentId] else { throw SyncError.unknownMachine }
    guard let threadId = threadId(for: target, entry: entry) else { throw SyncError.requestGone }
    let request = controllers[target]?.projection?.runtimeRequest(requestId)
    let isQuestion = request?.kind.isUserInput == true
    let wireDecision: ProviderApprovalDecision = switch decision {
    case .approve: .accept
    case .approveForSession: isQuestion ? .accept : .acceptForSession
    case .deny: isQuestion ? .cancel : .decline
    }
    let command = OrchestrationCommand.runtimeRequestRespond(RuntimeRequestRespondCommand(commandId: Self.newId(), threadId: threadId, requestId: requestId, decision: wireDecision))
    try await dispatch(command, on: target.environmentId)
  }

  public func perform(_ action: ThreadAction, on thread: ThreadRef) async throws {
    guard let entry = machines[thread.environmentId] else { throw SyncError.unknownMachine }
    guard entry.canOperate else { throw SyncError.sendBlocked(Self.readOnlyReason) }
    let commandId = Self.newId()
    let id = thread.threadId
    let command: OrchestrationCommand
    switch action {
    case .pin: command = .threadPin(commandId: commandId, threadId: id)
    case .unpin: command = .threadUnpin(commandId: commandId, threadId: id)
    case .resolve: command = .threadSettle(commandId: commandId, threadId: id)
    case .unresolve: command = .threadUnsettle(commandId: commandId, threadId: id)
    case .archive: command = .threadArchive(commandId: commandId, threadId: id)
    case .delete: command = .threadDelete(commandId: commandId, threadId: id)
    case .markUnread:
      command = .threadMarkUnread(commandId: commandId, threadId: id)
      // An open session would otherwise mark it read again right away.
      if let controller = controllers[.thread(thread)] { controller.visitedRun = .some(entry.thread(id)?.latestRunCompletedAt) }
    case let .rename(title):
      let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !clean.isEmpty else { throw SyncError.emptyTitle }
      command = .threadMetadataUpdate(ThreadMetadataUpdateCommand(commandId: commandId, threadId: id, title: clean))
    }
    try await dispatch(command, on: thread.environmentId)
  }

  /// The thread a target's commands address, when it is known.
  func threadId(for target: ChatTarget, entry: MachineEntry) -> String? {
    if let id = controllers[target]?.threadId { return id }
    switch target {
    case let .thread(ref): return ref.threadId
    case let .aide(p), let .project(p): return entry.project(p.projectId)?.coordinatorThreadId
    }
  }

  func dispatch(_ command: OrchestrationCommand, on env: String) async throws {
    let payload = try JSONValue.from(command)
    _ = try await withRetry(env) { socket in
      try await socket.call(tag: RpcMethod.dispatchCommand.rawValue, payload: payload)
    }
  }

  // MARK: - Calls

  /// Runs a call on the machine's socket, waiting briefly for one, and retries
  /// transient failures. The body must reuse its ids so a retry is idempotent.
  func withRetry<T: Sendable>(_ env: String, _ body: (RpcSocket) async throws -> T) async throws -> T {
    var attempt = 0
    while true {
      do {
        let socket = try await awaitSocket(env)
        return try await body(socket)
      } catch let error as TransportError where Self.isTransient(error) && attempt < options.retryLimit {
        attempt += 1
        try await Task.sleep(for: options.retryDelay)
      } catch {
        throw SyncError.wrap(error)
      }
    }
  }

  func awaitSocket(_ env: String) async throws -> RpcSocket {
    let deadline = ContinuousClock.now + options.socketWait
    var nudged = false
    while true {
      guard let entry = machines[env], entry.record.enabled else { throw SyncError.unknownMachine }
      if let socket = entry.socket, !(await socket.isClosed) { return socket }
      switch entry.status.state {
      case .needsRepair, .unsupported:
        throw entry.status.lastError ?? SyncError.machineOffline(label: displayName(entry))
      default:
        break
      }
      if !nudged {
        nudged = true
        let connection = entry.connection
        Task { await connection.networkChanged() }
      }
      if ContinuousClock.now >= deadline { throw SyncError.machineOffline(label: displayName(entry)) }
      try await Task.sleep(for: .milliseconds(100))
    }
  }

  static func isTransient(_ error: TransportError) -> Bool {
    switch error {
    case .timedOut, .closed, .unreachable, .upgradeFailed: true
    default: false
    }
  }
}
