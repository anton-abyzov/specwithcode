import { describe, expect, it } from "vite-plus/test";

import { englishPhrase } from "../i18n";
import {
  coordinatorExecutionLabel,
  coordinatorTagWords,
  MACHINE_LABEL_PHRASES,
  restartButtonLabel,
  threadMachineSuffix,
  windowMachineWords,
} from "./machineLabels";

type Words = { readonly text: string; readonly values?: Readonly<Record<string, string>> };
const said = (words: Words | null) => (words ? englishPhrase(words.text, words.values) : null);

const NAMES: Record<string, string> = { m4: "M4", m5: "M5", "linux-mini": "linux-mini" };
const name = (environmentId: string) => NAMES[environmentId] ?? environmentId;

describe("the window and the coordinator name their machines (1427 AC-05)", () => {
  it("names the window's machine for the sidebar header", () => {
    expect(said(windowMachineWords("M5"))).toBe("Window on M5");
  });

  it("tags another machine's coordinator by name, with the window's machine beside it", () => {
    const words = coordinatorTagWords({ shown: "linux-mini", window: "M5" });
    expect(said(words.tag)).toBe("linux-mini's coordinator");
    expect(said(words.window)).toBe("Window on M5");
    expect(said(words.tip)).toBe("Showing linux-mini's coordinator. This window runs on M5.");
  });

  it("names the machine a restart or an update acts on", () => {
    expect(said(restartButtonLabel("Update now", "M5"))).toBe("Update M5 now");
    expect(said(restartButtonLabel("Restart to update", "M5"))).toBe("Restart M5 to update");
    expect(said(restartButtonLabel("Retry update", "M5"))).toBe("Retry update on M5");
    // Progress words keep their own text, and no name keeps the old label.
    expect(said(restartButtonLabel("Restarting…", "M5"))).toBe("Restarting…");
    expect(said(restartButtonLabel("Update now", null))).toBe("Update now");
  });
});

describe("coordinator messages name their machines (1427 AC-06)", () => {
  const runs = [
    { id: "run-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
  ];

  it("labels a reply with the coordinator's machine, provider and model", () => {
    expect(
      said(coordinatorExecutionLabel({ role: "assistant", runId: "run-1" }, runs, "linux-mini")),
    ).toBe("Coordinator on linux-mini · Claude Code · Opus 5.5");
    expect(said(coordinatorExecutionLabel({ role: "assistant" }, runs, "M4"))).toBe(
      "Coordinator on M4 · Model not recorded",
    );
  });

  it("labels the user's own message with the coordinator it went to", () => {
    expect(
      said(
        coordinatorExecutionLabel(
          { role: "user", createdBy: "user", runId: "run-1" },
          runs,
          "linux-mini",
        ),
      ),
    ).toBe("To linux-mini's coordinator");
  });

  it("names a thread's machine only when it is not the coordinator's", () => {
    const thread = (environmentId: string, executionMachineId?: string) => ({
      environmentId,
      ...(executionMachineId ? { executionMachineId } : {}),
    });
    expect(threadMachineSuffix(thread("linux-mini"), "linux-mini", name)).toBeNull();
    expect(threadMachineSuffix(thread("m5"), "linux-mini", name)).toBe("M5");
    // A thread handed off to another machine names where it lives and where it runs.
    expect(threadMachineSuffix(thread("linux-mini", "m5"), "linux-mini", name)).toBe(
      "linux-mini → M5",
    );
    // Without a coordinator machine to compare with, nothing is added.
    expect(threadMachineSuffix(thread("m5"), null, name)).toBeNull();
  });

  it("lists each phrase it shows once, for the catalogs", () => {
    const phrases = Object.values(MACHINE_LABEL_PHRASES);
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(phrases).toContain("this window");
  });
});
