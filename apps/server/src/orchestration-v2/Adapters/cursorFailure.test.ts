import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSetupError,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import {
  ConfigurationError,
  CursorSdkError,
  RateLimitError,
  UnknownAgentError,
} from "../../provider/cursorSdk.ts";
import { ProviderAdapterTurnStartError } from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { CURSOR_PROVIDER, CursorAgentSdkRunnerError } from "./CursorAgentSdk.ts";
import {
  CURSOR_TURN_START_USAGE_LIMIT_DETAIL,
  cursorFailureClass,
  cursorModelUnavailableDetail,
  cursorRunErrorFailure,
  cursorThrownFailure,
  cursorTurnStartCause,
  isCursorUsageLimitCode,
} from "./cursorFailure.ts";

const instanceId = ProviderInstanceId.make("cursor");
const isProviderSetupError = Schema.is(ProviderSetupError);

function turnStartError(cause: unknown) {
  return new ProviderAdapterTurnStartError({
    driver: CURSOR_PROVIDER,
    threadId: ThreadId.make("cursor-failure-thread"),
    providerThreadId: ProviderThreadId.make("cursor-failure-provider-thread"),
    runId: RunId.make("cursor-failure-run"),
    cause,
  });
}

describe("cursorFailure", () => {
  it("recognizes Cursor usage-limit codes in either spelling", () => {
    assert.isTrue(isCursorUsageLimitCode("FREE_USER_USAGE_LIMIT"));
    assert.isTrue(isCursorUsageLimitCode("resource_exhausted"));
    assert.isTrue(isCursorUsageLimitCode("ERROR_PRO_USER_USAGE_LIMIT"));
    assert.isTrue(isCursorUsageLimitCode("Usage_Pricing_Required"));
    assert.isFalse(isCursorUsageLimitCode("invalid_argument"));
    assert.isFalse(isCursorUsageLimitCode(undefined));
  });

  it("classifies RateLimitError, usage codes and usage text as usage_limit", () => {
    const rateLimit = new CursorAgentSdkRunnerError({
      method: "run.wait",
      cause: new RateLimitError("Too many requests"),
    });
    assert.equal(cursorFailureClass({ cause: rateLimit }, "transport_error"), "usage_limit");
    assert.equal(cursorFailureClass({ code: "RATE_LIMITED" }, "provider_error"), "usage_limit");
    for (const message of [
      "You've used your weekly pool. It resets Monday.",
      "Claude models bill prepaid credit. Buy credits to continue.",
      "Enable usage-based pricing to keep using this model.",
      "Your team is out of credits.",
    ]) {
      assert.equal(cursorFailureClass({ message }, "provider_error"), "usage_limit", message);
    }
    assert.equal(
      cursorFailureClass(
        { cause: new CursorSdkError("Service unavailable", { code: "unavailable" }) },
        "transport_error",
      ),
      "transport_error",
    );
    assert.equal(
      cursorFailureClass({ message: "Model crashed" }, "provider_error"),
      "provider_error",
    );
  });

  it("shows Cursor's own run error text and classifies a usage stop", () => {
    const failure = cursorRunErrorFailure({
      message: "Usage limit exceeded",
      code: "resource_exhausted",
    });
    assert.equal(failure.class, "usage_limit");
    assert.equal(failure.message, "Usage limit exceeded");
    assert.equal(failure.code, "resource_exhausted");

    const plain = cursorRunErrorFailure({
      message: "Tool runner crashed with crsr_abcdefghijklmnop12",
    });
    assert.equal(plain.class, "provider_error");
    assert.equal(plain.message, "Tool runner crashed with [REDACTED]");
    assert.isNull(plain.code);

    const missing = cursorRunErrorFailure(undefined);
    assert.equal(missing.class, "provider_error");
    assert.isAbove(missing.message.length, 0);
  });

  it("keeps a thrown SDK error's message, code and retryable flag", () => {
    const failure = cursorThrownFailure(
      new CursorAgentSdkRunnerError({
        method: "run.wait",
        cause: new CursorSdkError("Connection reset by Cursor", {
          code: "unavailable",
          isRetryable: true,
        }),
      }),
    );
    assert.equal(failure.class, "transport_error");
    assert.equal(failure.message, "Connection reset by Cursor");
    assert.equal(failure.code, "unavailable");
    assert.isTrue(failure.retryable);

    const usage = cursorThrownFailure(
      new CursorAgentSdkRunnerError({
        method: "run.wait",
        cause: new RateLimitError("You've hit your usage limit", {
          code: "PRO_USER_USAGE_LIMIT",
          isRetryable: false,
        }),
      }),
    );
    assert.equal(usage.class, "usage_limit");
    assert.equal(usage.message, "You've hit your usage limit");
    assert.equal(usage.code, "PRO_USER_USAGE_LIMIT");
    assert.isFalse(usage.retryable);
  });

  it("names the model when Cursor rejects it at turn start", () => {
    const sdkError = new ConfigurationError("Model not available on your plan", {
      code: "BAD_MODEL_NAME",
    });
    const wrapped = cursorTurnStartCause(
      new CursorAgentSdkRunnerError({ method: "run.start", cause: sdkError }),
      { instanceId, model: "claude-opus-4-6" },
    );
    assert.isTrue(isProviderSetupError(wrapped));
    if (isProviderSetupError(wrapped)) {
      assert.equal(wrapped.operation, "model");
      assert.isUndefined(wrapped.usageLimit);
    }
    const failure = makeProviderFailure({ cause: turnStartError(wrapped) });
    assert.equal(failure.message, cursorModelUnavailableDetail("claude-opus-4-6"));
    assert.include(failure.message, '"claude-opus-4-6"');
    assert.notInclude(failure.message, "Retry the turn");
  });

  it("keeps a usage stop at turn start typed as a usage limit", () => {
    const wrapped = cursorTurnStartCause(
      new CursorAgentSdkRunnerError({
        method: "run.start",
        cause: new RateLimitError("Usage limit exceeded", { code: "FREE_USER_USAGE_LIMIT" }),
      }),
      { instanceId, model: "composer-2.5" },
    );
    const failure = makeProviderFailure({ cause: turnStartError(wrapped) });
    assert.equal(failure.class, "usage_limit");
    assert.equal(
      failure.message,
      `${CURSOR_TURN_START_USAGE_LIMIT_DETAIL} Cursor said: Usage limit exceeded`,
    );
  });

  it("treats a plan-gated model that mentions credit as a model problem", () => {
    const wrapped = cursorTurnStartCause(
      new CursorAgentSdkRunnerError({
        method: "run.start",
        cause: new ConfigurationError("Claude needs Premium and prepaid credit", {
          code: "MODEL_BLOCKED",
        }),
      }),
      { instanceId, model: "claude-opus-4-6" },
    );
    assert.isTrue(isProviderSetupError(wrapped));
    if (isProviderSetupError(wrapped)) {
      assert.equal(wrapped.operation, "model");
      assert.isUndefined(wrapped.usageLimit);
    }
  });

  it("names the model for the SDK's own catalog check", () => {
    const wrapped = cursorTurnStartCause(
      new ConfigurationError("Cannot use this model: composer-2. Available models: auto", {}),
      { instanceId, model: "composer-2" },
    );
    assert.isTrue(isProviderSetupError(wrapped));
    if (isProviderSetupError(wrapped)) assert.equal(wrapped.operation, "model");
  });

  it("names the model when Cursor has retired it", () => {
    const wrapped = cursorTurnStartCause(
      new CursorAgentSdkRunnerError({
        method: "run.start",
        cause: new UnknownAgentError("This model is no longer supported", {
          code: "MODEL_NO_LONGER_SUPPORTED",
        }),
      }),
      { instanceId, model: "composer-2" },
    );
    assert.isTrue(isProviderSetupError(wrapped));
    if (isProviderSetupError(wrapped)) assert.equal(wrapped.operation, "model");
  });

  it("passes other configuration errors through unchanged", () => {
    const internal = new CursorAgentSdkRunnerError({
      method: "agent.create",
      cause: new ConfigurationError("API key exchange succeeded but returned no access token", {
        code: "internal",
      }),
    });
    assert.strictEqual(cursorTurnStartCause(internal, { instanceId, model: "auto" }), internal);
  });

  it("leaves account and unrelated turn-start failures unchanged", () => {
    const badKey = new CursorAgentSdkRunnerError({
      method: "agent.resume",
      cause: new ConfigurationError("Bad API key", { code: "BAD_API_KEY" }),
    });
    assert.strictEqual(cursorTurnStartCause(badKey, { instanceId, model: "auto" }), badKey);
    const other = new Error("boom");
    assert.strictEqual(cursorTurnStartCause(other, { instanceId, model: "auto" }), other);
  });
});
