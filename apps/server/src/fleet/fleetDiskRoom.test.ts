import { AuthOrchestrationReadScope, EnvironmentId } from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real key file for the link.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  ProcessOutputLimitError,
  ProcessSpawnError,
  ProcessTimeoutError,
} from "../processRunner.ts";
import {
  DISK_ROOM_TIMEOUT,
  makeFleetDiskRoom,
  resolveDiskRoomHelper,
  runFleetDiskRoom,
} from "./fleetDiskRoom.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import { makeFleetAddressBook, makeFleetLink } from "./fleetTransport.ts";

// ---------------------------------------------------------------------------
// The worker: this release's disk_room.py behind a fake process runner
// ---------------------------------------------------------------------------

const SCRIPT = "/opt/specwithcode/runtime/studio-updater/disk_room.py";

const report = (fields: Record<string, unknown>) => ({
  identity: "m1",
  version: "1.0.190",
  freeBytes: 50 * 1024 ** 3,
  needBytes: 12 * 1024 ** 3,
  parts: { fallback: 10 * 1024 ** 3, backup: 1024 ** 3, staged: 1024 ** 3 },
  ok: true,
  volume: "/",
  ...fields,
});

const output = (
  stdout: string,
  code: number,
  timedOut = false,
): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function worker(options: {
  readonly answer?: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly script?: string | null;
  readonly identity?: string | null;
}) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const service = makeFleetDiskRoom({
    identity: options.identity === undefined ? "m1" : options.identity,
    script: Effect.succeed(options.script === undefined ? SCRIPT : options.script),
    run: (input) => {
      calls.push(input);
      return options.answer ?? Effect.succeed(output(JSON.stringify(report({})), 0));
    },
  });
  return { calls, service };
}

const ask = (service: ReturnType<typeof worker>["service"]) =>
  service.report({ version: "1.0.190", fullRead: "69,73" }).pipe(Effect.result);

describe("a machine reporting its disk room to its fleet primary", () => {
  it.effect("runs only its own release's disk_room.py with the version and FULL_READ numbers", () =>
    Effect.gen(function* () {
      const { calls, service } = worker({});
      expect(yield* ask(service)).toMatchObject({
        _tag: "Success",
        success: { workerIdentity: "m1", identity: "m1", ok: true, needBytes: 12 * 1024 ** 3 },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/usr/bin/python3",
        args: [
          "-B",
          "-E",
          "-s",
          SCRIPT,
          "--identity",
          "m1",
          "--version",
          "1.0.190",
          "--full-read",
          "69,73",
          "--json",
        ],
        timeout: DISK_ROOM_TIMEOUT,
        maxOutputBytes: 64 * 1024,
      });
    }),
  );

  it.effect("answers a machine short of disk (exit 1) with its report, not a failure", () =>
    Effect.gen(function* () {
      const { service } = worker({
        answer: Effect.succeed(
          output(`checking\n${JSON.stringify(report({ ok: false, freeBytes: 1024 }))}\n`, 1),
        ),
      });
      expect(yield* ask(service)).toMatchObject({
        _tag: "Success",
        success: { ok: false, freeBytes: 1024, workerIdentity: "m1" },
      });
    }),
  );

  it.effect("fails with the check's own words when it cannot tell (exit 2)", () =>
    Effect.gen(function* () {
      const error = { identity: "m1", version: "1.0.190", error: "No database for m1." };
      const { service } = worker({ answer: Effect.succeed(output(JSON.stringify(error), 2)) });
      expect(yield* ask(service)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "failed", message: "No database for m1." },
      });
    }),
  );

  it.effect("fails on a timed-out run, a runner timeout or no JSON", () =>
    Effect.gen(function* () {
      const timeout = new ProcessTimeoutError({
        command: "/usr/bin/python3",
        argumentCount: 11,
        timeoutMs: 1,
      });
      for (const [answer, message] of [
        [Effect.succeed(output("", 0, true)), "The disk room check did not answer in time."],
        [Effect.fail(timeout), "The disk room check did not answer in time."],
        [
          Effect.succeed(output("Traceback (most recent call last):", 1)),
          "The disk room check gave no report.",
        ],
      ] as const) {
        const { service } = worker({ answer });
        expect(yield* ask(service)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "failed", message },
        });
      }
    }),
  );

  it.effect("names a check it could not start or that printed too much, never as a timeout", () =>
    Effect.gen(function* () {
      const invocation = { command: "/usr/bin/python3", argumentCount: 11 };
      for (const [error, message] of [
        [
          new ProcessSpawnError({ ...invocation, cause: new Error("ENOENT") }),
          "The disk room check could not start /usr/bin/python3 here.",
        ],
        [
          new ProcessOutputLimitError({
            ...invocation,
            stream: "stdout",
            maxBytes: 65536,
            observedBytes: 70000,
          }),
          "The disk room check printed more output than it may.",
        ],
      ] as const) {
        const { service } = worker({ answer: Effect.fail(error) });
        expect(yield* ask(service)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "failed", message },
        });
      }
    }),
  );

  it.effect("is unsupported without a shipped disk_room.py or an identity, and runs nothing", () =>
    Effect.gen(function* () {
      for (const [script, identity] of [
        [null, "m1"],
        [SCRIPT, null],
        // Identities the server accepts that disk_room.py never would.
        [SCRIPT, "M1"],
        [SCRIPT, "mbp.home"],
        [SCRIPT, "3studio"],
      ] as const) {
        const { calls, service } = worker({ script, identity });
        expect(yield* ask(service)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unsupported" },
        });
        expect(calls).toHaveLength(0);
      }
    }),
  );

  it.effect(
    "finds no helper off macOS and Linux, as root, or without a trusted release folder",
    () =>
      Effect.gen(function* () {
        for (const input of [
          { platform: "win32", uid: 501, entry: "/opt/runtime/bin.mjs" },
          { platform: "linux", uid: 0, entry: "/opt/runtime/bin.mjs" },
          { platform: "darwin", uid: 501, entry: "bin.mjs" },
          { platform: "darwin", uid: 501, entry: "/nonexistent/specwithcode/bin.mjs" },
        ])
          expect(yield* resolveDiskRoomHelper(input)).toBeNull();
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// The primary: one `fleet room` over Connect
// ---------------------------------------------------------------------------

const TAILNET = "https://m1.fixture.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const PRIMARY = "env-m4";

const token = (jkt?: string) =>
  `${Buffer.from(JSON.stringify({ sid: "s1", ...(jkt ? { jkt } : {}) })).toString("base64url")}.sig`;

const describeMachine = (capabilities: Record<string, unknown>, serverVersion = "1.0.190") => ({
  environmentId: "env-m1",
  label: "Mac M1",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion,
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true, ...capabilities },
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

/** A primary with its fleet key, and a machine answering only on `up`. */
async function primary(input: {
  readonly up: ReadonlyArray<string>;
  readonly capabilities: Record<string, unknown>;
  readonly serverVersion?: string;
  readonly answer: (request: { method: string; path: string }) => Response;
  readonly descriptorStatus?: number;
}) {
  const baseDir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-room-"));
  dirs.push(baseDir);
  const key = await loadOrCreateFleetProofKey(baseDir);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (!input.up.includes(target.origin)) throw new TypeError("offline");
    if (target.pathname === "/.well-known/studio/environment")
      return Response.json(describeMachine(input.capabilities, input.serverVersion), {
        status: input.descriptorStatus ?? 200,
      });
    return input.answer({
      method: init?.method ?? "GET",
      path: `${target.pathname}${target.search}`,
    });
  });
  const link = makeFleetLink({ fetch: fetcher, baseDir, book: makeFleetAddressBook() });
  const target = {
    id: "m1",
    label: "Mac M1",
    environmentId: EnvironmentId.make("env-m1"),
    url: TAILNET,
    connectUrl: CONNECT,
    managementToken: token(key.thumbprint),
    scopes: [AuthOrchestrationReadScope],
  };
  return { fetcher, link, target };
}

const room = (setup: Awaited<ReturnType<typeof primary>>, connectOnly = true) =>
  runFleetDiskRoom({
    link: { ...setup.link, connectOnly },
    target: setup.target,
    coordinatorEnvironmentId: PRIMARY,
    version: "1.0.190",
    fullRead: "69,73",
  });

describe("the primary asking a fleet machine for its disk room", () => {
  it("prints the worker's report under its fleet id, with the Connect transport attested", async () => {
    const asked: Array<{ method: string; path: string }> = [];
    const setup = await primary({
      up: [CONNECT],
      capabilities: { fleetDiskRoom: true },
      answer: (request) => {
        asked.push(request);
        return Response.json({
          workerIdentity: "m1-service",
          ...report({ identity: "m1-service" }),
        });
      },
    });
    const outcome = await room(setup);
    expect(outcome).toMatchObject({
      identity: "m1",
      workerIdentity: "m1-service",
      ok: true,
      transport: "connect",
      serverVersion: "1.0.190",
    });
    expect(asked).toEqual([
      {
        method: "GET",
        path: "/api/studio/fleet/disk-room?coordinatorEnvironmentId=env-m4&version=1.0.190&fullRead=69%2C73",
      },
    ]);
  });

  it("names the machine and its release when it predates the Connect disk check", async () => {
    const setup = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      serverVersion: "1.0.188",
      answer: () => Response.json({}),
    });
    await expect(room(setup)).rejects.toMatchObject({
      reason: "unsupported",
      message: expect.stringMatching(/Mac M1 runs 1\.0\.188.*predates the Connect disk check/),
    });
    const paths = setup.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.filter((path) => path !== "/.well-known/studio/environment")).toEqual([]);
  });

  it("reports a refused token as unauthorized, naming the machine", async () => {
    const setup = await primary({
      up: [CONNECT],
      capabilities: { fleetDiskRoom: true },
      answer: () => Response.json({ message: "forbidden" }, { status: 403 }),
    });
    await expect(room(setup)).rejects.toMatchObject({
      reason: "unauthorized",
      message: expect.stringContaining("Mac M1"),
    });
  });

  it("passes a check that could not tell through as failed, in the worker's words", async () => {
    const setup = await primary({
      up: [CONNECT],
      capabilities: { fleetDiskRoom: true },
      answer: () =>
        Response.json(
          { _tag: "StudioFleetUpdateError", reason: "failed", message: "No database for m1." },
          { status: 409 },
        ),
    });
    await expect(room(setup)).rejects.toMatchObject({
      reason: "failed",
      message: "Mac M1: No database for m1.",
    });
  });

  it("stays on Connect when only the tailnet answers", async () => {
    const setup = await primary({
      up: [TAILNET],
      capabilities: { fleetDiskRoom: true },
      answer: () => Response.json(report({})),
    });
    await expect(room(setup)).rejects.toMatchObject({
      reason: "unreachable",
      message: expect.stringContaining("Mac M1"),
    });
    expect(setup.fetcher).toHaveBeenCalledTimes(1);
    expect(String(setup.fetcher.mock.calls[0]?.[0])).toContain(CONNECT);
  });

  it("never asks again over the tailnet when the check fails on Connect", async () => {
    const asked: string[] = [];
    const setup = await primary({
      up: [CONNECT, TAILNET],
      capabilities: { fleetDiskRoom: true },
      answer: (request) => {
        asked.push(request.path);
        throw new TypeError("connection reset");
      },
    });
    await expect(room(setup, false)).rejects.toMatchObject({
      message: expect.stringContaining("Mac M1"),
    });
    expect(asked).toHaveLength(1);
    const roomCalls = setup.fetcher.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/api/studio/fleet/disk-room"));
    expect(roomCalls).toEqual([expect.stringContaining(CONNECT)]);
  });

  it("is unreachable when no address answers", async () => {
    const setup = await primary({
      up: [],
      capabilities: { fleetDiskRoom: true },
      answer: () => Response.json(report({})),
    });
    await expect(room(setup, false)).rejects.toMatchObject({
      reason: "unreachable",
      message: expect.stringContaining("Mac M1"),
    });
  });
});
