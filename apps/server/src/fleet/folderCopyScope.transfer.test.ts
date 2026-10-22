// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated production copy protocol.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import type { ProjectService } from "../project/ProjectService.ts";
import { SourceTransfers } from "./folderTransfer/sourceService.ts";
import { DestinationCopies } from "./folderTransfer/destinationService.ts";
import { serveSource } from "./folderTransfer/sourceTestServer.testkit.ts";
import { makeCopyRegistration } from "./folderCopyRegistration.ts";

it("attests umbrella scope over HTTP, registers the child, and rejects replay changes", async () => {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copy-scope-wire-")),
  );
  const root = NodePath.join(base, "source");
  const relative = "odd/layout/app";
  NodeFS.mkdirSync(NodePath.join(root, relative), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "sibling-notes.txt"), "unfinished sibling work\n");
  NodeFS.writeFileSync(NodePath.join(root, relative, "app.txt"), "uncommitted app\n");
  const sources = new SourceTransfers(NodePath.join(base, "source-state"));
  const served = await serveSource(sources, "source-env");
  const registrations: string[] = [];
  const register = makeCopyRegistration({
    getByWorkspaceRoot: () => Effect.succeed(Option.none()),
    snapshot: Effect.succeed({ projects: [] }),
    bootstrap: (input: { workspaceRoot: string; projectId: string }) =>
      Effect.sync(() => {
        registrations.push(input.workspaceRoot);
        return { project: { id: input.projectId } };
      }),
  } as unknown as ProjectService["Service"]);
  const copies = new DestinationCopies(NodePath.join(base, "destination-state"), {
    allowLoopback: true,
    pollMs: 1,
    sleep: async () => undefined,
    // eslint-disable-next-line studio/no-manual-effect-runtime-in-tests -- Bridge the production Promise callback to the Effect-based registration service under test.
    register: (record) => Effect.runPromise(register(record)),
  });
  const operationId = "00000000-0000-4000-8000-000000000992";
  const sourceInput = {
    operationId,
    projectId: "source-project",
    folder: root,
    projectRelativePath: relative,
    mode: "copy-and-move" as const,
    destinationEnvironmentId: "destination-env",
  };
  try {
    const offered = await sources.offer(sourceInput);
    await expect(
      sources.offer({ ...sourceInput, folder: NodePath.join(root, relative) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(sources.offer({ ...sourceInput, projectRelativePath: "." })).rejects.toMatchObject(
      { code: "conflict" },
    );
    const input = {
      operationId,
      sourceUrl: served.url,
      token: offered.token,
      sourceEnvironmentId: "source-env",
      sourceProjectId: "source-project",
      sourceMachine: "Mac",
      mode: "copy-and-move" as const,
      targetFolder: NodePath.join(base, "destination"),
      title: "App",
      projectId: "destination-project",
      copyRoot: root,
      projectRelativePath: relative,
    };
    await expect(copies.start({ ...input, projectRelativePath: "." })).rejects.toMatchObject({
      code: "refused",
    });
    await copies.start(input);
    const settle = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        await copies.waitFor(operationId);
        const current = await copies.read(operationId);
        if (current && ["previewed", "applied", "failed"].includes(current.state)) return current;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Copy did not settle");
    };
    expect((await settle()).state).toBe("previewed");
    await copies.approve(operationId);
    const applied = await settle();
    expect(applied).toMatchObject({
      state: "applied",
      committed: true,
      projectId: "destination-project",
      copyRoot: root,
      projectRelativePath: relative,
    });
    expect(registrations).toEqual([NodePath.join(input.targetFolder, relative)]);
    expect(
      NodeFS.readFileSync(NodePath.join(input.targetFolder, "sibling-notes.txt"), "utf8"),
    ).toBe("unfinished sibling work\n");
    await expect(
      copies.start({ ...input, targetFolder: NodePath.join(base, "other") }),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(copies.start({ ...input, projectRelativePath: "." })).rejects.toMatchObject({
      code: "refused",
    });
    await expect(
      copies.start({ ...input, sourceProjectId: "different-project" }),
    ).rejects.toMatchObject({ code: "refused" });
    expect((await copies.start(input)).projectId).toBe("destination-project");
    expect(registrations).toHaveLength(1);
    // A restarted Apply/registration must not trust an operation record whose
    // scope no longer agrees with the durable, source-attested manifest.
    const recordFile = NodePath.join(
      base,
      "destination-state",
      "folder-copies",
      operationId,
      "operation.json",
    );
    for (const failedStep of ["applying", "applied"] as const) {
      NodeFS.writeFileSync(
        recordFile,
        JSON.stringify({
          ...applied,
          state: "failed",
          failedStep,
          projectRelativePath: ".",
          projectId: null,
        }),
      );
      await copies.retry(operationId);
      expect(await settle()).toMatchObject({
        state: "failed",
        error: { code: "refused", message: expect.stringContaining("copy scope") },
      });
      expect(registrations).toHaveLength(1);
      expect(
        NodeFS.readFileSync(NodePath.join(input.targetFolder, relative, "app.txt"), "utf8"),
      ).toBe("uncommitted app\n");
    }
  } finally {
    await copies.close();
    await served.close();
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
