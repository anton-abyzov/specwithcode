// Drives two real SpecWithCode servers over a synthetic linked project, for
// test-protected-tables-after-restart.py. Never real state: every home is a temporary folder the
// caller made.
//
//   node drive.mjs seed <fixture.json> <first home> <second home>
//     Starts each server once on its empty home (its migrations build the database), adds a
//     project, writes the fixture's memory notes and plan through the server's own RPC, stops it,
//     then links the two projects into one logical project (workspace_settings_json, as a link
//     commit leaves it). Prints {first, second}: projectId, environmentId and label of each.
//   node drive.mjs passes <seed.json> <first home> <second home> <seconds>
//     Starts both servers and, for <seconds>, runs what an open app window runs every pass for a
//     linked pair (linkedMemorySync and linkedPlanSync): export from each side, merge into the
//     other. Prints {phase: "idle", passes}, then waits for one line on stdin, passes again until no
//     merge is refused as paused (up to a minute) and prints {phase: "released", pass} before
//     both servers stop.
//
// Environment: STUDIO_SERVER_ENTRYPOINT (default apps/server/src/bin.ts of this checkout; a
// release passes its built bin.mjs), and the caller's node runs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ENTRYPOINT = NodePath.resolve(
  process.env.STUDIO_SERVER_ENTRYPOINT || NodePath.join(HERE, "../../../../apps/server/src/bin.ts"),
);
const PASS_MS = 10_000;
const PROVIDERS = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

function environmentFor(home) {
  const user = NodePath.join(home, "..", "user-home");
  NodeFS.mkdirSync(user, { recursive: true });
  return {
    HOME: user,
    USER: process.env.USER ?? "fixture",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    STUDIO_HOME: home,
    STUDIO_LOG_LEVEL: "Warn",
    STUDIO_ENABLE_HOSTED_SERVICES: "false",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
}

async function start(home) {
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  const settings = NodePath.join(home, "userdata/settings.json");
  try {
    NodeFS.readFileSync(settings);
  } catch {
    NodeFS.writeFileSync(
      settings,
      JSON.stringify({
        providers: Object.fromEntries(PROVIDERS.map((driver) => [driver, { enabled: false }])),
      }),
      { mode: 0o600 },
    );
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = environmentFor(home);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      ENTRYPOINT,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home,
      "--mode",
      "web",
      "--no-browser",
    ],
    { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`server exited during startup (${child.exitCode}): ${stderr}`);
    // Ready once the local CLI session it publishes at startup is accepted (the web root
    // answers 503 without a built web app).
    try {
      const token = NodeFS.readFileSync(
        NodePath.join(home, "userdata/secrets/local-cli-credential.bin"),
        "utf8",
      ).trim();
      const answer = await fetch(origin + "/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(1000),
      });
      if (answer.status === 200) return { home, origin, env, child, token, stderr: () => stderr };
    } catch {}
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("server did not become ready in 120 s");
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  const exited = new Promise((done) => server.child.once("exit", done));
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 30_000);
  await exited;
  clearTimeout(timer);
}

/** One RPC over the server's WebSocket with the local CLI session: {ok, value} or {ok: false, error}. */
async function rpc(server, tag, payload) {
  const issued = await fetch(server.origin + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: "Bearer " + server.token },
  });
  if (issued.status !== 200) throw new Error(`websocket ticket refused: HTTP ${issued.status}`);
  const { ticket } = await issued.json();
  const url = new URL(server.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const ws = new WebSocket(url);
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 30_000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${tag} transport failed`));
      });
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        let items;
        try {
          const value = JSON.parse(event.data);
          items = Array.isArray(value) ? value : [value];
        } catch {
          return;
        }
        for (const item of items) {
          if (item._tag !== "Exit" || item.requestId !== "1") continue;
          clearTimeout(timer);
          if (item.exit._tag === "Success") done({ ok: true, value: item.exit.value });
          else {
            const cause = (item.exit.cause ?? []).find((part) => part._tag === "Fail");
            done({ ok: false, error: cause?.error ?? { _tag: "Defect" } });
          }
        }
      });
    });
  } finally {
    ws.close();
  }
}

async function must(server, tag, payload) {
  const answer = await rpc(server, tag, payload);
  if (!answer.ok) throw new Error(`${tag} failed: ${JSON.stringify(answer.error)}`);
  return answer.value;
}

async function seed(fixturePath, homes) {
  const fixture = JSON.parse(NodeFS.readFileSync(fixturePath, "utf8"));
  const machines = {};
  for (const [name, home] of Object.entries(homes)) {
    const spec = fixture.machines[name];
    const server = await start(home);
    try {
      const folder = NodePath.join(home, "..", "project-" + name);
      NodeFS.mkdirSync(folder, { recursive: true });
      const added = NodeChildProcess.spawnSync(
        process.execPath,
        [ENTRYPOINT, "project", "add", folder, "--base-dir", home],
        { env: server.env, encoding: "utf8", timeout: 60_000 },
      );
      if (added.status !== 0) throw new Error(`project add failed: ${added.stderr}`);
      const projectId = /Added project (\S+)/.exec(added.stdout)?.[1];
      if (!projectId) throw new Error("project add printed no project id");
      for (const [note, content] of Object.entries(spec.memory)) {
        await must(server, "projects.memoryWrite", {
          projectId,
          name: note,
          content,
          expectedRevision: null,
        });
      }
      if (spec.plan)
        await must(server, "projects.planReplace", {
          projectId,
          expectedRevision: 0,
          definition: spec.plan,
        });
      const environmentId = NodeFS.readFileSync(
        NodePath.join(home, "userdata/environment-id"),
        "utf8",
      ).trim();
      machines[name] = { projectId, environmentId, label: "fixture-" + name, folder };
    } finally {
      await stop(server);
    }
  }
  const members = Object.values(machines).map((machine) => ({
    environmentId: machine.environmentId,
    projectId: machine.projectId,
    coordinatorThreadId: "coordinator:" + machine.projectId,
    workspaceRoot: machine.folder,
  }));
  for (const [name, home] of Object.entries(homes)) {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata/statev2.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT workspace_settings_json AS settings FROM projection_projects WHERE project_id = ?",
        )
        .get(machines[name].projectId);
      const settings = row?.settings ? JSON.parse(row.settings) : {};
      settings.logicalProject = {
        ...fixture.logicalProject,
        coordinatorId: members[0].environmentId + ":" + members[0].projectId,
        members,
      };
      db.prepare(
        "UPDATE projection_projects SET workspace_settings_json = ? WHERE project_id = ?",
      ).run(JSON.stringify(settings), machines[name].projectId);
    } finally {
      db.close();
    }
  }
  return machines;
}

/** What an app window's pass does for the pair: memory and plan, each way. */
async function pass(servers, machines) {
  const results = [];
  for (const [from, to] of [
    ["second", "first"],
    ["first", "second"],
  ]) {
    const source = machines[from],
      target = machines[to];
    const peer = {
      environmentId: source.environmentId,
      projectId: source.projectId,
      label: source.label,
    };
    for (const [kind, exportTag, mergeTag] of [
      ["memory", "projectLink.memoryExport", "projectLink.memoryMerge"],
      ["plan", "projectLink.planExport", "projectLink.planMerge"],
    ]) {
      const exported = await rpc(servers[from], exportTag, { projectId: source.projectId });
      const result = { kind, from, to, exported: exported.ok ? true : exported.error };
      if (exported.ok) {
        if (kind === "memory")
          result.exportedFiles = exported.value.files.map((file) => file.name).sort();
        const merged = await rpc(servers[to], mergeTag, {
          projectId: target.projectId,
          peer,
          export: exported.value,
        });
        result.merged = merged.ok ? merged.value : { error: merged.error };
      }
      results.push(result);
    }
  }
  return results;
}

async function passes(seedPath, homes, seconds) {
  const machines = JSON.parse(NodeFS.readFileSync(seedPath, "utf8"));
  const servers = {};
  try {
    for (const [name, home] of Object.entries(homes)) servers[name] = await start(home);
    const began = Date.now(),
      done = [];
    while (Date.now() - began < seconds * 1000) {
      done.push({ at: Date.now() - began, results: await pass(servers, machines) });
      await delay(Math.min(PASS_MS, Math.max(0, seconds * 1000 - (Date.now() - began))));
    }
    process.stdout.write(
      JSON.stringify({ phase: "idle", seconds: (Date.now() - began) / 1000, passes: done }) + "\n",
    );
    await new Promise((resume) => process.stdin.once("data", resume));
    // The server reads the gate on its own poll, so the first passes after it is removed may
    // still be refused: pass again until no merge answers 'paused', for up to a minute.
    let last,
      tries = 0;
    for (; tries < 30; tries += 1) {
      last = await pass(servers, machines);
      if (!last.some((result) => result.merged?.error?.code === "paused")) break;
      await delay(2000);
    }
    process.stdout.write(
      JSON.stringify({ phase: "released", tries: tries + 1, pass: last }) + "\n",
    );
  } finally {
    for (const server of Object.values(servers)) await stop(server);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "seed") {
  const [fixture, first, second] = rest;
  process.stdout.write(
    JSON.stringify(
      await seed(fixture, { first: NodePath.resolve(first), second: NodePath.resolve(second) }),
    ) + "\n",
  );
} else if (command === "passes") {
  const [seedPath, first, second, seconds] = rest;
  await passes(
    seedPath,
    { first: NodePath.resolve(first), second: NodePath.resolve(second) },
    Number(seconds),
  );
} else {
  process.stderr.write(
    "usage: drive.mjs seed <fixture.json> <first home> <second home> | passes <seed.json> <first home> <second home> <seconds>\n",
  );
  process.exit(2);
}
process.exit(0);
