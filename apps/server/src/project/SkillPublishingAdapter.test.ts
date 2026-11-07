import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import type { SkillPublication } from "@specweave-studio/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as Adapter from "./SkillPublishingAdapter.ts";
import {
  SkillPublishingAdapter,
  SkillPublishingError,
  skillContentHash,
} from "./SkillPublishingService.ts";

const publication: SkillPublication = {
  repository: "example/skills",
  visibility: "public",
  state: "published",
  version: "1.0.0",
  contentHash: "hash",
  skillId: "example/skills/weekly-notes",
  skillPath: "skills/1.0.0/weekly-notes/SKILL.md",
};
function harness(
  respond: (url: string) => Response,
  existingDirectory = false,
  files: Record<string, string> = {},
  linkPath?: string,
) {
  const requests: string[] = [];
  const commands: string[] = [];
  const http = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url)));
  });
  const noop = FileSystem.makeNoop({});
  const fs = FileSystem.makeNoop({
    readFileString: (file) =>
      file in files
        ? Effect.succeed(files[file]!)
        : file.endsWith("keys.env")
          ? Effect.succeed("")
          : noop.readFileString(file),
    readLink: (file) =>
      file === linkPath ? Effect.succeed("/outside/missing") : noop.readLink(file),
    exists: (file) =>
      Effect.succeed(
        file in files ||
          file === "/scratch" ||
          (existingDirectory && file.endsWith("weekly-notes")),
      ),
    realPath: (file) => Effect.succeed(file),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(FileSystem.FileSystem, fs),
    NodePath.layerPosix,
    Layer.succeed(HostProcessEnvironment, {}),
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          commands.push(input.command);
          return {
            stdout: "fake-github-credential",
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
  );
  const run = <A>(
    f: (adapter: SkillPublishingAdapter["Service"]) => Effect.Effect<A, SkillPublishingError>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* SkillPublishingAdapter);
      }).pipe(Effect.provide(Adapter.layer.pipe(Layer.provide(dependencies)))),
    );
  return { run, requests, commands };
}
describe("publishing external boundaries", () => {
  it("refuses a private repository in public mode without submission", async () => {
    const f = harness(() => Response.json({ private: true }));
    await expect(
      f.run((a) => a.prepare({ repository: "example/skills", visibility: "public" })),
    ).rejects.toThrow("visibility");
    expect(f.requests).toEqual(["https://api.github.com/repos/example/skills"]);
  });
  it("refuses private publication without an authenticated account", async () => {
    const f = harness(() => Response.json({ private: true }));
    await expect(
      f.run((a) =>
        a.prepare({ repository: "example/skills", visibility: "private", tenant: "example" }),
      ),
    ).rejects.toThrow("vskill auth login");
    expect(f.requests).toHaveLength(1);
  });
  it("never accepts an existing immutable version with different content", async () => {
    const f = harness((url) =>
      url.endsWith("SKILL.md")
        ? Response.json({ content: Buffer.from("different").toString("base64") })
        : Response.json([{ name: "SKILL.md", type: "file" }]),
    );
    await expect(f.run((a) => a.upload(publication, "draft"))).rejects.toThrow("different content");
    expect(f.requests).toHaveLength(2);
  });
  it("requires the exact published hash", async () => {
    const f = harness(() =>
      Response.json({ versions: [{ version: "1.0.0", contentHash: "other" }] }),
    );
    await expect(f.run((a) => a.verify(publication))).rejects.toThrow("does not match");
  });
  it("does not recover an unknown submission from an unrelated path", async () => {
    const f = harness(() =>
      Response.json({
        submissions: [
          {
            id: "wrong",
            repoUrl: "https://github.com/example/skills",
            skillName: "weekly-notes",
            skillPath: "SKILL.md",
          },
        ],
      }),
    );
    await expect(f.run((a) => a.status(publication))).rejects.toThrow("not yet identifiable");
    expect(f.requests).toHaveLength(2);
  });
  it("previews only the selected scope and refuses a stale apply without running an installer", async () => {
    const f = harness(() => Response.json({}));
    const request = { scope: "project" as const, agents: ["codex"], instanceIds: [] };
    const preview = await f.run((a) => a.apply(publication, "/scratch", request, true));
    expect(preview.files).toEqual([
      "/scratch/.agents/skills/weekly-notes/SKILL.md",
      "/scratch/vskill.lock",
    ]);
    expect(preview.ready).toBe(false);
    await expect(
      f.run((a) => a.apply(publication, "/scratch", { ...request, expectedHash: "stale" }, false)),
    ).rejects.toThrow("stale");
    expect(f.commands).toEqual([]);
  });
  it("refuses same-name directories before an install can overwrite files", async () => {
    const f = harness(() => Response.json({}), true);
    await expect(
      f.run((a) =>
        a.apply(
          publication,
          "/scratch",
          { scope: "project", agents: ["codex"], instanceIds: [] },
          true,
        ),
      ),
    ).rejects.toThrow("already exists");
    expect(f.commands).toEqual([]);
  });
  it("recognizes a successful install after the response is lost without running the installer", async () => {
    const content = "reviewed skill";
    const exact = { ...publication, contentHash: skillContentHash(content) };
    const files = {
      "/scratch/.agents/skills/weekly-notes/SKILL.md": content,
      "/scratch/vskill.lock": JSON.stringify({
        skills: {
          "weekly-notes": {
            version: exact.version,
            sha: exact.contentHash,
            scope: "project",
            sourceRepoUrl: "https://github.com/example/skills",
            sourceSkillPath: exact.skillPath,
          },
        },
      }),
    };
    const f = harness(() => Response.json({}), true, files);
    const result = await f.run((a) =>
      a.apply(
        exact,
        "/scratch",
        {
          scope: "project",
          agents: ["codex"],
          instanceIds: [],
          expectedHash: "original-preview-before-install",
        },
        false,
      ),
    );
    expect(result.installedVersion).toBe("1.0.0");
    expect(result.summary).toContain("Already installed and verified");
    expect(f.commands).toEqual([]);
  });
  it("refuses matching bytes with a different lock provenance", async () => {
    const content = "reviewed skill";
    const exact = { ...publication, contentHash: skillContentHash(content) };
    const f = harness(() => Response.json({}), true, {
      "/scratch/.agents/skills/weekly-notes/SKILL.md": content,
      "/scratch/vskill.lock": JSON.stringify({
        skills: {
          "weekly-notes": {
            version: exact.version,
            sha: exact.contentHash,
            scope: "project",
            sourceRepoUrl: "https://github.com/other/skills",
            sourceSkillPath: exact.skillPath,
          },
        },
      }),
    });
    await expect(
      f.run((a) =>
        a.apply(exact, "/scratch", { scope: "project", agents: ["codex"], instanceIds: [] }, false),
      ),
    ).rejects.toThrow("already exists");
    expect(f.commands).toEqual([]);
  });
  it.each(["/scratch/.agents", "/scratch/.agents/skills/weekly-notes", "/scratch/vskill.lock"])(
    "refuses a dangling link at %s before preview",
    async (link) => {
      const f = harness(() => Response.json({}), false, {}, link);
      await expect(
        f.run((a) =>
          a.apply(
            publication,
            "/scratch",
            { scope: "project", agents: ["codex"], instanceIds: [] },
            true,
          ),
        ),
      ).rejects.toThrow("symbolic link");
      expect(f.commands).toEqual([]);
    },
  );
  it("recovers a summary by fetching its exact skill path", async () => {
    const f = harness((url) =>
      url.includes("?mine=")
        ? Response.json({
            submissions: [
              {
                id: "sub1",
                repoUrl: "https://github.com/example/skills",
                skillName: "weekly-notes",
              },
            ],
            total: 1,
          })
        : Response.json({
            id: "sub1",
            repoUrl: "https://github.com/example/skills",
            skillName: "weekly-notes",
            skillPath: publication.skillPath,
            state: "RECEIVED",
          }),
    );
    expect((await f.run((a) => a.status(publication))).id).toBe("sub1");
  });
  it("only declares an unsubmitted publication from a complete nondegraded feed", async () => {
    const complete = harness(() => Response.json({ submissions: [], total: 0 }));
    expect((await complete.run((a) => a.status(publication))).state).toBe("UNSUBMITTED");
    for (const feed of [
      { submissions: [], total: 101 },
      { submissions: [], total: 0, degraded: true },
      { total: 0 },
    ]) {
      const f = harness(() => Response.json(feed));
      await expect(f.run((a) => a.status(publication))).rejects.toThrow("not yet identifiable");
    }
  });
  it("never treats the public account feed as proof of private absence", async () => {
    const f = harness(() => Response.json({ submissions: [], total: 0 }));
    await expect(
      f.run((a) =>
        a.status({ ...publication, visibility: "private", tenant: "example", tenantId: "t1" }),
      ),
    ).rejects.toThrow("Archive this unresolved draft");
    expect(f.requests).toEqual([]);
  });
});
