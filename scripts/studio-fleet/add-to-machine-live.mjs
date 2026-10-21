#!/usr/bin/env node
// Run on > Add to another machine between two real server processes on this Mac.
//
// A ("M4") holds the projects; B ("Minis") is where they are added. Each server
// has its own temp home, state folder and loopback port. They are paired the
// product's way: `fleet invite` on one, `fleet add` on the other, over a
// private-looking Tailscale name (`*.fixture.ts.net`) that resolves to a local
// TLS proxy, only inside these processes, with a throwaway certificate. A
// stand-in `tailscale` on their PATH reports that name and its Serve route.
// Origins are local bare repositories cloned over file://.
//
// Drives the real web client (headless) and checks results on disk and over RPC:
//   a. clone to B with progress events, link as a member, Run on lists B
//   b. ignored non-secret files copy, .env* secrets do not
//   c. existing folder through the dialog review: same, behind, ahead, diverged
//      (with Undo), dirty, file conflicts with ignored files (with Undo), a
//      linked worktree, and unrelated folders refused
//   d. cancel mid-clone, then restart B: no half-linked member
//   e. a nickname rename on A shows on B
//   f. AC-02: an unlinked copy on B is offered as "Has a copy at <path> · Link"
//   g. AC-04: B cannot read the remote: sign-in fix, nothing starts
// Never touches the live app stores, a real Tailscale or another machine.
//
// Usage: node scripts/studio-fleet/add-to-machine-live.mjs [/absolute/report/dir]
// Needs `apps/web` and `apps/server` built from the checked-out commit; a run
// from a tree with uncommitted changes or an older build fails. ONLY=ab,c,...
// runs some steps. STUDIO_TEST_PLAYWRIGHT_MODULE and STUDIO_TEST_CHROMIUM
// override the Playwright module and browser.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  prepareConsolidationFixtures,
  scenarioConsolidation,
} from "./add-to-machine-live/consolidation.mjs";
import {
  createProject,
  dump,
  fleetCli,
  git,
  launchBrowser,
  log,
  makeHost,
  makeOrigin,
  openClient,
  output,
  receipt,
  save,
  scenario,
  scratch,
  startProxy,
  startServer,
  state,
  stopServer,
  write,
} from "./add-to-machine-live/harness.mjs";
import {
  scenarioCancel,
  scenarioCloneAndLink,
  scenarioLinkExistingCopy,
  scenarioNickname,
  scenarioUnreadableRemote,
} from "./add-to-machine-live/scenarios.mjs";

const { existsSync, mkdirSync, readFileSync, rmSync } = NodeFS;
const { dirname, join } = NodePath;

async function runScenarios(fixtures) {
  state.browser = await launchBrowser();
  const page = await openClient("system");
  const steps = [
    ["ab", () => scenarioCloneAndLink(page, fixtures)],
    ["f", () => scenarioLinkExistingCopy(page, fixtures.linkme)],
    ["g", () => scenarioUnreadableRemote(page, fixtures.gone)],
    ["c", () => scenarioConsolidation(page)],
    ["d", () => scenarioCancel(page)],
    // Last: it renames Minis, which the other scenarios look for by name.
    ["e", () => scenarioNickname(page)],
  ];
  for (const [name, run] of steps) {
    if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
    try {
      await run();
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => undefined);
      await dump(page, `failure-${name}.txt`).catch(() => undefined);
      scenario(`${name} (stopped)`, false, { error: String(error?.stack ?? error).slice(0, 3000) });
    }
  }
  receipt.pageErrors = page.errors;
}

const proxies = [];
const A = (state.A = await makeHost("M4", "m4.fixture.ts.net"));
const B = (state.B = await makeHost("Minis", "minis.fixture.ts.net"));
receipt.hosts = [A, B].map(({ label, environmentId, origin, fleetUrl }) => ({
  label,
  environmentId,
  origin,
  fleetUrl,
}));
let exitCode = 1;
try {
  // Fixtures first: building them blocks this process for a while.
  const sourceCheckout = (origin) => {
    const path = join(A.home, "Projects", origin.name);
    mkdirSync(dirname(path), { recursive: true });
    git(scratch, "clone", "-q", origin.url, path);
    return path;
  };
  const demo = makeOrigin("demo-app");
  const big = makeOrigin("big-app", { bigMegabytes: 320 });
  const demoRoot = sourceCheckout(demo);
  write(join(demoRoot, "notes/todo.md"), "Ignored notes, only on M4.\n");
  write(join(demoRoot, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  write(join(demoRoot, ".env"), "API_KEY=fixture-not-a-secret\n");
  write(join(demoRoot, ".env.local"), "LOCAL_KEY=fixture\n");
  const bigRoot = sourceCheckout(big);
  const linkme = { origin: makeOrigin("linkme") };
  linkme.aRoot = sourceCheckout(linkme.origin);
  linkme.bRoot = join(B.home, "code", "linkme-checkout");
  git(scratch, "clone", "-q", linkme.origin.url, linkme.bRoot);
  const gone = { origin: makeOrigin("gone-app") };
  gone.aRoot = sourceCheckout(gone.origin);
  Object.assign(
    state.caseFixtures,
    prepareConsolidationFixtures({ aHome: A.home, bHome: B.home, sourceCheckout }),
  );

  for (const host of [A, B]) proxies.push(await startProxy(host));
  await Promise.all([startServer(A), startServer(B)]);
  log(`Servers up: A pid ${A.child.pid} ${A.origin}, B pid ${B.child.pid} ${B.origin}`);

  // Pairing, the product's way: invite on one machine, add the line on the other.
  for (const [inviter, adder] of [
    [B, A],
    [A, B],
  ]) {
    const invited = await fleetCli(
      inviter,
      "invite",
      "--label",
      inviter.label,
      "--tailscale-serve-port",
      String(inviter.proxyPort),
    );
    const code = invited
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 40 && !line.includes(" "));
    if (!code) throw new Error(`No invitation line from ${inviter.label}: ${invited}`);
    const added = await fleetCli(adder, "add", code, "--id", inviter.label.toLowerCase());
    log(added.split("\n")[0]);
  }
  const fleetA = JSON.parse(readFileSync(join(A.data, "studio-fleet.json"), "utf8"));
  if (fleetA.machines[0].environmentId !== B.environmentId || fleetA.machines[0].url !== B.fleetUrl)
    throw new Error(`M4's fleet does not list Minis: ${JSON.stringify(fleetA.machines)}`);
  receipt.pairing = "fleet invite on each machine, fleet add of the line on the other";
  save();

  // Each machine's own nickname, the way Settings > Connections stores it.
  const stamp = () => new Date().toISOString();
  await A.rpc.call("server.updateSettings", {
    patch: {
      machineNicknames: {
        [A.environmentId]: { name: "M4", updatedAt: stamp() },
        [B.environmentId]: { name: "Minis", updatedAt: stamp() },
      },
    },
  });

  A.demoId = await createProject(A, "demo-app", demoRoot);
  A.bigId = await createProject(A, "big-app", bigRoot);
  linkme.projectId = await createProject(A, "linkme", linkme.aRoot);
  // Saved on Minis under another name and folder; only the repository matches.
  linkme.minisProjectId = await createProject(B, "linkme checkout", linkme.bRoot);
  gone.projectId = await createProject(A, "gone-app", gone.aRoot);
  for (const [name, fixture] of Object.entries(state.caseFixtures))
    fixture.projectId = await createProject(A, name, fixture.aRoot);
  receipt.projects = { demoRoot, bigRoot };
  save();

  await runScenarios({ demo, big, demoRoot, bigRoot, linkme, gone });
  const allPassed = Object.values(receipt.scenarios).every((entry) => entry.passed);
  // Evidence for a commit needs a clean tree and a build made after that commit.
  const tied = receipt.source.uncommittedPaths.length === 0 && receipt.source.builtAfterCommit;
  receipt.tiedToCommit = tied;
  exitCode = allPassed && tied ? 0 : 1;
  receipt.success = exitCode === 0;
  if (!tied) log(`NOT TIED TO ${receipt.source.commit}: ${JSON.stringify(receipt.source)}`);
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  log(`ERROR ${receipt.error}`);
  for (const [index, page] of state.openPages.entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => undefined);
    await dump(page, `failure-${index}.txt`).catch(() => undefined);
  }
} finally {
  save();
  await state.browser?.close().catch(() => undefined);
  await Promise.all([A, B].map((host) => stopServer(host).catch(() => undefined)));
  for (const proxy of proxies) proxy.close();
  if (process.env.KEEP_SCRATCH !== "1") rmSync(scratch, { recursive: true, force: true });
  receipt.scratchRemoved = !existsSync(scratch);
  save();
}
process.exit(exitCode);
