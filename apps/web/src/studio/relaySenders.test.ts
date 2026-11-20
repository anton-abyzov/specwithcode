import { describe, expect, it } from "vite-plus/test";

import { senderWithMachine } from "./conversationMachine";
import { relaySender, sameRelaySenders, type RelaySenderShell } from "./relaySenders";

const NAMES: Record<string, string> = { m5: "M5", m6: "M6", "studio-host": "studio-host" };
const name = (environmentId: string) => NAMES[environmentId] ?? "another machine";

const worker = (extra: Partial<RelaySenderShell> = {}): RelaySenderShell => ({
  id: "thread-release",
  environmentId: "m5",
  title: "Release notes",
  ...extra,
});

describe("relay senders follow the thread's live machine (1427 AC-06)", () => {
  it("sees a runner that moved, and ignores what a relay label does not show", () => {
    expect(sameRelaySenders([worker()], [worker()])).toBe(true);
    expect(sameRelaySenders([worker()], [worker({ executionMachineId: "m6" })])).toBe(false);
    expect(sameRelaySenders([worker()], [worker({ ownerMachineId: "m6" })])).toBe(false);
    expect(sameRelaySenders([worker()], [worker({ executionMachineLabel: "M6" })])).toBe(false);
    expect(sameRelaySenders([worker()], [worker({ title: "Release notes v2" })])).toBe(false);
    // A status change keeps the list, so messages are not rebuilt for it.
    expect(sameRelaySenders([worker()], [{ ...worker(), status: "running" } as never])).toBe(true);
  });

  it("names the machine a moved thread runs on now", () => {
    const moved = worker({ executionMachineId: "m6" });
    expect(senderWithMachine(relaySender("thread-release", [moved]), "studio-host", name)).toBe(
      "Release notes · M5 → M6",
    );
  });

  it("finds a sender that only the remote workers list", () => {
    const remote = worker({ id: "thread-check", title: "Sign-in check", environmentId: "m6" });
    const found = relaySender("thread-check", [worker(), remote]);
    expect(found).toBe(remote);
    expect(senderWithMachine(found, "studio-host", name)).toBe("Sign-in check · M6");
    expect(relaySender("thread-gone", [worker(), remote])).toBeUndefined();
    expect(relaySender(undefined, [worker(), remote])).toBeUndefined();
  });

  it("never names a local worker for a remote sender that shares its id", () => {
    const local = worker({ environmentId: "studio-host", title: "Release notes" });
    const remote = worker({ environmentId: "m6", title: "Sign-in check" });
    // The relay names its sender's machine: that machine's thread, whichever list comes first.
    expect(relaySender("thread-release", [local, remote], "m6")).toBe(remote);
    expect(relaySender("thread-release", [local, remote], "studio-host")).toBe(local);
    expect(relaySender("thread-release", [local, remote], "m5")).toBeUndefined();
    // A bare id that two machines hold is not guessed: the neutral label shows.
    expect(relaySender("thread-release", [local, remote])).toBeUndefined();
    // One machine's thread listed twice is still one sender.
    expect(relaySender("thread-release", [local, local])).toBe(local);
  });
});
