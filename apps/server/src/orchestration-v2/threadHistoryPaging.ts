import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";

/**
 * Every window stops at the byte budget. A window that holds a user turn also
 * stops at `maxUserTurns` or `maxTurnItems` rows, which keeps ordinary turns
 * whole. Any other window, such as an agent-driven thread or the inside of one
 * very long turn, stops at `maxItems` rows. Clients that do not ask for
 * bounded long turns get `WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY` instead.
 */
export const THREAD_HISTORY_PAGE_POLICY = {
  maxUserTurns: 10,
  maxItems: 75,
  maxTurnItems: 500,
  maxEncodedBytes: 1_048_576,
} as const;

/**
 * The windows older clients expect: user turns stay whole however long they
 * are, and only histories without user turns use the row and byte budgets.
 */
export const WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY = {
  ...THREAD_HISTORY_PAGE_POLICY,
  wholeTurns: true,
} as const;

export const OLDER_THREAD_USER_TURN_LIMIT = 20;
export const THREAD_HISTORY_MAX_RAW_TURNS = 150;

/** Extra rows let the projection query retain an inclusive cursor and prove another page exists. */
export const THREAD_HISTORY_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
/** The projection query's row limit while the newest user turn fits `maxTurnItems`. */
export const THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 2;

/** Reject absurd cursors before base64 work or JSON parse. */
export const THREAD_HISTORY_CURSOR_MAX_LENGTH = 4_096;

export type ThreadHistoryPagePolicy = {
  readonly maxUserTurns?: number | undefined;
  readonly maxItems: number;
  /** Row cap for a window that holds a user turn. Defaults to `maxItems`. */
  readonly maxTurnItems?: number | undefined;
  readonly maxEncodedBytes: number;
  /** Keep user turns whole, with no row or byte cap, for older clients. */
  readonly wholeTurns?: boolean | undefined;
};

export type ThreadHistoryCursorPayload = {
  readonly v: 1;
  readonly seq: number;
  readonly st: string;
  readonly si: string;
  readonly p: number;
  /** The cursor row's ordinal, to resume below it after the row disappears. */
  readonly o?: number;
  /** 1 when the page was cut with bounded long turns. */
  readonly b?: 1;
};

export type SelectTimelinePageResult = {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
};

export type BoundedProjectionResult = {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  /** Max ordinal across the authoritative full projection's local turnItems. */
  readonly latestLocalTurnOrdinal: number | null;
  /**
   * The user message that opened the turn the window starts inside. Set only
   * when the window holds no user turn start and older rows exist; the rows
   * between it and the window still page from `historyCursor`.
   */
  readonly windowTurnStart: OrchestrationV2ProjectedTurnItem | null;
};

export class InvalidThreadHistoryCursorError extends Error {
  readonly _tag = "InvalidThreadHistoryCursorError";
  constructor(message = "Invalid thread history cursor.") {
    super(message);
    this.name = "InvalidThreadHistoryCursorError";
  }
}

function bytesOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Ordinary history-page cost: one projected row (item is nested once). */
export function projectedRowEncodedBytes(row: OrchestrationV2ProjectedTurnItem): number {
  return bytesOfJson(row);
}

/**
 * Bounded-snapshot cost: local rows also land in `projection.turnItems`, so
 * charge the nested item a second time. Inherited rows only appear in the
 * visible list.
 */
export function projectedRowBoundedSnapshotEncodedBytes(
  row: OrchestrationV2ProjectedTurnItem,
  threadId: ThreadId | string,
): number {
  const rowBytes = projectedRowEncodedBytes(row);
  if (row.visibility === "local" || String(row.sourceThreadId) === String(threadId)) {
    return rowBytes + bytesOfJson(row.item);
  }
  return rowBytes;
}

function renumberPositions(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return items.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function encodeCursorPayload(payload: ThreadHistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeThreadHistoryCursor(input: {
  readonly snapshotSequence: number;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceItemId: TurnItemId | string;
  readonly position: number;
  readonly ordinal?: number | undefined;
  readonly boundLongTurns?: boolean | undefined;
}): string {
  return encodeCursorPayload({
    v: 1,
    seq: input.snapshotSequence,
    st: String(input.sourceThreadId),
    si: String(input.sourceItemId),
    p: input.position,
    ...(input.ordinal === undefined ? {} : { o: input.ordinal }),
    ...(input.boundLongTurns === true ? { b: 1 as const } : {}),
  });
}

export function decodeThreadHistoryCursor(cursor: string): ThreadHistoryCursorPayload {
  if (cursor.length === 0 || cursor.length > THREAD_HISTORY_CURSOR_MAX_LENGTH) {
    throw new InvalidThreadHistoryCursorError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidThreadHistoryCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    (parsed as { v: unknown }).v !== 1 ||
    !("seq" in parsed) ||
    typeof (parsed as { seq: unknown }).seq !== "number" ||
    !Number.isInteger((parsed as { seq: number }).seq) ||
    (parsed as { seq: number }).seq < 0 ||
    !("st" in parsed) ||
    typeof (parsed as { st: unknown }).st !== "string" ||
    (parsed as { st: string }).st.length === 0 ||
    !("si" in parsed) ||
    typeof (parsed as { si: unknown }).si !== "string" ||
    (parsed as { si: string }).si.length === 0 ||
    !("p" in parsed) ||
    typeof (parsed as { p: unknown }).p !== "number" ||
    !Number.isInteger((parsed as { p: number }).p) ||
    (parsed as { p: number }).p < 0 ||
    ("o" in parsed &&
      (typeof (parsed as { o: unknown }).o !== "number" ||
        !Number.isInteger((parsed as { o: number }).o))) ||
    ("b" in parsed && (parsed as { b: unknown }).b !== 1)
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  return parsed as ThreadHistoryCursorPayload;
}

export function isThreadHistoryTurnStart(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "user_message" &&
    (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
  );
}

/** Steering belongs to its existing turn and must not consume another page slot. */
export function isThreadHistoryUserTurn(item: OrchestrationV2TurnItem): boolean {
  return (
    isThreadHistoryTurnStart(item) && item.type === "user_message" && item.createdBy === "user"
  );
}

/**
 * Walk a chronological timeline backward from the exclusive end, collecting rows
 * through complete user turns within the row and byte budgets. Always admit at
 * least one row so oversized items cannot deadlock paging.
 */
function selectOlderTimelinePage(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly exclusiveEndIndex: number;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
  /** The store left older rows out of `items`; a page that reaches the first row still has more. */
  readonly olderRowsUnloaded?: boolean | undefined;
}): SelectTimelinePageResult {
  const policy: ThreadHistoryPagePolicy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const rowCost = input.rowEncodedBytes ?? projectedRowEncodedBytes;
  const end = Math.min(Math.max(input.exclusiveEndIndex, 0), input.items.length);
  if (end <= 0) {
    return { items: [], nextCursor: null, hasMoreHistory: false };
  }

  const selected: OrchestrationV2ProjectedTurnItem[] = [];
  let encodedBytes = 0;
  let userTurns = 0;
  let rawTurns = 0;
  const turnLimit = input.items.slice(0, end).some((row) => isThreadHistoryUserTurn(row.item))
    ? policy.maxUserTurns
    : undefined;
  const wholeTurns = policy.wholeTurns === true && turnLimit !== undefined;
  const maxItems =
    turnLimit === undefined ? policy.maxItems : (policy.maxTurnItems ?? policy.maxItems);
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = input.items[index]!;
    const rowBytes = wholeTurns ? 0 : rowCost(row);
    const turnsFull =
      turnLimit !== undefined &&
      (userTurns >= turnLimit || rawTurns >= THREAD_HISTORY_MAX_RAW_TURNS);
    if (
      selected.length > 0 &&
      (wholeTurns
        ? turnsFull
        : selected.length >= maxItems ||
          encodedBytes + rowBytes > policy.maxEncodedBytes ||
          turnsFull)
    ) {
      break;
    }
    selected.push(row);
    encodedBytes += rowBytes;
    if (isThreadHistoryUserTurn(row.item)) userTurns += 1;
    if (isThreadHistoryTurnStart(row.item)) rawTurns += 1;
  }
  // Inside a turn longer than the window no selected row starts a user turn.
  // The projection query then loads only `maxItems + 2` rows for the next
  // page, so this page stops at `maxItems` too and never skips a row.
  if (!wholeTurns && userTurns === 0) selected.splice(policy.maxItems);
  selected.reverse();

  const oldest = selected[0];
  const oldestIndex = oldest
    ? input.items.findIndex(
        (row) =>
          row.sourceThreadId === oldest.sourceThreadId && row.sourceItemId === oldest.sourceItemId,
      )
    : -1;
  // The store cuts each segment of a forked timeline on its own, so a page
  // can reach the first loaded row while older rows wait in the store.
  const hasMoreHistory = oldestIndex > 0 || (oldestIndex === 0 && input.olderRowsUnloaded === true);
  const nextCursor =
    hasMoreHistory && oldest
      ? encodeThreadHistoryCursor({
          snapshotSequence: input.snapshotSequence,
          sourceThreadId: oldest.sourceThreadId,
          sourceItemId: oldest.sourceItemId,
          position: oldest.position,
          ordinal: oldest.item.ordinal,
          boundLongTurns: policy.wholeTurns !== true,
        })
      : null;

  return {
    items: renumberPositions(selected),
    nextCursor,
    hasMoreHistory,
  };
}

export function selectRecentTimelineWindow(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
  readonly olderRowsUnloaded?: boolean | undefined;
}): SelectTimelinePageResult {
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: input.items.length,
    snapshotSequence: input.snapshotSequence,
    olderRowsUnloaded: input.olderRowsUnloaded,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
  });
}

function findCursorIndex(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  cursor: ThreadHistoryCursorPayload,
): number {
  const byIdentity = items.findIndex(
    (row) => String(row.sourceThreadId) === cursor.st && String(row.sourceItemId) === cursor.si,
  );
  if (byIdentity !== -1) {
    return byIdentity;
  }
  // The cursor row left the timeline, for example when its run was rolled
  // back. Resume below it by ordinal: rows of the cursor's thread before its
  // ordinal, and the older threads above them. A position would skip rows,
  // since the window the cursor came from was shorter than this one. An old
  // cursor without an ordinal resumes after every row of its thread; the
  // store loads only rows up to the cursor for an anchored page.
  const ordinal = cursor.o ?? Number.POSITIVE_INFINITY;
  let seenCursorThread = false;
  for (const [index, row] of items.entries()) {
    const inCursorThread =
      String(row.sourceThreadId) === cursor.st && row.visibility !== "synthetic";
    if (inCursorThread) {
      if (row.item.ordinal >= ordinal) return index;
      seenCursorThread = true;
    } else if (seenCursorThread) {
      // A later thread's rows, or the fork marker after the cursor's thread.
      return index;
    }
  }
  return items.length;
}

export function selectHistoryPageFromCursor(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly cursor: string;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly olderRowsUnloaded?: boolean | undefined;
}): SelectTimelinePageResult {
  const decoded = decodeThreadHistoryCursor(input.cursor);
  const anchorIndex = findCursorIndex(input.items, decoded);
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: anchorIndex,
    snapshotSequence: input.snapshotSequence,
    olderRowsUnloaded: input.olderRowsUnloaded,
    // A cursor keeps the mode of the page that issued it.
    policy: input.policy ?? {
      ...(decoded.b === 1 ? THREAD_HISTORY_PAGE_POLICY : WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY),
      maxUserTurns: OLDER_THREAD_USER_TURN_LIMIT,
    },
  });
}

/** Whether a history cursor came from a page cut with bounded long turns. */
export function threadHistoryCursorBoundsLongTurns(cursor: ThreadHistoryCursorPayload): boolean {
  return cursor.b === 1;
}

function isLocalProjectedRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || String(row.sourceThreadId) === String(projection.thread.id);
}

/**
 * Visibility for superseded `run_interrupt_result` rows depends on a matching
 * `run_interrupt_request` in `turnItems`. Keep every small request item from the
 * full projection even when it sits outside the recent visible window, so a
 * later history page that introduces the matching result still has the request
 * available for live attempt/run reducers.
 */
function retainedInterruptRequestTurnItems(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const visibleLocalIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      visibleLocalIds.add(String(row.sourceItemId));
    }
  }

  const retained: OrchestrationV2TurnItem[] = [];
  for (const item of projection.turnItems) {
    if (item.type !== "run_interrupt_request") {
      continue;
    }
    // Already covered by local turnItems for the visible window.
    if (visibleLocalIds.has(String(item.id))) {
      continue;
    }
    retained.push(item);
  }
  return retained;
}

function localTurnItemsForVisibleWindow(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const localIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      localIds.add(String(row.sourceItemId));
    }
  }
  if (localIds.size === 0) {
    return [];
  }
  return projection.turnItems.filter((item) => localIds.has(String(item.id)));
}

function messagesForBoundedProjection(
  projection: OrchestrationV2ThreadProjection,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection["messages"] {
  const retainedMessageIds = new Set<string>();
  for (const item of turnItems) {
    if ("messageId" in item) {
      retainedMessageIds.add(String(item.messageId));
    }
  }

  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const retainedRunIds = new Set<string>();
  for (const run of projection.runs) {
    if (
      run.id === latestRun?.id ||
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting" ||
      run.status === "queued"
    ) {
      retainedRunIds.add(String(run.id));
      retainedMessageIds.add(String(run.userMessageId));
    }
  }

  return projection.messages.filter(
    (message) =>
      retainedMessageIds.has(String(message.id)) ||
      (message.runId !== null && retainedRunIds.has(String(message.runId))) ||
      message.delegatedCompletion !== undefined,
  );
}

/**
 * Max local turn ordinal over the authoritative full projection turnItems.
 * Used as a cheap partial-timeline watermark so old missing turn-item updates
 * cannot append newest when the bounded window has no local rows.
 */
export function computeLatestLocalTurnOrdinal(
  turnItems: ReadonlyArray<{ readonly ordinal: number }>,
): number | null {
  let latest: number | null = null;
  for (const item of turnItems) {
    if (latest === null || item.ordinal > latest) {
      latest = item.ordinal;
    }
  }
  return latest;
}

/**
 * Encoded timeline contribution for a bounded snapshot: visible rows plus the
 * duplicated local turnItems and any retained interrupt-request dependencies.
 */
export function boundedTimelineEncodedBytes(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): number {
  let total = 0;
  for (const row of input.visibleTurnItems) {
    total += projectedRowEncodedBytes(row);
  }
  for (const item of input.turnItems) {
    total += bytesOfJson(item);
  }
  return total;
}

/**
 * Builds a partial thread projection with full control-plane arrays and a
 * bounded recent timeline window plus matching local turnItems.
 */
export function buildBoundedThreadProjection(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  /**
   * The thread's newest user turn start when the projection rows hold none.
   * Sent beside the window when the window starts inside that turn.
   */
  readonly latestUserTurnStart?: OrchestrationV2ProjectedTurnItem | null | undefined;
  readonly olderRowsUnloaded?: boolean | undefined;
}): BoundedProjectionResult {
  const policy: ThreadHistoryPagePolicy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const threadId = input.projection.thread.id;
  const controlProjection = {
    ...input.projection,
    plans: input.projection.plans.filter((plan) => plan.status === "active"),
    contextHandoffs: input.projection.contextHandoffs.filter(
      (handoff) => handoff.status === "pending" || handoff.status === "ready",
    ),
  };
  const latestLocalTurnOrdinal = computeLatestLocalTurnOrdinal(input.projection.turnItems);
  const pendingIds = new Set(
    controlProjection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => String(request.id)),
  );
  const pendingControlItems = controlProjection.turnItems.filter(
    (item) =>
      item.threadId === threadId &&
      (item.type === "user_input_request" || item.type === "approval_request") &&
      pendingIds.has(String(item.requestId)),
  );
  const pendingControlIds = new Set(pendingControlItems.map((item) => String(item.id)));

  // Reserve bytes for small interrupt-request dependencies that may sit outside
  // the recent window but are required for visibility of results inside it.
  const dependencyReserve = (() => {
    // Upper bound: all request items in the full projection. Window selection
    // uses this reserve so the final contribution stays under the cap.
    let reserve = 0;
    for (const item of controlProjection.turnItems) {
      if (item.type === "run_interrupt_request" || pendingControlIds.has(String(item.id))) {
        reserve += bytesOfJson(item);
      }
    }
    return reserve;
  })();
  const controlBytes = bytesOfJson({
    ...controlProjection,
    messages: [],
    turnItems: [],
    visibleTurnItems: [],
  });
  const latestUserTurnStart =
    policy.wholeTurns === true
      ? null
      : (input.latestUserTurnStart ??
        input.projection.visibleTurnItems.findLast((row) => isThreadHistoryUserTurn(row.item)) ??
        null);
  const selectWindow = (reserve: number) => {
    const windowBudget = Math.max(
      0,
      policy.maxEncodedBytes - dependencyReserve - reserve - controlBytes - 1_024,
    );
    const window = selectRecentTimelineWindow({
      items: controlProjection.visibleTurnItems,
      snapshotSequence: input.snapshotSequence,
      // Zero still admits the first row via the at-least-one rule.
      policy: { ...policy, maxEncodedBytes: windowBudget },
      rowEncodedBytes: (row) => projectedRowBoundedSnapshotEncodedBytes(row, threadId),
      olderRowsUnloaded: input.olderRowsUnloaded,
    });
    const items = renumberPositions(window.items);
    return {
      window,
      visibleTurnItems: items,
      windowTurnStart: windowTurnStartFor({
        turnStart: latestUserTurnStart,
        window: items,
        hasMoreHistory: window.hasMoreHistory,
      }),
    };
  };
  // The prompt sent beside the window takes its bytes from the window. Charge
  // them only when it is sent: a prompt inside the window is counted there.
  const unreserved = selectWindow(0);
  const { window, visibleTurnItems, windowTurnStart } =
    unreserved.windowTurnStart === null
      ? unreserved
      : selectWindow(projectedRowEncodedBytes(unreserved.windowTurnStart));
  const windowTurnItems = localTurnItemsForVisibleWindow(controlProjection, visibleTurnItems);
  const dependencyTurnItems = retainedInterruptRequestTurnItems(
    controlProjection,
    visibleTurnItems,
  );
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of windowTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  for (const item of [...dependencyTurnItems, ...pendingControlItems]) {
    turnItemById.set(String(item.id), item);
  }
  const turnItems = [...turnItemById.values()];

  const visiblePlanIds = new Set(
    turnItems.flatMap((item) =>
      item.type === "proposed_plan" || item.type === "todo_list" ? [String(item.planId)] : [],
    ),
  );
  const visibleHandoffIds = new Set(
    turnItems.flatMap((item) => (item.type === "handoff" ? [String(item.contextHandoffId)] : [])),
  );
  const plans = input.projection.plans
    .filter((plan) => plan.status === "active" || visiblePlanIds.has(String(plan.id)))
    .map((plan) =>
      plan.status === "active"
        ? plan
        : plan.kind === "proposed_plan"
          ? { ...plan, markdown: "", detailInTurnItem: true as const }
          : { ...plan, explanation: undefined, detailInTurnItem: true as const },
    );
  const contextHandoffs = input.projection.contextHandoffs
    .filter(
      (handoff) =>
        handoff.status === "pending" ||
        handoff.status === "ready" ||
        visibleHandoffIds.has(String(handoff.id)),
    )
    .map((handoff) =>
      handoff.status === "pending" || handoff.status === "ready"
        ? handoff
        : { ...handoff, summaryText: "", detailInTurnItem: true as const },
    );

  const projection = {
    ...controlProjection,
    plans,
    contextHandoffs,
    messages: messagesForBoundedProjection(
      controlProjection,
      windowTurnStart === null ? turnItems : [windowTurnStart.item, ...turnItems],
    ),
    turnItems,
    visibleTurnItems,
  };
  return {
    projection,
    historyCursor: window.nextCursor,
    hasMoreHistory: window.hasMoreHistory,
    // Always from the full projection so inherited-only windows still carry a
    // watermark for partial live reducers.
    latestLocalTurnOrdinal,
    windowTurnStart,
  };
}

function projectedRowKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

/**
 * A window inside one long turn would open on tool output with no prompt
 * above it. Keep the turn's user message beside the window; the rows between
 * them stay behind the history cursor, so paging reaches them in order.
 */
function windowTurnStartFor(input: {
  readonly turnStart: OrchestrationV2ProjectedTurnItem | null;
  readonly window: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly hasMoreHistory: boolean;
}): OrchestrationV2ProjectedTurnItem | null {
  const { turnStart, window } = input;
  if (
    turnStart === null ||
    !input.hasMoreHistory ||
    !isThreadHistoryUserTurn(turnStart.item) ||
    window.some((row) => isThreadHistoryUserTurn(row.item))
  ) {
    return null;
  }
  const key = projectedRowKey(turnStart);
  const oldest = window[0];
  if (
    oldest === undefined ||
    window.some((row) => projectedRowKey(row) === key) ||
    // Only a local window can open inside a local turn; ordinals order rows
    // within one thread.
    String(oldest.sourceThreadId) !== String(turnStart.sourceThreadId) ||
    oldest.item.ordinal <= turnStart.item.ordinal
  ) {
    return null;
  }
  return turnStart.position === 0 ? turnStart : { ...turnStart, position: 0 };
}
