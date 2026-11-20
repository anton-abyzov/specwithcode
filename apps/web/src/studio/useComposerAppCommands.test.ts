import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  closeHandOffMachine,
  handOffMachineScope,
  readHandOffMachineRequest,
} from "../components/handoff/HandOffMachineDialog";
import { readAwayRequest, requestAway } from "./awayRequest";
import { openComposerAppDialog } from "./useComposerAppCommands";

const LAPTOP = "env-laptop" as EnvironmentId;
const thread = {
  environmentId: LAPTOP,
  projectId: "project-atlas" as ProjectId,
} as EnvironmentThreadShell;

beforeEach(() => {
  closeHandOffMachine();
});

describe("the composer's dialog commands", () => {
  it("/away opens Hand off for every project on the machine, not the Away form", () => {
    openComposerAppDialog("away", thread);
    expect(readAwayRequest()).toBeNull();
    const request = readHandOffMachineRequest();
    expect(request).toEqual({ environmentId: LAPTOP });
    expect(handOffMachineScope("Laptop", request?.project?.title)).toBe(
      "Scope: every project on Laptop",
    );
  });

  it("/away before a thread exists hands off this window's machine", () => {
    openComposerAppDialog("away", null);
    expect(readAwayRequest()).toBeNull();
    expect(readHandOffMachineRequest()).toEqual({ environmentId: null });
  });

  it("/handoff in a thread keeps to that thread's project", () => {
    openComposerAppDialog("handoff", thread, () => ({ title: "atlas" }));
    const request = readHandOffMachineRequest();
    expect(request).toEqual({
      environmentId: LAPTOP,
      project: { id: "project-atlas", title: "atlas" },
    });
    expect(handOffMachineScope("Laptop", request?.project?.title)).toBe("Scope: atlas");
  });

  it("/back still asks to bring work back", () => {
    openComposerAppDialog("back", thread);
    expect(readAwayRequest()).toBe("back");
    expect(readHandOffMachineRequest()).toBeNull();
    requestAway("away");
  });
});
