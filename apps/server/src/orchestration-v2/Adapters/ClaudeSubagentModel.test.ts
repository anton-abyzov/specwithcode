import { describe, expect, it } from "vite-plus/test";

import { withInheritedSubagentModel } from "./ClaudeAdapterV2.ts";

describe("withInheritedSubagentModel", () => {
  it("runs every subagent on the thread's model, whatever the Task call or agent file asks", () => {
    const environment = { PATH: "/usr/bin" };
    expect(withInheritedSubagentModel(environment, "claude-opus-5-5")).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    // The workflow environment is not changed in place.
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps a subagent model the host already set", () => {
    const environment = { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5" };
    expect(withInheritedSubagentModel(environment, "claude-opus-5-5")).toBe(environment);
  });
});
