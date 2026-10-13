// @effect-diagnostics nodeBuiltinImport:off - resolves the repository's scripts directory from this file.
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as Hold from "./ServiceUpdateHold.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";
import * as Gate from "./UpdateInstallGate.ts";

const serverSource = (name: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.readFileString(NodeURL.fileURLToPath(new URL(`../${name}`, import.meta.url))),
  );

const fleetScript = (name: string) =>
  NodeURL.fileURLToPath(new URL(`../../../../scripts/studio-fleet/${name}`, import.meta.url));

/** The quoted words in `text`, in order. */
const quotedWords = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]!);

const readScript = (name: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.readFileString(fleetScript(name)),
  );

const sorted = (values: ReadonlyArray<string>) => [...values].toSorted();

it.effect("mirrors the idle check in update.py", () =>
  Effect.gen(function* () {
    const source = yield* readScript("update.py");
    const terminalRuns = source.match(/^TERMINAL_RUNS = \{([^}]*)\}/m);
    assert.isNotNull(terminalRuns);
    assert.deepEqual(
      sorted(quotedWords(terminalRuns![1]!)),
      sorted(Preparation.TERMINAL_RUN_STATUSES),
    );

    const effects = source.match(
      /FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN \(([^)]*)\)/,
    );
    assert.isNotNull(effects);
    assert.deepEqual(
      sorted(quotedWords(effects![1]!)),
      sorted(Preparation.TERMINAL_EFFECT_STATUSES),
    );

    const sessions = source.match(
      /FROM orchestration_v2_projection_provider_sessions WHERE status IN \(([^)]*)\)/,
    );
    assert.isNotNull(sessions);
    assert.deepEqual(
      sorted(quotedWords(sessions![1]!)),
      sorted(Preparation.WORKING_SESSION_STATUSES),
    );
    assert.deepEqual(
      sorted(Cleanup.WORKING_SESSION_STATUSES),
      sorted(Preparation.WORKING_SESSION_STATUSES),
    );
    // The requests check counts `pending` rows only, which the cleanup cancels.
    assert.include(
      source,
      "FROM orchestration_v2_projection_runtime_requests WHERE status='pending'",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads the request and the agent's answer where the update agent keeps them", () =>
  Effect.gen(function* () {
    const source = yield* readScript("update_agent.py");
    const statuses = source.match(/^STATUSES = \(([^)]*)\)/m);
    assert.isNotNull(statuses);
    const agentStatuses = quotedWords(statuses![1]!);
    for (const status of Hold.AGENT_BUSY_STATUSES) assert.include(agentStatuses, status);
    // The agent keeps its state and settings where the hold reads them.
    assert.include(source, "self.state_path = self.updates / 'state.json'");
    assert.include(source, "self.updates = self.own / 'updates'");
    assert.include(source, "path = updates / 'config.json'");
    // A request is settled when the agent copies it into handledInstallRequestAt.
    assert.include(source, "state['handledInstallRequestAt'] = config['installRequestedAt']");
    assert.include(
      source,
      "self.state['handledInstallRequestAt'] = self.config['installRequestedAt']",
    );
    assert.include(
      source,
      "hold = parse_time(self.config['installHoldUntil']) if self.config['installMode'] == 'force' else None",
    );
    // The timings the hold follows a forced pass by.
    const seconds = (name: string) => {
      const found = source.match(new RegExp(`^${name} = (\\d+)$`, "m"));
      assert.isNotNull(found, name);
      return Number(found![1]) * 1000;
    };
    assert.equal(seconds("SNAPSHOT_TIMEOUT"), Hold.AGENT_SNAPSHOT_TIMEOUT_MS);
    assert.equal(seconds("RETRY_SECONDS"), Hold.AGENT_RETRY_MS);
    assert.isAtMost(
      15 * 60_000 + seconds("APPLY_TIMEOUT"),
      Hold.HOLD_MAX_MS,
      "the ceiling covers the retry window and one install",
    );
    assert.include(source, "FORCE_WINDOW = datetime.timedelta(minutes=15)");
    assert.include(source, `'${Hold.AGENT_APPLY_RETRY_MESSAGE}'`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finds a finished turn's checkpoint under the command its run enqueues", () =>
  Effect.gen(function* () {
    const source = yield* serverSource("orchestration-v2/RunExecutionService.ts");
    assert.include(source, `\`${Cleanup.CHECKPOINT_CAPTURE_COMMAND_PREFIX}\${input.run.id}\``);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads the install gate where update.py writes it, for no longer than the helper runs",
  () =>
    Effect.gen(function* () {
      const helper = yield* readScript("update.py");
      assert.include(helper, `INSTALL_GATE_FILE = '${Gate.INSTALL_GATE_FILE}'`);
      assert.include(helper, "return safe_path(own / 'updates' / INSTALL_GATE_FILE, home)");
      const seconds = (source: string, name: string) => {
        const found = source.match(new RegExp(`^${name} = (\\d+)$`, "m"));
        assert.isNotNull(found, name);
        return Number(found![1]) * 1000;
      };
      assert.equal(seconds(helper, "INSTALL_GATE_MAX_SECONDS"), Gate.INSTALL_GATE_MAX_MS);
      // No helper runs longer than the gate lasts: the agent kills it at APPLY_TIMEOUT,
      // and the helper caps any budget it is given.
      const agent = yield* readScript("update_agent.py");
      assert.isAtMost(seconds(agent, "APPLY_TIMEOUT"), Gate.INSTALL_GATE_MAX_MS);
      const cap = helper.match(/^APPLY_BUDGET_SECONDS = min\((\d+), /m);
      assert.isNotNull(cap);
      assert.isAtMost(Number(cap![1]) * 1000, Gate.INSTALL_GATE_MAX_MS);
    }).pipe(Effect.provide(NodeServices.layer)),
);
