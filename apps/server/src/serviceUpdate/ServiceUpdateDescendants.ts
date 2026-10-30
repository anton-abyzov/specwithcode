/**
 * The processes still running under this service after a drain, other than the
 * ones the update helper accepts there.
 *
 * `scripts/studio-fleet/quiescence.py` refuses an install while anything runs
 * beneath the service except its supervisor (`caffeinate`), its own headless
 * server browser with that browser's helpers, and its own Connect tunnel
 * (`cloudflared`). Agent processes the drain closes can take a moment to exit,
 * and a refusal costs the install another snapshot, so the drain waits briefly
 * for them (`settleDescendants`) and reports what is left. The helper's own
 * check stays the authority: it also proves each process's identity, which this
 * count does not.
 *
 * @module ServiceUpdateDescendants
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface DescendantRow {
  readonly pid: number;
  readonly ppid: number;
  /** `ps` comm: on macOS the path of the file the process runs. */
  readonly executable: string;
}

/** `ps -ww -axo pid=,ppid=,comm=`, the inventory quiescence.py reads (without owner and start). */
export const DESCENDANT_TABLE_ARGS = ["-ww", "-axo", "pid=,ppid=,comm="] as const;

const ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/;

export function parseDescendantTable(output: string): ReadonlyArray<DescendantRow> {
  const rows: Array<DescendantRow> = [];
  for (const line of output.split("\n")) {
    const match = ROW_PATTERN.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), executable: match[3] ?? "" });
  }
  return rows;
}

const basename = (executable: string) => executable.slice(executable.lastIndexOf("/") + 1);

/**
 * What the helper accepts directly beneath the service: the supervisor, the
 * server browser (its helpers descend from it) and the tunnel. The `ps` this
 * module runs to look is a child too, and the resource monitor is a sidecar
 * the drain does not end.
 */
const ACCEPTED_CHILDREN: ReadonlySet<string> = new Set([
  "caffeinate",
  "chrome-headless-shell",
  "cloudflared",
  "ps",
  "studio-resource-monitor",
]);

/**
 * The descendants of `rootPid` the helper would refuse: every process beneath
 * it except an accepted direct child (`ACCEPTED_CHILDREN`) and what descends
 * from that child.
 */
export function leftoverDescendants(
  rows: ReadonlyArray<DescendantRow>,
  rootPid: number,
): ReadonlyArray<DescendantRow> {
  const children = new Map<number, Array<DescendantRow>>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const left: Array<DescendantRow> = [];
  const seen = new Set<number>([rootPid]);
  const pending = (children.get(rootPid) ?? []).filter(
    (child) => !ACCEPTED_CHILDREN.has(basename(child.executable)),
  );
  while (pending.length > 0) {
    const row = pending.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    left.push(row);
    pending.push(...(children.get(row.pid) ?? []));
  }
  return left.toSorted((a, b) => a.pid - b.pid);
}

export class ServiceUpdateDescendants extends Context.Service<
  ServiceUpdateDescendants,
  {
    /** How many processes beneath this server the helper would refuse; none when unreadable. */
    readonly countLeftover: Effect.Effect<Option.Option<number>>;
  }
>()("specweave-studio/serviceUpdate/ServiceUpdateDescendants") {}

/**
 * Looks until nothing the helper would refuse is left beneath the service, at
 * most `budgetMs`; the count still left then, or none when it cannot be read.
 */
export const settleDescendants = (
  countLeftover: Effect.Effect<Option.Option<number>>,
  budgetMs: number,
  pollMs: number,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    while (true) {
      const left = yield* countLeftover.pipe(
        Effect.timeoutOption(Duration.millis(Math.max(pollMs, budgetMs))),
        Effect.map(Option.flatten),
      );
      if (Option.isNone(left) || left.value === 0) return left;
      if ((yield* Clock.currentTimeMillis) >= deadline) return left;
      yield* Effect.sleep(Duration.millis(pollMs));
    }
  });

/** Reads the process table on macOS, where the helper checks the tree; elsewhere nothing. */
export const layer = Layer.effect(
  ServiceUpdateDescendants,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (platform !== "darwin")
      return ServiceUpdateDescendants.of({ countLeftover: Effect.succeedNone });
    return ServiceUpdateDescendants.of({
      countLeftover: spawner
        .string(
          ChildProcess.make("/bin/ps", [...DESCENDANT_TABLE_ARGS], {
            stdin: "ignore",
            stderr: "ignore",
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          }),
        )
        .pipe(
          Effect.map((output) =>
            Option.some(leftoverDescendants(parseDescendantTable(output), process.pid).length),
          ),
          Effect.orElseSucceed(() => Option.none<number>()),
        ),
    });
  }),
);
