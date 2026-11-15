#!/usr/bin/env node
// Two projects for one repository that were added on their own, one per machine
// (M4, and an older checkout on M5), each with its own goal, memory, thread and
// routine. Links them in the real web client, checks what each machine holds
// after the first memory sync, then brings the older folder up to date with Copy
// to another machine into the existing folder.
//
// Build web and server first. Usage:
//   node scripts/studio-logical-projects/link-existing.mjs /absolute/report/dir
import * as NodeChild from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as h from "../studio-fleet/add-to-machine-live/harness.mjs";

const {
  createProject,
  dialog,
  dump,
  fleetCli,
  git,
  headOf,
  http,
  launchBrowser,
  log,
  makeHost,
  makeOrigin,
  offerAndScan,
  openClient,
  output,
  pollCopy,
  projectsOf,
  receipt,
  save,
  scenario,
  scratch,
  sleep,
  startCopy,
  startProxy,
  entrypoint,
  exchange,
  hostEnv,
  RpcClient,
  state,
  stopServer,
  until,
  write,
} = h;
const { randomUUID } = NodeCrypto;
const { existsSync, mkdirSync, readFileSync, rmSync } = NodeFS;
const { dirname, join } = NodePath;

// The harness's startServer, plus the Tailscale HTTPS port invitations are published on.
async function startServer(host) {
  const child = NodeChild.spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(host.port),
      "--base-dir",
      host.data,
      "--no-browser",
      "--tailscale-serve-port",
      String(host.proxyPort),
    ],
    { cwd: host.dir, env: hostEnv(host), stdio: ["ignore", "pipe", "pipe"] },
  );
  host.child = child;
  receipt.pids.push({ label: host.label, pid: child.pid });
  const logFile = join(output, `server-${host.label.toLowerCase()}.log`);
  const token = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`${host.label} startup timeout`)), 60_000);
    const inspect = (chunk) => {
      const text = chunk.toString();
      NodeFS.writeFileSync(logFile, text.replace(/(Token: |token=)\S+/g, "$1<redacted>"), {
        flag: "a",
      });
      buffer = (buffer + text).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => reject(new Error(`${host.label} exited during startup`)));
  });
  await exchange(host, token);
  host.rpc = new RpcClient(host);
}

const observe = (name, value) => {
  receipt.observations = { ...receipt.observations, [name]: value };
  save();
};
const tryCall = async (label, run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: `${label}: ${String(error?.message ?? error).slice(0, 1200)}` };
  }
};
const shot = async (page, name, locator) => {
  const target = locator ? locator() : page;
  await target.screenshot({ path: join(output, `${name}.png`) }).catch(() => undefined);
};

const workspace = (host, projectId) => host.rpc.call("projects.workspaceRead", { projectId });
async function memoryOf(host, projectId) {
  const read = await workspace(host, projectId);
  const files = {};
  for (const file of read.memory.files) {
    const full = await host.rpc.call("projects.memoryRead", { projectId, name: file.name });
    files[file.name] = full.content;
  }
  return files;
}
async function setGoal(host, projectId, goal, instructions) {
  const { settings } = await workspace(host, projectId);
  await http(host, "/api/projects/mutate", {
    type: "project.update",
    commandId: randomUUID(),
    projectId,
    workspaceSettings: { expectedRevision: settings.revision, goal, instructions, origin: "user" },
  });
}
const writeMemory = (host, projectId, name, content) =>
  host.rpc.call("projects.memoryWrite", { projectId, name, content, expectedRevision: null });
const MODEL = { instanceId: "codex", model: "gpt-5" };
const createThread = (host, projectId, threadId, title) =>
  host.rpc.call("orchestration.dispatchCommand", {
    commandId: randomUUID(),
    type: "thread.create",
    threadId,
    projectId,
    title,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
const createRoutine = (host, projectId, title) =>
  host.rpc.call("scheduledTasks.upsert", {
    title,
    prompt: `Fixture routine ${title}`,
    enabled: true,
    schedule: { type: "interval", everyMs: 24 * 60 * 60 * 1000 },
    projectId,
    workspaceStrategy: { type: "root" },
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    ownThread: true,
  });
const routinesOf = async (host, projectId) => {
  const listed = await host.rpc.call("scheduledTasks.list", {});
  const tasks = Array.isArray(listed) ? listed : (listed.tasks ?? []);
  return tasks
    .filter((task) => task.projectId === projectId)
    .map(({ id, title, enabled, nextRunAt, lastRunError, threadId }) => ({
      id,
      title,
      enabled,
      nextRunAt,
      lastRunError,
      threadId,
    }));
};
const threadExists = async (host, threadId) => {
  const got = await tryCall("thread", () =>
    host.rpc.call("orchestration.getThreadProjection", { threadId }),
  );
  return got.ok ? { title: got.value.thread?.title ?? got.value.title ?? "(found)" } : null;
};

const proxies = [];
const A = (state.A = await makeHost("M4", "m4.fixture.ts.net"));
const B = (state.B = await makeHost("M5", "minis.fixture.ts.net"));
let exitCode = 1;
let page;
try {
  // ---------------------------------------------------------------- fixtures
  const origin = makeOrigin("specweave");
  const aRoot = join(A.home, "Projects", "specweave");
  const bRoot = join(B.home, "old", "specweave");
  mkdirSync(dirname(aRoot), { recursive: true });
  mkdirSync(dirname(bRoot), { recursive: true });
  git(scratch, "clone", "-q", origin.url, aRoot);
  git(scratch, "clone", "-q", origin.url, bRoot);
  // M4 moved on: two commits the old M5 checkout never fetched.
  write(join(aRoot, "src/app.js"), "export const version = 3;\n");
  git(aRoot, "commit", "-qam", "Third");
  write(join(aRoot, "src/new.js"), "export const added = true;\n");
  git(aRoot, "add", "-A");
  git(aRoot, "commit", "-qm", "Fourth");
  git(aRoot, "push", "-q", "origin", "main");
  // M5's own work: a local branch never pushed, an uncommitted edit, an untracked file.
  git(bRoot, "checkout", "-q", "-b", "m5-wip");
  write(join(bRoot, "m5-only.txt"), "Committed only on M5.\n");
  git(bRoot, "add", "-A");
  git(bRoot, "commit", "-qm", "M5 work in progress");
  const wipHead = headOf(bRoot);
  git(bRoot, "checkout", "-q", "main");
  write(join(bRoot, "README.md"), "specweave\nEdited on M5, never committed.\n");
  write(join(bRoot, "scratch-m5.txt"), "Untracked on M5.\n");
  // Both name the same hosted repository, as two clones of one project do. Nothing
  // fetches from it: the copy below moves commits machine to machine.
  for (const root of [aRoot, bRoot])
    git(root, "remote", "set-url", "origin", "https://github.com/example-org/specweave.git");
  const before = {
    m4Head: headOf(aRoot),
    m5Head: headOf(bRoot),
    m5Wip: wipHead,
    m5Status: git(bRoot, "status", "--porcelain"),
  };
  observe("git before", before);

  for (const host of [A, B]) proxies.push(await startProxy(host));
  await Promise.all([startServer(A), startServer(B)]);
  log(`Servers up: M4 pid ${A.child.pid}, M5 pid ${B.child.pid}`);
  // Pairing is not needed to link: the browser reaches both machines itself.
  const paired = await tryCall("pair", async () => {
    for (const [inviter, adder] of [
      [B, A],
      [A, B],
    ]) {
      const invited = await fleetCli(
        inviter,
        "invite",
        "--coordinator",
        adder.environmentId,
        "--label",
        inviter.label,
      );
      const code = invited
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 40 && !line.includes(" "));
      if (!code) throw new Error(`No invitation line from ${inviter.label}: ${invited}`);
      log((await fleetCli(adder, "add", code, "--id", inviter.label.toLowerCase())).split("\n")[0]);
    }
  });
  observe("fleet pairing", paired.ok ? "paired both ways" : paired.error);
  const stamp = () => new Date().toISOString();
  for (const host of [A, B])
    await host.rpc.call("server.updateSettings", {
      patch: {
        machineNicknames: {
          [A.environmentId]: { name: "M4", updatedAt: stamp() },
          [B.environmentId]: { name: "M5", updatedAt: stamp() },
        },
      },
    });

  // Two projects made independently, same name, never copied from each other.
  const aId = await createProject(A, "specweave", aRoot);
  const bId = await createProject(B, "specweave", bRoot);
  await setGoal(A, aId, "M4 goal: ship 1.1.0", "M4 instructions: short commits");
  await setGoal(B, bId, "M5 goal: old experiments", "M5 instructions: old rules");
  const SEED = {
    A: {
      "MEMORY.md": "# M4 index\n- only-m4\n",
      "shared.md": "shared note, M4 text\n",
      "same.md": "identical on both\n",
      "only-m4.md": "only on M4\n",
      "theirs.md": "theirs note, M4 text\n",
    },
    B: {
      "MEMORY.md": "# M5 index\n- only-m5\n",
      "shared.md": "shared note, M5 text\n",
      "same.md": "identical on both\n",
      "only-m5.md": "only on M5\n",
      "theirs.md": "theirs note, M5 text\n",
    },
  };
  for (const [name, content] of Object.entries(SEED.A)) await writeMemory(A, aId, name, content);
  for (const [name, content] of Object.entries(SEED.B)) await writeMemory(B, bId, name, content);
  const threads = { A: `m4-thread-${randomUUID()}`, B: `m5-thread-${randomUUID()}` };
  observe("thread create", {
    m4: await tryCall("m4", () => createThread(A, aId, threads.A, "M4 feature thread")),
    m5: await tryCall("m5", () => createThread(B, bId, threads.B, "M5 old thread")),
  });
  observe("routine create", {
    m4: await tryCall("m4", () => createRoutine(A, aId, "M4 nightly")),
    m5: await tryCall("m5", () => createRoutine(B, bId, "M5 nightly")),
  });
  // M4's coordinator is the one in use: a later settings write keeps it the newer copy.
  const seeded = {
    m4: {
      settings: (await workspace(A, aId)).settings,
      memory: await memoryOf(A, aId),
      routines: await tryCall("list", () => routinesOf(A, aId)),
    },
    m5: {
      settings: (await workspace(B, bId)).settings,
      memory: await memoryOf(B, bId),
      routines: await tryCall("list", () => routinesOf(B, bId)),
    },
  };
  observe("before link", {
    m4: {
      goal: seeded.m4.settings.goal,
      memory: Object.keys(seeded.m4.memory),
      routines: seeded.m4.routines,
    },
    m5: {
      goal: seeded.m5.settings.goal,
      memory: Object.keys(seeded.m5.memory),
      routines: seeded.m5.routines,
    },
  });

  // ------------------------------------------------------------------- UI
  state.browser = await launchBrowser();
  page = await openClient("light");
  await page.evaluate(() => {
    const key = "studio:client-settings:v1";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...settings, legacySidebarEnabled: false }));
  });
  await page.goto(`${A.origin}/`);
  const suggestion = page.locator("[data-link-suggestion]");
  const offered = await tryCall("suggestion", () =>
    suggestion.first().waitFor({ timeout: 60_000 }),
  );
  await shot(page, "01-sidebar-before-link");
  await dump(page, "01-sidebar-before-link.txt").catch(() => undefined);
  const suggestionLabels = await suggestion.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  const rowsBefore = await page
    .locator(".sws-side-row-label")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  const offer = offered.ok
    ? await suggestion.first().evaluate((node) => ({
        text: node.textContent,
        title: node.getAttribute("title"),
      }))
    : null;
  scenario(
    "1. sidebar shows a labeled Link that names the other project and machine",
    offered.ok &&
      offer.text === "Link" &&
      /M[45].*Link with specweave on M[45]…$/u.test(offer.title ?? ""),
    { offer, suggestionLabels, rowsBefore, error: offered.error },
  );
  if (!offered.ok) throw new Error("No link suggestion in the sidebar.");

  // The machine menu under the message box offers the same link.
  const menuLink = await tryCall("machine menu", async () => {
    await page.locator(".sws-side-row-label", { hasText: "specweave" }).first().click();
    const chip = page.locator(".sws-execution-control button.machine-chip").first();
    await chip.waitFor({ timeout: 30_000 });
    await chip.click();
    const item = page.locator("[data-orchestrator-link]").first();
    await item.waitFor({ timeout: 15_000 }).catch(async (error) => {
      await shot(page, "01a-machine-menu-missing");
      const menu = await page
        .getByRole("menu")
        .innerText()
        .catch(() => "(no menu open)");
      throw new Error(`${error.message}\nMenu: ${menu}`);
    });
    const text = await item.innerText();
    await shot(page, "01a-machine-menu");
    await item.click();
    const opened = dialog(page);
    await opened.getByText("Link with a project on another machine").waitFor({ timeout: 30_000 });
    const picked = await opened
      .locator('[data-slot="link-candidate"] [role="radio"][aria-checked="true"]')
      .count();
    await page.keyboard.press("Escape");
    await until(async () => (await page.getByRole("dialog").count()) === 0, "the dialog to close");
    return { text, picked };
  });
  scenario(
    "2. machine menu offers Link with the project on M5 and opens the link dialog on it",
    menuLink.ok && /^Link with the project on M5/u.test(menuLink.value.text),
    menuLink,
  );
  const openedProject = page.url();
  // The row shows more controls on hover: hover first, as a person does.
  await page.locator(".sws-side-row").filter({ has: suggestion }).first().hover();
  await sleep(500);
  await shot(page, "01b-sidebar-row-hovered");
  await suggestion.first().click();
  const box = dialog(page);
  await box.getByText("Link with a project on another machine").waitFor({ timeout: 30_000 });
  await shot(page, "02-link-dialog-pick");
  const review = box.getByRole("button", { name: "Review link" });
  await until(() => review.isEnabled(), "Review link to enable", 60_000);
  await review.click();
  await box.getByText("Make these one project.", { exact: false }).waitFor({ timeout: 60_000 });
  await shot(page, "03-link-dialog-review");
  const reviewText = await box.innerText();
  write(join(output, "03-link-dialog-review.txt"), reviewText);
  const keptRadio = await box
    .getByRole("radiogroup", { name: "Coordinator stays on" })
    .innerText()
    .catch(() => "");
  // MEMORY.md: keep M4's. shared.md: keep both. theirs.md: keep M5's.
  const conflictNames = await box
    .locator('[data-slot="note-conflict"] > span')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  const link = box.getByRole("button", { name: /^Link, keep coordinator on / });
  const linkLabel = await link.innerText();
  const disabledBeforeChoices = await link.isDisabled();
  for (const name of conflictNames) {
    const group = box.getByRole("radiogroup", { name: `Which ${name} to keep` });
    const choice =
      name === "shared.md" ? "Keep both" : name === "theirs.md" ? "Keep M5" : "Keep M4";
    await group.getByText(choice, { exact: true }).click();
  }
  await box.getByText("Make these one project.", { exact: false }).click();
  await until(() => link.isEnabled(), "Link to enable", 60_000);
  await shot(page, "04-link-dialog-ready");
  await link.click();
  const sawLinked = { text: false };
  await until(
    async () => {
      if (await page.getByText("Projects linked").count()) sawLinked.text = true;
      return sawLinked.text || (await page.getByRole("dialog").count()) === 0;
    },
    "the link to finish",
    90_000,
    100,
  );
  await shot(page, "05-after-link-click");
  const doneText = sawLinked.text ? await box.innerText() : "(dialog closed with no confirmation)";
  if (sawLinked.text) await box.getByRole("button", { name: "Done" }).click();
  scenario(
    "3. link dialog: M4 keeps the coordinator, note conflicts need a choice, M5's routine is named, and the link ends on Projects linked",
    /M4/u.test(linkLabel) &&
      disabledBeforeChoices &&
      ["MEMORY.md", "shared.md", "theirs.md"].every((name) => conflictNames.includes(name)) &&
      reviewText.includes("only-m5.md") &&
      reviewText.includes("Goal on M5") &&
      reviewText.includes("1 routine on M5 stops running.") &&
      reviewText.includes("M5 nightly") &&
      sawLinked.text &&
      page.url() === openedProject,
    { linkLabel, keptRadio, conflictNames, disabledBeforeChoices, doneText },
  );

  // --------------------------------------------------------- after the link
  const [aView, bView] = await Promise.all([
    A.rpc.call("projectLink.preview", { projectId: aId }),
    B.rpc.call("projectLink.preview", { projectId: bId }),
  ]);
  const members = aView.logicalProject?.members ?? [];
  scenario(
    "4. one logical project: M4 active coordinator, M5 a member that gave way",
    members.length === 2 &&
      aView.logicalProject?.id === bView.logicalProject?.id &&
      aView.coordinatorBinding?.state === "active" &&
      bView.coordinatorBinding?.state === "transferred" &&
      bView.coordinatorBinding?.successor?.environmentId === A.environmentId,
    {
      logicalId: aView.logicalProject?.id,
      members: members.map((member) => ({
        machine: member.environmentId === A.environmentId ? "M4" : "M5",
        projectId: member.projectId,
        workspaceRoot: member.workspaceRoot,
      })),
      m4Binding: aView.coordinatorBinding,
      m5Binding: bView.coordinatorBinding,
      projectIdsUnchanged: aView.member.projectId === aId && bView.member.projectId === bId,
    },
  );

  // Memory: after the servers' two-way pass both machines hold what the review chose.
  const EXPECTED = {
    "MEMORY.md": SEED.A["MEMORY.md"],
    "shared.md": SEED.A["shared.md"],
    "shared-m5.md": SEED.B["shared.md"],
    "theirs.md": SEED.B["theirs.md"],
    "same.md": SEED.A["same.md"],
    "only-m4.md": SEED.A["only-m4.md"],
    "only-m5.md": SEED.B["only-m5.md"],
  };
  const asChosen = (files) =>
    Object.keys(files).sort().join() === Object.keys(EXPECTED).sort().join() &&
    Object.entries(EXPECTED).every(([name, text]) => files[name] === text);
  let memory = { m4: {}, m5: {} };
  const readBoth = async () => {
    memory = { m4: await memoryOf(A, aId), m5: await memoryOf(B, bId) };
    return asChosen(memory.m4) && asChosen(memory.m5);
  };
  const converged = await tryCall("memory", () =>
    until(readBoth, "both machines to hold the chosen notes", 240_000, 5_000),
  );
  // Later passes change nothing.
  await sleep(30_000);
  const stable = await readBoth();
  const marked = (files) =>
    Object.entries(files)
      .filter(([name, text]) => /^(<{7}|={7}|>{7})/mu.test(text) || name.includes("conflict"))
      .map(([name]) => name);
  scenario(
    "5. memory: both machines hold the chosen text for every note, with no conflict markers or copies",
    converged.ok && stable && marked(memory.m4).length === 0 && marked(memory.m5).length === 0,
    {
      m4: Object.fromEntries(Object.entries(memory.m4).map(([k, v]) => [k, v.trim()])),
      m5: Object.fromEntries(Object.entries(memory.m5).map(([k, v]) => [k, v.trim()])),
      markedOnM4: marked(memory.m4),
      markedOnM5: marked(memory.m5),
      error: converged.error,
    },
  );

  const after = {
    m4: (await workspace(A, aId)).settings,
    m5: (await workspace(B, bId)).settings,
  };
  scenario(
    "6. goal and instructions: M4 keeps its own; M5's own text is still stored on M5",
    after.m4.goal === "M4 goal: ship 1.1.0" &&
      after.m4.instructions === "M4 instructions: short commits" &&
      after.m5.goal === "M5 goal: old experiments",
    {
      m4: { goal: after.m4.goal, instructions: after.m4.instructions },
      m5: { goal: after.m5.goal, instructions: after.m5.instructions },
      m5Replica: bView.replica
        ? { goal: bView.replica.goal, instructions: bView.replica.instructions }
        : null,
    },
  );

  const threadsAfter = {
    m4: await threadExists(A, threads.A),
    m5: await threadExists(B, threads.B),
    m5Coordinator: await threadExists(B, bView.member.coordinatorThreadId),
  };
  const projects = { m4: await projectsOf(A), m5: await projectsOf(B) };
  scenario(
    "7. threads stay on their own machine; no project was created or removed",
    threadsAfter.m4 !== null &&
      threadsAfter.m5 !== null &&
      projects.m4.filter((project) => project.title === "specweave").length === 1 &&
      projects.m5.filter((project) => project.title === "specweave").length === 1,
    {
      threadsAfter,
      m4Projects: projects.m4.map((project) => project.title),
      m5Projects: projects.m5.map((project) => project.title),
    },
  );
  // M5's own routine rests: it cannot run or be turned on there, and can be removed.
  const m5Routine = (await routinesOf(B, bId))[0];
  const routine = (method, input) =>
    tryCall(method, () => B.rpc.call(`scheduledTasks.${method}`, { id: m5Routine.id, ...input }));
  const routines = {
    runNow: await routine("runNow", {}),
    turnOff: await routine("setEnabled", { enabled: false }),
    turnOn: await routine("setEnabled", { enabled: true }),
    remove: await routine("delete", {}),
    m5After: await routinesOf(B, bId),
    m4After: await routinesOf(A, aId),
  };
  scenario(
    "8. M5's own routine does not run or turn on there, can be turned off and deleted, and M4's is untouched",
    !routines.runNow.ok &&
      routines.turnOff.ok &&
      !routines.turnOn.ok &&
      routines.remove.ok &&
      routines.m5After.length === 0 &&
      routines.m4After.length === 1 &&
      routines.m4After[0].enabled,
    routines,
  );

  await page.goto(`${A.origin}/`);
  await page.locator(".sws-side-row-label").first().waitFor({ timeout: 30_000 });
  await sleep(3_000);
  const rowsAfter = await page
    .locator(".sws-side-row-label")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  const stillOffered = await page.locator("[data-link-suggestion]").count();
  const rowTitles = await page
    .locator(".sws-side-row")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.closest("[title]")?.getAttribute("title") ?? node.textContent),
    );
  await shot(page, "06-sidebar-after-link");
  scenario(
    "9. sidebar lists specweave once and stops offering the link",
    rowsAfter.filter((title) => title === "specweave").length === 1 && stillOffered === 0,
    { rowsBefore, rowsAfter, stillOffered, rowTitles },
  );

  // ---------------------------------------------- bring the M5 folder up to date
  const operationId = randomUUID();
  const copy = await tryCall("copy", async () => {
    const { offer, summary } = await offerAndScan(A, aId, B, operationId);
    const previewed = await startCopy(B, offer, bRoot, ["repository", "tracked", "untracked"]);
    write(join(output, "08-copy-preview.json"), JSON.stringify(previewed, null, 2));
    const refusedWithoutChoice = await B.rpc
      .call("machineHandoff.copyApprove", { operationId })
      .then(
        () => null,
        (error) => String(error?.message ?? error).slice(0, 600),
      );
    // Keep what is here: the uncommitted edit stays, and the newer commits are fetched.
    const decisions = Object.fromEntries(
      previewed.rows.filter((row) => row.needsDecision).map((row) => [row.id, "keep-mine"]),
    );
    await B.rpc.call("machineHandoff.copyDecide", { operationId, decisions });
    await pollCopy(B, operationId);
    const approved = await B.rpc.call("machineHandoff.copyApprove", { operationId }).then(
      () => null,
      (error) => String(error?.message ?? error).slice(0, 600),
    );
    const applied = await pollCopy(B, operationId);
    observe("copy rows", {
      preview: previewed.rows.map(({ id, status, detail, choices }) => ({
        id,
        status,
        detail,
        choices,
      })),
      decisions,
      approved,
      appliedState: applied.state,
      appliedError: applied.error,
      appliedRows: applied.rows?.map(({ id, status, detail, decision }) => ({
        id,
        status,
        detail,
        decision,
      })),
    });
    write(join(output, "08-copy-applied.json"), JSON.stringify(applied, null, 2));
    return { summary, previewState: previewed.state, refusedWithoutChoice, state: applied.state };
  });
  const gitAfter = {
    m5Head: headOf(bRoot),
    m5Branch: git(bRoot, "rev-parse", "--abbrev-ref", "HEAD"),
    m5Wip: headOf(bRoot, "m5-wip"),
    m5Status: git(bRoot, "status", "--porcelain"),
    readme: readFileSync(join(bRoot, "README.md"), "utf8"),
    untracked: existsSync(join(bRoot, "scratch-m5.txt")),
    refs: git(bRoot, "for-each-ref", "--format=%(refname) %(objectname:short)"),
  };
  scenario(
    "10. copy into the existing M5 folder asks before touching it; local branch, uncommitted edit and untracked file survive",
    copy.ok &&
      copy.value.refusedWithoutChoice !== null &&
      gitAfter.m5Wip === before.m5Wip &&
      gitAfter.readme.includes("Edited on M5, never committed.") &&
      gitAfter.untracked,
    { copy, before, gitAfter, m4Head: before.m4Head, upToDate: gitAfter.m5Head === before.m4Head },
  );
  const projectsEnd = await projectsOf(B);
  const endView = await B.rpc.call("projectLink.preview", { projectId: bId });
  scenario(
    "11. the copy reuses the linked M5 project: no second project, still one identity",
    projectsEnd.filter((project) => project.deletedAt == null).length ===
      projects.m5.filter((project) => project.deletedAt == null).length &&
      endView.logicalProject?.id === aView.logicalProject?.id,
    {
      m5Projects: projectsEnd.map((project) => ({
        title: project.title,
        root: project.workspaceRoot,
      })),
    },
  );
  receipt.pageErrors = page.errors;
  exitCode = Object.values(receipt.scenarios).every((entry) => entry.passed) ? 0 : 1;
  receipt.success = exitCode === 0;
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  log(`ERROR ${receipt.error}`);
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
    await dump(page, "failure.txt").catch(() => undefined);
  }
} finally {
  save();
  await state.browser?.close().catch(() => undefined);
  await Promise.all([A, B].map((host) => stopServer(host).catch(() => undefined)));
  for (const proxy of proxies) proxy.close();
  if (process.env.KEEP_SCRATCH !== "1") rmSync(scratch, { recursive: true, force: true });
  save();
}
process.exit(exitCode);
