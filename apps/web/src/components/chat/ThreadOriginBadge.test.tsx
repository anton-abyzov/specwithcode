import type { OrchestrationV2ThreadOrigin } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadOriginBadge, threadOriginText, threadOriginTooltip } from "./ThreadOriginBadge";

const fleet = {
  kind: "fleet_machine",
  label: "SpecWithCode",
  machineLabel: "m4-studio",
  environmentId: "env-coordinator",
} as OrchestrationV2ThreadOrigin;
const client = { kind: "mcp_client", label: "Claude.ai" } as OrchestrationV2ThreadOrigin;

describe("ThreadOriginBadge", () => {
  it("reads From <label> · <machine>, or From <label> without a machine", () => {
    expect(threadOriginText(fleet)).toBe("From SpecWithCode · m4-studio");
    expect(threadOriginText(client)).toBe("From Claude.ai");
    expect(threadOriginText({ ...client, machineLabel: "bb-1" })).toBe("From Claude.ai · bb-1");
  });

  it("explains the origin and the parent thread in the tooltip", () => {
    expect(threadOriginTooltip(client)).toBe(
      "Started by Claude.ai, an outside agent connected over MCP.",
    );
    expect(
      threadOriginTooltip({
        ...fleet,
        parentThreadRef: { threadId: "parent-1" } as never,
      }),
    ).toBe(
      "Started by work from m4-studio through SpecWithCode. Its parent thread parent-1 is on m4-studio.",
    );
  });

  it("renders the badge with its text and an accessible tooltip label", () => {
    const markup = renderToStaticMarkup(<ThreadOriginBadge origin={fleet} />);
    expect(markup).toContain('data-thread-origin="fleet_machine"');
    expect(markup).toContain("From SpecWithCode · m4-studio");
    expect(markup).toContain("Started by work from m4-studio through SpecWithCode.");
    expect(renderToStaticMarkup(<ThreadOriginBadge origin={client} variant="chip" />)).toContain(
      'class="sws-chip"',
    );
  });

  it("renders nothing for a thread without an origin", () => {
    expect(renderToStaticMarkup(<ThreadOriginBadge origin={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ThreadOriginBadge origin={null} />)).toBe("");
  });
});
