import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  canOperate: true,
  interrupt: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canOperate }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.interrupt }));

import type { BackgroundWorkStop } from "./background-work-status";
import {
  runStopBackgroundWork,
  STOP_BACKGROUND_WORK_FAILED_TITLE,
  stopBackgroundWorkFailureMessage,
  useStopBackgroundWork,
} from "./use-stop-background-work";

const accepted = () => AsyncResult.success<unknown, unknown>(undefined);
const rejected = (error: unknown) => AsyncResult.failure<unknown, unknown>(Cause.fail(error));
const interrupted = () => AsyncResult.failure<unknown, unknown>(Cause.interrupt());

function stoppingKeyStore(initial: string | null) {
  let current = initial;
  return {
    get: () => current,
    set: (update: (value: string | null) => string | null) => {
      current = update(current);
    },
  };
}

beforeEach(() => {
  mocks.canOperate = true;
  mocks.interrupt.mockReset();
  mocks.alert.mockReset();
});

describe("runStopBackgroundWork", () => {
  it("marks the thread stopping until the interrupt settles", async () => {
    const store = stoppingKeyStore(null);
    let settle: () => void = () => {};
    const interrupt = vi.fn(
      () =>
        new Promise<ReturnType<typeof accepted>>((resolve) => {
          settle = () => resolve(accepted());
        }),
    );
    const onFailure = vi.fn();
    const run = runStopBackgroundWork({
      key: "env:a",
      interrupt,
      setStoppingKey: store.set,
      onFailure,
    });
    expect(store.get()).toBe("env:a");
    expect(interrupt).toHaveBeenCalledTimes(1);
    settle();
    await run;
    expect(store.get()).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a rejected stop and allows a retry", async () => {
    const store = stoppingKeyStore(null);
    const onFailure = vi.fn();
    await runStopBackgroundWork({
      key: "env:a",
      interrupt: async () => rejected(new Error("Thread is not running")),
      setStoppingKey: store.set,
      onFailure,
    });
    expect(store.get()).toBeNull();
    expect(onFailure).toHaveBeenCalledWith("Thread is not running");
  });

  it("says nothing when the request itself was interrupted", async () => {
    const onFailure = vi.fn();
    await runStopBackgroundWork({
      key: "env:a",
      interrupt: async () => interrupted(),
      setStoppingKey: stoppingKeyStore(null).set,
      onFailure,
    });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("clears the stopping mark even when the interrupt throws", async () => {
    const store = stoppingKeyStore(null);
    await expect(
      runStopBackgroundWork({
        key: "env:a",
        interrupt: () => Promise.reject(new Error("offline")),
        setStoppingKey: store.set,
        onFailure: vi.fn(),
      }),
    ).rejects.toThrow("offline");
    expect(store.get()).toBeNull();
  });

  it("leaves another thread's stop in flight alone", async () => {
    const store = stoppingKeyStore(null);
    await runStopBackgroundWork({
      key: "env:a",
      interrupt: async () => {
        store.set(() => "env:b");
        return accepted();
      },
      setStoppingKey: store.set,
      onFailure: vi.fn(),
    });
    expect(store.get()).toBe("env:b");
  });
});

describe("stopBackgroundWorkFailureMessage", () => {
  it("uses the error's message, or a plain fallback", () => {
    expect(stopBackgroundWorkFailureMessage(accepted())).toBeNull();
    expect(stopBackgroundWorkFailureMessage(interrupted())).toBeNull();
    expect(stopBackgroundWorkFailureMessage(rejected(new Error("Denied")))).toBe("Denied");
    expect(stopBackgroundWorkFailureMessage(rejected({ _tag: "Opaque" }))).toBe(
      "Failed to stop background work.",
    );
  });
});

describe("useStopBackgroundWork", () => {
  const environmentId = "env-1" as EnvironmentId;
  const threadId = "thread-1" as ThreadId;

  function Probe(props: { readonly report: (stop: BackgroundWorkStop | null) => void }) {
    props.report(useStopBackgroundWork(environmentId, threadId));
    return null;
  }

  function renderStop(): BackgroundWorkStop | null {
    const reported: Array<BackgroundWorkStop | null> = [];
    renderToStaticMarkup(createElement(Probe, { report: (stop) => reported.push(stop) }));
    return reported[0] ?? null;
  }

  it("offers no stop when this device may not operate the thread", () => {
    mocks.canOperate = false;
    expect(renderStop()).toBeNull();
  });

  it("interrupts the thread's turn and alerts when the stop is rejected", async () => {
    mocks.interrupt.mockResolvedValue(rejected(new Error("Provider refused")));
    const stop = renderStop();
    expect(stop?.stopping).toBe(false);
    stop?.onStop();
    expect(mocks.interrupt).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    await vi.waitFor(() =>
      expect(mocks.alert).toHaveBeenCalledWith(
        STOP_BACKGROUND_WORK_FAILED_TITLE,
        "Provider refused",
      ),
    );
  });

  it("stays quiet when the stop is accepted", async () => {
    mocks.interrupt.mockResolvedValue(accepted());
    renderStop()?.onStop();
    await vi.waitFor(() => expect(mocks.interrupt).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
