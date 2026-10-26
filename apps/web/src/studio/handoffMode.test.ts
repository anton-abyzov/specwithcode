import type {
  HandoffModeSnapshot,
  HandoffThreadState,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadHandoffMenuState } from "./handoffMode";

const P = "project-p" as ProjectId;
const Q = "project-q" as ProjectId;
const T = "thread-t" as ThreadId;

const snapshot = (
  projectModes: Record<string, "on" | "off">,
  threads: ReadonlyArray<Partial<HandoffThreadState>> = [],
) =>
  ({
    config: { defaultMode: "off" },
    projectModes,
    threads,
    incoming: [],
  }) as unknown as HandoffModeSnapshot;

describe("threadHandoffMenuState", () => {
  it("is undefined without a snapshot", () => {
    expect(threadHandoffMenuState(null, T, P)).toBeUndefined();
  });

  it("inherits the project's mode for a thread with no record", () => {
    expect(threadHandoffMenuState(snapshot({ [P]: "on" }), T, P)).toEqual({
      mode: "inherit",
      effective: "on",
      continued: false,
    });
  });

  it("falls back to the machine default when the project has no setting", () => {
    expect(threadHandoffMenuState(snapshot({ [P]: "on" }), T, Q)?.effective).toBe("off");
  });

  it("uses the server's record when the thread has one", () => {
    const state = threadHandoffMenuState(
      snapshot({ [P]: "on" }, [
        { threadId: T, mode: "off", effectiveMode: "off", continuedOn: null },
      ]),
      T,
      P,
    );
    expect(state).toEqual({ mode: "off", effective: "off", continued: false });
  });
});
