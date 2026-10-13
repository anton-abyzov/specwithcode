import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectEnvironmentError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  makeProviderFailure,
  providerFailureDiagnostics,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  simulatedUsageLimitFailure,
} from "./ProviderFailure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import { ProviderAdapterTurnStartError } from "./ProviderAdapter.ts";

it("redacts credentials and URL secrets from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      'request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop',
    code: "provider_rejected",
    class: "provider_error",
  });

  assert.equal(failure.class, "provider_error");
  assert.equal(failure.code, "provider_rejected");
  assert.include(failure.message, "[REDACTED]");
  assert.include(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "bearer-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "url-secret");
  assert.notInclude(failure.message, "json-secret");
  assert.notInclude(failure.message, "key-secret");
  assert.notInclude(failure.message, "sk-abcdefghijklmnop");
});

it("replaces unsafe control characters without stripping whitespace", () => {
  const failure = makeProviderFailure({ message: "before\u0000\u0007\t\nafter\u007f" });

  assert.equal(failure.message, "before  \t\nafter");
});

it("bounds provider-controlled failure strings", () => {
  const failure = makeProviderFailure({
    message: "m".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH + 500),
    code: "c".repeat(MAX_PROVIDER_FAILURE_CODE_LENGTH + 50),
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  assert.equal(failure.code?.length, MAX_PROVIDER_FAILURE_CODE_LENGTH);
  assert.match(failure.message, /…$/u);
  assert.match(failure.code ?? "", /…$/u);
});

it("does not split a surrogate pair at the truncation boundary", () => {
  const failure = makeProviderFailure({
    message: `${"a".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 2)}🚀tail`,
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 1);
  assert.equal(failure.message.at(-1), "…");
  assert.notMatch(failure.message.slice(0, -1), /[\uD800-\uDBFF]$/u);
});

it("does not expose arbitrary cause messages and preserves explicit messages", () => {
  const cause = new Error("Adapter failed", {
    cause: new Error("Session expired. Sign in again."),
  });
  for (const value of [
    cause,
    Cause.fail(cause),
    "Session expired. Sign in again.",
    { message: "Session expired. Sign in again." },
  ]) {
    assert.equal(makeProviderFailure({ cause: value }).message, "Provider turn failed.");
    assert.equal(
      makeProviderFailure({ cause: value, message: "Provider connection closed." }).message,
      "Provider connection closed.",
    );
  }
});

it("preserves actionable handoff errors wrapped by turn startup", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:handoff-error"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
    runId: RunId.make("run:handoff-error"),
    cause: new ContextHandoffBudgetError(),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    new ContextHandoffBudgetError().message,
  );
});

it("keeps native quota admission typed when an existing session starts its turn", () => {
  const resetAt = "2026-10-18T03:58:37.000Z";
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:quota"),
    providerThreadId: ProviderThreadId.make("provider-thread:quota"),
    runId: RunId.make("run:quota"),
    cause: new ProviderSetupError({
      instanceId: ProviderInstanceId.make("codex"),
      operation: "session",
      detail: "Permission denied",
      usageLimit: { resetAt },
    }),
  });
  for (const wrapped of [cause, Cause.fail(cause)]) {
    const failure = makeProviderFailure({ cause: wrapped, class: "provider_error" });
    assert.equal(failure.class, "usage_limit");
    assert.equal(failure.resetAt, resetAt);
    assert.equal(failure.message, "Permission denied");
  }
  assert.equal(
    makeProviderFailure({ cause: new Error("usage limit denied"), class: "provider_error" }).class,
    "provider_error",
  );
});

it("names the setup reason when turn startup fails a native status check", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("claudeAgent"),
    threadId: ThreadId.make("thread:status-check"),
    providerThreadId: ProviderThreadId.make("provider-thread:status-check"),
    runId: RunId.make("run:status-check"),
    cause: new ProviderSetupError({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      operation: "session",
      detail:
        "The native provider status check timed out. Refresh Providers on this machine and try again.",
    }),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    "The native provider status check timed out. Refresh Providers on this machine and try again.",
  );
});

it("does not expose defect text nested inside a known error category", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterEventStreamError",
      cause: new Error(
        `Session rejected: Bearer nested-secret https://user:pass@example.test/path?token=secret ${"x".repeat(5000)}`,
      ),
    },
  });
  assert.include(failure.message, "provider event stream closed unexpectedly");
  assert.notInclude(failure.message, "Session rejected:");
  assert.notInclude(failure.message, "nested-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.isBelow(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(makeProviderFailure({ cause: cyclic }).message, "Provider turn failed.");
  assert.equal(
    makeProviderFailure({
      cause: {
        get message() {
          throw new Error("unreadable");
        },
        get cause() {
          throw new Error("unreadable");
        },
      },
    }).message,
    "Provider turn failed.",
  );
});

it("falls back when inspecting a provider cause throws", () => {
  const cause = new Proxy(
    {},
    {
      has() {
        throw new Error("unreadable provider cause");
      },
    },
  );
  assert.equal(makeProviderFailure({ cause }).message, "Provider turn failed.");
});

it("does not serialize arbitrary provider causes", () => {
  const failure = makeProviderFailure({
    cause: {
      payload: { authorization: "Bearer nested-secret" },
      stack: "private provider stack",
    },
    class: "transport_error",
  });

  assert.deepEqual(failure, {
    class: "transport_error",
    message: "Provider turn failed.",
    code: null,
    retryable: null,
  });
});

it.effect("keys terminal failure items by provider turn across retries and fallback paths", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const driver = ProviderDriverKind.make("codex");
    const runId = RunId.make("run:provider-failure-id");
    const base = {
      idAllocator,
      driver,
      threadId: ThreadId.make("thread:provider-failure-id"),
      runId,
      nodeId: NodeId.make("node:provider-failure-id"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-failure-id"),
      itemOrdinal: 101,
      failure: makeProviderFailure({ message: "Provider failed" }),
      occurredAt: DateTime.makeUnsafe("2026-06-22T12:00:00.000Z"),
    } as const;
    const firstTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:first");
    const secondTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:second");

    const firstAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: firstTurnId,
    });
    const retriedAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: secondTurnId,
    });
    const ingestorFallback = makeProviderFailureTurnItem({
      ...base,
      runId: null,
      nodeId: null,
      providerTurnId: firstTurnId,
    });

    assert.notEqual(firstAttempt.id, retriedAttempt.id);
    assert.equal(firstAttempt.id, ingestorFallback.id);
    assert.equal(firstAttempt.ordinal, 101);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it("simulates a usage limit only for the listed provider instances", () => {
  const env = { STUDIO_SIMULATE_USAGE_LIMIT: " claudeAgent , cursor" };
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const failure = simulatedUsageLimitFailure("claudeAgent", env, now);
  assert.equal(failure?.class, "usage_limit");
  assert.equal(failure?.resetAt, "2026-10-09T13:00:00.000Z");
  assert.equal(simulatedUsageLimitFailure("codex", env, now), null);
  assert.equal(simulatedUsageLimitFailure("claudeAgent", {}, now), null);
});

it("shows the project folder policy condition instead of a generic provider startup error", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("acpRegistry"),
    threadId: ThreadId.make("aide"),
    providerThreadId: ProviderThreadId.make("provider-thread:aide"),
    runId: RunId.make("run:aide"),
    cause: new ProjectEnvironmentError({
      projectId: ProjectId.make("project:aide"),
      code: "unsupported_provider",
    }),
  });
  for (const wrapped of [cause, Cause.fail(cause)]) {
    const failure = makeProviderFailure({ cause: wrapped });
    assert.include(failure.message, "additional project folders under the current permissions");
    assert.include(failure.message, "Full access");
    assert.notInclude(failure.message, "could not start this turn");
  }
  assert.notInclude(
    makeProviderFailure({
      cause: {
        _tag: "ProjectEnvironmentError",
        code: "unsupported_provider",
        message: "private payload",
      },
    }).message,
    "private payload",
  );
});
it("retains curated project folder identity errors through startup wrappers", () => {
  const error = new ProjectEnvironmentError({
    projectId: ProjectId.make("p"),
    code: "path_not_approved",
  });
  assert.equal(
    makeProviderFailure({ cause: { _tag: "ProviderAdapterTurnStartError", cause: error } }).message,
    error.message,
  );
});

it("logs structural startup causes and the curated folder error code without payloads", () => {
  const environment = new ProjectEnvironmentError({
    projectId: ProjectId.make("private-project-id"),
    code: "unsupported_provider",
  });
  const wrapped = {
    _tag: "ProviderAdapterTurnStartError",
    detail: "Bearer private-token",
    cause: environment,
  };
  assert.deepEqual(providerFailureDiagnostics(Cause.fail(wrapped)), {
    errorTags: ["ProviderAdapterTurnStartError", "ProjectEnvironmentError"],
    errorCode: "unsupported_provider",
  });
  const raw = {
    _tag: "secret-provider-tag",
    cause: new Error("private prompt content"),
    detail: "private content",
  };
  const serialized = JSON.stringify(providerFailureDiagnostics(raw));
  assert.notInclude(serialized, "secret-provider-tag");
  assert.notInclude(serialized, "private");
  raw.cause = raw as unknown as Error;
  assert.deepEqual(providerFailureDiagnostics(raw), { errorTags: ["UnknownError"] });
  assert.deepEqual(
    providerFailureDiagnostics({
      get _tag() {
        throw new Error("private getter");
      },
    }),
    { errorTags: [] },
  );
});
