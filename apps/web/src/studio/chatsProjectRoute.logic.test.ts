import { describe, expect, it } from "vite-plus/test";

import { isChatsProjectRoute } from "./chatsProjectRoute.logic";

const scratchRootFor = (environmentId: string) => `/data/${environmentId}/scratch`;

describe("isChatsProjectRoute", () => {
  it("sends a page naming a machine's No project folder away", () => {
    const group = { memberProjects: [{ environmentId: "m1", workspaceRoot: "/data/m1/scratch" }] };
    expect(isChatsProjectRoute({ group, scratchRootFor })).toBe(true);
  });

  it("keeps a real project's page, and one only partly made of chat folders", () => {
    const real = { memberProjects: [{ environmentId: "m1", workspaceRoot: "/code/app" }] };
    expect(isChatsProjectRoute({ group: real, scratchRootFor })).toBe(false);
    const mixed = {
      memberProjects: [
        { environmentId: "m1", workspaceRoot: "/data/m1/scratch" },
        { environmentId: "m2", workspaceRoot: "/code/app" },
      ],
    };
    expect(isChatsProjectRoute({ group: mixed, scratchRootFor })).toBe(false);
  });

  it("waits while the project or the machine's folder is unknown", () => {
    expect(isChatsProjectRoute({ group: undefined, scratchRootFor })).toBe(false);
    const group = { memberProjects: [{ environmentId: "m1", workspaceRoot: "/data/m1/scratch" }] };
    expect(isChatsProjectRoute({ group, scratchRootFor: () => null })).toBe(false);
  });
});
