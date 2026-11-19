// End to end of the first feature guide (1398 T-08, AC-22, AC-25) against a server run from source
// in a new private home, with a fake agent and a fake `specweave`. Nothing reaches a model, the
// network, a live store or a credential folder.
//
// It drives the RPCs the guide's presses call, in a person's order: the offer is there
// (`firstFeatureSample`), the sample is made and stamped as the sample with its guide started,
// step 1 turns SpecWeave on, step 2 sends AC-22's request to the coordinator, and the fake agent,
// working in the folder the coordinator's session was given, writes the feature with a review from
// a second family. The card reaches Done with that review listed (what step 3 shows), the guide is
// stored as finished, and the offer is gone (`firstFeatureFinished`), also after removal.
//
// What it does not walk, and where that is proven instead: the card arrives already closed, so
// step 2's Planning, Working, In review and Fixing lines are the guide's unit tests and fixture
// (PR 641); no real `specweave verify` or `complete` runs; and step 3's "open the review" press and
// the guide storing finished on its own are the host tests. Here the run marks finished itself.
//
//   node scripts/studio-projects/first-feature.mjs [out-dir]
//   node scripts/studio-projects/first-feature.mjs --fake-agent   (what the server runs)
import * as NodeAssert from "node:assert/strict";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const SCRIPT = NodeURL.fileURLToPath(import.meta.url);
const ROOT = NodePath.resolve(NodePath.dirname(SCRIPT), "../..");

/** AC-22's request, word for word; the test checks it against the guide's own constant. */
export const FIRST_FEATURE_REQUEST =
  "Build a dark mode switch for this page as a new increment with no Review section: plan it, do every task, then verify, review and close it.";
export const FEATURE_ID = "0001-dark-mode-switch";
/** The review the fake records: a second family (Meta) on work a Claude-family author did. */
export const REVIEW_HEADER =
  "reviewer=muse-wonder-full-1.0 model=muse-wonder-full-1.0 family=meta author=claude";

/** The feature as an agent leaves it: planned, every task done, verified, reviewed, closed. */
export function writeFeatureIncrement(projectRoot, at = new Date().toISOString()) {
  const folder = NodePath.join(projectRoot, ".specweave", "increments", FEATURE_ID);
  NodeFS.mkdirSync(NodePath.join(folder, "reports", "reviews"), { recursive: true });
  const tasks = ["Add the switch", "Add the dark colours"];
  NodeFS.writeFileSync(
    NodePath.join(folder, "spec.md"),
    [
      "# Dark mode switch",
      "",
      "## Tasks",
      "",
      ...tasks.map(
        (title, index) =>
          `### T-0${index + 1} ${title}\n- AC: AC-01 | Files: index.html | Test: npm test\n`,
      ),
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(folder, "ledger.jsonl"),
    tasks
      .map((_, index) => JSON.stringify({ t: `T-0${index + 1}`, e: "done", by: "claude@e2e", at }))
      .join("\n") + "\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(folder, "reports", "reviews", "review-muse-wonder-full-1.0-1.md"),
    `<!-- specweave review: ${REVIEW_HEADER} at=${at} -->\n# Review: dark mode switch\nVerdict: ship\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(folder, "metadata.json"),
    JSON.stringify({ id: FEATURE_ID, status: "completed", title: "Dark mode switch", updated: at }),
  );
  return folder;
}

/** A `specweave` that does what `specweave init --quick` leaves behind, offline. */
export function fakeSpecweaveSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
if (process.argv[2] !== "init") process.exit(0);
fs.mkdirSync(path.join(process.cwd(), ".specweave", "increments"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), ".specweave", "config.json"), JSON.stringify({ version: "3" }) + "\\n");
`;
}

// ── The fake agent (ACP over stdio) ─────────────────────────────────────────────────────────

function fakeAgent() {
  const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const models = {
    availableModels: [{ modelId: "default", name: "Fake first feature" }],
    currentModelId: "default",
  };
  const cwds = new Map();
  const sessionLog = process.env.FIRST_FEATURE_E2E_SESSIONS;
  let sessions = 0;
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params = {} } = message;
    if (method === undefined) return;
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: {},
            mcpCapabilities: { http: false, sse: false },
          },
          authMethods: [],
          agentInfo: { name: "first-feature-e2e", version: "0.0.0" },
        },
      });
    if (method === "session/new") {
      const sessionId = `first-feature-${process.pid}-${++sessions}`;
      cwds.set(sessionId, params.cwd ?? process.cwd());
      // The script reads where the server put each session.
      if (sessionLog)
        NodeFS.appendFileSync(
          sessionLog,
          `${JSON.stringify({ sessionId, cwd: params.cwd ?? null })}\n`,
        );
      return send({ id, result: { sessionId, models } });
    }
    if (method.startsWith("session/set_") || method === "authenticate")
      return send({ id, result: {} });
    if (method === "session/prompt") {
      const text = (params.prompt ?? []).map((part) => part.text ?? "").join(" ");
      let reply = "Fake agent: nothing to do.";
      if (text.includes(FIRST_FEATURE_REQUEST)) {
        // Where a real agent writes: the folder its session was given. If the server sent the
        // coordinator somewhere the Board does not read, the card never shows and the run fails.
        writeFeatureIncrement(cwds.get(params.sessionId));
        reply = `Planned, built, verified, reviewed and closed ${FEATURE_ID}.`;
      }
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
        },
      });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    if (method === "session/cancel") return;
    if (id !== undefined)
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  });
  process.stdin.on("end", () => process.exit(0));
}

// ── The run ───────────────────────────────────────────────────────────────────────────────

const freePort = () =>
  new Promise((done, reject) => {
    const socket = NodeNet.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => done(port));
    });
  });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, read, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (last.ok) return last.value;
    await delay(500);
  }
  throw new Error(
    `${what}: not reached in ${timeoutMs} ms (${JSON.stringify(last?.seen ?? null).slice(0, 400)})`,
  );
}

/** One RPC over the app's WebSocket, with a ticket from the signed-in session. */
async function rpc(session, tag, payload = {}) {
  const ticket = await fetch(`${session.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Origin: session.origin, Cookie: session.cookie },
  });
  NodeAssert.equal(ticket.status, 200, "ticket exchange failed");
  const url = new URL(session.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", (await ticket.json()).ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${tag}: timed out`));
    }, 30_000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("error", () => reject(new Error(`${tag}: transport failed`)));
    ws.addEventListener("message", (event) => {
      for (const item of [JSON.parse(event.data)].flat()) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        clearTimeout(timer);
        ws.close();
        if (item.exit?._tag === "Success") resolve(item.exit.value);
        else reject(new Error(`${tag} failed: ${JSON.stringify(item.exit).slice(0, 400)}`));
      }
    });
  });
}

export async function runFirstFeature(out) {
  const home = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "first-feature-e2e-"),
  );
  const state = NodePath.join(home, "state");
  const bin = NodePath.join(home, ".local", "bin");
  for (const dir of [
    NodePath.join(state, "userdata"),
    bin,
    NodePath.join(home, "tmp"),
    NodePath.join(home, "Projects"),
  ])
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(bin, "specweave"), fakeSpecweaveSource(), { mode: 0o755 });
  const sessions = NodePath.join(home, "agent-sessions.jsonl");
  const fixture = { instanceId: "fixture", model: "default" };
  const natives = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
  NodeFS.writeFileSync(
    NodePath.join(state, "userdata", "settings.json"),
    JSON.stringify({
      defaultModelSelection: fixture,
      textGenerationModelSelection: fixture,
      providers: Object.fromEntries(natives.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        ...Object.fromEntries(
          natives.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        fixture: {
          driver: "acpRegistry",
          enabled: true,
          displayName: "First feature e2e",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [SCRIPT, "--fake-agent"],
            customModels: ["default"],
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    HOME: home,
    USER: "first-feature-e2e",
    LOGNAME: "first-feature-e2e",
    TMPDIR: NodePath.join(home, "tmp"),
    PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(NodePath.delimiter),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "First feature e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "First feature e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    STUDIO_DISABLE_AUTO_UPDATE: "true",
    FIRST_FEATURE_E2E_SESSIONS: sessions,
  };
  const receipt = { home, origin, steps: [] };
  const step = (name, data = {}) => {
    receipt.steps.push({ name, ...data });
    console.log(`first-feature: ${name}`);
  };
  const server = NodeChild.spawn(
    process.execPath,
    [
      NodePath.join(ROOT, "apps/server/src/bin.ts"),
      "serve",
      "--no-browser",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      state,
    ],
    { cwd: state, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  try {
    const credential = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("server start timed out")), 90_000);
      const read = (chunk) => {
        log += chunk.toString();
        const match = log.match(/(?:^|\n)Token: (\S+)/);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      };
      server.stdout.on("data", read);
      server.stderr.on("data", read);
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}`));
      });
    });
    const signIn = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    NodeAssert.equal(signIn.status, 200, "sign-in failed");
    const session = {
      origin,
      cookie: signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };

    // The offer: the server says it can make the sample, and no guide has finished.
    const ready = await until("the fake agent is ready", async () => {
      const config = await rpc(session, "server.getConfig");
      const provider = config.providers.find((entry) => entry.instanceId === "fixture");
      return { ok: provider?.status === "ready", value: config, seen: provider?.status };
    });
    NodeAssert.equal(ready.firstFeatureSample, true, "the server offers the sample");
    NodeAssert.notEqual(ready.firstFeatureFinished, true, "no guide has finished yet");
    step("offer");

    const made = await rpc(session, "projects.createNew", {
      name: "First feature",
      sample: "first-feature",
    });
    const projectId = made.projectId;
    const read = () => rpc(session, "projects.workspaceRead", { projectId });
    const projectRoot = made.workspaceRoot;
    NodeAssert.ok(projectRoot, "the sample has a folder");
    NodeAssert.equal(made.sampleAutoReviewError, undefined, "the sample's own review is off");
    const fresh = await read();
    NodeAssert.equal(
      fresh.settings.sample,
      "first-feature",
      "the project is stamped as the sample",
    );
    NodeAssert.ok(fresh.settings.firstFeatureGuide?.started, "the guide is stored as started");
    NodeAssert.equal(fresh.settings.firstFeatureGuide?.ended, undefined, "the guide is running");
    const override = (await rpc(session, "server.getConfig")).settings.projectSettingsOverrides?.[
      projectId
    ];
    NodeAssert.equal(
      override?.adversarialReview?.autoOnFeatureComplete,
      false,
      "the sample's automatic review is off on record",
    );
    // Neither the create result nor the workspace read carries the title; a fresh home has no
    // other sample, so the name is not numbered. A wrong title fails the removal below.
    const title = "First feature";
    step("sample made", { projectId, guide: fresh.settings.firstFeatureGuide });

    // Step 1: Turn SpecWeave on.
    await rpc(session, "projects.specweaveSetUp", { projectId });
    await until("SpecWeave is on", async () => {
      const snapshot = await read();
      return {
        ok: snapshot.specweaveState === "on" || snapshot.specweave === true,
        seen: snapshot.specweaveState,
      };
    });
    step("step 1: SpecWeave on");

    // Step 2: Ask for it whole, in one request.
    await rpc(session, "projects.coordinatorStart", {
      projectId,
      commandId: "first-feature-start",
    });
    await rpc(session, "projects.coordinatorSend", {
      projectId,
      commandId: "first-feature-ask",
      prompt: FIRST_FEATURE_REQUEST,
    });
    const card = await until(
      "the card is in Done with its review",
      async () => {
        const board = await rpc(session, "projects.board", { projectId });
        const found = board.cards.find((entry) => entry.incrementId === FEATURE_ID);
        return {
          ok: found?.column === "done" && (found.reviews?.length ?? 0) > 0,
          value: found,
          seen: found ?? board.cards.length,
        };
      },
      120_000,
    );
    // The coordinator's session ran in the sample's own folder.
    const cwdsSeen = NodeFS.readFileSync(sessions, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).cwd);
    NodeAssert.ok(
      cwdsSeen.some((cwd) => cwd && NodeFS.realpathSync(cwd) === NodeFS.realpathSync(projectRoot)),
      `a session ran in the sample's folder: ${JSON.stringify(cwdsSeen)}`,
    );
    step("step 2: card in Done", { sessionCwds: cwdsSeen });

    // Step 3: Read the review. The guide lists what the board records.
    NodeAssert.deepEqual(
      card.reviews.map((entry) => [entry.model, entry.family, entry.author, entry.verdict]),
      [["muse-wonder-full-1.0", "meta", "claude", "ship"]],
    );
    step("step 3: review listed", { reviews: card.reviews });

    // The end: stored as finished, and the offer is gone for good, removed sample included.
    await rpc(session, "projects.firstFeatureGuide", { projectId, mark: "finished" });
    NodeAssert.equal(
      (await rpc(session, "server.getConfig")).firstFeatureFinished,
      true,
      "the offer is gone",
    );
    // As the guide's Remove does; the coordinator's turn may still be settling.
    let attempt = 0;
    await until("the sample is removed", async () => {
      attempt += 1;
      try {
        await rpc(session, "projects.mutate", {
          type: "project.delete",
          commandId: `first-feature-remove-${attempt}`,
          projectId,
          force: true,
          confirmationTitle: title,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, seen: String(error.message).slice(0, 200) };
      }
    });
    NodeAssert.equal(
      (await rpc(session, "server.getConfig")).firstFeatureFinished,
      true,
      "still gone after the sample is removed",
    );
    NodeAssert.ok(NodeFS.existsSync(projectRoot), "the sample's folder stays on disk");
    step("finished, offer gone, sample removed");
    receipt.ok = true;
    return receipt;
  } catch (error) {
    receipt.ok = false;
    receipt.error = String(error?.message ?? error);
    receipt.serverLogTail = log
      .replace(/Token: \S+/g, "Token: <withheld>")
      .split("\n")
      .slice(-40)
      .join("\n");
    throw error;
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((done) => server.once("exit", done)), delay(10_000)]);
      if (server.exitCode === null) {
        server.kill("SIGKILL");
        await Promise.race([new Promise((done) => server.once("exit", done)), delay(5_000)]);
      }
    }
    if (out) {
      NodeFS.mkdirSync(out, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(out, "first-feature-e2e.json"),
        JSON.stringify(receipt, null, 2),
      );
    }
    // The private home goes either way; the receipt keeps what failed.
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] === SCRIPT) {
  if (process.argv[2] === "--fake-agent") fakeAgent();
  else
    await runFirstFeature(process.argv[2] ? NodePath.resolve(process.argv[2]) : undefined).then(
      () => console.log("first-feature: passed"),
      (error) => {
        console.error(`first-feature: failed: ${error.message}`);
        process.exitCode = 1;
      },
    );
}
