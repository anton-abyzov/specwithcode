import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  ThreadId,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { agentWorkCgroup, type AgentWorkCgroup } from "./agentWorkCgroup.ts";
import { pageBytesFrom, parseProcessStat } from "./MemoryGuard.ts";

/**
 * When agent work passes its memory limit (AgentMemoryLimit) the kernel ends
 * the largest agent process. The harness that started it sees only "Killed",
 * so the thread is told what was ended and why.
 *
 * The kernel says how many it ended (`oom_kill` in `memory.events`), not which.
 * While agent work is near its limit, every pass records the largest agent
 * processes and the thread each belongs to; when the count rises, the
 * recorded ones that are gone are the ones ended.
 */

const PASS_INTERVAL = "2 seconds";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** Below this share of the limit nothing can be close to being ended. */
const WATCH_FROM_SHARE = 0.5;
/** Smaller processes are never the ones the kernel picks. */
const MIN_RECORDED_BYTES = 128 * MIB;
const RECORDED = 8;
/** At most one message per thread in this time. */
const PER_THREAD_MS = 60_000;
const THREAD_ID_ENV = "SPECWEAVE_STUDIO_THREAD_ID";
const COMMAND_CHARS = 160;
export const AGENT_MEMORY_NOTICE_PREFIX = "agent-memory-notice:";

export interface RecordedProcess {
  readonly pid: number;
  readonly startTime: string;
  readonly rssBytes: number;
  readonly command: string;
  readonly threadId: string | undefined;
}

export function parseOomKills(events: string): number | null {
  const match = /^oom_kill (\d+)$/m.exec(events)?.[1];
  return match === undefined ? null : Number(match);
}

/** The command line as a person would type it, cut to a readable length. */
export function commandOf(cmdline: string, comm: string): string {
  const words = cmdline.split("\0").filter((word) => word !== "");
  const text = words.length === 0 ? comm : words.join(" ");
  return text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS - 3)}...` : text;
}

export function threadIdOf(environ: string): string | undefined {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(`${THREAD_ID_ENV}=`)) {
      const value = entry.slice(THREAD_ID_ENV.length + 1);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / MIB)} MB`;

export function agentMemoryNotice(input: {
  readonly ended: RecordedProcess;
  readonly limitBytes: number;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { ended, limitBytes } = input;
  const limit = formatBytes(limitBytes);
  return {
    text: [
      `SpecWithCode ended \`${ended.command}\` (process ${ended.pid}, ${formatBytes(ended.rssBytes)})`,
      `because agent work on this machine reached its memory limit of ${limit}.`,
      "The limit keeps the machine and SpecWithCode answering while checks run.",
      "Run fewer heavy checks at once (typechecks, builds, test suites), then run it again.",
    ].join(" "),
    notification: {
      source: { kind: "command" },
      outcome: "failed",
      summary: `A command was ended: agent work reached its memory limit of ${limit}.`,
    },
  };
}

export interface AgentMemoryNoticeOptions {
  readonly procRoot?: string;
  readonly group?: () => AgentWorkCgroup | undefined;
  readonly notify: (ended: RecordedProcess, limitBytes: number) => Effect.Effect<void>;
}

export const makeAgentMemoryNotice = Effect.fn("makeAgentMemoryNotice")(function* (
  options: AgentMemoryNoticeOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const procRoot = options.procRoot ?? "/proc";
  const group = options.group ?? agentWorkCgroup;
  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const pageBytes = pageBytesFrom(
    yield* readText(`${procRoot}/self/status`),
    yield* readText(`${procRoot}/self/statm`),
  );
  const state: {
    groupPath: string | undefined;
    kills: number | null;
    recorded: ReadonlyArray<RecordedProcess>;
    /** pid:startTime of processes already described, so each is read once. */
    known: Map<string, Pick<RecordedProcess, "command" | "threadId">>;
    toldAt: Map<string, number>;
  } = { groupPath: undefined, kills: null, recorded: [], known: new Map(), toldAt: new Map() };

  /** Every process in the group and in the session groups below it. */
  const pidsUnder = (path: string): Effect.Effect<ReadonlyArray<number>> =>
    Effect.gen(function* () {
      const own = (yield* readText(`${path}/cgroup.procs`))
        .split("\n")
        .flatMap((line) => (/^\d+$/.test(line) ? [Number(line)] : []));
      const names = yield* fs.readDirectory(path).pipe(Effect.orElseSucceed(() => []));
      const children = yield* Effect.forEach(
        names.filter((name) => !name.includes(".")),
        (name) => pidsUnder(`${path}/${name}`),
      );
      return [...own, ...children.flat()];
    });

  const record = (path: string) =>
    Effect.gen(function* () {
      const pids = yield* pidsUnder(path);
      const entries = yield* Effect.forEach(
        pids,
        (pid) => readText(`${procRoot}/${pid}/stat`).pipe(Effect.map((stat) => parseProcessStat(stat, pageBytes))),
        { concurrency: 16 },
      );
      const largest = entries
        .flatMap((entry) => (entry !== null && entry.rssBytes >= MIN_RECORDED_BYTES ? [entry] : []))
        .toSorted((a, b) => b.rssBytes - a.rssBytes)
        .slice(0, RECORDED);
      const live = new Set(largest.map((entry) => `${entry.pid}:${entry.startTime}`));
      for (const key of state.known.keys()) if (!live.has(key)) state.known.delete(key);
      state.recorded = yield* Effect.forEach(largest, (entry) =>
        Effect.gen(function* () {
          const key = `${entry.pid}:${entry.startTime}`;
          let described = state.known.get(key);
          if (described === undefined) {
            described = {
              command: commandOf(yield* readText(`${procRoot}/${entry.pid}/cmdline`), entry.comm),
              threadId: threadIdOf(yield* readText(`${procRoot}/${entry.pid}/environ`)),
            };
            state.known.set(key, described);
          }
          return { pid: entry.pid, startTime: entry.startTime, rssBytes: entry.rssBytes, ...described };
        }),
      );
    });

  const isGone = (recorded: RecordedProcess) =>
    readText(`${procRoot}/${recorded.pid}/stat`).pipe(
      Effect.map((stat) => parseProcessStat(stat)?.startTime !== recorded.startTime),
    );

  const pass = Effect.gen(function* () {
    const current = group();
    if (current === undefined) {
      state.groupPath = undefined;
      return;
    }
    if (state.groupPath !== current.path) {
      state.groupPath = current.path;
      state.kills = null;
      state.recorded = [];
    }
    const kills = parseOomKills(yield* readText(`${current.path}/memory.events`));
    if (kills !== null && state.kills !== null && kills > state.kills) {
      const gone = yield* Effect.forEach(state.recorded, isGone);
      const ended = state.recorded.filter((_, index) => gone[index]);
      const now = yield* Clock.currentTimeMillis;
      if (ended.length === 0) {
        yield* Effect.logWarning("agent work passed its memory limit; the kernel ended a process", {
          kills: kills - state.kills,
          limitBytes: current.limitBytes,
        });
      }
      for (const victim of ended) {
        yield* Effect.logWarning("agent work passed its memory limit; the kernel ended a process", {
          pid: victim.pid,
          command: victim.command,
          rssBytes: victim.rssBytes,
          threadId: victim.threadId,
          limitBytes: current.limitBytes,
        });
        if (victim.threadId === undefined) continue;
        if (now - (state.toldAt.get(victim.threadId) ?? Number.NEGATIVE_INFINITY) < PER_THREAD_MS) {
          continue;
        }
        state.toldAt.set(victim.threadId, now);
        yield* options.notify(victim, current.limitBytes);
      }
      state.recorded = state.recorded.filter((each) => !ended.includes(each));
    }
    if (kills !== null) state.kills = kills;
    const used = Number((yield* readText(`${current.path}/memory.current`)).trim());
    if (Number.isFinite(used) && used >= current.limitBytes * WATCH_FROM_SHARE) {
      yield* record(current.path);
    } else {
      state.recorded = [];
    }
  });

  return { pass, state };
});

export const start = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) !== "linux") return;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const notify = (ended: RecordedProcess, limitBytes: number) =>
    Effect.gen(function* () {
      if (ended.threadId === undefined) return;
      const threadId = ThreadId.make(ended.threadId);
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) return;
      const message = agentMemoryNotice({ ended, limitBytes });
      // One message per ended process: the orchestrator ignores a command id it already took.
      const id = `${AGENT_MEMORY_NOTICE_PREFIX}${ended.pid}:${ended.startTime}`;
      yield* threads.sendToThread({
        projectId: thread.projectId,
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: message.text,
        notification: message.notification,
        attachments: [],
        // Steers the run that is waiting on the command, else starts one to say what happened.
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not tell a thread its command was ended.", {
          threadId: ended.threadId,
          cause,
        }),
      ),
    );
  const notice = yield* makeAgentMemoryNotice({ notify });
  yield* forkParked(
    notice.pass.pipe(
      Effect.catchCause((cause) => Effect.logWarning("agent memory notice pass failed", { cause })),
      Effect.andThen(Effect.sleep(PASS_INTERVAL)),
      Effect.forever,
    ),
  );
});
