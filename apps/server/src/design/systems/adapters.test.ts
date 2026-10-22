import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { rootsFrom } from "./adapters.ts";
import { userCaller } from "./DesignSystemService.ts";

const environmentId = EnvironmentId.make("env");
const roots = rootsFrom({
  playgroundDir: "design/playground",
  ownerRoot: () => Effect.die("reads never create the design folder"),
  findOwnerRoot: (_caller, owner) =>
    Effect.succeed(
      owner.kind === "project"
        ? {
            owner: { kind: "project", environmentId, projectId: owner.projectId },
            root: "/work/app/.specweave/design",
          }
        : { owner: { kind: "playground", environmentId }, root: "/state/design/playground" },
    ),
});

describe("rootsFrom", () => {
  it("derives the checkout and the reference prefix from the design root", async () => {
    const project = await Effect.runPromise(
      roots.resolve(userCaller, { kind: "project", projectId: ProjectId.make("p") }),
    );
    expect(project).toMatchObject({
      designRoot: "/work/app/.specweave/design",
      projectRoot: "/work/app",
      refPrefix: ".specweave/design/systems/",
    });
    const playground = await Effect.runPromise(roots.resolve(userCaller, { kind: "playground" }));
    expect(playground).toMatchObject({
      projectRoot: null,
      refPrefix: "design/playground/systems/",
    });
  });
});
