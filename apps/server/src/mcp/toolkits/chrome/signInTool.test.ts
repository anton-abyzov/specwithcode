// @effect-diagnostics globalDate:off -- drives chrome_sign_in_needed with a fake extension and a fake card.
import {
  type AccessRequestSubject,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import type { AccessRequestCardResult } from "../../../access/accessRequestCard.ts";
import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import { connectFake, setup } from "../../../browserExtension/fakeChrome.testkit.ts";
import { newReceivingKey } from "../../../fleet/fileTransfer/seal.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { SIGN_IN_SUBJECT_DETAIL, signInNeeded } from "./signInTool.ts";

const scope = {
  environmentId: EnvironmentId.make("env-m1"),
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  requestNamespace: "thread:t1",
  thread: {
    threadId: ThreadId.make("t1"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
} as McpInvocationContext.McpInvocationScope & { readonly thread: { readonly threadId: string } };

const input = {
  url: "https://app.squareup.com/login",
  reason: "The dues sync needs Square to export today's payments.",
  clientRequestId: "square-daily",
};

function harness(
  answer: (subjects: ReadonlyArray<AccessRequestSubject>) => AccessRequestCardResult["status"],
  paired = true,
) {
  const { extension, token } = setup();
  if (paired) connectFake(extension, token);
  const cards: Array<{ accessTitle: string; subjects: ReadonlyArray<AccessRequestSubject> }> = [];
  const service = {
    requestAccess: (
      _scope: unknown,
      card: { accessTitle: string; subjects: ReadonlyArray<AccessRequestSubject> },
    ) =>
      Effect.sync(() => {
        cards.push(card);
        return { status: answer(card.subjects) };
      }),
  } as unknown as OrchestratorMcpService.OrchestratorMcpService["Service"];
  const layer = Layer.mergeAll(
    Layer.succeed(BrowserExtension.BrowserExtension, extension),
    Layer.succeed(OrchestratorMcpService.OrchestratorMcpService, service),
  );
  const call = () => signInNeeded(scope, input).pipe(Effect.provide(layer));
  return { extension, cards, call };
}

describe("chrome_sign_in_needed (1488)", () => {
  it.effect("shows one sign-in card, and hears Not now as declined", () =>
    Effect.gen(function* () {
      const { cards, call } = harness(() => "denied");
      const result = yield* call();
      expect(result.status).toBe("declined");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.accessTitle).toBe("Sign-in needed on this machine: app.squareup.com");
      expect(cards[0]!.subjects[0]).toMatchObject({
        kind: "sign-in",
        label: "app.squareup.com",
        detail: SIGN_IN_SUBJECT_DETAIL,
      });
      // A retry hears the same answer and raises no second card.
      expect((yield* call()).status).toBe("declined");
      expect(cards).toHaveLength(1);
    }),
  );

  it.effect("after Allow waits for the view, and returns only how it ended", () =>
    Effect.gen(function* () {
      const { extension, cards, call } = harness(() => "allowed");
      const requestId = () => cards[0]!.subjects[0]!.key.slice("sign-in:".length);
      const waiting = yield* Effect.forkChild(call());
      while (cards.length === 0) yield* Effect.yieldNow;
      yield* Effect.promise(async () => {
        const started = await extension.signIn.start(requestId(), newReceivingKey().publicKey);
        await extension.signIn.end(started.viewId, "done");
      });
      const result = yield* Fiber.join(waiting);
      expect(result).toEqual({ status: "done", message: expect.stringContaining("signed in") });
      expect(JSON.stringify(result)).not.toContain("squareup");
    }),
  );

  it.effect("a card that closed unanswered ends the request as expired", () =>
    Effect.gen(function* () {
      const { call } = harness(() => "timed_out");
      expect((yield* call()).status).toBe("expired");
    }),
  );

  it.effect("needs Chrome paired on this machine", () =>
    Effect.gen(function* () {
      const { call } = harness(() => "allowed", false);
      const error = yield* Effect.flip(call());
      expect(error.message).toMatch(/this machine's Chrome/);
    }),
  );
});
