/**
 * A send during an update: the host refuses it or the socket drops, and the
 * same command goes out again once the host is back, so it is neither lost
 * nor delivered twice.
 */
import { SERVICE_UPDATE_IN_PROGRESS_MESSAGE } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { isTransientSendFailure, retryTransientSend } from "./transientSendRetry";

const tagged = (tag: string) => Object.assign(new Error(tag), { _tag: tag });
const noSleep = async () => {};

describe("retryTransientSend", () => {
  it("sends the same command again after the update refused it", async () => {
    const commandIds: string[] = [];
    const commandId = "cmd-1";
    const send = vi.fn(async () => {
      commandIds.push(commandId);
      return commandIds.length === 1
        ? AsyncResult.failure(Cause.fail(new Error(SERVICE_UPDATE_IN_PROGRESS_MESSAGE)))
        : AsyncResult.success("accepted");
    });
    const waitForHost = vi.fn(async () => true);
    const result = await retryTransientSend(send, { waitForHost, sleep: noSleep });
    expect(result._tag).toBe("Success");
    expect(commandIds).toEqual(["cmd-1", "cmd-1"]);
    expect(waitForHost).toHaveBeenCalledOnce();
  });

  it("retries a send whose socket dropped during the restart", async () => {
    let calls = 0;
    const result = await retryTransientSend(
      async () =>
        (calls += 1) < 3
          ? AsyncResult.failure(Cause.fail(tagged("EnvironmentRpcUnavailableError")))
          : AsyncResult.success("accepted"),
      { waitForHost: async () => true, sleep: noSleep },
    );
    expect(result._tag).toBe("Success");
    expect(calls).toBe(3);
  });

  it("does not retry a send the host rejected", async () => {
    const send = vi.fn(async () =>
      AsyncResult.failure(Cause.fail(new Error("Thread is archived"))),
    );
    const result = await retryTransientSend(send, {
      waitForHost: async () => true,
      sleep: noSleep,
    });
    expect(result._tag).toBe("Failure");
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports the failure once the host does not come back in time", async () => {
    let clock = 0;
    const send = vi.fn(async () =>
      AsyncResult.failure(Cause.fail(tagged("EnvironmentRpcUnavailableError"))),
    );
    const result = await retryTransientSend(send, {
      waitForHost: async () => true,
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      delaysMs: [1_000],
      deadlineMs: 3_500,
    });
    expect(result._tag).toBe("Failure");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("stops when the host never becomes ready", async () => {
    const send = vi.fn(async () =>
      AsyncResult.failure(Cause.fail(tagged("EnvironmentRpcUnavailableError"))),
    );
    const result = await retryTransientSend(send, {
      waitForHost: async () => false,
      sleep: noSleep,
    });
    expect(result._tag).toBe("Failure");
    expect(send).toHaveBeenCalledOnce();
  });

  it("finds a transient failure wrapped in a cause", () => {
    expect(isTransientSendFailure({ cause: tagged("RpcClientError") })).toBe(true);
    expect(isTransientSendFailure(new Error("Model not available"))).toBe(false);
  });
});
