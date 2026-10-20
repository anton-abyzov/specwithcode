// Standalone `specwithcode provision` for clean test machines: the same command as the
// shipped CLI, bundled into one file that needs only Node.js 22 to run.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { provisionCommand } from "../../apps/server/src/cli/provision.ts";

const cli = Command.make("specwithcode").pipe(Command.withSubcommands([provisionCommand]));

Command.run(cli, {
  version: process.env.STUDIO_PROVISION_HARNESS_VERSION ?? "0.0.0-provision",
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
