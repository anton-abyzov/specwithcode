import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  isContextLimitError,
  latestRootProviderFailure,
  latestRootProviderFailureItem,
  providerFailureDisplayMessage,
  providerFailureDisplayTitle,
  threadErrorSummary,
  unwrapProviderErrorMessage,
} from "./orchestrationV2ThreadError.ts";

const geminiMessage = "The input token count exceeds the maximum number of tokens allowed 1048576.";
const gemini = JSON.stringify({
  error: {
    message: JSON.stringify({
      error: { code: 400, message: geminiMessage, status: "INVALID_ARGUMENT" },
    }),
    code: 400,
    status: "Bad Request",
  },
});

describe("provider error messages", () => {
  it("gives recovery ownership to the latest failed root item, never a child or recovered run", () => {
    const run = { id: "run", rootNodeId: "root", status: "failed" } as const;
    const makeItem = (id: string, nodeId: string, ordinal: number) => ({
      id,
      nodeId,
      ordinal,
      runId: run.id,
      type: "error",
      status: "failed",
      updatedAt: DateTime.makeUnsafe("2026-10-22T18:00:00.000Z"),
      failure: { class: "provider_error", message: geminiMessage, code: null, retryable: false },
    });
    const items = [
      makeItem("old-root", "root", 1),
      makeItem("terminal-root", "root", 2),
      makeItem("child", "child-node", 3),
    ];
    expect(latestRootProviderFailureItem(run as never, items as never)?.id).toBe("terminal-root");
    expect(latestRootProviderFailure(run as never, items as never)?.message).toBe(geminiMessage);
    expect(
      latestRootProviderFailureItem({ ...run, status: "completed" } as never, items as never),
    ).toBeNull();
  });
  it("unwraps the exact Gemini envelope and repeated JSON string encodings", () => {
    for (const message of [
      gemini,
      JSON.stringify(gemini),
      JSON.stringify(JSON.stringify(gemini)),
    ]) {
      expect(unwrapProviderErrorMessage(message)).toBe(geminiMessage);
      expect(providerFailureDisplayMessage({ class: "provider_error", message })).toBe(
        geminiMessage,
      );
      expect(providerFailureDisplayTitle({ class: "provider_error", message })).toBe(
        "Context limit reached",
      );
    }
  });

  it("handles response/data envelopes and prefers the specific inner error", () => {
    expect(
      unwrapProviderErrorMessage(
        JSON.stringify({
          message: "Bad Request",
          error: {
            response: {
              data: { error: { message: "Requests ending with a model turn are not supported." } },
            },
          },
        }),
      ),
    ).toBe("Requests ending with a model turn are not supported.");
    expect(unwrapProviderErrorMessage(`Error: ${gemini}`)).toBe(geminiMessage);
    expect(unwrapProviderErrorMessage(JSON.stringify("Plain provider failure."))).toBe(
      "Plain provider failure.",
    );
  });

  it("retains plain prose and class-specific legacy fallbacks", () => {
    expect(unwrapProviderErrorMessage("Permission denied. Check sign-in.")).toBe(
      "Permission denied. Check sign-in.",
    );
    expect(providerFailureDisplayMessage({ class: "usage_limit", message: "  " })).toBe(
      "The provider's usage limit was reached.",
    );
    expect(
      providerFailureDisplayMessage({ class: "transport_error", message: "Provider turn failed." }),
    ).toContain("connection to the provider closed");
  });

  it("preserves provider tags and unwraps response errors before generic wrapper messages", () => {
    for (const message of [
      "[ACP] Authentication failed. Sign in again.",
      "[GoogleGenerativeAI Error]: Error fetching the model.",
      '"Retry later" was the provider response.',
    ]) {
      expect(unwrapProviderErrorMessage(message)).toBe(message);
    }
    expect(
      unwrapProviderErrorMessage(
        JSON.stringify({
          message: "Bad Request",
          response: { data: { error: { message: "Specific inner provider error" } } },
        }),
      ),
    ).toBe("Specific inner provider error");
  });

  it("prefers specific prose to a scalar HTTP status while retaining nested error priority", () => {
    for (const error of [
      "Bad Request",
      "400 Bad Request",
      "INVALID_ARGUMENT",
      "invalid_request_error",
    ]) {
      const message = JSON.stringify({ error, message: geminiMessage });
      expect(unwrapProviderErrorMessage(message)).toBe(geminiMessage);
      expect(isContextLimitError(message)).toBe(true);
    }
    expect(unwrapProviderErrorMessage(JSON.stringify({ error: "Bad Request" }))).toBe(
      "Bad Request",
    );
    expect(
      unwrapProviderErrorMessage(
        JSON.stringify({ error: { message: "Specific nested error" }, message: "Outer message" }),
      ),
    ).toBe("Specific nested error");
  });

  it("bounds malformed, scalar, array, oversized and deeply nested envelopes", () => {
    for (const message of ['{"error":', "{}", "[]", "null", "42", "true", "x".repeat(65_537)]) {
      expect(unwrapProviderErrorMessage(message)).toBe(
        "The provider returned an error without a readable message.",
      );
    }
    let deeplyNested: unknown = "Hidden error";
    for (let depth = 0; depth < 30; depth++) deeplyNested = { error: deeplyNested };
    expect(unwrapProviderErrorMessage(JSON.stringify(deeplyNested))).toBe(
      "The provider returned an error without a readable message.",
    );
  });

  it("matches stored raw session errors to newly normalized failures without changing quota state", () => {
    const failure = {
      class: "provider_error",
      message: geminiMessage,
      code: null,
      retryable: null,
    } as const;
    expect(threadErrorSummary(failure, gemini, "failed").lastErrorClass).toBe("provider_error");
    expect(threadErrorSummary(failure, "A different failure.", "failed").lastErrorClass).toBeNull();
    expect(
      threadErrorSummary({ ...failure, message: '{"first":' }, '{"second":', "failed")
        .lastErrorClass,
    ).toBeNull();
  });
});

describe("context limits are not account quotas", () => {
  it.each([
    gemini,
    "This model's maximum context length is 128000 tokens.",
    "context_length_exceeded",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "The context window is full.",
    JSON.stringify({ error: { code: "context_length_exceeded", message: "Request rejected." } }),
  ])("recognizes %s", (message) => {
    expect(isContextLimitError(message)).toBe(true);
  });

  it.each([
    "Rate limit reached for tokens per minute (TPM).",
    "The output token count exceeds the maximum number of tokens allowed 8192.",
    "The completion token count exceeds the maximum number of tokens allowed 8192.",
    "You have exceeded your monthly quota.",
    "Insufficient credits. Buy more tokens.",
    "Too many requests. Retry after 30 seconds.",
    "Next observed reset: 2026-10-18T03:58:37.000Z.",
    "Requests ending with a model turn are not supported.",
  ])("does not mistake %s for context overflow", (message) => {
    expect(isContextLimitError(message)).toBe(false);
  });

  it("preserves a usage classification and reset timestamp", () => {
    const failure = {
      class: "usage_limit",
      message: JSON.stringify({ error: { message: "Token quota exceeded." } }),
      code: "quota",
      retryable: false,
      resetAt: "2026-10-23T04:00:00.000Z",
    } as const;
    const summary = threadErrorSummary(failure, failure.message, "failed");
    expect(summary.lastErrorClass).toBe("usage_limit");
    expect(summary.usageLimitResetAt).toBe(failure.resetAt);
    expect(providerFailureDisplayTitle(failure)).toBe("Usage limit reached");
  });
});
