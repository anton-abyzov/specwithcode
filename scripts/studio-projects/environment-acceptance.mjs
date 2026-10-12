import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ownedConnectionFixtureSource = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owned-acceptance', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'read_fixture', description: 'Read owned synthetic data', inputSchema: { type: 'object', properties: {} } }] };
  else if (message.method === 'ping') result = {};
  else return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No external calls' } }) + '\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`;

/** Actual isolated server operations; the only executable configured is this owned inert fixture. */
export async function verifyPersonalEnvironment({
  step,
  required,
  optional,
  settings,
  mutate,
  scope,
  stateDir,
  fakeHome,
  openProject,
  page,
  screenshot,
}) {
  let personal;
  let environment;
  await step("personal-project-without-git-or-provider", async () => {
    const created = await required("projects.createNew", {
      name: "Acceptance Personal",
      kind: "personal",
    });
    scope.projectIds.add(created.projectId);
    personal = { id: created.projectId, title: "Acceptance Personal", dir: created.workspaceRoot };
    assert.equal(
      (await required("projects.workspaceRead", { projectId: personal.id })).settings.kind,
      "personal",
    );
    assert.ok(!existsSync(join(personal.dir, ".git")));
    assert.equal(created.commitError, undefined);
    await required("projects.memoryWrite", {
      projectId: personal.id,
      name: "MEMORY.md",
      content: "Synthetic personal preference",
      expectedRevision: null,
    });
  });
  await step("combined-folders-and-multiple-repositories-with-durable-match", async () => {
    const additionalPath = join(stateDir, "approved-personal-folder");
    mkdirSync(additionalPath);
    const additional = realpathSync(additionalPath);
    writeFileSync(join(additional, "preserve.txt"), "Owned fixture must survive\n");
    const repositories = ["notes", "planning"].map((id) => ({
      id,
      url: `https://github.com/acceptance-fixture/${id}`,
      localPath: join(personal.dir, id),
    }));
    for (const repo of repositories) {
      mkdirSync(repo.localPath);
      for (const args of [
        ["init", "-b", "main"],
        ["remote", "add", "origin", repo.url],
      ])
        execFileSync("/usr/bin/git", args, {
          cwd: repo.localPath,
          stdio: "ignore",
          env: { HOME: fakeHome, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
        });
    }
    await settings(personal, { environment: { additionalFolders: [additional], repositories } });
    environment = await required("projects.environmentRead", { projectId: personal.id });
    assert.equal(environment.repositories.length, 2);
    assert.equal(environment.workspaceRoot, realpathSync(personal.dir));
    assert.deepEqual(environment.additionalFolders, [additional]);
    const request = {
      projectId: personal.id,
      repositoryId: "notes",
      expectedRevision: environment.revision,
      commandId: randomUUID(),
      mode: "match",
    };
    const prepared = await required("projects.environmentPrepare", request);
    assert.equal(prepared.repositories.find((r) => r.id === "notes").status, "ready");
    assert.deepEqual(await required("projects.environmentPrepare", request), prepared);
    assert.equal(
      readFileSync(join(additional, "preserve.txt"), "utf8"),
      "Owned fixture must survive\n",
    );
    assert.equal(
      (await required("projects.workspaceRead", { projectId: personal.id })).settings.kind,
      "personal",
    );
  });
  await step("project-connections-discovery-grants-revoke-and-visible-settings", async () => {
    const fixture = join(stateDir, "owned-connection.cjs");
    writeFileSync(fixture, ownedConnectionFixtureSource);
    scope.connectionCommand = process.execPath;
    scope.connectionArgs = [fixture];
    const config = {
      name: "Acceptance tools",
      command: process.execPath,
      args: [fixture],
      envKeys: [],
    };
    const saved = await required("projects.connectionSave", {
      projectId: personal.id,
      id: "owned-tools",
      expectedRevision: null,
      config,
      allowedTools: [],
    });
    assert.equal(saved.status, "configured");
    const checked = await required("projects.connectionCheck", {
      projectId: personal.id,
      id: saved.id,
      expectedRevision: saved.revision,
    });
    assert.equal(checked.status, "ready");
    assert.deepEqual(checked.allowedTools, []);
    assert.equal(checked.tools[0].name, "read_fixture");
    const granted = await required("projects.connectionSave", {
      projectId: personal.id,
      id: saved.id,
      expectedRevision: checked.revision,
      config,
      allowedTools: ["read_fixture"],
    });
    assert.deepEqual(granted.allowedTools, ["read_fixture"]);
    await openProject(personal);
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("navigation", { name: "Project settings sections" })
      .getByRole("button", { name: "Environment", exact: true })
      .click();
    await dialog.getByRole("heading", { name: "Connections", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Acceptance tools · ready", exact: true }).click();
    assert.equal(await dialog.getByRole("checkbox", { name: /read_fixture/ }).isChecked(), true);
    for (const repo of environment.repositories)
      assert.equal(
        await dialog.getByLabel(`Checkout path for ${repo.url}`).inputValue(),
        repo.localPath,
      );
    await screenshot("personal-project-environment-connections");
    await dialog.getByRole("button", { name: "Revoke connection", exact: true }).click();
    await dialog.getByRole("button", { name: "Acceptance tools · revoked", exact: true }).waitFor();
    const final = (await required("projects.connectionsRead", { projectId: personal.id }))
      .connections[0];
    assert.equal(final.status, "revoked");
    assert.deepEqual(final.allowedTools, []);
    assert.equal(
      (
        await optional("projects.connectionCheck", {
          projectId: personal.id,
          id: final.id,
          expectedRevision: final.revision,
        })
      ).code,
      "denied",
    );
    await page.keyboard.press("Escape");
    await mutate(personal, "project.delete", { force: true, confirmationTitle: personal.title });
    assert.equal(
      (await optional("projects.connectionsRead", { projectId: personal.id })).code,
      "not_found",
    );
    assert.ok(existsSync(personal.dir));
  });
}
