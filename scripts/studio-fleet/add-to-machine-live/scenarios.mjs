// Run on scenarios driven through the real web client against two real servers:
// a+b clone with extras, AC-02 link an existing copy, AC-04 unreadable remote,
// d cancel mid-clone and restart, e nickname rename.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  dialog,
  git,
  headOf,
  menu,
  openAddDialog,
  openDraft,
  output,
  projectsOf,
  runOnButton,
  scenario,
  shootThemes,
  sleep,
  startServer,
  state,
  stopServer,
  until,
  watchClones,
} from "./harness.mjs";

const { existsSync, renameSync, writeFileSync } = NodeFS;
const { join } = NodePath;

/** a + b: the full UI clone, extras copy and link, through the real web client. */
export async function scenarioCloneAndLink(page, fixtures) {
  const { A, B } = state;
  const watch = await watchClones(B);
  await openDraft(page, "demo-app");
  await runOnButton(page).click();
  await menu(page).getByText("Machines with demo-app").waitFor();
  await shootThemes(page, "01-run-on-menu", () => menu(page));
  await menu(page)
    .getByRole("menuitem", { name: /Add to another machine/ })
    .click();
  await menu(page).getByText("Clone it there").waitFor();
  await shootThemes(page, "02-run-on-add-to-machine", () => menu(page));
  await menu(page).getByRole("menuitem").filter({ hasText: "Minis" }).click();
  const box = dialog(page);
  await box.getByText("Add demo-app to Minis").waitFor({ timeout: 30_000 });
  await box.getByText(".env.local").waitFor({ timeout: 60_000 });
  // D-03: outside /Users or /home the default is ~/<name> on the destination.
  const destination = join(B.home, "demo-app");
  await box.getByText(destination).first().waitFor({ timeout: 30_000 });
  await box.getByRole("checkbox", { name: /Copy ignored files/ }).check();
  await shootThemes(page, "03-add-dialog", () => box);
  const dialogText = await box.innerText();
  writeFileSync(join(output, "03-add-dialog.txt"), dialogText);
  const secretsTicked = await box
    .locator("label")
    .filter({ hasText: /^\.env/ })
    .getByRole("checkbox")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-checked") ?? node.checked));
  await box.getByRole("button", { name: "Clone to Minis" }).click();
  const done = await until(
    () =>
      watch.events.find((event) => event.destinationPath === destination && event.phase === "done"),
    "the clone on Minis to finish",
    120_000,
  );
  const projectId = done.projectId;
  const linked = await until(
    async () => {
      const view = await B.rpc.call("projectLink.preview", { projectId }).catch(() => null);
      const members = view?.logicalProject?.members ?? [];
      return members.some((member) => member.projectId === A.demoId) ? view : null;
    },
    "the clone to be linked as a member",
    120_000,
    1000,
  );
  watch.stop();
  const files = {
    readme: existsSync(join(destination, "README.md")),
    ignoredNotes: existsSync(join(destination, "notes/todo.md")),
    env: existsSync(join(destination, ".env")),
    envLocal: existsSync(join(destination, ".env.local")),
    nodeModules: existsSync(join(destination, "node_modules")),
  };
  const sameHead = headOf(destination) === headOf(fixtures.demoRoot);
  const remote = git(destination, "remote", "get-url", "origin");
  // Run on now lists Minis with the project.
  await page.keyboard.press("Escape").catch(() => undefined);
  await runOnButton(page).waitFor();
  const trigger = await runOnButton(page).getAttribute("aria-label");
  await runOnButton(page).click();
  await menu(page).getByText("Machines with demo-app").waitFor();
  await until(
    async () => (await menu(page).innerText()).includes("Minis"),
    "Minis under Machines with demo-app",
    30_000,
  );
  const menuText = await menu(page).innerText();
  await shootThemes(page, "05-run-on-after-clone", () => menu(page));
  await page.keyboard.press("Escape");
  const phases = [...new Set(watch.events.map((event) => event.phase))];
  const stages = [...new Set(watch.events.map((event) => event.stage))];
  const passedA =
    done.phase === "done" &&
    sameHead &&
    remote === fixtures.demo.url &&
    linked.logicalProject.members.length === 2 &&
    menuText.includes("Minis") &&
    !menuText.includes("Clone it there");
  scenario("a. clone to a machine without the project, link, Run on lists it", passedA, {
    destination,
    projectIdOnMinis: projectId,
    cloneEvents: watch.events.length,
    phases,
    stages,
    remote,
    sameHead,
    members: linked.logicalProject.members.map((member) =>
      member.environmentId === A.environmentId ? "M4" : "Minis",
    ),
    runOnTrigger: trigger,
    runOnMenu: menuText.split("\n").filter(Boolean),
  });
  scenario(
    "b. copy ignored files: non-secret ignored copies, .env* does not",
    files.readme &&
      files.ignoredNotes &&
      !files.env &&
      !files.envLocal &&
      !files.nodeModules &&
      secretsTicked.every((value) => value === false || value === "false"),
    {
      files,
      secretCheckboxes: secretsTicked,
      dialogListsSecrets: dialogText.includes(".env.local"),
    },
  );
  return { projectId, destination };
}

/** Sidebar lines that read exactly `title`: one per listed project or group. */
async function sidebarRows(page, title) {
  const text = await page.locator('[data-sidebar="sidebar"]').first().innerText();
  return text.split("\n").filter((line) => line.trim() === title).length;
}
/** The "N projects" count next to a sidebar group, or null when it has one project. */
async function sidebarGroupLabel(page, title) {
  const lines = (await page.locator('[data-sidebar="sidebar"]').first().innerText()).split("\n");
  const index = lines.findIndex((line) => line.trim() === title);
  return index >= 0 && /^\d+ projects$/u.test(lines[index + 1]?.trim() ?? "")
    ? lines[index + 1].trim()
    : null;
}

/** d: Cancel in the composer's progress strip mid-clone, then restart Minis. */
export async function scenarioCancel(page) {
  const { A, B } = state;
  const watch = await watchClones(B);
  await openAddDialog(page, "big-app");
  const destination = join(B.home, "big-app");
  await dialog(page).getByText(destination).first().waitFor({ timeout: 30_000 });
  await until(
    () => dialog(page).getByRole("button", { name: "Clone to Minis" }).isEnabled(),
    "Clone to Minis to enable",
    60_000,
  );
  await dialog(page).getByRole("button", { name: "Clone to Minis" }).click();
  const strip = page.getByText(/^Cloning big-app/).first();
  await strip.waitFor({ timeout: 30_000 });
  await until(
    () =>
      watch.events.some(
        (event) =>
          event.destinationPath === destination &&
          event.stage === "receiving" &&
          (event.percent ?? 0) > 0,
      ),
    "receiving progress",
    180_000,
    100,
  );
  // While the clone runs: the draft on Minis cannot send, the sidebar lists big-app
  // once (the clone groups with its source), and nothing else is open over the page.
  const duringClone = {
    sendButton: await page
      .locator('button[type="submit"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute("aria-label")}|${node.disabled}`),
      ),
    runOn: await runOnButton(page).getAttribute("aria-label"),
    sidebarBigAppRows: await sidebarRows(page, "big-app"),
    sidebarGroup: await sidebarGroupLabel(page, "big-app"),
    openMenus: await page.getByRole("menu").count(),
    // Not linked yet on the servers: the sidebar groups it from the pending add.
    minisMembers:
      (await projectsOf(B)).find((project) => project.workspaceRoot === destination)
        ?.workspaceSettings?.logicalProject?.members?.length ?? null,
  };
  const stripBox = page
    .locator("[data-slot=composer-banner], [role=status]")
    .filter({ hasText: /Cloning big-app/ })
    .first();
  const stripLocator = (await stripBox.count())
    ? stripBox
    : strip.locator("xpath=ancestor::div[3]");
  await shootThemes(page, "04-progress-strip", () => stripLocator);
  await shootThemes(page, "04b-progress-strip-composer");
  const stripText = await stripLocator.innerText();
  const running = watch.events.filter(
    (event) => event.destinationPath === destination && event.phase === "running",
  );
  const projectId = running[0].projectId;
  await stripLocator.getByRole("button", { name: "Cancel" }).click();
  await until(
    () =>
      watch.events.some((event) => event.projectId === projectId && event.phase === "cancelled") ||
      !existsSync(destination),
    "the clone to stop",
    60_000,
  );
  await until(() => !existsSync(destination), "the partial folder to be removed", 30_000);
  watch.stop();
  const afterCancel = {
    folderExists: existsSync(destination),
    projectOnMinis: await B.rpc.call("projectLink.preview", { projectId }).then(
      () => true,
      () => false,
    ),
  };
  const sourceView = await A.rpc.call("projectLink.preview", { projectId: A.bigId });
  // Restart check: Minis restarts; nothing comes back half-linked, and the page's
  // pending job (if any) does not link anything once it re-checks the folder.
  await stopServer(B);
  await startServer(B);
  await sleep(35_000);
  const sourceAfterRestart = await A.rpc.call("projectLink.preview", { projectId: A.bigId });
  const afterRestart = {
    folderExists: existsSync(destination),
    projectOnMinis: await B.rpc.call("projectLink.preview", { projectId }).then(
      () => true,
      () => false,
    ),
    sourceMembers: sourceAfterRestart.logicalProject?.members?.length ?? 1,
    pendingJobs: await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.includes("add-to-machine")),
    ),
  };
  const percents = running.map((event) => event.percent).filter((value) => value !== null);
  scenario(
    "d. cancel mid-clone: no half-linked member, partial folder removed, restart clean",
    !afterCancel.folderExists &&
      !afterCancel.projectOnMinis &&
      (sourceView.logicalProject?.members?.length ?? 1) <= 1 &&
      !afterRestart.folderExists &&
      !afterRestart.projectOnMinis &&
      afterRestart.sourceMembers <= 1 &&
      afterRestart.pendingJobs.length === 0 &&
      // No provider is enabled here, so the label names that first; the clone's own
      // block ("Cloning repository") is covered by projectCloneSendBlockReason's test.
      duringClone.sendButton.length > 0 &&
      duringClone.sendButton.every((entry) => entry.endsWith("|true")) &&
      duringClone.sidebarBigAppRows === 1 &&
      duringClone.openMenus === 0,
    {
      strip: stripText.split("\n").filter(Boolean),
      duringClone,
      runningEvents: running.length,
      percents: [Math.min(...percents), Math.max(...percents)],
      phases: [
        ...new Set(
          watch.events.filter((event) => event.projectId === projectId).map((event) => event.phase),
        ),
      ],
      afterCancel,
      afterRestart,
      restartedMinisPid: B.child.pid,
    },
  );
}

/** e: rename Minis from M4's Run on menu; Minis's own server gets the name. */
export async function scenarioNickname(page) {
  const { A, B } = state;
  await openDraft(page, "demo-app");
  await runOnButton(page).click();
  await menu(page)
    .getByRole("menuitem", { name: /Rename a machine/ })
    .click();
  await menu(page).getByRole("menuitem", { name: "Rename Minis" }).click();
  const box = dialog(page);
  const input = box.getByRole("textbox").first();
  await input.fill("Mini Lab");
  await shootThemes(page, "08-rename-dialog", () => box);
  await box.getByRole("button", { name: /^(Rename|Save)/ }).click();
  const startedAt = Date.now();
  const onB = await until(
    async () => {
      const settings = await B.rpc.call("server.getSettings", {});
      return settings.machineNicknames?.[B.environmentId]?.name === "Mini Lab"
        ? settings.machineNicknames
        : null;
    },
    "the rename to reach Minis",
    90_000,
    500,
  );
  const onA = (await A.rpc.call("server.getSettings", {})).machineNicknames;
  const dialogSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  // The page writes to every machine it is connected to. A rename stored on M4's
  // server alone reaches Minis over the fleet pairing (MachineNicknameSync).
  const fleetStart = Date.now();
  await A.rpc.call("server.updateSettings", {
    patch: {
      machineNicknames: {
        [A.environmentId]: { name: "M4 Max", updatedAt: new Date().toISOString() },
      },
    },
  });
  const viaFleet = await until(
    async () => {
      const settings = await B.rpc.call("server.getSettings", {});
      return settings.machineNicknames?.[A.environmentId]?.name === "M4 Max"
        ? settings.machineNicknames
        : null;
    },
    "the server-side rename to reach Minis over the fleet",
    90_000,
    500,
  );
  scenario("e. nickname rename on M4 shows on Minis", true, {
    fromRunOnMenu: {
      seconds: dialogSeconds,
      onM4: onA[B.environmentId],
      onMinis: onB[B.environmentId],
    },
    fromM4ServerOnly: {
      seconds: Math.round((Date.now() - fleetStart) / 100) / 10,
      onMinis: viaFleet[A.environmentId],
    },
  });
}

/**
 * f (AC-02): Minis has an unlinked checkout of the same repository saved as a
 * project. Run on offers "Has a copy at <path> · Link" for it, never a clone;
 * Link makes it a member and Run on moves the draft there.
 */
export async function scenarioLinkExistingCopy(page, fixture) {
  const { A, B } = state;
  await openDraft(page, "linkme");
  await runOnButton(page).click();
  const machinesMenu = (await menu(page).innerText()).split("\n").filter(Boolean);
  await menu(page)
    .getByRole("menuitem", { name: /Add to another machine/ })
    .click();
  const offer = `Has a copy at ${fixture.bRoot}`;
  const row = menu(page).getByRole("menuitem").filter({ hasText: offer });
  await row.waitFor({ timeout: 30_000 });
  const addMenu = (await menu(page).innerText()).split("\n").filter(Boolean);
  await shootThemes(page, "10-run-on-has-a-copy", () => menu(page));
  await row.click();
  const box = dialog(page);
  await box.getByRole("button", { name: "Review link" }).click();
  await box.getByText("Make these one project.", { exact: false }).click();
  const link = box.getByRole("button", { name: /^Link, keep coordinator on / });
  await until(() => link.isEnabled(), "Link to enable", 60_000);
  await shootThemes(page, "10b-link-dialog", () => box);
  await link.click();
  await box.getByText("Projects linked").waitFor({ timeout: 60_000 });
  await box.getByRole("button", { name: "Done" }).click();
  const runOn = await until(
    async () => {
      const label = await runOnButton(page).getAttribute("aria-label");
      return label?.includes("Minis") ? label : null;
    },
    "Run on to move to Minis",
    30_000,
  );
  const view = await A.rpc.call("projectLink.preview", { projectId: fixture.projectId });
  const members = view.logicalProject?.members ?? [];
  scenario(
    "f. AC-02: an unlinked copy on Minis shows Has a copy at <path> · Link; Link joins it and Run on moves there",
    !machinesMenu.includes("Minis") &&
      addMenu.some((line) => line.includes(offer)) &&
      addMenu.some((line) => /(?:^|· )Link$/u.test(line.trim())) &&
      !addMenu.some((line) => line.includes("Clone it there")) &&
      members.some(
        (member) =>
          member.environmentId === B.environmentId && member.projectId === fixture.minisProjectId,
      ) &&
      runOn.includes("Minis"),
    { machinesMenu, addMenu, members: members.length, runOn },
  );
}

/**
 * g (AC-04): Minis cannot read the repository (git ls-remote fails). Clone shows
 * the sign-in fix for Minis and starts nothing.
 */
export async function scenarioUnreadableRemote(page, fixture) {
  const { B } = state;
  const watch = await watchClones(B);
  // M4 keeps the origin it recorded, but the URL no longer answers.
  renameSync(fixture.origin.bare, `${fixture.origin.bare}.moved`);
  await openAddDialog(page, "gone-app");
  const box = dialog(page);
  const destination = join(B.home, "gone-app");
  const clone = box.getByRole("button", { name: "Clone to Minis" });
  await until(() => clone.isEnabled(), "Clone to Minis to enable", 60_000);
  await clone.click();
  const alert = box.getByRole("alert").filter({ hasText: /can't read this repository/ });
  await alert.waitFor({ timeout: 60_000 });
  await shootThemes(page, "09-add-dialog-sign-in", () => box);
  const message = await alert.innerText();
  await sleep(2000);
  watch.stop();
  const projects = await projectsOf(B);
  const evidence = {
    message,
    stillInDialog: await box.getByText("Add gone-app to Minis").isVisible(),
    cloneEvents: watch.events.filter((event) => event.destinationPath === destination).length,
    folderCreated: existsSync(destination),
    projectOnMinis: projects.some((project) => project.workspaceRoot === destination),
  };
  await box.getByRole("button", { name: "Cancel" }).click();
  scenario(
    "g. AC-04: git ls-remote fails on Minis: sign-in fix for Minis, nothing starts",
    /^Minis can't read this repository\. Sign in .* on Minis/u.test(message) &&
      evidence.stillInDialog &&
      evidence.cloneEvents === 0 &&
      !evidence.folderCreated &&
      !evidence.projectOnMinis,
    evidence,
  );
}
