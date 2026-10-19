/**
 * Keeps provider runtimes (ACP agents such as Copilot, the Codex app server) from starving
 * this server and from leaving their tool processes behind.
 *
 * Call `reserve` in the runtime's scope before spawning it, then the function it returns
 * with the runtime's pid. That lowers the runtime's CPU priority, so agent tool work
 * (builds, tests, video jobs) yields to the server's event loop on a saturated Mac; its
 * children inherit it. Until the scope closes, one shared process-table sample every few
 * seconds records what the runtime starts (providerDescendants). The reservation closes
 * after the runtime's own teardown (scopes close in reverse order), so the provider ends
 * gracefully first; then the recorded process groups and processes still running get
 * SIGTERM, and SIGKILL after a grace. Only macOS and Linux are supervised; elsewhere, and
 * whenever `ps` or a signal fails, it does nothing and the runtime's own teardown is
 * unchanged.
 *
 * The default does nothing, so tests and tools that spawn fake providers never sample the
 * host; the server provides `layer`.
 */
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { signalProcessGroup } from "./processGroup.ts";
import {
  PROCESS_TABLE_ARGS,
  type DescendantLedger,
  type ProcessRow,
  type ReapTarget,
  makeDescendantLedger,
  observeDescendants,
  parseProcessTable,
  reapTargets,
} from "./providerDescendants.ts";

/** Nice value for provider runtimes: below the server, above nothing the user started. */
export const PROVIDER_NICE = 10;

export type SuperviseProviderProcess = (pid: number | undefined) => Effect.Effect<void>;

export interface ProviderProcessSupervisorShape {
  readonly reserve: Effect.Effect<SuperviseProviderProcess, never, Scope.Scope>;
}

const unsupervised: ProviderProcessSupervisorShape = {
  reserve: Effect.succeed(() => Effect.void),
};

export const ProviderProcessSupervisor = Context.Reference<ProviderProcessSupervisorShape>(
  "specweave-studio/process/ProviderProcessSupervisor",
  { defaultValue: () => unsupervised },
);

export interface ProviderProcessHost {
  readonly platform: NodeJS.Platform;
  readonly serverPid: number;
  /** The process table, or undefined when it could not be read. */
  readonly readTable: Effect.Effect<ReadonlyArray<ProcessRow> | undefined>;
  readonly signal: (target: ReapTarget, signal: NodeJS.Signals) => void;
  readonly setNice: (pid: number, nice: number) => void;
}

export interface ProviderProcessSupervisorOptions {
  readonly sampleInterval?: Duration.Input;
  readonly grace?: Duration.Input;
}

const describeTargets = (targets: ReadonlyArray<ReapTarget>) => ({
  groups: targets.filter((target) => target.kind === "group").length,
  processes: targets.filter((target) => target.kind === "process").length,
});

export const make = Effect.fn("ProviderProcessSupervisor.make")(function* (
  host: ProviderProcessHost,
  options: ProviderProcessSupervisorOptions = {},
) {
  if (host.platform !== "darwin" && host.platform !== "linux") {
    return unsupervised;
  }
  const ledgers = new Set<DescendantLedger>();
  const lower = (pid: number) => {
    try {
      host.setNice(pid, PROVIDER_NICE);
    } catch {
      // Exited already, or not ours to change: leave it as it is.
    }
  };
  const signalAll = (targets: ReadonlyArray<ReapTarget>, signal: NodeJS.Signals) => {
    for (const target of targets) {
      try {
        host.signal(target, signal);
      } catch {
        // Gone since the sample (ESRCH) or not ours (EPERM).
      }
    }
  };
  // The server's group is read from the same sample; without it nothing is recorded or
  // signalled, since it could not be told apart from the provider's.
  const readSample = Effect.map(host.readTable, (table) => {
    const serverPgid = table?.find((row) => row.pid === host.serverPid)?.pgid;
    return table === undefined || serverPgid === undefined ? undefined : { table, serverPgid };
  });
  const observe = (
    ledger: DescendantLedger,
    sample: { table: ReadonlyArray<ProcessRow>; serverPgid: number },
  ) => {
    for (const row of observeDescendants(ledger, sample.table, sample.serverPgid)) {
      // Children inherit the runtime's priority; this catches ones forked before it was lowered.
      if (row.pid !== ledger.rootPid && row.nice < PROVIDER_NICE) lower(row.pid);
    }
  };

  const sampleAll = Effect.gen(function* () {
    if (ledgers.size === 0) return;
    const sample = yield* readSample;
    if (sample === undefined) return;
    for (const ledger of ledgers) observe(ledger, sample);
  });
  yield* sampleAll.pipe(
    Effect.andThen(Effect.sleep(options.sampleInterval ?? "2 seconds")),
    Effect.forever,
    Effect.forkScoped,
  );

  const reap = Effect.fn("ProviderProcessSupervisor.reap")(function* (ledger: DescendantLedger) {
    const first = yield* readSample;
    if (first === undefined) return;
    observe(ledger, first);
    const server = { pid: host.serverPid, pgid: first.serverPgid };
    const targets = reapTargets(ledger, first.table, server);
    if (targets.length === 0) return;
    signalAll(targets, "SIGTERM");
    yield* Effect.sleep(options.grace ?? "2 seconds");
    const second = yield* readSample;
    if (second === undefined) return;
    observe(ledger, second);
    const survivors = reapTargets(ledger, second.table, {
      pid: host.serverPid,
      pgid: second.serverPgid,
    });
    signalAll(survivors, "SIGKILL");
    yield* Effect.logInfo("Stopped processes a provider runtime left running", {
      rootPid: ledger.rootPid,
      terminated: describeTargets(targets),
      killed: describeTargets(survivors),
    });
  });

  return ProviderProcessSupervisor.of({
    reserve: Effect.gen(function* () {
      const reservation = yield* Scope.fork(yield* Scope.Scope);
      return (pid: number | undefined) =>
        Effect.gen(function* () {
          if (
            pid === undefined ||
            !Number.isSafeInteger(pid) ||
            pid <= 1 ||
            pid === host.serverPid
          ) {
            return;
          }
          lower(pid);
          const ledger = makeDescendantLedger(pid);
          ledgers.add(ledger);
          yield* Scope.addFinalizer(
            reservation,
            reap(ledger).pipe(Effect.ensuring(Effect.sync(() => ledgers.delete(ledger)))),
          );
        });
    }),
  });
});

const PS_COMMAND: Partial<Record<NodeJS.Platform, string>> = { darwin: "/bin/ps", linux: "ps" };

/** This host: `ps` for the table, POSIX signals, and `setpriority` for nice values. */
export const makeHost = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = PS_COMMAND[platform] ?? "ps";
  const host: ProviderProcessHost = {
    platform,
    serverPid: process.pid,
    readTable: spawner
      .string(
        ChildProcess.make(command, [...PROCESS_TABLE_ARGS], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.map(parseProcessTable),
        Effect.orElseSucceed(() => undefined),
      ),
    signal: (target, signal) =>
      target.kind === "group"
        ? signalProcessGroup(target.pgid, signal)
        : process.kill(target.pid, signal),
    setNice: (pid, nice) => NodeOS.setPriority(pid, nice),
  };
  return host;
});

export const layer = Layer.effect(
  ProviderProcessSupervisor,
  Effect.flatMap(makeHost, (host) => make(host)),
);
