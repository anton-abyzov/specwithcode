import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  StudioFleetMachine,
  StudioFleetRemoteWorkersResult,
  StudioFleetWorkersAllowInput,
  StudioFleetWorkersResult,
  StudioFleetWorkersStopInput,
} from "./studioFleet.ts";

const decodeMachine = Schema.decodeUnknownSync(StudioFleetMachine);
const decodeAllow = Schema.decodeUnknownSync(StudioFleetWorkersAllowInput);
const decodeStop = Schema.decodeUnknownSync(StudioFleetWorkersStopInput);
const decodeWorkersResult = Schema.decodeUnknownSync(StudioFleetWorkersResult);
const decodeRemoteWorkers = Schema.decodeUnknownSync(StudioFleetRemoteWorkersResult);

const machine = {
  id: "m1",
  label: "M1",
  environmentId: "env-m1",
  url: "https://m1.example.ts.net",
  status: "reachable",
  pairingConfigured: true,
};

describe("studio fleet worker contracts", () => {
  it("decodes a machine from a server older than coordinator workers", () => {
    expect(decodeMachine(machine).workers).toBeUndefined();
  });

  it("decodes worker status on a machine", () => {
    const decoded = decodeMachine({
      ...machine,
      workers: {
        status: "allowed",
        access: "auto",
        expiresAt: "2026-11-11T00:00:00.000Z",
        renewable: true,
        problem: null,
      },
    });
    expect(decoded.workers?.status).toBe("allowed");
    expect(decoded.workers?.access).toBe("auto");
  });

  it("accepts only a machine id, an access level and an optional pairing code", () => {
    expect(decodeAllow({ id: "m1", access: "auto-accept-edits" })).toEqual({
      id: "m1",
      access: "auto-accept-edits",
    });
    expect(decodeAllow({ id: "m1", access: "auto", pairingCode: "abc123" }).pairingCode).toBe(
      "abc123",
    );
    expect(() => decodeAllow({ id: "m1", access: "auto", url: "https://evil.ts.net" })).toThrow();
    expect(() => decodeAllow({ id: "m1", access: "read-only" })).toThrow();
    expect(() => decodeAllow({ id: "m1", access: "auto", pairingCode: "has space" })).toThrow();
    expect(() => decodeStop({ id: "m1", token: "x" })).toThrow();
    expect(decodeStop({ id: "m1" })).toEqual({ id: "m1" });
  });

  it("decodes worker results and remote worker records", () => {
    expect(
      decodeWorkersResult({
        id: "m1",
        workers: {
          status: "not_allowed",
          access: null,
          expiresAt: null,
          renewable: false,
          problem: "unsupported",
        },
        remoteSessionKept: true,
      }).remoteSessionKept,
    ).toBe(true);
    const workers = decodeRemoteWorkers({
      workers: [
        {
          id: "rwt:mcp:1",
          machineId: "m1",
          machineLabel: "M1",
          environmentId: "env-m1",
          callerThreadId: "thread-coordinator",
          remoteThreadId: "thread-remote",
          threadRef: "studio://thread/env-m1/thread-remote",
          title: "Fix login",
          state: "following",
          lastStatus: "running",
          reachable: true,
          updatedAt: "2026-10-12T00:00:00.000Z",
        },
      ],
    });
    expect(workers.workers[0]?.state).toBe("following");
  });
});
