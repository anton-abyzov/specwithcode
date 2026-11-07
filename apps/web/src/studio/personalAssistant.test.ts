import { describe, expect, it } from "vite-plus/test";
import {
  assistantDisplayTitle,
  findMachineAssistant,
  isExtraAssistant,
  machineNeedsAssistantSetup,
  personalAssistantSetupStep,
  threadsVisibleWithAide,
  visibleWithAide,
  visibleWithAideKeeping,
  machineOffersAssistant,
  personalAssistantDisabledMessage,
  isPersonalAssistantDisabledError,
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

  it("creates this machine's assistant even while looking at another machine's project", () => {
    expect(
      personalAssistantSetupStep({
        projects: [ownM4],
        connectedEnvironmentIds: ["ministorm", "m4"],
        ownEnvironmentId: "ministorm",
        preferredEnvironmentId: "m4",
      }),
    ).toEqual({ kind: "create", environmentId: "ministorm" });
  });

  it("asks which machine when this machine is not connected, never another machine by default", () => {
    expect(
      personalAssistantSetupStep({
        projects: [ownM4],
        connectedEnvironmentIds: ["m4"],
        ownEnvironmentId: "ministorm",
        preferredEnvironmentId: "m4",
      }),
    ).toEqual({ kind: "choose-machine" });
  });

  it("still offers Set up when only another machine has an assistant", () => {
    expect(machineNeedsAssistantSetup({ assistants: [ownM4], ownEnvironmentId: "ministorm" })).toBe(
      true,
    );
    expect(machineNeedsAssistantSetup({ assistants: [ownM4], ownEnvironmentId: "m4" })).toBe(false);
    expect(
      machineNeedsAssistantSetup({
        assistants: [personal("old", "m4", "2026-01-01T00:00:00.000Z", true)],
        ownEnvironmentId: "m4",
      }),
    ).toBe(false);
  });

  it("a client with no machine of its own needs Set up only when no assistant is listed", () => {
    expect(machineNeedsAssistantSetup({ assistants: [], ownEnvironmentId: null })).toBe(true);
    expect(machineNeedsAssistantSetup({ assistants: [ownM4], ownEnvironmentId: null })).toBe(false);
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

describe("hiding the personal assistant", () => {
  const code = { id: "atlas", environmentId: "m1", workspaceSettings: { kind: "code" } };
  const aide = personal("aide", "m1", "2026-01-01T00:00:00Z");
  const archivedAide = personal("old-aide", "m2", "2026-01-01T00:00:00Z", true);
  const projects = [code, aide, archivedAide];
  const threads = [
    { id: "t1", environmentId: "m1", projectId: "atlas" },
    { id: "t2", environmentId: "m1", projectId: "aide" },
    { id: "t3", environmentId: "m2", projectId: "old-aide" },
    // Same project id on another machine is a different project.
    { id: "t4", environmentId: "m2", projectId: "aide" },
  ];

  it("lists every project while on, and leaves out personal ones, archived too, while off", () => {
    expect(visibleWithAide(projects, true)).toBe(projects);
    expect(visibleWithAide(projects, false)).toEqual([code]);
    expect(visibleWithAide([code], false)).toEqual([code]);
  });

  it("drops a hidden assistant's chats and keeps every other chat", () => {
    expect(threadsVisibleWithAide(threads, projects, true)).toBe(threads);
    expect(threadsVisibleWithAide(threads, projects, false).map((t) => t.id)).toEqual(["t1", "t4"]);
    expect(threadsVisibleWithAide(threads, [code], false)).toBe(threads);
  });
});

describe("hiding the personal assistant from a picker with a saved choice", () => {
  const code = { id: "code", workspaceSettings: { kind: "code" } };
  const aide = { id: "aide", workspaceSettings: { kind: "personal" } };
  it("drops a hidden assistant unless it is the saved or selected one", () => {
    expect(visibleWithAideKeeping([aide, code], false, [null])).toEqual([code]);
    expect(visibleWithAideKeeping([aide, code], false, ["aide"])).toEqual([aide, code]);
    const all = [aide, code];
    expect(visibleWithAideKeeping(all, true, [])).toBe(all);
  });
});

describe("machines that disagree on the Aide switch", () => {
  const aideOnM1 = { id: "a1", environmentId: "m1", workspaceSettings: { kind: "personal" } };
  it("offers Set up only where the machine's own settings turn Aide on", () => {
    expect(
      machineOffersAssistant({ environmentId: "m4", aideEnabledOnMachine: true, projects: [] }),
    ).toBe(true);
    // This device shows Aide on, but M3 still has it off: no setup there.
    expect(
      machineOffersAssistant({ environmentId: "m3", aideEnabledOnMachine: false, projects: [] }),
    ).toBe(false);
  });

  it("still opens an assistant a machine already has, whatever its switch says", () => {
    expect(
      machineOffersAssistant({
        environmentId: "m1",
        aideEnabledOnMachine: false,
        projects: [aideOnM1],
      }),
    ).toBe(true);
  });

  it("names the machine that refused", () => {
    expect(personalAssistantDisabledMessage("M3")).toBe(
      "The personal assistant is turned off on M3. Turn it on in Settings > General while M3 is connected.",
    );
    expect(personalAssistantDisabledMessage(undefined)).toContain("on this machine");
  });

  it("recognizes the server's refusal by reason or by its words", () => {
    expect(isPersonalAssistantDisabledError({ reason: "project_assistant_disabled" })).toBe(true);
    expect(isPersonalAssistantDisabledError({ reason: "assistant_disabled" })).toBe(true);
    expect(
      isPersonalAssistantDisabledError(
        new Error("The personal assistant is turned off. Turn it on in Settings > General."),
      ),
    ).toBe(true);
    expect(isPersonalAssistantDisabledError(new Error("name taken"))).toBe(false);
    expect(isPersonalAssistantDisabledError(null)).toBe(false);
  });
});
