import { describe, expect, it } from "vite-plus/test";

import {
  displayToolSourceName,
  summarizeToolGroup,
  summarizeToolGroupChips,
  type WorkLogPresentationEntry,
} from "./presentation.ts";
import { extractToolActivityPresentation } from "./toolPresentation.ts";

const entry = (
  id: string,
  overrides: Partial<WorkLogPresentationEntry>,
): WorkLogPresentationEntry => ({
  id,
  createdAt: "2026-10-15T00:00:00Z",
  label: "Tool call",
  tone: "tool",
  ...overrides,
});
const commands = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    entry(`cmd-${index}`, { itemType: "command_execution", command: "vp test run" }),
  );

describe("compact turn summary", () => {
  it("counts the two largest kinds of work as short chips", () => {
    const studio = {
      key: "mcp:specweave studio",
      name: "SpecWeave Studio",
      kind: "integration" as const,
    };
    const work = [
      ...commands(3),
      entry("thought", { itemType: "reasoning", tone: "thinking" }),
      entry("mcp-1", { label: "Status", toolSource: studio }),
    ];
    expect(summarizeToolGroupChips(work)).toEqual(["3 commands", "1 SpecWithCode call"]);
    expect(summarizeToolGroupChips(commands(1))).toEqual(["1 command"]);
    expect(summarizeToolGroup(work).summary).toBe(
      "Used SpecWithCode integration and ran 3 commands",
    );
  });

  it("names the app's own MCP server by the product, in history too", () => {
    expect(displayToolSourceName("SpecWeave Studio")).toBe("SpecWithCode");
    expect(displayToolSourceName("specweave-studio")).toBe("SpecWithCode");
    expect(displayToolSourceName("Firecrawl")).toBe("Firecrawl");
    expect(
      extractToolActivityPresentation({
        toolSource: { key: "mcp:specweave studio", name: "SpecWeave Studio", kind: "integration" },
      }).toolSource?.name,
    ).toBe("SpecWithCode");
  });
});
