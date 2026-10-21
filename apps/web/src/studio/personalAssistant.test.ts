import { describe, expect, it } from "vite-plus/test";
import {
  assistantDisplayTitle,
  findMachineAssistant,
  isExtraAssistant,
  personalAssistantSetupStep,
} from "./personalAssistant";

// Two fictional machines; neither names a real person or folder.
const personal = (id: string, environmentId: string, createdAt: string, archived = false) => ({
  id,
  environmentId,
  createdAt,
  workspaceSettings: { kind: "personal", archived },
});
const studio = {
  id: "atlas",
  environmentId: "m4",
  createdAt: "2026-01-01",
  workspaceSettings: { kind: "code" },
};
const ownM4 = personal("aide-m4", "m4", "2026-02-01");
const ownAnna = personal("aide-anna", "anna", "2026-01-15");

describe("one personal assistant per machine", () => {
  it("finds each machine's own assistant and never another machine's", () => {
    const projects = [studio, ownAnna, ownM4];
    expect(findMachineAssistant(projects, "m4")).toBe(ownM4);
    expect(findMachineAssistant(projects, "anna")).toBe(ownAnna);
    expect(findMachineAssistant([studio, ownAnna], "m4")).toBeUndefined();
  });

  it("keeps an older duplicate's history visible, as an earlier assistant", () => {
    const duplicate = personal("aide-m4-later", "m4", "2026-03-01");
    const archivedFirst = personal("aide-m4-first", "m4", "2026-01-10", true);
    const projects = [ownM4, duplicate, archivedFirst];
    expect(findMachineAssistant(projects, "m4")).toBe(archivedFirst);
    expect(isExtraAssistant(duplicate, projects)).toBe(true);
    expect(isExtraAssistant(archivedFirst, projects)).toBe(false);
    expect(isExtraAssistant(studio, [studio])).toBe(false);
  });
});

describe("Set up", () => {
  it("opens the assistant of the machine in context, even when another machine has one", () => {
    expect(
      personalAssistantSetupStep({
        projects: [ownAnna, ownM4],
        connectedEnvironmentIds: ["m4", "anna"],
        preferredEnvironmentId: "m4",
      }),
    ).toEqual({ kind: "open", assistant: ownM4 });
  });

  it("creates one on this machine instead of opening Anna's", () => {
    expect(
      personalAssistantSetupStep({
        projects: [ownAnna],
        connectedEnvironmentIds: ["m4", "anna"],
        preferredEnvironmentId: "m4",
      }),
    ).toEqual({ kind: "create", environmentId: "m4" });
  });

  it("uses the only connected machine, and asks which machine when several are and none is in context", () => {
    expect(personalAssistantSetupStep({ projects: [], connectedEnvironmentIds: ["anna"] })).toEqual(
      { kind: "create", environmentId: "anna" },
    );
    expect(
      personalAssistantSetupStep({
        projects: [ownM4],
        connectedEnvironmentIds: ["m4", "anna"],
        preferredEnvironmentId: "offline-mac",
      }),
    ).toEqual({ kind: "choose-machine" });
  });

  it("names each machine's assistant once more than one machine is connected", () => {
    expect(assistantDisplayTitle("Aide", "Anna's MacBook", 2)).toBe("Aide · Anna's MacBook");
    expect(assistantDisplayTitle("Aide", "Anna's MacBook", 1)).toBe("Aide");
    expect(assistantDisplayTitle("Aide", null, 3)).toBe("Aide");
  });
});
