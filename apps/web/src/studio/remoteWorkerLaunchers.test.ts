import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetRemoteWorkerLaunchersForTests,
  currentRemoteWorkerLaunchers,
  publishRemoteWorkerLaunchers,
  withdrawRemoteWorkerLaunchers,
} from "./remoteWorkerLaunchers";

const worker = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

afterEach(() => {
  __resetRemoteWorkerLaunchersForTests();
});

describe("remote worker launchers", () => {
  it("joins every published source", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]));
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t2"), "c2"]]));
    expect(new Map(currentRemoteWorkerLaunchers())).toEqual(
      new Map([
        [worker("w", "t1"), "c1"],
        [worker("w", "t2"), "c2"],
      ]),
    );
  });

  it.each([
    ["overview first", ["overview", "sidebar"]],
    ["sidebar first", ["sidebar", "overview"]],
  ])("keeps the coordinator of the source whose id sorts first (%s)", (_name, order) => {
    const named: Record<string, string> = { overview: "c-overview", sidebar: "c-sidebar" };
    for (const id of order)
      publishRemoteWorkerLaunchers(id, new Map([[worker("w", "t1"), named[id]!]]));
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c-overview");
  });

  it("keeps the same winner after a withdraw and republish", () => {
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t1"), "c-overview"]]));
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c-sidebar"]]));
    withdrawRemoteWorkerLaunchers("overview");
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c-sidebar");
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t1"), "c-overview"]]));
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c-overview");
  });

  it("forgets a withdrawn source", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]));
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t2"), "c2"]]));
    withdrawRemoteWorkerLaunchers("sidebar");
    expect(new Map(currentRemoteWorkerLaunchers())).toEqual(new Map([[worker("w", "t2"), "c2"]]));
    withdrawRemoteWorkerLaunchers("overview");
    expect(currentRemoteWorkerLaunchers().size).toBe(0);
  });

  it("replaces a source's map when it publishes again", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]));
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t2"), "c3"]]));
    expect(new Map(currentRemoteWorkerLaunchers())).toEqual(new Map([[worker("w", "t2"), "c3"]]));
  });
});
