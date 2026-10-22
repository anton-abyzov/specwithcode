// @effect-diagnostics nodeBuiltinImport:off - temporary destination directories only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectId } from "@specweave-studio/contracts";
import type { ProjectService } from "../project/ProjectService.ts";
import type { DestinationRecord } from "./folderTransfer/destinationService.ts";
import { makeCopyRegistration } from "./folderCopyRegistration.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

it.live("registers and reuses the relative child without reviving an umbrella registration", () =>
  Effect.gen(function* () {
    const target = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copy-registration-")),
    );
    roots.push(target);
    const child = NodePath.join(target, "custom/app");
    NodeFS.mkdirSync(child, { recursive: true });
    const id = ProjectId.make("target-child");
    const registrations = new Map([[target, { id: ProjectId.make("unrelated-umbrella") }]]);
    const created: string[] = [];
    const projects = {
      getByWorkspaceRoot: (root: string) =>
        Effect.succeed(Option.fromNullishOr(registrations.get(root))),
      snapshot: Effect.succeed({ projects: [] }),
      bootstrap: (input: { workspaceRoot: string; projectId: typeof id }) =>
        Effect.sync(() => {
          created.push(input.workspaceRoot);
          const project = { id: input.projectId };
          registrations.set(input.workspaceRoot, project);
          return { project };
        }),
    } as unknown as ProjectService["Service"];
    const record = {
      operationId: "00000000-0000-4000-8000-000000000992",
      targetFolder: target,
      projectRelativePath: "custom/app",
      requestedProjectId: id,
      title: "App",
      sourceMachine: "Mac",
    } as unknown as DestinationRecord;
    const register = makeCopyRegistration(projects);
    expect(yield* register(record)).toBe(id);
    expect(yield* register(record)).toBe(id);
    expect(created).toEqual([child]);
    expect(registrations.get(target)?.id).toBe("unrelated-umbrella");
    const wrongId = yield* register({ ...record, requestedProjectId: "other" }).pipe(Effect.flip);
    expect(wrongId.message).toContain("Another project");
  }),
);
