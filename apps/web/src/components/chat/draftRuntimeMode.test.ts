import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDraftDefaultRuntimeMode } from "./draftRuntimeMode";

const projectId = ProjectId.make("project-1");
const here = { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "full-access" as const };
const worker = { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" as const };

describe("resolveDraftDefaultRuntimeMode", () => {
  it("starts a chat on another machine with this machine's access", () => {
    expect(
      resolveDraftDefaultRuntimeMode({
        environmentSettings: worker,
        projectId: null,
        primarySettings: here,
      }),
    ).toBe("full-access");
  });

  it("keeps a project setting saved on the other machine", () => {
    const withOverride = {
      ...worker,
      projectSettingsOverrides: {
        [projectId]: { defaultRuntimeMode: "auto-accept-edits" as const },
      },
    };
    expect(
      resolveDraftDefaultRuntimeMode({
        environmentSettings: withOverride,
        projectId,
        primarySettings: here,
      }),
    ).toBe("auto-accept-edits");
  });

  it("uses the machine's own default for a chat on this machine", () => {
    expect(
      resolveDraftDefaultRuntimeMode({
        environmentSettings: worker,
        projectId: null,
        primarySettings: null,
      }),
    ).toBe("approval-required");
  });
});
