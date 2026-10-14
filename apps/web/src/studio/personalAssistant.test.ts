import { describe, expect, it } from "vite-plus/test";
import { findPersonalAssistant, personalAssistantCreationEnvironment } from "./personalAssistant";
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
