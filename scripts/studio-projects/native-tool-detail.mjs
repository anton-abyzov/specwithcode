// Local, read-only detail hydration for the exact already-approved synthetic calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { APPROVAL_PLAN, approvalReceipt, unpromptedWaitDetailBinding } from "./native-approval.mjs";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const waits = new WeakMap(),
  failures = new WeakMap();
function guard(ok, reason) {
  if (ok) return;
  const error = new assert.AssertionError({ message: `Native tool detail refused: ${reason}` });
  failures.set(error, error.message);
  throw error;
}
export function toolDetailFailureReason(error) {
  return failures.get(error);
}
function one(rows, predicate, reason) {
  const result = rows.filter(predicate);
  guard(result.length === 1, reason);
  return result[0];
}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Exact pure port of toolOutput.ts/compactDynamicToolOutput and htmlRender.ts readers
// from runtime 8d40b4e8dce1224feadac1a528630a6cb1df9bd6. Predicate.isObject
// is the identical non-null/non-array object predicate above. No runtime dependency.
const HTML_RENDER_MIN_HEIGHT = 80,
  HTML_RENDER_MAX_HEIGHT = 2000,
  HTML_RENDER_MAX_TITLE_LENGTH = 200;
const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0], clampHtmlRenderHeight(entry[1])]]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

function readHtmlRenderReference(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights } = value;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
  };
}

function clampHtmlRenderHeight(height) {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

function readResult(value, budget, depth = 0) {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data;
    let failed = false;
    for (const block of value) {
      const text = object(block) ? block.text : undefined;
      const result = readResult(object(text) ? (text.text ?? text) : text, budget, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!object(value)) return { failed: false };
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const content = value.structuredContent ?? value.content;
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value) {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

/** Keeps only IDs and failure metadata used by Studio's grouped tool summaries. */
export function canonicalNativeToolOutput(value) {
  const budget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output = result.failed ? { isError: true } : {};
  const data = budget.exceeded ? undefined : result.data;
  if (data !== undefined) {
    for (const key of ["threadId", "messageId", "taskId", "scheduledTaskId"]) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const nestedThreadId = object(data.thread) ? boundedId(data.thread.threadId) : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!object(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // A partial batch or a top-level ID would turn an unknown creation
        // count into a confidently wrong one in the existing summary parser.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  if (encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

export function readOwnedToolItem(db, projectId, threadId, itemId) {
  const row = db
    .prepare(`SELECT t.project_id, i.thread_id, i.payload_json
    FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
    WHERE t.project_id = ? AND t.deleted_at IS NULL AND i.thread_id = ? AND i.turn_item_id = ?`)
    .get(projectId, threadId, itemId);
  guard(
    row && typeof row.payload_json === "string" && Buffer.byteLength(row.payload_json) <= 1048576,
    "owned stored item missing or oversized",
  );
  let item;
  try {
    item = JSON.parse(row.payload_json);
  } catch {
    guard(false, "stored item JSON");
  }
  return { projectId: row.project_id, threadId: row.thread_id, item };
}
export function hydrateApprovedToolOutputs(scope, projection, read, now = Date.now()) {
  guard(
    projection.thread.projectId === scope.projectId && scope.threadIds.has(projection.thread.id),
    "projection owner",
  );
  const grants = approvalReceipt(scope),
    pending = waits.get(scope) ?? new Map();
  waits.set(scope, pending);
  for (const [id, entry] of pending)
    if (entry.threadId === projection.thread.id) {
      const item = one(projection.turnItems, (i) => i.id === id, "detail publication disappeared");
      guard(
        item.type === "dynamic_tool" && item.status === "completed" && item.outputOmitted === true,
        "detail publication reverted",
      );
    }
  let ready = true,
    reads = 0;
  const hydrated = new Map();
  const turnItems = [...projection.turnItems]
    .sort(
      (a, b) =>
        Number(a.toolName === "studio-code.studio_thread_wait") -
        Number(b.toolName === "studio-code.studio_thread_wait"),
    )
    .map((wire) => {
      if (wire.type !== "dynamic_tool" || wire.status !== "completed") return wire;
      const operation = wire.toolName?.replace(/^studio-code\./, "");
      if (wire.toolName === "studio-code.orchestrator_capabilities") return wire; // Existing guard validates discovery; it has no approval/result dependency.
      guard(
        APPROVAL_PLAN.operations.includes(operation) &&
          wire.toolName === `studio-code.${operation}`,
        "unreviewed operation",
      );
      guard(wire.outputOmitted === true, "completed wire output marker missing");
      const unpromptedWait =
        operation === "studio_thread_wait" && !grants.some((g) => g.operation === operation);
      if (unpromptedWait && !ready) return wire; // A prior send's stored revision must settle first.
      const grant = unpromptedWait
        ? unpromptedWaitDetailBinding(
            scope,
            { ...projection, turnItems: projection.turnItems.map((i) => hydrated.get(i.id) ?? i) },
            wire,
          )
        : one(
            grants,
            (g) => g.operation === operation && g.submitted && g.decision === "accept",
            "submitted grant missing",
          );
      guard(
        grant.projectId === scope.projectId &&
          grant.threadId === projection.thread.id &&
          grant.callId === wire.id &&
          grant.runId === wire.runId &&
          grant.providerThreadId === wire.providerThreadId &&
          grant.providerTurnId === wire.providerTurnId &&
          grant.inputSha256 === hash(wire.input),
        "grant/item binding",
      );
      const run = one(projection.runs, (r) => r.id === wire.runId, "run missing");
      const observed = scope.runs.get(run.id);
      const attempt = one(projection.attempts, (a) => a.runId === run.id, "attempt missing");
      const provider = one(
        projection.providerThreads,
        (p) => p.id === wire.providerThreadId,
        "provider thread missing",
      );
      const session = one(
        projection.providerSessions,
        (s) => s.id === provider.providerSessionId,
        "provider session missing",
      );
      const turn = one(
        projection.providerTurns,
        (t) => t.id === wire.providerTurnId,
        "provider turn missing",
      );
      guard(
        observed?.threadId === projection.thread.id &&
          run.threadId === projection.thread.id &&
          run.activeAttemptId === grant.attemptId &&
          attempt.id === grant.attemptId &&
          attempt.attemptOrdinal === 1 &&
          attempt.reason === "initial" &&
          attempt.providerThreadId === provider.id &&
          turn.runAttemptId === attempt.id &&
          turn.providerThreadId === provider.id &&
          provider.appThreadId === projection.thread.id &&
          hash(session.id) === grant.sessionSha256,
        "run/attempt/turn/session binding",
      );
      guard(++reads <= APPROVAL_PLAN.maxResponses, "detail read budget");
      const row = read(scope.projectId, projection.thread.id, wire.id),
        raw = row?.item;
      guard(
        row?.projectId === scope.projectId &&
          row.threadId === projection.thread.id &&
          object(raw) &&
          raw.threadId === projection.thread.id,
        "stored item owner",
      );
      for (const key of [
        "id",
        "runId",
        "nodeId",
        "providerThreadId",
        "providerTurnId",
        "type",
        "toolName",
        "status",
        "input",
        "ordinal",
        "createdAt",
      ])
        guard(isDeepStrictEqual(raw[key], wire[key]), "stored item identity/input/status differs");
      guard(wire.threadId === undefined || wire.threadId === raw.threadId, "wire item owner");
      guard(
        raw.outputOmitted !== true &&
          object(raw.output) &&
          (wire.output === undefined || object(wire.output)),
        "full stored output missing",
      );
      if (operation === "studio_thread_read")
        guard(
          object(raw.output.thread) && raw.output.thread.threadId === wire.input.threadId,
          "full read thread binding",
        );
      guard(
        isDeepStrictEqual(wire.output, canonicalNativeToolOutput(raw.output)),
        "canonical wire output conflicts",
      );
      guard(
        typeof wire.updatedAt === "string" &&
          Number.isFinite(Date.parse(wire.updatedAt)) &&
          typeof raw.updatedAt === "string" &&
          Number.isFinite(Date.parse(raw.updatedAt)),
        "item revision missing",
      );
      const identity = hash({
        grant,
        id: wire.id,
        runId: wire.runId,
        nodeId: wire.nodeId,
        input: wire.input,
      });
      const previous = pending.get(wire.id);
      guard(
        !previous || (previous.identity === identity && now - previous.since <= 2000),
        "detail publication changed or timed out",
      );
      if (wire.updatedAt !== raw.updatedAt) {
        pending.set(wire.id, previous ?? { threadId: projection.thread.id, identity, since: now });
        ready = false;
        return wire;
      }
      pending.delete(wire.id);
      const detail = { ...wire, output: raw.output, outputOmitted: undefined };
      hydrated.set(wire.id, detail);
      return detail;
    });
  const byId = new Map(turnItems.map((i) => [i.id, i]));
  return {
    projection: { ...projection, turnItems: projection.turnItems.map((i) => byId.get(i.id)) },
    ready,
  };
}
