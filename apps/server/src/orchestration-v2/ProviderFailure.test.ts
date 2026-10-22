import { providerFailureFallbackMessage } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderFailureClass,
  ProjectEnvironmentError,
  ProjectId,
  ProviderDriverKind,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  ProviderInstanceId,
  ProviderSessionId,
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
  innermostCauseMessage,
  makeProviderFailure,
  providerFailureDiagnostics,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  shouldHoldQueueAfterFailure,
  simulatedUsageLimitFailure,
  WORKSPACE_BRANCH_MISSING_FAILURE_CODE,
} from "./ProviderFailure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterTurnStartError,
} from "./ProviderAdapter.ts";
import { ProviderSessionOpenError } from "./ProviderSessionManager.ts";
import { AcpRegistryError } from "../provider/acp/AcpRegistrySupport.ts";
import * as EffectAcpErrors from "@specweave-studio/effect-acp/errors";

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

it("redacts bare Cursor and xAI keys from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      "Key crsr_abcdefghijklmnop1234 was rejected; grok_ABCDEFGHIJKLMNOP-5678 and xai_abcdefgh_ijklmnop9 too, also xai-AbCdEfGhIjKlMnOpQr12. grok_short and grok-code-fast-1-preview-0825 stay.",
    class: "provider_error",
  });

  assert.equal(
    failure.message,
    "Key [REDACTED] was rejected; [REDACTED] and [REDACTED] too, also [REDACTED]. grok_short and grok-code-fast-1-preview-0825 stay.",
  );
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
    assert.equal(
      makeProviderFailure({ cause: value }).message,
      providerFailureFallbackMessage("unknown"),
    );
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

it("explains unsupported project folder grants wrapped by provider startup", () => {
  const environmentError = new ProjectEnvironmentError({
    projectId: ProjectId.make("project:folders"),
    code: "unsupported_provider",
  });
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("acpRegistry"),
    threadId: ThreadId.make("thread:folders"),
    providerThreadId: ProviderThreadId.make("provider-thread:folders"),
    runId: RunId.make("run:folders"),
    cause: environmentError,
  });
  for (const wrapped of [cause, Cause.fail(cause)]) {
    const failure = makeProviderFailure({ cause: wrapped, class: "provider_error" });
    assert.include(failure.message, "additional project folders under the current permissions");
    assert.include(failure.message, "Full access");
    assert.equal(failure.class, "provider_error");
  }
});

it("reconstructs project environment diagnostics without reading supplied text", () => {
  const projectId = ProjectId.make("project:safe-error");
  const cause = new ProjectEnvironmentError({ projectId, code: "path_not_approved" });
  Object.defineProperty(cause, "message", {
    get() {
      throw new Error("Private provider text must not be read.");
    },
  });
  const failure = makeProviderFailure({ cause });
  assert.equal(
    failure.message,
    new ProjectEnvironmentError({ projectId, code: "path_not_approved" }).message,
  );
  assert.notInclude(failure.message, "private-provider-text");
});

it("does not trust unknown project environment codes", () => {
  for (const cause of [
    { _tag: "ProjectEnvironmentError", projectId: "p", code: "provider-secret" },
    { _tag: "ProjectEnvironmentError", message: "Private provider text" },
  ]) {
    assert.equal(makeProviderFailure({ cause }).message, providerFailureFallbackMessage("unknown"));
  }
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

it("marks a provider that cannot run on this machine as unavailable", () => {
  const detail =
    "GitHub Copilot 1.0.101 is not prepared. Use Install / update agent in Settings → Providers.";
  const unavailable = (setup: Partial<ConstructorParameters<typeof ProviderSetupError>[0]>) =>
    new ProviderAdapterOpenSessionError({
      driver: ProviderDriverKind.make("acpRegistry"),
      providerSessionId: ProviderSessionId.make("provider-session:unavailable"),
      cause: new ProviderSetupError({
        instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
        operation: "session",
        detail,
        ...setup,
      }),
    });
  const cause = unavailable({ unavailable: { reason: "not_prepared" } });
  for (const wrapped of [cause, Cause.fail(cause)]) {
    assert.deepEqual(makeProviderFailure({ cause: wrapped, class: "provider_error" }), {
      class: "provider_error",
      message: detail,
      code: ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
      retryable: null,
    });
  }
  // An explicit code wins, a quota denial stays a usage limit, and an unmarked
  // setup failure keeps no code.
  assert.equal(
    makeProviderFailure({ cause, class: "provider_error", code: "explicit" }).code,
    "explicit",
  );
  const limited = makeProviderFailure({
    cause: unavailable({ unavailable: { reason: "signed_out" }, usageLimit: {} }),
    class: "provider_error",
  });
  assert.equal(limited.class, "usage_limit");
  assert.equal(limited.code, null);
  assert.equal(makeProviderFailure({ cause: unavailable({}), class: "provider_error" }).code, null);
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

const acpOpenChain = (inner: unknown) =>
  new ProviderSessionOpenError({
    instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
    providerSessionId: ProviderSessionId.make("provider-session:copilot"),
    cause: new ProviderAdapterOpenSessionError({
      driver: ProviderDriverKind.make("acpRegistry"),
      providerSessionId: ProviderSessionId.make("provider-session:copilot"),
      cause: new EffectAcpErrors.AcpSpawnError({ command: "copilot", cause: inner }),
    }),
  });

it("reads the innermost reason through session, adapter and ACP wrappers", () => {
  const detail = "Copilot 1.0.101 is not prepared.";
  const chain = acpOpenChain(new AcpRegistryError({ reason: "runner_unavailable", detail }));
  for (const wrapped of [chain, Cause.fail(chain), Cause.die(chain)]) {
    assert.equal(innermostCauseMessage(wrapped), detail);
  }
  // A plain string at the bottom is a deliberate reason.
  assert.equal(
    innermostCauseMessage(acpOpenChain("Agent binary missing.")),
    "Agent binary missing.",
  );
  // Error.cause and bare objects with a cause field are followed too.
  assert.equal(
    innermostCauseMessage(new Error("outer", { cause: { message: "inner reason" } })),
    "inner reason",
  );
});

it("keeps a registry error's own detail over its raw cause", () => {
  const detail = "Could not fetch ACP Registry index.";
  const raw = new Error(
    "ENOENT: no such file or directory, open '/Users/x/.specwithcode/acp/index.json'",
  );
  const chain = acpOpenChain(
    new AcpRegistryError({ reason: "registry_unavailable", detail, cause: raw }),
  );
  for (const wrapped of [chain, Cause.fail(chain), Cause.die(chain)]) {
    assert.equal(innermostCauseMessage(wrapped), detail);
  }
  const setup = new ProviderSetupError({
    instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
    operation: "open",
    detail: "Copilot is not installed.",
    cause: new SyntaxError("Unexpected token < in JSON at position 0"),
  });
  assert.equal(innermostCauseMessage(acpOpenChain(setup)), "Copilot is not installed.");
});

it("skips messages that name internal ids and wrappers that only name sessions", () => {
  const idBearing = new Error("Lost run:thread:abc:ordinal:3 on provider-session:x");
  // The ACP spawn message is the innermost readable one left.
  assert.equal(
    innermostCauseMessage(acpOpenChain(idBearing)),
    "Failed to spawn ACP process for command: copilot",
  );
  assert.isUndefined(
    innermostCauseMessage(
      new ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("acpRegistry"),
        providerSessionId: ProviderSessionId.make("provider-session:copilot"),
        cause: "Session thread:t1 closed",
      }),
    ),
  );
  // A curated cause is left to makeProviderFailure's own translation.
  assert.isUndefined(innermostCauseMessage(acpOpenChain(new ContextHandoffBudgetError())));
  assert.isUndefined(innermostCauseMessage(new Error("")));
});

it("walks cyclic and unreadable cause chains without looping", () => {
  const a: { message: string; cause?: unknown } = { message: "first" };
  const b: { message: string; cause?: unknown } = { message: "second", cause: a };
  a.cause = b;
  assert.equal(innermostCauseMessage(a), "second");
  let deep: unknown = "bottom";
  for (let index = 0; index < 100; index++) deep = { message: `level ${index}`, cause: deep };
  assert.equal(innermostCauseMessage(deep), "level 84");
  assert.equal(
    innermostCauseMessage({
      message: "readable",
      get cause() {
        throw new Error("unreadable");
      },
    }),
    "readable",
  );
});

it("keeps a typed code from a wrapped cause", () => {
  const budget = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:budget-code"),
    providerThreadId: ProviderThreadId.make("provider-thread:budget-code"),
    runId: RunId.make("run:budget-code"),
    cause: new ContextHandoffBudgetError(),
  });
  for (const wrapped of [
    budget,
    Cause.fail(budget),
    Cause.die(new Error("x", { cause: budget })),
  ]) {
    assert.equal(makeProviderFailure({ cause: wrapped }).code, "context_handoff_budget");
  }
  // Innermost wins; an explicit code and the unavailable rule still come first.
  assert.equal(
    makeProviderFailure({ cause: { code: "outer", cause: { code: "inner" } } }).code,
    "inner",
  );
  assert.equal(makeProviderFailure({ cause: budget, code: "explicit" }).code, "explicit");
  assert.equal(makeProviderFailure({ cause: { code: "outer", cause: { code: 7 } } }).code, "outer");
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(
    makeProviderFailure({ cause: cyclic }).message,
    providerFailureFallbackMessage("unknown"),
  );
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
    providerFailureFallbackMessage("unknown"),
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
  assert.equal(makeProviderFailure({ cause }).message, providerFailureFallbackMessage("unknown"));
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
    message: providerFailureFallbackMessage("transport_error"),
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

it("holds the queue after a failure the next message would repeat", () => {
  const hold = (
    failure: { class: OrchestrationV2ProviderFailureClass; code: string | null } | undefined,
    queuedProviderInstanceId = "codex",
  ) =>
    shouldHoldQueueAfterFailure({
      failure,
      failedProviderInstanceId: "codex",
      queuedProviderInstanceId,
    });

  assert.isTrue(hold({ class: "provider_error", code: null }));
  assert.isFalse(hold({ class: "provider_error", code: null }, "claudeAgent"));
  assert.isFalse(hold({ class: "validation_error", code: null }));
  assert.isFalse(hold(undefined));
  // A deleted thread folder fails the next message on any provider.
  const workspaceGone = {
    class: "validation_error" as const,
    code: WORKSPACE_BRANCH_MISSING_FAILURE_CODE,
  };
  assert.isTrue(hold(workspaceGone));
  assert.isTrue(hold(workspaceGone, "claudeAgent"));
});
