import { describe, expect, it } from "vite-plus/test";

import { threadMachinePresentation } from "./threadMachine";

const base = {
  name: "linuxbox",
  hostLabel: "linuxbox",
  kind: "laptop" as const,
  os: "linux" as const,
  isThisMachine: false,
  phase: "connected" as const,
  error: null,
  canOperate: true,
  handoff: "available" as const,
};

describe("threadMachinePresentation", () => {
  it("names a remote machine and its OS", () => {
    const machine = threadMachinePresentation(base);
    expect(machine.label).toBe("linuxbox");
    expect(machine.warning).toBeNull();
    expect(machine.tip).toBe(
      "Runs on linuxbox (Linux). To move it, use ⋯ › Move to another machine.",
    );
  });

  it("says a personal assistant's chat stays on its machine", () => {
    const machine = threadMachinePresentation({ ...base, handoff: "private" });
    expect(machine.tip).not.toContain("Move to another machine");
    expect(machine.tip).toContain("A personal assistant's chats stay on their machine.");
  });

  it("does not offer a handoff the menu greys out or lacks", () => {
    const continued = threadMachinePresentation({ ...base, handoff: "continued" });
    expect(continued.tip).not.toContain("Move to another machine");
    expect(continued.tip).toContain("It already moved to another machine");
    expect(
      threadMachinePresentation({ ...base, handoff: "available", canOperate: false }).tip,
    ).toBe("Runs on linuxbox (Linux). Its commands, files and terminal are on that machine.");
    expect(threadMachinePresentation({ ...base, handoff: "none" }).tip).toBe(
      "Runs on linuxbox (Linux). Its commands, files and terminal are on that machine.",
    );
  });

  it("keeps the host name beside a nickname", () => {
    const machine = threadMachinePresentation({
      ...base,
      name: "M4",
      hostLabel: "work-laptop.local",
      os: "darwin",
      isThisMachine: true,
    });
    expect(machine.label).toBe("M4");
    expect(machine.tip).toContain("Runs on this computer, M4 (work-laptop.local, macOS).");
  });

  it("warns when a remote machine cannot be reached", () => {
    const machine = threadMachinePresentation({
      ...base,
      phase: "reconnecting",
      error: "timed out",
    });
    expect(machine.warning).toBe("Can't reach");
    expect(machine.tip).toContain("Can't reach. Retrying automatically.");
  });

  it("does not warn while this machine only catches up", () => {
    const machine = threadMachinePresentation({
      ...base,
      isThisMachine: true,
      phase: "connecting",
    });
    expect(machine.warning).toBeNull();
  });
});
