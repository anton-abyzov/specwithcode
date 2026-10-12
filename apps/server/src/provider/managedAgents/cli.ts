// @effect-diagnostics nodeBuiltinImport:off -- this module is the CLI boundary.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { resolveAgentInstructions } from "@specweave-studio/contracts";
import * as ManagedAgents from "./ManagedAgents.ts";
import {
  ManagedAgentsConfigurationError,
  parseManagedAgentsConfig,
  type ManagedAgentsConfig,
} from "./config.ts";

class ManagedAgentsCliArgumentError extends Error {}
const isConfigurationError = Schema.is(ManagedAgentsConfigurationError);

const help = `SpecWeave Studio Managed Agents beta (Anthropic API, text workflows)
  specweave-studio managed-agents status [--config <file>]
  specweave-studio managed-agents run --beta --config <file> --prompt-file <file> [--receipt <file>]

Requires ANTHROPIC_API_KEY separately from Claude Code subscription login.
Config requires enabled, environmentId, model, maxCostCents, timeoutSeconds.
Optional globalInstructions and projectInstructions are added to both lead and worker systems.
Optional responseStyle is "concise" (default) or "detailed".
Only supplied text is sent; no repository, local credential folder or Studio store is uploaded.
Runs archive their exact newly-created session and agents. Existing environments are reused.
`;

function parseArguments(args: readonly string[]) {
  const [command, ...rest] = args;
  const values: Record<string, string> = {};
  let beta = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--beta") {
      beta = true;
      continue;
    }
    if (
      !["--config", "--prompt-file", "--receipt"].includes(flag) ||
      !rest[i + 1] ||
      rest[i + 1]!.startsWith("--")
    )
      throw new ManagedAgentsCliArgumentError(
        "Unknown or incomplete Managed Agents option. Use --help.",
      );
    if (values[flag]) throw new ManagedAgentsCliArgumentError("Duplicate Managed Agents option.");
    values[flag] = rest[++i]!;
  }
  if (command !== "status" && command !== "run")
    throw new ManagedAgentsCliArgumentError("Choose managed-agents status or run.");
  return { command, values, beta };
}

/** This entry is dispatched by the shipped Studio binary; domain logic stays in the service. */
export async function runManagedAgentsCli(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  try {
    const { command, values, beta } = parseArguments(args);
    const configPath = values["--config"];
    let config: ManagedAgentsConfig | undefined;
    if (configPath) {
      let input: unknown;
      try {
        input = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
      } catch {
        throw new ManagedAgentsCliArgumentError(
          "Managed Agents config must be a readable JSON file.",
        );
      }
      config = parseManagedAgentsConfig(input);
    }
    if (command === "run" && (!config || !values["--prompt-file"]))
      throw new ManagedAgentsCliArgumentError(
        "Managed Agents run requires --config and --prompt-file.",
      );
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    const services = ManagedAgents.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(ManagedAgents.ManagedAgentsCredentials, {
            apiKey: key ? Redacted.make(key) : undefined,
          }),
        ),
      ),
    );
    if (command === "status") {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ManagedAgents.ManagedAgents).status(config);
        }).pipe(Effect.provide(services)),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const prompt = await NodeFSP.readFile(values["--prompt-file"]!, "utf8");
    let previous = "";
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ManagedAgents.ManagedAgents;
        return yield* service.run({
          config: config!,
          betaOptIn: beta,
          prompt,
          sharedInstructions: resolveAgentInstructions(config!),
          onResourceCreated: (resource) =>
            process.stderr.write(`${JSON.stringify({ resourceCreated: resource })}\n`),
          onResourceArchived: (resource, success) =>
            process.stderr.write(`${JSON.stringify({ resourceArchived: resource, success })}\n`),
          onProgress: (state) => {
            const progress = JSON.stringify({ status: state.status, runs: state.runs });
            if (progress !== previous) {
              process.stderr.write(`${progress}\n`);
              previous = progress;
            }
          },
        });
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ type: "failure" as const, message: error.message }),
          onSuccess: (receipt) => ({ type: "success" as const, receipt }),
        }),
        Effect.provide(services),
      ),
    );
    if (outcome.type === "failure") {
      process.stderr.write(`${outcome.message}\n`);
      process.exitCode = 1;
      return;
    }
    const receipt = outcome.receipt;
    const output = `${JSON.stringify(receipt, null, 2)}\n`;
    if (values["--receipt"])
      await NodeFSP.writeFile(values["--receipt"]!, output, { flag: "wx", mode: 0o600 });
    process.stdout.write(output);
    if (
      !receipt.executionComplete ||
      receipt.cleanupFailures.length ||
      !receipt.evidenceComplete ||
      receipt.threadEvidence.some((thread) => thread.failed)
    )
      process.exitCode = 2;
  } catch (error) {
    // Never serialize Effect causes or HTTP requests: their headers carry API credentials.
    let message = "Managed Agents command failed. No live result is claimed.";
    if (error instanceof ManagedAgentsCliArgumentError || isConfigurationError(error))
      message = error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
