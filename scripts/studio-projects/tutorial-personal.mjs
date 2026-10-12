// Actual UI actions against an owned synthetic store; no external account or provider calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export function inertMcpSource() {
  return String.raw`const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
let result;
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'owned-tutorial',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'read_synthetic_note',description:'Owned synthetic tutorial data only',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='ping')result={};
else return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Discovery fixture only; no external calls'}})+'\n');
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});`;
}
export function createPersonalFixture(project, stateDir) {
  assert(!fs.existsSync(path.join(project.dir, ".git")), "Personal storage must start without Git");
  const additional = path.join(stateDir, "reference-notes"),
    checkout = path.join(project.dir, "tutorial-notes");
  fs.mkdirSync(additional);
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(additional, "note.txt"), "Owned synthetic reference note.\n");
  const repositoryUrl = "https://github.com/example/tutorial-notes.git";
  for (const args of [
    ["init", "-b", "main"],
    ["remote", "add", "origin", repositoryUrl],
  ]) {
    execFileSync("/usr/bin/git", args, {
      cwd: checkout,
      stdio: "ignore",
      env: {
        HOME: path.join(stateDir, "home"),
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  }
  const mcp = path.join(stateDir, "owned-discovery.cjs");
  fs.writeFileSync(mcp, inertMcpSource());
  return {
    additional: fs.realpathSync(additional),
    checkout: fs.realpathSync(checkout),
    repositoryUrl,
    mcp: fs.realpathSync(mcp),
  };
}
export async function capturePersonalEnvironment({
  project,
  fixture,
  open,
  page,
  beat,
  button,
  dialog,
  section,
  required,
  waitForRead,
}) {
  await beat(
    "personal",
    "This Personal project uses app-managed storage and starts without a Git repository.",
    () => open(project),
  );
  await beat(
    "shared-memory",
    "Personal projects keep the same project-specific memory, routines and usage views.",
    async () => {
      await button(page, "Project settings").click();
      await section("Memory");
      await dialog()
        .getByRole("button", { name: /^MEMORY\.md\s/ })
        .click();
    },
  );
  await beat(
    "environment",
    "Its execution device owns the storage. Extra folders and repositories are optional.",
    async () => {
      await section("Environment");
      await dialog().getByText("Managed project storage", { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        (await required("projects.workspaceRead", { projectId: project.id })).settings.kind,
        "personal",
      );
    },
  );
  await beat(
    "folder",
    "Add an existing synthetic folder and save its access grant. This does not move the folder.",
    async () => {
      await dialog().getByLabel("Folder path", { exact: true }).fill(fixture.additional);
      await button(dialog(), "Add folder").click();
      await button(dialog(), "Save changes").click();
      await waitForRead(
        () => required("projects.environmentRead", { projectId: project.id }),
        (value) => value.additionalFolders.includes(fixture.additional),
      );
      await dialog().getByText(fixture.additional, { exact: true }).scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "repository",
    "A repository URL can coexist with that folder. Associate the owned local checkout before saving.",
    async () => {
      await dialog().getByLabel("Repository URL", { exact: true }).fill(fixture.repositoryUrl);
      await button(dialog(), "Add URL").click();
      await dialog()
        .getByLabel(`Checkout path for ${fixture.repositoryUrl}`)
        .fill(fixture.checkout);
      await button(dialog(), "Save changes").click();
      await waitForRead(
        () => required("projects.environmentRead", { projectId: project.id }),
        (value) =>
          value.repositories.some(
            (repo) => repo.url === fixture.repositoryUrl && repo.localPath === fixture.checkout,
          ),
      );
      await button(dialog(), "Match existing checkout").scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "match",
    "Match checks the checkout's actual remote identity. This walkthrough performs no network clone.",
    async () => {
      await button(dialog(), "Match existing checkout").click();
      await waitForRead(
        () => required("projects.environmentRead", { projectId: project.id }),
        (value) =>
          value.repositories.some(
            (repo) => repo.url === fixture.repositoryUrl && repo.status === "ready",
          ),
      );
      await dialog().getByText("Checkout: ready", { exact: true }).waitFor();
    },
  );
  await beat(
    "connection-save",
    "Save a local MCP command separately. This example is an owned, inert discovery fixture.",
    async () => {
      await dialog().getByLabel("Connection name", { exact: true }).fill("Synthetic note tools");
      await dialog().getByLabel("Executable command", { exact: true }).fill("node");
      await dialog().getByLabel("Arguments (one per line)", { exact: true }).fill(fixture.mcp);
      await button(dialog(), "Save connection").click();
      const result = await waitForRead(
        () => required("projects.connectionsRead", { projectId: project.id }),
        (value) => value.connections.length === 1,
      );
      assert.equal(result.connections[0].status, "configured");
      assert.equal(result.connections[0].checkedAt, null);
      assert.deepEqual(result.connections[0].allowedTools, []);
      await button(dialog(), "Check and discover tools").scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "discovery",
    "Check discovers MCP tools. It does not verify a Gmail, Calendar or other external service account.",
    async () => {
      await button(dialog(), "Check and discover tools").click();
      const result = await waitForRead(
        () => required("projects.connectionsRead", { projectId: project.id }),
        (value) => value.connections[0]?.status === "ready",
      );
      assert.deepEqual(
        result.connections[0].tools.map((tool) => tool.name),
        ["read_synthetic_note"],
      );
      assert.deepEqual(result.connections[0].allowedTools, []);
      await dialog()
        .getByRole("checkbox", { name: /read_synthetic_note/ })
        .scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "grants",
    "Choose and save exactly the tools this project may use. Calls still follow Studio's approval rules.",
    async () => {
      await dialog()
        .getByRole("checkbox", { name: /read_synthetic_note/ })
        .check();
      await button(dialog(), "Save connection").click();
      await waitForRead(
        () => required("projects.connectionsRead", { projectId: project.id }),
        (value) => value.connections[0]?.allowedTools.join() === "read_synthetic_note",
      );
      await button(dialog(), "Revoke connection").scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "revoke",
    "Revoke removes future access. Restoring requires a new discovery check and fresh tool grants.",
    async () => {
      await button(dialog(), "Revoke connection").click();
      const result = await waitForRead(
        () => required("projects.connectionsRead", { projectId: project.id }),
        (value) => value.connections[0]?.status === "revoked",
      );
      assert.deepEqual(result.connections[0].allowedTools, []);
      await button(dialog(), "Restore configuration").scrollIntoViewIfNeeded();
    },
  );
  await beat(
    "boundaries",
    "The command runs as the device's user. No external account or AI provider was contacted in this walkthrough.",
    async () => {
      await dialog()
        .getByText(
          "The executable runs as the signed-in user on the selected machine. Tool grants are not an operating-system sandbox.",
          { exact: true },
        )
        .scrollIntoViewIfNeeded();
      assert(!fs.existsSync(path.join(project.dir, ".git")));
    },
    8,
  );
  return {
    managedStorage: true,
    noGit: true,
    repositoryMatch: "passed",
    connectionDiscovery: "owned-inert-mcp",
    externalAccountAuthentication: "not_tested",
    toolInvocation: "not_requested",
  };
}
