import { describe, expect, it } from "@effect/vitest";
import {
  SourceControlRepositoryError,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { AGENT_CLONE_TIMEOUT_MS, agentClone } from "./agentClone.ts";

const PATH = "/home/example/Projects/widgets";
const REMOTE = "git@github.com:example/widgets.git";

const setup = (options: {
  readonly found: Partial<SourceControlInspectDestinationResult> & {
    readonly state: SourceControlInspectDestinationResult["state"];
  };
  readonly cloneFails?: SourceControlRepositoryError;
  readonly dirty?: boolean;
}) => {
  const world = {
    clones: [] as Array<{ readonly timeoutMs: number | null | undefined }>,
    discarded: [] as Array<{ readonly path: string; readonly removeDestination?: boolean }>,
  };
  const layer = Layer.mergeAll(
    Layer.mock(Repositories.SourceControlRepositoryService)({
      inspectDestination: () =>
        Effect.succeed({
          path: PATH,
          originKey: null,
          sameRepository: false,
          checkedOut: false,
          ...options.found,
        }),
      cloneRepository: (input, cloneOptions) => {
        world.clones.push({ timeoutMs: cloneOptions?.timeoutMs });
        return options.cloneFails === undefined
          ? Effect.succeed({ cwd: PATH, remoteUrl: input.remoteUrl ?? REMOTE, repository: null })
          : Effect.fail(options.cloneFails);
      },
      discardClone: (path, discardOptions) => {
        world.discarded.push({
          path,
          ...(discardOptions?.removeDestination === undefined
            ? {}
            : { removeDestination: discardOptions.removeDestination }),
        });
        return Effect.void;
      },
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      statusDetailsLocal: () =>
        Effect.succeed({
          isRepo: true,
          hasWorkingTreeChanges: options.dirty === true,
        } as GitVcsDriver.GitStatusDetails),
    }),
  );
  const run = (input: Parameters<typeof agentClone>[0]) =>
    agentClone(input).pipe(Effect.provide(layer));
  return { world, run };
};

const timedOut = new SourceControlRepositoryError({
  operation: "cloneRepository",
  provider: "unknown",
  detail: "The repository could not be cloned.",
  cause: { detail: "Git command timed out." },
});

describe("studio_project_clone for another machine's agent", () => {
  it.effect("gives the clone the caller's 10 minutes, not the 2-minute default", () => {
    const { world, run } = setup({ found: { state: "missing" } });
    return Effect.gen(function* () {
      const result = yield* run({ remoteUrl: REMOTE, destinationPath: "~/Projects/widgets" });
      expect(result.cwd).toBe(PATH);
      expect(world.clones).toEqual([{ timeoutMs: AGENT_CLONE_TIMEOUT_MS }]);
      expect(AGENT_CLONE_TIMEOUT_MS).toBe(10 * 60 * 1_000);
    });
  });

  it.effect("says how long a clone ran when it times out, and removes its partial folder", () => {
    const { world, run } = setup({ found: { state: "missing" }, cloneFails: timedOut });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        run({ remoteUrl: REMOTE, destinationPath: "~/Projects/widgets" }),
      );
      expect(error.code).toBe("orchestration_error");
      expect(error.message).toContain("The clone stopped after 0 seconds");
      expect(error.message).toContain("600 seconds at most");
      expect(error.message).toContain(`partial folder at ${PATH} was removed`);
      expect(world.discarded).toEqual([{ path: "~/Projects/widgets", removeDestination: true }]);
    });
  });

  it.effect("empties a folder that was empty before a failed clone, keeping the folder", () => {
    const failed = new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: "unknown",
      detail: "remote: Repository not found.",
    });
    const { world, run } = setup({ found: { state: "empty" }, cloneFails: failed });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run({ remoteUrl: REMOTE, destinationPath: PATH }));
      expect(error.message).toBe("remote: Repository not found.");
      expect(world.discarded).toEqual([{ path: PATH, removeDestination: false }]);
    });
  });

  it.effect("never removes a destination that held something before", () => {
    const notEmpty = new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: "unknown",
      detail: "Destination path already exists and is not empty.",
    });
    const { world, run } = setup({
      found: { state: "repository", sameRepository: true, checkedOut: true },
      cloneFails: notEmpty,
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run({ remoteUrl: REMOTE, destinationPath: PATH }));
      expect(error.message).toBe("Destination path already exists and is not empty.");
      expect(world.discarded).toEqual([]);
    });
  });

  it.effect("uses a clean clone of the same repository an earlier call left there", () => {
    const { world, run } = setup({
      found: { state: "repository", sameRepository: true, checkedOut: true },
    });
    return Effect.gen(function* () {
      const result = yield* run({ remoteUrl: REMOTE, destinationPath: PATH, resumeExisting: true });
      expect(result).toEqual({ cwd: PATH, remoteUrl: REMOTE, repository: null });
      expect(world.clones).toEqual([]);
    });
  });

  it.effect("refuses to resume into another repository, local changes or other files", () => {
    const cases = [
      {
        found: { state: "repository" as const, sameRepository: false, checkedOut: true },
        says: "holds another repository",
      },
      {
        found: { state: "repository" as const, sameRepository: true, checkedOut: true },
        dirty: true,
        says: "has local changes",
      },
      {
        found: { state: "repository" as const, sameRepository: true, checkedOut: false },
        says: "did not finish checking out",
      },
      { found: { state: "not-repository" as const }, says: "not a clone of this repository" },
    ];
    return Effect.gen(function* () {
      for (const item of cases) {
        const { world, run } = setup(item);
        const error = yield* Effect.flip(
          run({ remoteUrl: REMOTE, destinationPath: PATH, resumeExisting: true }),
        );
        expect(error.message).toContain(item.says);
        expect(world.clones).toEqual([]);
        expect(world.discarded).toEqual([]);
      }
    });
  });
});
