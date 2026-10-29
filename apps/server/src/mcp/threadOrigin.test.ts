import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type * as McpInvocationContext from "./McpInvocationContext.ts";
import { launchOriginOf } from "./threadOrigin.ts";

const scope = (client: McpInvocationContext.McpClientCaller | undefined) =>
  ({
    environmentId: EnvironmentId.make("env-here"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "ns",
    thread: undefined,
    client,
  }) satisfies McpInvocationContext.McpInvocationScope;

const claude = { sessionId: "s-1", label: "  Claude.ai  ", access: "full-access" } as const;
const fleetWork = {
  coordinatorLabel: "m4-studio",
  origin: {
    coordinatorEnvironmentId: EnvironmentId.make("env-coordinator"),
    path: [EnvironmentId.make("env-coordinator")],
    hops: 1,
  },
};

describe("launchOriginOf", () => {
  it("names an outside MCP client that launches with no calling thread", () => {
    expect(launchOriginOf({ scope: scope(claude), caller: undefined }, undefined)).toEqual({
      kind: "mcp_client",
      label: "Claude.ai",
    });
  });

  it("prefers another machine's fleet work over the grant client's own name", () => {
    expect(launchOriginOf({ scope: scope(claude), caller: undefined }, fleetWork)).toEqual({
      kind: "fleet_machine",
      label: "SpecWithCode",
      machineLabel: "m4-studio",
      environmentId: "env-coordinator",
    });
  });

  it("shows the sending machine's client or thread as display text only", () => {
    const here = { scope: scope(claude), caller: undefined };
    expect(
      launchOriginOf(here, fleetWork, { clientLabel: "  Grok\n agent ".padEnd(300, "x") }),
    ).toEqual({
      kind: "fleet_machine",
      label: expect.stringMatching(/^Grok agent x+…$/u),
      machineLabel: "m4-studio",
      environmentId: "env-coordinator",
    });
    // The parent thread is on the machine the grant names, whatever else is sent.
    expect(launchOriginOf(here, fleetWork, { parentThreadId: ThreadId.make("parent-1") })).toEqual({
      kind: "fleet_machine",
      label: "SpecWithCode",
      machineLabel: "m4-studio",
      environmentId: "env-coordinator",
      parentThreadRef: { environmentId: "env-coordinator", threadId: "parent-1" },
    });
    // A blank name falls back to the app's.
    expect(launchOriginOf(here, fleetWork, { clientLabel: "   " })?.label).toBe("SpecWithCode");
    // Never an mcp_client badge, and never from a thread here or without fleet work.
    expect(launchOriginOf(here, undefined, { clientLabel: "Fake" })).toEqual({
      kind: "mcp_client",
      label: "Claude.ai",
    });
    expect(
      launchOriginOf({ scope: scope(claude), caller: { id: "t" } }, fleetWork, {
        clientLabel: "Fake",
      })?.label,
    ).toBe("SpecWithCode");
  });

  it("records nothing for this machine's own threads and users", () => {
    const caller = { id: "thread-1" } as never;
    expect(launchOriginOf({ scope: scope(claude), caller }, undefined)).toBeUndefined();
    expect(
      launchOriginOf({ scope: scope(undefined), caller: undefined }, undefined),
    ).toBeUndefined();
    expect(
      launchOriginOf(
        { scope: scope({ ...claude, label: "   " }), caller: undefined },
        { coordinatorLabel: "x", origin: undefined },
      ),
    ).toBeUndefined();
  });

  it("keeps a long client name to a badge-sized label", () => {
    const origin = launchOriginOf(
      { scope: scope({ ...claude, label: "a".repeat(200) }), caller: undefined },
      undefined,
    );
    expect(origin?.label.length).toBe(80);
  });
});
