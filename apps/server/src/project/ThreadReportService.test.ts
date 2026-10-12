import { describe, expect, it } from "vite-plus/test";

import { finishedWorkerReport } from "./ThreadReportService.ts";

const event = (payload: Record<string, unknown>, type = "subagent.updated") =>
  ({
    type,
    payload: {
      origin: "app_owned",
      status: "completed",
      childThreadId: "worker-1",
      result: "# Review\n\nDone.",
      ...payload,
    },
  }) as never;

describe("finishedWorkerReport", () => {
  it("takes the report of a Studio worker that finished", () => {
    expect(finishedWorkerReport(event({}))).toEqual({
      threadId: "worker-1",
      text: "# Review\n\nDone.",
    });
  });

  it("ignores running, provider-native, threadless and resultless workers, and other events", () => {
    expect(finishedWorkerReport(event({ status: "running" }))).toBeNull();
    expect(finishedWorkerReport(event({ origin: "provider_native" }))).toBeNull();
    expect(finishedWorkerReport(event({ childThreadId: null }))).toBeNull();
    expect(finishedWorkerReport(event({ result: null }))).toBeNull();
    expect(finishedWorkerReport(event({}, "thread.created"))).toBeNull();
  });
});
