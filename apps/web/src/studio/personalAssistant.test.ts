import { describe, expect, it } from "vite-plus/test";
import {
  findPersonalAssistant,
  PERSONAL_ASSISTANT_ELSEWHERE_NOTICE,
  personalAssistantCreationEnvironment,
  personalAssistantSetupStep,
} from "./personalAssistant";
describe("personal assistant entry", () => {
  it("opens the existing assistant across machines regardless of current project", () => {
    const remote = { environmentId: "remote", workspaceSettings: { kind: "personal" } };
    expect(
      findPersonalAssistant([
        { environmentId: "local", workspaceSettings: { kind: "code" } },
        remote,
      ]),
    ).toBe(remote);
  });
  it("prefers an active legacy assistant and retains an archived one rather than duplicating it", () => {
    const archived = { workspaceSettings: { kind: "personal", archived: true } };
    const active = { workspaceSettings: { kind: "personal" } };
    expect(findPersonalAssistant([archived, active])).toBe(active);
    expect(findPersonalAssistant([archived])).toBe(archived);
    expect(findPersonalAssistant([])).toBeUndefined();
  });
});

it("uses one creation authority independent of catalog order or online status", () => {
  expect(personalAssistantCreationEnvironment(["m4", "m1", "m3"])).toBe("m1");
  expect(personalAssistantCreationEnvironment(["m3", "m4", "m1"])).toBe("m1");
  expect(personalAssistantCreationEnvironment([])).toBeNull();
});

describe("personal assistant Set up", () => {
  const code = { workspaceSettings: { kind: "code" } };
  const m4 = { label: "M4MAX" };

  it("opens an assistant a connected machine has, even while another machine is hidden", () => {
    const assistant = { workspaceSettings: { kind: "personal" } };
    expect(
      personalAssistantSetupStep({ projects: [code, assistant], unseenMachines: [m4] }),
    ).toEqual({ kind: "open", assistant });
  });

  it("offers Connect to hidden private machines before creating a second assistant", () => {
    expect(personalAssistantSetupStep({ projects: [code], unseenMachines: [m4] })).toEqual({
      kind: "connect-first",
      machines: [m4],
    });
    expect(PERSONAL_ASSISTANT_ELSEWHERE_NOTICE).toBe(
      "An assistant on another Mac is not visible until that Mac is connected.",
    );
  });

  it("creates one when every private machine is visible, or when the user chose a separate one", () => {
    expect(personalAssistantSetupStep({ projects: [code], unseenMachines: [] })).toEqual({
      kind: "create",
    });
    expect(
      personalAssistantSetupStep({ projects: [code], unseenMachines: [m4], separate: true }),
    ).toEqual({ kind: "create" });
  });
});
