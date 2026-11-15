import {
  DesktopCommandLineToolActionSchema,
  DesktopCommandLineToolResultSchema,
  type DesktopCommandLineToolResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as CommandLineTool from "../../cli/commandLineTool.ts";
import { makeNodeCommandLineToolHost } from "../../cli/commandLineToolHost.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const hostFor = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  makeNodeCommandLineToolHost({
    platform: environment.platform,
    homeDirectory: environment.homeDirectory,
    appVersion: environment.appVersion,
    isPackaged: environment.isPackaged,
    resourcesPath: environment.resourcesPath,
  });

// One action at a time: two clicks must not race on the same file.
let queue: Promise<unknown> = Promise.resolve();
const serialized = <A>(task: () => Promise<A>): Promise<A> => {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
};

const toWire = (result: CommandLineTool.CommandLineToolResult): DesktopCommandLineToolResult => ({
  ok: result.ok,
  reason: result.ok ? null : result.reason,
  state: result.state,
});

export const commandLineTool = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMMAND_LINE_TOOL_CHANNEL,
  payload: DesktopCommandLineToolActionSchema,
  result: DesktopCommandLineToolResultSchema,
  handler: Effect.fn("desktop.ipc.commandLineTool")(function* (action) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const host = hostFor(environment);
    if (host === null) return yield* Effect.die(new Error("This system has no command-line tool."));
    return yield* Effect.promise(() =>
      serialized(async () => {
        switch (action) {
          case "inspect":
            return toWire({ ok: true, state: await CommandLineTool.inspect(host) });
          case "install":
            return toWire(await CommandLineTool.install(host));
          case "remove":
            return toWire(await CommandLineTool.remove(host));
          case "add-to-path":
            return toWire(await CommandLineTool.addToShellPath(host));
        }
      }),
    );
  }),
});

/** At launch: repairs the app's own command when it points at a copy of the app that is gone. */
export const repairCommandLineToolAtLaunch = Effect.fn("desktop.commandLineTool.repairAtLaunch")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const host = hostFor(environment);
    if (host === null) return;
    const outcome = yield* Effect.tryPromise(() =>
      serialized(() => CommandLineTool.repairAtLaunch(host)),
    ).pipe(Effect.orElseSucceed(() => "failed" as const));
    if (outcome !== "unchanged") {
      yield* Effect.logInfo(`specwithcode command at launch: ${outcome}`);
    }
  },
);
