/**
 * `specwithcode provision`: checks the target, then installs or verifies each
 * pinned package in order, verifying after every change. Every step looks
 * before it acts, so a second run changes nothing, and a newer installed
 * version is always kept. Progress is a resumable state file plus a log under
 * `<home>/provision/`. No step needs an AI model.
 *
 * Root boundary: root steps are collected into one script run with
 * `sudo -n` (passwordless sudo), with `sudo` at the machine's own terminal, or
 * not at all; then the readback prints the one line to run. Sign-ins, Allow
 * workers, billing and subscriptions are never touched; the readback lists them
 * as the user's steps.
 */
import type {
  ProvisionEvent,
  ProvisionItem,
  ProvisionItemId,
  ProvisionReadback,
  ProvisionRootStep,
  ProvisionUserStep,
} from "@specweave-studio/contracts";
import { PROVISION_READBACK_SCHEMA_VERSION } from "@specweave-studio/contracts";

import { type ProvisionHost } from "./host.ts";
import { rootPlanIsEmpty } from "./rootScript.ts";
import { checkTarget } from "./target.ts";
import {
  type Ctx,
  type Probes,
  ProvisionRunError,
  type ProvisionOptions,
  type RunState,
  isLinux,
  join,
} from "./context.ts";

export { ProvisionRunError, type ProvisionOptions } from "./context.ts";
import { emptyService, probeAll, readTargetFacts, resolvePaths, stripTarget } from "./probe.ts";
import { failItem, planItems, reprobe, verifyItem } from "./plan.ts";
import {
  applyServerItem,
  buildRootPlan,
  describeRootStep,
  installClaude,
  installCodex,
  installGh,
  installNode,
  runRootStep,
} from "./install.ts";

export async function runProvision(
  host: ProvisionHost,
  options: ProvisionOptions,
): Promise<ProvisionReadback> {
  const emit = (event: ProvisionEvent) => options.onEvent?.(event);
  const target = checkTarget(await readTargetFacts(host));
  const paths = await resolvePaths(host, options);
  const runId = `${host.now().toISOString().replace(/[-:.]/gu, "").slice(0, 15)}-${process.pid}`;

  const base = {
    schemaVersion: PROVISION_READBACK_SCHEMA_VERSION,
    manifestVersion: options.manifestVersion,
    dryRun: options.dryRun,
    target: stripTarget(target),
  } as const;

  if (!target.supported || target.key === null) {
    const readback: ProvisionReadback = {
      ...base,
      runId,
      generatedAt: host.now().toISOString(),
      resumed: false,
      items: [],
      service: emptyService(paths.home),
      server: { wanted: options.serverVersion ?? options.manifestVersion, found: null },
      providers: [],
      rootStep: null,
      userSteps: [],
      changed: false,
      ok: false,
      summary: `Not provisioned: ${target.reason} Nearest supported: ${target.nearest}. Nothing was installed.`,
      logPath: null,
    };
    throw new ProvisionRunError("unsupported", readback.summary, readback);
  }
  const key = target.key;

  // State and lock. A dry run reads the state but writes nothing.
  const previous = await readState(host, paths.statePath);
  if (options.resume && (!previous || previous.finished))
    throw new ProvisionRunError(
      "no-run-to-resume",
      "There is no unfinished provisioning run to resume; run `specwithcode provision` without --resume.",
    );
  let release: (() => Promise<void>) | null = null;
  if (!options.dryRun) {
    release = await acquireLock(host, paths.lockPath);
    if (!release)
      throw new ProvisionRunError(
        "busy",
        "Another provisioning run is in progress on this machine.",
      );
  }
  const resumed = options.resume && previous !== null;
  const state: RunState =
    resumed && previous
      ? { ...previous, finished: false }
      : {
          schemaVersion: 1,
          runId,
          startedAt: host.now().toISOString(),
          manifestVersion: options.manifestVersion,
          serverVersion: options.serverVersion ?? options.manifestVersion,
          finished: false,
          steps: {},
        };
  const wantedServer = state.serverVersion;
  const logPath = options.dryRun ? null : join(paths.provisionDir, "logs", `${state.runId}.log`);
  // Appends run in order; a log that cannot be written never fails the run.
  let logged: Promise<void> = Promise.resolve();
  const log = (line: string): Promise<void> => {
    if (!logPath) return logged;
    const text = `${host.now().toISOString()} ${line}\n`;
    logged = logged.then(() => host.appendText(logPath, text, 0o600)).catch(() => {});
    return logged;
  };
  const saveState = async () => {
    if (!options.dryRun)
      await host.writeText(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  };

  try {
    if (resumed) await log(`resuming run ${state.runId}`);
    await log(
      `provision ${options.manifestVersion} on ${target.prettyName} ${target.arch}, home ${paths.home}${options.dryRun ? " (dry run)" : ""}`,
    );
    await saveState();
    const ctx: Ctx = { host, options, target, key, paths, wantedServer, log, emit };
    const items = new Map<ProvisionItemId, ProvisionItem>();
    const put = async (item: ProvisionItem) => {
      items.set(item.id, item);
      emit({ type: "item", item });
      if (!options.dryRun && item.status !== "running") {
        state.steps[item.id] = {
          status: item.status,
          at: host.now().toISOString(),
          detail: item.detail,
        };
        await saveState();
      }
      await log(
        `${item.id}: ${item.status}${item.found ? ` (found ${item.found})` : ""}${item.detail ? ` - ${item.detail}` : ""}`,
      );
    };

    // 1. Look at everything first; this is the plan.
    const probes = await probeAll(ctx);
    for (const item of planItems(ctx, probes)) items.set(item.id, item);
    const rootPlan = buildRootPlan(ctx, probes);
    let rootStep: ProvisionRootStep | null = rootPlanIsEmpty(rootPlan)
      ? null
      : describeRootStep(ctx, rootPlan, false);
    emit({
      type: "plan",
      readback: await assemble(ctx, items, probes, rootStep, state.runId, resumed, logPath),
    });
    if (options.dryRun) {
      const readback = await assemble(ctx, items, probes, rootStep, state.runId, resumed, logPath);
      emit({ type: "done", readback });
      return readback;
    }

    // 2. Root steps, as one script.
    if (rootStep) {
      rootStep = await runRootStep(ctx, rootPlan);
      for (const id of rootStep.items) {
        const before = items.get(id)!;
        const after = await reprobe(ctx, id, probes);
        await put(
          rootStep.ran
            ? verifyItem(
                before,
                after,
                `${before.label} did not install from the root steps; see ${logPath}.`,
              )
            : { ...before, status: "needs-root", command: rootStep.command },
        );
      }
    }

    // 3. User-level packages, each verified after it changes.
    for (const [id, install] of [
      ["node", installNode],
      ["gh", installGh],
      ["claude", installClaude],
      ["codex", installCodex],
    ] as const) {
      const before = items.get(id)!;
      if (before.status !== "planned") {
        await put(before);
        continue;
      }
      await put({ ...before, status: "running" });
      try {
        await install(ctx);
        await put(
          verifyItem(
            before,
            await reprobe(ctx, id, probes),
            `${before.label} did not verify after installing.`,
          ),
        );
      } catch (error) {
        await put(failItem(before, error));
      }
    }

    // 4. The server, its service and the PATH that service gives agents.
    for (const id of ["server", "service", "service-path", "legacy-names"] as const) {
      // Re-planned now: installing the server also installs and starts its service.
      Object.assign(probes, await probeAll(ctx));
      const before = planItems(ctx, probes).find((entry) => entry.id === id)!;
      if (before.status !== "planned") {
        await put(before);
        continue;
      }
      if (id !== "server" && items.get("server")?.status === "failed") {
        await put(failItem(before, "Waits for the SpecWithCode server, which did not install."));
        continue;
      }
      await put({ ...before, status: "running" });
      try {
        const outcome = await applyServerItem(ctx, id, probes);
        await put(
          outcome ??
            verifyItem(before, await reprobe(ctx, id, probes), `${before.label} did not verify.`),
        );
      } catch (error) {
        await put(failItem(before, error));
      }
    }
    for (const id of ["git", "tailscale", "linger"] as const) {
      const item = items.get(id);
      if (item && !(rootStep?.items ?? []).includes(id)) await put(item);
    }

    // Fresh probes for the readback, so it reports what is on the machine now.
    const final = await probeAll(ctx);
    const readback = await assemble(ctx, items, final, rootStep, state.runId, resumed, logPath);
    state.finished = readback.items.every((item) => item.status !== "failed");
    await saveState();
    await log(`done: ${readback.summary}`);
    emit({ type: "done", readback });
    return readback;
  } finally {
    await release?.();
  }
}

// ---------------------------------------------------------------------------
// Readback

async function assemble(
  ctx: Ctx,
  items: Map<ProvisionItemId, ProvisionItem>,
  p: Probes,
  rootStep: ProvisionRootStep | null,
  runId: string,
  resumed: boolean,
  logPath: string | null,
): Promise<ProvisionReadback> {
  const list = [...items.values()];
  const linux = isLinux(ctx.target);
  const userSteps: ProvisionUserStep[] = [];
  if (rootStep && !rootStep.ran)
    userSteps.push({
      id: "root",
      title: `Run the root steps (${rootStep.items.join(", ")}) in this machine's terminal, then run provisioning again.`,
      command: `${rootStep.command} && specwithcode provision`,
      optional: false,
    });
  for (const entry of list)
    if (entry.status === "user-action" && entry.command)
      userSteps.push({
        id: entry.id,
        title: `${entry.label}: ${entry.detail ?? ""}`.trim(),
        command: entry.command,
        optional: false,
      });
  if (p.tailscale.found !== null && p.tailscale.state !== "Running")
    userSteps.push({
      id: "tailscale-signin",
      title: "Sign in to Tailscale with the account your main machine uses.",
      command: linux ? `sudo tailscale up --operator=${ctx.host.user}` : "open -a Tailscale",
      optional: false,
    });
  const provider = (id: string) => p.providers.find((entry) => entry.id === id);
  if (provider("claude")?.found && provider("claude")?.signedIn === false)
    userSteps.push({
      id: "claude-signin",
      title: "Sign in to Claude Code (on a VPS use an API key helper instead).",
      command: "claude",
      optional: false,
    });
  if (provider("codex")?.found && provider("codex")?.signedIn === false)
    userSteps.push({
      id: "codex-signin",
      title: "Sign in to Codex.",
      command: "codex login",
      optional: false,
    });
  if (provider("gh")?.found && provider("gh")?.signedIn === false)
    userSteps.push({
      id: "gh-signin",
      title: "Sign in to GitHub.",
      command: "gh auth login",
      optional: false,
    });
  if (ctx.options.mode === "cli")
    userSteps.push({
      id: "join",
      title:
        "Add this machine to your main one, if it is not listed there yet: run this, then paste the line it prints into Settings > Connections > Add a machine.",
      command: "specwithcode fleet invite",
      optional: false,
    });
  userSteps.push({
    id: "allow-workers",
    title:
      "On your main machine, turn on Allow workers for this machine in Settings > Connections > Your private machines.",
    command: null,
    optional: false,
  });
  if (linux && p.sleepMasked === false)
    userSteps.push({
      id: "always-on",
      title: "Keep this machine from sleeping so workers stay reachable.",
      command:
        "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
      optional: true,
    });

  const failed = list.filter((entry) => entry.status === "failed");
  const waiting = list.filter((entry) => entry.status === "needs-root");
  const changed = list.some((entry) => entry.status === "changed");
  const planned = list.filter((entry) => entry.status === "planned");
  const summary = ctx.options.dryRun
    ? planned.length === 0
      ? "Dry run: nothing to change."
      : `Dry run: would change ${planned.map((entry) => entry.id).join(", ")}. Nothing was changed.`
    : failed.length > 0
      ? `Failed: ${failed.map((entry) => entry.id).join(", ")}. Fix the problem shown, then run specwithcode provision --resume.`
      : waiting.length > 0
        ? `Waiting for root: ${waiting.map((entry) => entry.id).join(", ")}. Run ${rootStep?.command}, then provisioning again.`
        : changed
          ? `Provisioned: ${list
              .filter((entry) => entry.status === "changed")
              .map((entry) => entry.id)
              .join(", ")} changed and verified.`
          : "Nothing to change: this machine is already provisioned.";
  return {
    schemaVersion: PROVISION_READBACK_SCHEMA_VERSION,
    manifestVersion: ctx.options.manifestVersion,
    runId,
    generatedAt: ctx.host.now().toISOString(),
    dryRun: ctx.options.dryRun,
    resumed,
    target: stripTarget(ctx.target),
    items: list,
    service: { ...p.service, missingOnPath: p.servicePath.missing },
    server: { wanted: ctx.wantedServer, found: p.server.found },
    providers: p.providers,
    rootStep,
    userSteps,
    changed,
    ok: failed.length === 0 && waiting.length === 0,
    summary,
    logPath,
  };
}

// ---------------------------------------------------------------------------
// State and lock

async function readState(host: ProvisionHost, path: string): Promise<RunState | null> {
  const text = await host.readText(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as RunState;
    return parsed.schemaVersion === 1 && typeof parsed.runId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireLock(
  host: ProvisionHost,
  path: string,
): Promise<(() => Promise<void>) | null> {
  const existing = await host.readText(path);
  const pid = Number.parseInt(existing ?? "", 10);
  if (Number.isFinite(pid) && pid !== process.pid) {
    try {
      process.kill(pid, 0);
      return null;
    } catch {
      // A killed run left its lock behind.
    }
  }
  await host.writeText(path, `${process.pid}\n`, 0o600);
  return async () => {
    if ((await host.readText(path))?.trim() === String(process.pid)) await host.remove(path);
  };
}
