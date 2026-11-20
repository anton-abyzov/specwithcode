// @effect-diagnostics nodeBuiltinImport:off - temp folders holding stand-in tools and projects.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CREDENTIAL_CATALOG, type CredentialTool } from "./catalog.ts";
import {
  commandWithTool,
  declaresPackage,
  describeTool,
  findTool,
  foldersOutsideProjects,
  hasSignInFile,
  insideProjects,
  locateTool,
  pathFolders,
  projectPackage,
  relativeFolderParts,
  shellWord,
  type ToolMachine,
} from "./tool.ts";

let base: string;
let terminal: string;
let app: string;
let project: string;

const put = async (path: string, text: string, mode = 0o644) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, text, { mode });
  return path;
};
const tool = (folder: string, name: string) =>
  put(NodePath.join(folder, name), "#!/bin/sh\nexit 0\n", 0o755);

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-tool-")),
  );
  terminal = NodePath.join(base, "bin");
  app = NodePath.join(base, "app", "commands");
  project = NodePath.join(base, "project");
  for (const folder of [terminal, app, project]) await NodeFSP.mkdir(folder, { recursive: true });
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const wrangler = CREDENTIAL_CATALOG.find((entry) => entry.id === "cloudflare")!
  .tool as CredentialTool;
const machine = (over: Partial<ToolMachine> = {}): ToolMachine => ({
  platform: "linux",
  home: base,
  folders: [terminal, app],
  terminalFolders: [terminal],
  appFolders: [app],
  projectRoots: [project],
  projectRoot: project,
  xdgConfigHome: null,
  ...over,
});

describe("locateTool", () => {
  it("says terminal, app, project or missing, in that order of preference", async () => {
    await put(
      NodePath.join(project, "package.json"),
      JSON.stringify({ devDependencies: { wrangler: "4" } }),
    );
    expect((await locateTool(machine(), wrangler, ["."])).state).toBe("missing");
    expect((await locateTool(machine(), wrangler, ["."])).project).toEqual({
      folder: project,
      bin: null,
      binReal: null,
      manager: "npm",
    });
    const own = await tool(NodePath.join(project, "node_modules", ".bin"), "wrangler");
    const fromProject = await locateTool(machine(), wrangler, ["."]);
    expect(fromProject).toEqual({
      state: "project",
      found: null,
      project: { folder: project, bin: own, binReal: own, manager: "npm" },
    });
    // Nothing from the source machine about folders: the project's copy is not looked for.
    expect((await locateTool(machine(), wrangler, [])).state).toBe("missing");
    expect((await locateTool(machine({ projectRoot: null }), wrangler, ["."])).state).toBe(
      "missing",
    );
    const inApp = await tool(app, "wrangler");
    expect(await locateTool(machine(), wrangler, ["."])).toEqual({
      state: "app",
      found: { folder: app, path: inApp, real: inApp },
      project: null,
    });
    // A folder that is neither Terminal's nor the app's (a system one) is the machine's own tool.
    expect((await locateTool(machine({ appFolders: [] }), wrangler, ["."])).state).toBe("terminal");
    await tool(terminal, "wrangler");
    expect((await locateTool(machine(), wrangler, ["."])).state).toBe("terminal");
  });

  it("passes over a tool on PATH that is really inside a registered project", async () => {
    const planted = await tool(NodePath.join(project, "bin"), "wrangler");
    await NodeFSP.symlink(planted, NodePath.join(terminal, "wrangler"));
    expect(await findTool("wrangler", [terminal], [project], "linux")).toBeNull();
    expect(await findTool("wrangler", [terminal], [], "linux")).toEqual({
      folder: terminal,
      path: NodePath.join(terminal, "wrangler"),
      real: planted,
    });
    // A name with a folder in it, a file that cannot run and a relative folder are no tool.
    expect(await findTool("../wrangler", [terminal], [], "linux")).toBeNull();
    await put(NodePath.join(app, "gh"), "not a program");
    expect(await findTool("gh", [app], [], "linux")).toBeNull();
    expect(await findTool("wrangler", ["bin"], [], "linux")).toBeNull();
  });
});

describe("projectPackage", () => {
  it("reads only a package.json of its own under the project, whatever the other machine named", async () => {
    await put(NodePath.join(project, "a", "package.json"), JSON.stringify({ name: "a" }));
    await put(
      NodePath.join(project, "b", "package.json"),
      JSON.stringify({ dependencies: { wrangler: "4" } }),
    );
    await put(NodePath.join(project, "yarn.lock"), "");
    const ask = (folders: ReadonlyArray<string>) =>
      projectPackage({ root: project, folders, tool: wrangler, platform: "linux" });
    expect(await ask(["a"])).toBeNull();
    expect(await ask(["a", "b"])).toEqual({
      folder: NodePath.join(project, "b"),
      bin: null,
      binReal: null,
      manager: "yarn",
    });
    expect(await ask(["../b", "/etc", "b/../../b", "C:\\b", "b\u0000"])).toBeNull();
    // A package.json that is a link is not read.
    await NodeFSP.mkdir(NodePath.join(project, "c"));
    await NodeFSP.symlink(
      NodePath.join(project, "b", "package.json"),
      NodePath.join(project, "c", "package.json"),
    );
    expect(await ask(["c"])).toBeNull();
    // A tool with no npm package, a relative root and the top of the disk have no project copy.
    const gcloud = CREDENTIAL_CATALOG.find((entry) => entry.id === "google-cloud")!.tool!;
    expect(
      await projectPackage({ root: project, folders: ["b"], tool: gcloud, platform: "linux" }),
    ).toBeNull();
    expect(
      await projectPackage({ root: "project", folders: ["b"], tool: wrangler, platform: "linux" }),
    ).toBeNull();
    expect(
      await projectPackage({ root: "/", folders: ["."], tool: wrangler, platform: "linux" }),
    ).toBeNull();
  });

  it("prefers the folder that already has the tool over one that only lists it", async () => {
    for (const name of ["first", "second"])
      await put(
        NodePath.join(project, name, "package.json"),
        JSON.stringify({ devDependencies: { wrangler: "4" } }),
      );
    const bin = await tool(NodePath.join(project, "second", "node_modules", ".bin"), "wrangler");
    expect(
      await projectPackage({
        root: project,
        folders: ["first", "second"],
        tool: wrangler,
        platform: "linux",
      }),
    ).toEqual({ folder: NodePath.join(project, "second"), bin, binReal: bin, manager: "npm" });
  });
});

describe("command text", () => {
  it("quotes only what a shell would read", () => {
    expect(shellWord("/Users/me/app")).toBe("/Users/me/app");
    expect(shellWord("/Users/me/My App")).toBe("'/Users/me/My App'");
    expect(shellWord("it's; rm -rf ~")).toBe("'it'\\''s; rm -rf ~'");
    expect(shellWord("$(id)")).toBe("'$(id)'");
    expect(shellWord("")).toBe("''");
  });

  it("swaps the tool's name where it starts a command, and nowhere else", () => {
    expect(commandWithTool("wrangler login", "wrangler", "npx wrangler")).toBe(
      "npx wrangler login",
    );
    expect(commandWithTool("gh auth login && gh auth setup-git", "gh", "/app/gh")).toBe(
      "/app/gh auth login && /app/gh auth setup-git",
    );
    expect(commandWithTool("npm login --scope=npm", "npm", "/a/npm")).toBe(
      "/a/npm login --scope=npm",
    );
    expect(commandWithTool("docker login <registry>", "gh", "/app/gh")).toBe(
      "docker login <registry>",
    );
  });

  it("keeps a PATH's absolute folders, each once", () => {
    expect(pathFolders("/a:/b::./c:d:/a: /e ", "linux")).toEqual(["/a", "/b", "/e"]);
    expect(pathFolders(undefined, "linux")).toEqual([]);
  });

  it("takes a folder under the project, and nothing that could leave it", () => {
    expect(relativeFolderParts(".")).toEqual([]);
    expect(relativeFolderParts("./apps//web/")).toEqual(["apps", "web"]);
    for (const bad of ["", "..", "a/../b", "/a", "\\a", "C:/a", "a\\b", "a\nb", "a\u202eb"])
      expect(relativeFolderParts(bad), JSON.stringify(bad)).toBeNull();
    expect(relativeFolderParts("a".repeat(4097))).toBeNull();
  });

  it("finds a package among a package.json's dependencies of any kind", () => {
    const has = (manifest: unknown) => declaresPackage(JSON.stringify(manifest), "wrangler");
    expect(has({ devDependencies: { wrangler: "^4" } })).toBe(true);
    expect(has({ dependencies: { wrangler: "4" } })).toBe(true);
    expect(has({ optionalDependencies: { wrangler: "4" } })).toBe(true);
    expect(has({ scripts: { deploy: "wrangler deploy" } })).toBe(false);
    expect(has({ devDependencies: { "wrangler-action": "1" } })).toBe(false);
    expect(has({ devDependencies: ["wrangler"] })).toBe(false);
    expect(has({ devDependencies: { toString: "1" } })).toBe(false);
    expect(declaresPackage("{ not json", "wrangler")).toBe(false);
    expect(declaresPackage("[]", "wrangler")).toBe(false);
    expect(declaresPackage(JSON.stringify({ dependencies: {} }), "toString")).toBe(false);
  });
});

describe("folders a project could have put on PATH", () => {
  it("keeps only folders outside every registered project, links followed", async () => {
    const own = NodePath.join(project, "node_modules", ".bin");
    await NodeFSP.mkdir(own, { recursive: true });
    const linked = NodePath.join(base, "linked-bin");
    await NodeFSP.symlink(own, linked);
    expect(
      await foldersOutsideProjects(
        [terminal, own, linked, "relative/bin", app],
        [project],
        "linux",
      ),
    ).toEqual([terminal, app]);
    expect(await insideProjects(NodePath.join(project, "config"), [project], "linux")).toBe(true);
    expect(await insideProjects(NodePath.join(base, "config"), [project], "linux")).toBe(false);
    // macOS folders ignore case; a root stored in another case is the same project.
    expect(await insideProjects(own.toUpperCase(), [project], "darwin")).toBe(true);
  });
});

describe("describeTool", () => {
  const cloudflare = CREDENTIAL_CATALOG.find((entry) => entry.id === "cloudflare")!;

  it("gives no commands at all when one would not fit what the wire allows", async () => {
    const far = `/${"deep/".repeat(1200)}bin`;
    const located = {
      state: "terminal" as const,
      found: { folder: far, path: `${far}/wrangler`, real: `${far}/wrangler` },
      project: null,
    };
    expect(await describeTool(machine({ terminalFolders: [] }), cloudflare, located)).toBeNull();
    // The same tool where Terminal looks needs no folder in its commands, and fits.
    expect(await describeTool(machine({ terminalFolders: [far] }), cloudflare, located)).toEqual(
      expect.objectContaining({ signIn: "wrangler login", check: "wrangler whoami" }),
    );
  });

  it("passes over a project folder whose real name could disguise a command", async () => {
    const odd = NodePath.join(project, "bad\u202Ename");
    await put(
      NodePath.join(odd, "package.json"),
      JSON.stringify({ devDependencies: { wrangler: "4" } }),
    );
    // The hint is a plain name; the link it follows leads to the odd one.
    await NodeFSP.symlink(odd, NodePath.join(project, "plain"));
    expect(
      await projectPackage({
        root: project,
        folders: ["plain"],
        tool: wrangler,
        platform: "linux",
      }),
    ).toBeNull();
  });
});

describe("hasSignInFile", () => {
  it("does not take an SSH config for a key", async () => {
    const home = { home: base, xdgConfigHome: null };
    await put(NodePath.join(base, ".ssh", "config"), "Host github.com\n");
    expect(await hasSignInFile(home, "ssh")).toBe(false);
    await put(NodePath.join(base, ".ssh", "id_ed25519"), "stand-in\n");
    expect(await hasSignInFile(home, "ssh")).toBe(true);
  });
});
