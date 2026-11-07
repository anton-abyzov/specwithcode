import * as Context from "effect/Context";
import { Tool } from "effect/ai";
import { assert, describe, it } from "vitest";

import { DesignScreenshotToolkit, DesignToolkit } from "./toolkits/design/tools.ts";
import { DecisionToolkit } from "./toolkits/decision/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { GoogleToolkit } from "./toolkits/google/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { MachinesToolkit } from "./toolkits/machines/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProjectKnowledgeToolkit } from "./toolkits/projectKnowledge/tools.ts";
import { ProjectMemoryToolkit } from "./toolkits/projectMemory/tools.ts";
import { ProjectPlanToolkit } from "./toolkits/projectPlan/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { STUDIO_READ_ONLY_TOOLS, studioToolName } from "./studioReadOnlyTools.ts";

const TOOLS = [
  OrchestratorToolkit,
  ThreadToolkit,
  WorktreeToolkit,
  ProjectToolkit,
  ProjectMemoryToolkit,
  ProjectKnowledgeToolkit,
  ProjectPlanToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  HtmlToolkit,
  MachinesToolkit,
  DecisionToolkit,
  DesignToolkit,
  DesignScreenshotToolkit,
  GoogleToolkit,
].flatMap((toolkit) => Object.values(toolkit.tools));

// Annotated as writes only because reading a finished result acknowledges its delivery.
const ACKNOWLEDGING_READS = ["task_status", "studio_thread_read"];

describe("STUDIO_READ_ONLY_TOOLS", () => {
  it("holds only real tools that read, or acknowledge a delivered result", () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
    for (const name of STUDIO_READ_ONLY_TOOLS) {
      const tool = byName.get(name);
      assert.isDefined(tool, name);
      if (tool === undefined) continue;
      assert.isFalse(Context.get(tool.annotations, Tool.Destructive), name);
      if (!ACKNOWLEDGING_READS.includes(name))
        assert.isTrue(Context.get(tool.annotations, Tool.Readonly), name);
    }
  });

  it("takes only Google's status, never mail, files or calendar content", () => {
    const google = Object.values(GoogleToolkit.tools).map((tool) => tool.name);
    assert.deepEqual(
      google.filter((name) => STUDIO_READ_ONLY_TOOLS.has(name)),
      ["studio_google_status"],
    );
  });

  it("needs the server in the title", () => {
    assert.equal(studioToolName("mcp__studio_code__task_status"), "task_status");
    assert.isNull(studioToolName("task_status"));
    assert.isNull(studioToolName("mcp__studio_code__"));
  });
});
