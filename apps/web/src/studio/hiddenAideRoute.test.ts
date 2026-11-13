import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../components/studio/ProjectWorkspace", () => ({ findProjectGroup: vi.fn() }));
vi.mock("../components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [],
}));
vi.mock("../hooks/useSettings", () => ({
  useAideEnabled: () => false,
  useAideSettingSettled: () => true,
}));

vi.mock("../state/entities", () => ({ useProjects: () => [], useThreadShell: () => null }));

import { isHiddenAideRoute, isHiddenAideThread } from "./hiddenAideRoute";

const aide = { memberProjects: [{ workspaceSettings: { kind: "personal" } }] };
const code = { memberProjects: [{ workspaceSettings: { kind: "code" } }] };

describe("isHiddenAideRoute", () => {
  it("sends a personal assistant's page away only once Percy is known to be off", () => {
    expect(isHiddenAideRoute({ group: aide, aideEnabled: false, settled: true })).toBe(true);
    // Settings still loading: off may only mean "not loaded yet", so the link stays.
    expect(isHiddenAideRoute({ group: aide, aideEnabled: false, settled: false })).toBe(false);
    expect(isHiddenAideRoute({ group: aide, aideEnabled: true, settled: true })).toBe(false);
  });

  it("leaves code projects and unknown keys alone", () => {
    expect(isHiddenAideRoute({ group: code, aideEnabled: false, settled: true })).toBe(false);
    expect(isHiddenAideRoute({ group: undefined, aideEnabled: false, settled: true })).toBe(false);
  });
});

describe("isHiddenAideThread", () => {
  const personal = { workspaceSettings: { kind: "personal" } };
  it("sends a personal assistant's chat away only once Percy is known to be off", () => {
    expect(isHiddenAideThread({ project: personal, aideEnabled: false, settled: true })).toBe(true);
    expect(isHiddenAideThread({ project: personal, aideEnabled: false, settled: false })).toBe(
      false,
    );
    expect(isHiddenAideThread({ project: personal, aideEnabled: true, settled: true })).toBe(false);
  });

  it("leaves code chats and chats whose project has not loaded alone", () => {
    expect(
      isHiddenAideThread({
        project: { workspaceSettings: { kind: "code" } },
        aideEnabled: false,
        settled: true,
      }),
    ).toBe(false);
    expect(isHiddenAideThread({ project: undefined, aideEnabled: false, settled: true })).toBe(
      false,
    );
  });
});
