import { describe, expect, it } from "vite-plus/test";

import { chatsProjectRoute } from "./chatsProjectRoute.logic";

const scratchRootFor = (environmentId: string) => `/data/${environmentId}/scratch`;
const unknown = () => undefined;
const one = (workspaceRoot: string) => ({
  memberProjects: [{ environmentId: "m1", workspaceRoot }],
});

describe("chatsProjectRoute", () => {
  it("sends a page naming a machine's No project folder away", () => {
    expect(chatsProjectRoute({ group: one("/data/m1/scratch"), scratchRootFor })).toBe("chats");
  });

  it("keeps a real project's page, and one only partly made of chat folders", () => {
    expect(chatsProjectRoute({ group: one("/code/app"), scratchRootFor })).toBe("project");
    const mixed = {
      memberProjects: [
        { environmentId: "m1", workspaceRoot: "/data/m1/scratch" },
        { environmentId: "m2", workspaceRoot: "/code/app" },
      ],
    };
    expect(chatsProjectRoute({ group: mixed, scratchRootFor })).toBe("project");
    expect(chatsProjectRoute({ group: undefined, scratchRootFor })).toBe("project");
  });

  it("waits for the config before deciding a folder shaped like No project", () => {
    expect(
      chatsProjectRoute({
        group: one("/home/me/.specwithcode/m1/scratch"),
        scratchRootFor: unknown,
      }),
    ).toBe("pending");
    // A real project named scratch in the app's projects folder matches the same shape.
    const named = one("/home/me/.specwithcode/projects/scratch");
    expect(chatsProjectRoute({ group: named, scratchRootFor: unknown })).toBe("pending");
    expect(
      chatsProjectRoute({ group: named, scratchRootFor: () => "/home/me/.specwithcode/scratch" }),
    ).toBe("project");
    expect(chatsProjectRoute({ group: one("/code/app"), scratchRootFor: unknown })).toBe("project");
  });

  it("treats nothing as a chat folder on a machine whose config offers none", () => {
    expect(chatsProjectRoute({ group: one("/data/m1/scratch"), scratchRootFor: () => null })).toBe(
      "project",
    );
  });
});
