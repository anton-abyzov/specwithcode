// @effect-diagnostics nodeBuiltinImport:off - the sweep's steps are plain async I/O; Effect runs the loop.
/**
 * The readiness check after an app update. When the server starts on a
 * version this machine has not checked yet, it waits for a quiet moment (no
 * run, queued turn, question or tool call in flight), then installs what the
 * app can install with no admin password and is missing: Node.js, the GitHub
 * CLI and SpecWeave, and replaces the app's own copies older than the new
 * pins. It never installs Git (an installer that asks for permission), never
 * touches tools the person installed, and never starts while work runs: it
 * checks again every few minutes until the machine is quiet. What it did is
 * kept in `<home>/provision/readiness.json`, which the machine check reports.
 */
import type {
  MachineReadinessSweep,
  MachineReadinessToolId,
  MachineToolsCheck,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodePath from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { makeNodeProvisionHost } from "../provision/host.ts";
import { TERMINAL_RUN_STATUSES } from "../serviceUpdate/ServiceUpdatePreparation.ts";
import { checkMachineTools, machineToolName } from "./machineTools.ts";
import {
  machineToolsContext,
  readinessFile,
  readSweepState,
  startInstall,
  type MachineToolsContextServices,
} from "./runtime.ts";

/** After start: resumed threads get going first, and first-run setup gets its turn. */
export const SWEEP_START_DELAY = Duration.minutes(2);
export const SWEEP_RETRY = Duration.minutes(5);
const SWEEP_ORDER: ReadonlyArray<MachineReadinessToolId> = ["node", "gh", "specweave"];

/** What the sweep installs: what is missing or the app's own older copy, never Git. */
export function sweepTargets(check: MachineToolsCheck): ReadonlyArray<MachineReadinessToolId> {
  return SWEEP_ORDER.filter((tool) => {
    const status = check.tools?.find((entry) => entry.tool === tool);
    return (
      status !== undefined &&
      status.canInstall &&
      (status.presence === "missing" || (status.outdated && status.managed))
    );
  });
}

export interface SweepDeps {
  readonly version: string;
  /** The current time as an ISO string. */
  readonly now: () => string;
  readonly read: () => Promise<MachineReadinessSweep | null>;
  readonly write: (state: MachineReadinessSweep) => Promise<void>;
  /** True while any work runs on this machine. */
  readonly busy: () => Promise<boolean>;
  readonly check: () => Promise<MachineToolsCheck>;
  /** Resolves with null when installed, or why not; "busy" when another install holds the machine. */
  readonly install: (tool: MachineReadinessToolId) => Promise<string | null>;
}

/**
 * One pass. `skipped`: this version was already checked. `waiting`: work runs
 * or another install holds the machine, so the caller tries again later.
 */
export async function sweepOnce(deps: SweepDeps): Promise<"skipped" | "waiting" | "done"> {
  const previous = await deps.read();
  if (previous !== null && previous.version === deps.version && previous.state !== "waiting")
    return "skipped";
  const record = (
    state: MachineReadinessSweep["state"],
    installed: ReadonlyArray<MachineReadinessToolId>,
    detail: string | null,
  ) =>
    deps.write({
      version: deps.version,
      at: deps.now(),
      state,
      installed: [...installed],
      detail,
    });
  const waiting = async (installed: ReadonlyArray<MachineReadinessToolId>) => {
    await record("waiting", installed, "Work is running on this machine, so the check waits.");
    return "waiting" as const;
  };
  // What an earlier waiting pass for this version installed still counts.
  const installed: MachineReadinessToolId[] =
    previous?.version === deps.version ? [...previous.installed] : [];
  if (await deps.busy()) return waiting(installed);
  const failures: string[] = [];
  for (const tool of sweepTargets(await deps.check())) {
    if (await deps.busy()) return waiting(installed);
    const problem = await deps.install(tool);
    if (problem === "busy") return waiting(installed);
    if (problem === null) installed.push(tool);
    else failures.push(`${machineToolName(tool)}: ${problem}`);
  }
  await record(
    failures.length === 0 ? "done" : "failed",
    installed,
    failures.length === 0 ? null : failures.join(" ").slice(0, 1900),
  );
  return "done";
}

const TERMINAL_RUNS_SQL = TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

/** Any run not finished (queued turns held by a person aside), or a question or tool call pending. */
export const BUSY_SQL = `
  SELECT
    (SELECT COUNT(*) FROM orchestration_v2_projection_runs
      WHERE status NOT IN (${TERMINAL_RUNS_SQL})
        AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1))
  + (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending')
  AS count`;

/**
 * Whether this server sweeps: an installed app does; a development server, CI
 * and test servers do not (they would download into throwaway homes), and
 * STUDIO_READINESS_SWEEP=off turns it off anywhere.
 */
export function sweepEnabled(
  env: Readonly<Record<string, string | undefined>>,
  devUrl: URL | undefined,
): boolean {
  const flag = env["STUDIO_READINESS_SWEEP"]?.trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  if (flag === "on" || flag === "1" || flag === "true") return true;
  const ci = env["CI"]?.trim().toLowerCase();
  if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") return false;
  return devUrl === undefined;
}

/** Starts the sweep in the background; it ends once this version is checked. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // oxlint-disable-next-line studio/no-global-process-runtime -- the server's own environment decides.
    if (!sweepEnabled(process.env, config.devUrl)) return;
    const sql = yield* SqlClient.SqlClient;
    const services = yield* Effect.context<MachineToolsContextServices>();
    const home = config.baseDir;
    const host = makeNodeProvisionHost();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const busy = () =>
      run(
        sql.unsafe<{ readonly count: number }>(BUSY_SQL).pipe(
          Effect.map((rows) => Number(rows[0]?.count ?? 0) > 0),
          // An unreadable projection counts as busy: never install over work.
          Effect.orElseSucceed(() => true),
        ),
      );
    const fresh = () => Effect.runPromiseWith(services)(machineToolsContext);
    const deps: SweepDeps = {
      version: packageJson.version,
      now: () => DateTime.formatIso(DateTime.nowUnsafe()),
      read: () => readSweepState(host, home),
      write: async (state) => {
        const file = readinessFile(home, host.platform);
        await host.mkdirp(
          (host.platform === "win32" ? NodePath.win32 : NodePath.posix).dirname(file),
        );
        await host.writeText(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      },
      busy,
      check: async () => {
        const { ctx: now, git } = await fresh();
        return checkMachineTools(now, git);
      },
      install: async (tool) => {
        const { ctx: now, git } = await fresh();
        const lines: string[] = [];
        const started = startInstall(now, tool, git, (line) => lines.push(line));
        if ("busyWith" in started) return "busy";
        try {
          await started.run;
          return null;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return /setting this machine up right now/u.test(message) ? "busy" : message;
        }
      },
    };
    const pass = Effect.tryPromise(() => sweepOnce(deps)).pipe(
      Effect.orElseSucceed(() => "waiting" as const),
    );
    yield* Effect.sleep(SWEEP_START_DELAY).pipe(
      Effect.andThen(pass),
      Effect.flatMap((first) =>
        first === "waiting"
          ? Effect.sleep(SWEEP_RETRY).pipe(
              Effect.andThen(pass),
              Effect.repeat({ while: (result) => result === "waiting" }),
            )
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.forkScoped,
    );
  }),
);
