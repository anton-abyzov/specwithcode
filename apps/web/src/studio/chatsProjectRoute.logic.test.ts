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

  it("tells a No project folder apart before the machine's config arrives", () => {
    expect(isChatsProjectRoute({ group: undefined, scratchRootFor })).toBe(false);
    const chats = {
      memberProjects: [{ environmentId: "m1", workspaceRoot: "/home/me/.specwithcode/m1/scratch" }],
    };
    expect(isChatsProjectRoute({ group: chats, scratchRootFor: () => undefined })).toBe(true);
    const real = { memberProjects: [{ environmentId: "m1", workspaceRoot: "/code/app" }] };
    expect(isChatsProjectRoute({ group: real, scratchRootFor: () => undefined })).toBe(false);
    // A loaded config that offers no folder: nothing there is a chat folder.
    const group = { memberProjects: [{ environmentId: "m1", workspaceRoot: "/data/m1/scratch" }] };
    expect(isChatsProjectRoute({ group, scratchRootFor: () => null })).toBe(false);
  });
});
