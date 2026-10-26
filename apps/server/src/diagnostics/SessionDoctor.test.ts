import { assert, it } from "@effect/vitest";

import {
  checkDatabaseFiles,
  checkMachineLoad,
  checkRendererMemory,
  formatDoctorReport,
  makeSessionDoctor,
} from "./SessionDoctor.ts";

const span = (fields: {
  name: string;
  durationMs: number;
  spanId?: string;
  parentSpanId?: string;
  query?: string;
  endMs?: number;
}) =>
  JSON.stringify({
    type: "effect-span",
    name: fields.name,
    spanId: fields.spanId,
    parentSpanId: fields.parentSpanId,
    durationMs: fields.durationMs,
    endTimeUnixNano: String(BigInt(fields.endMs ?? 1_000) * 1_000_000n),
    attributes: fields.query === undefined ? {} : { "db.query.text": fields.query },
    resourceAttributes: { "service.version": "1.0.34" },
  });

it("fails a slow coordinator send and names the query and the code that ran it", () => {
  const doctor = makeSessionDoctor();
  // A query ends before the transaction and the send that contain it.
  [
    span({
      name: "sql.execute",
      durationMs: 4_347,
      parentSpanId: "send",
      query: "\n  SELECT sequence, event_id\n  FROM orchestration_events",
    }),
    span({ name: "sql.execute", durationMs: 300, parentSpanId: "tx", query: "SELECT 1" }),
    span({ name: "sql.transaction", durationMs: 301, spanId: "tx", parentSpanId: "sweep" }),
    span({ name: "ProviderFallbackWorker.sweep", durationMs: 302, spanId: "sweep" }),
    span({ name: "ProjectCoordinatorAttachments.send", durationMs: 4_433, spanId: "send" }),
    span({ name: "ws.rpc.projects.coordinatorSend", durationMs: 4_438, spanId: "rpc" }),
    span({ name: "ws.rpc.projects.coordinatorSend", durationMs: 239, spanId: "rpc2" }),
    span({ name: "ws.rpc.orchestration.dispatchCommand", durationMs: 9, spanId: "cmd" }),
  ].forEach(doctor.addLine);
  const report = doctor.finish();

  assert.deepStrictEqual(report.versions, ["1.0.34"]);
  const [send, reads] = report.checks;
  assert.strictEqual(send!.level, "fail");
  assert.strictEqual(send!.title, "Sending messages: slowest step p90 4.4 s");
  assert.include(send!.details[0]!, "Send to the coordinator: 2 calls, p50 239 ms");
  assert.strictEqual(reads!.level, "fail");
  assert.deepStrictEqual(reads!.details, [
    "4.3 s max, 1x in ProjectCoordinatorAttachments.send: SELECT sequence, event_id FROM orchestration_events",
    "300 ms max, 1x in ProviderFallbackWorker.sweep: SELECT 1",
  ]);
  assert.include(formatDoctorReport(report), "FAIL  Sending messages");
});

it("passes fast sends and leaves out spans before the window", () => {
  const doctor = makeSessionDoctor(5_000);
  [
    span({ name: "ws.rpc.projects.coordinatorSend", durationMs: 9_000, endMs: 1_000 }),
    span({ name: "ws.rpc.projects.coordinatorSend", durationMs: 40, endMs: 6_000 }),
    span({ name: "sql.execute", durationMs: 2, endMs: 6_000, query: "SELECT 1" }),
  ].forEach(doctor.addLine);
  const report = doctor.finish();

  assert.strictEqual(report.spanCount, 2);
  assert.deepStrictEqual(
    report.checks.map((check) => [check.level, check.title]),
    [
      ["ok", "Sending messages: slowest step p90 40 ms"],
      ["ok", "Database reads: none over 250 ms"],
    ],
  );
});

it("warns when the write-ahead log has grown past checkpoints", () => {
  assert.strictEqual(
    checkDatabaseFiles({ databaseBytes: 2 ** 30, walBytes: 5 * 2 ** 20 }).level,
    "ok",
  );
  const stalled = checkDatabaseFiles({ databaseBytes: 2 ** 30, walBytes: 300 * 2 ** 20 });
  assert.strictEqual(stalled.level, "warn");
  assert.strictEqual(stalled.title, "Database: 1.0 GiB, write-ahead log 300 MiB");
  assert.strictEqual(
    checkDatabaseFiles({ databaseBytes: undefined, walBytes: undefined }).level,
    "ok",
  );
});

it("reports the memory of windows that sampled recently, with their growth", () => {
  const hour = 3_600_000;
  const sample = (pid: number, at: number, gib: number) =>
    JSON.stringify({
      event: "sample",
      surface: "main",
      rendererPid: pid,
      timestampUnixMs: at,
      memory: { workingSetBytes: gib * 1024 ** 3 },
    });
  const now = 10 * hour;
  const check = checkRendererMemory(
    [
      sample(1, now - 9 * hour, 3),
      sample(2, now - 2 * hour, 0.5),
      sample(2, now, 1.75),
      "not json",
    ],
    now,
  );
  // Window 1 stopped sampling hours ago, so only window 2 is counted.
  assert.strictEqual(check.level, "warn");
  assert.strictEqual(check.title, "Window memory: largest window 1.8 GiB");
  assert.deepStrictEqual(check.details, ["1.8 GiB after 2.0 h, 640 MiB/h growth"]);
});

it("warns that timings are inflated when the machine is overloaded", () => {
  assert.strictEqual(checkMachineLoad({ fiveMinute: 6.2, cpuCount: 16 }).level, "ok");
  assert.strictEqual(checkMachineLoad({ fiveMinute: 16, cpuCount: 16 }).level, "ok");
  const busy = checkMachineLoad({ fiveMinute: 664.7, cpuCount: 16 });
  assert.strictEqual(busy.level, "warn");
  assert.strictEqual(busy.title, "Machine load: 664.7 on 16 cores");
  assert.match(busy.details[0]!, /Run doctor again once it is quiet/);
});

it("says load is not reported where the OS has none", () => {
  const check = checkMachineLoad({ fiveMinute: undefined, cpuCount: 8 });
  assert.strictEqual(check.level, "ok");
  assert.strictEqual(check.title, "Machine load: not reported on this system");
});
