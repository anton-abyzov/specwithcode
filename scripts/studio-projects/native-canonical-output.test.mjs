import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalNativeToolOutput as compact } from "./native-tool-detail.mjs";
const id = "x".repeat(256),
  nest = (value, count) => (count ? { content: nest(value, count - 1) } : value);
const textAt = (bytes) =>
  JSON.stringify({
    taskId: "t",
    pad: "x".repeat(bytes - JSON.stringify({ taskId: "t", pad: "" }).length),
  });
const blocks = (count) =>
  Array.from({ length: count }, (_, i) => ({ text: JSON.stringify({ taskId: String(i) }) }));
const threads = (count) => Array.from({ length: count }, (_, i) => ({ threadId: String(i) }));
// Each block costs four nodes after the outer object/array; 31 stays within128,32 exceeds.
const nodes = (count) => ({
  content: Array.from({ length: count }, () => ({
    text: Array.from({ length: 3 }, () => ({ text: { taskId: "t" } })),
  })),
});
export const canonicalCases = [
  ["absent", undefined, undefined],
  ["null", null, undefined],
  ["empty", {}, undefined],
  ["scalar", 17, undefined],
  [
    "all keys",
    { threadId: "t", messageId: "m", taskId: "a", scheduledTaskId: "s", discard: "full" },
    { threadId: "t", messageId: "m", taskId: "a", scheduledTaskId: "s" },
  ],
  [
    "nested thread",
    { thread: { threadId: "t", title: "full", secret: "omitted" } },
    { thread: { threadId: "t" } },
  ],
  ["unknown status", { status: "completed" }, undefined],
  ["rolled back", { status: "rolled_back" }, { status: "rolled_back" }],
  ...["isError", "is_error"].map((key) => [
    key,
    { [key]: true, taskId: "t" },
    { isError: true, taskId: "t" },
  ]),
  ["failure tag", { _tag: "OrchestratorMcpFailure" }, { isError: true }],
  ["nonnull error", { error: false }, { isError: true }],
  ["null error", { error: null }, undefined],
  ["ID256", { taskId: id }, { taskId: id }],
  ["ID257", { taskId: id + "x" }, undefined],
  ["blank ID", { taskId: "  " }, undefined],
  ["untrimmed ID", { taskId: " t " }, { taskId: " t " }],
  ["UTF16 accepted", { taskId: "😀".repeat(128) }, { taskId: "😀".repeat(128) }],
  ["UTF16 over", { taskId: "😀".repeat(129) }, undefined],
  [
    "structured precedence",
    { structuredContent: { taskId: "s" }, content: { taskId: "c" } },
    { taskId: "s" },
  ],
  [
    "null structured fallback",
    { structuredContent: null, content: { taskId: "c" } },
    { taskId: "c" },
  ],
  ["nested failure", { isError: true, content: { taskId: "t" } }, { isError: true, taskId: "t" }],
  ["string JSON", JSON.stringify({ taskId: "t" }), { taskId: "t" }],
  ["invalid JSON", "{", undefined],
  ["text16384", textAt(16384), { taskId: "t" }],
  ["text16385", textAt(16385), undefined],
  ["UTF8 budget", JSON.stringify({ taskId: "t", pad: "😀".repeat(5000) }), undefined],
  ["depth4", nest({ taskId: "t" }, 4), { taskId: "t" }],
  ["depth5", nest({ taskId: "t" }, 5), undefined],
  [
    "overdepth keeps failure",
    { isError: true, content: nest({ taskId: "t" }, 4) },
    { isError: true },
  ],
  ["blocks32", blocks(32), { taskId: "0" }],
  ["blocks33", blocks(33), undefined],
  ["nested text block", [{ text: { text: JSON.stringify({ taskId: "t" }) } }], { taskId: "t" }],
  [
    "array failed result",
    [{ text: { taskId: "t" } }, { text: { error: "failure" } }],
    { isError: true, taskId: "t" },
  ],
  ["nodes within", nodes(31), { taskId: "t" }],
  ["nodes exceeded", nodes(32), undefined],
  ["empty threads", { threads: [] }, { threads: [] }],
  ["threads100", { threads: threads(100) }, { threads: threads(100) }],
  [
    "threads101",
    { threadId: "t", status: "rolled_back", taskId: "a", threads: threads(101) },
    { taskId: "a" },
  ],
  [
    "invalid batch",
    { threadId: "t", status: "rolled_back", threads: [{ threadId: "good" }, {}], messageId: "m" },
    { messageId: "m" },
  ],
  ["scalar batch", { threadId: "t", threads: [1] }, undefined],
  [
    "rollback entry",
    { threads: [{ status: "rolled_back", ignored: true }] },
    { threads: [{ status: "rolled_back" }] },
  ],
  [
    "metadata under8192",
    { threadId: "t", status: "rolled_back", threads: Array(29).fill({ threadId: id }) },
    { threadId: "t", status: "rolled_back", threads: Array(29).fill({ threadId: id }) },
  ],
  [
    "metadata over8192",
    {
      threadId: "t",
      status: "rolled_back",
      taskId: "a",
      threads: Array(30).fill({ threadId: id }),
    },
    { taskId: "a" },
  ],
  [
    "html normalized",
    {
      htmlRender: {
        attachmentId: "a",
        title: "  ",
        height: 1,
        heights: [
          [1000, 9000],
          [1, 81.6],
        ],
      },
    },
    {
      htmlRender: {
        attachmentId: "a",
        title: "HTML",
        height: 80,
        heights: [
          [1, 82],
          [1000, 2000],
        ],
      },
    },
  ],
  [
    "html max title",
    { htmlRender: { attachmentId: "a", title: "x".repeat(201), height: 3000 } },
    { htmlRender: { attachmentId: "a", title: "x".repeat(200), height: 2000 } },
  ],
  [
    "html invalid attachment",
    { htmlRender: { attachmentId: "x".repeat(257), title: "t", height: 100 } },
    undefined,
  ],
  [
    "html invalid measured",
    { htmlRender: { attachmentId: "a", title: "t", height: 100, heights: [[0, 100]] } },
    { htmlRender: { attachmentId: "a", title: "t", height: 100 } },
  ],
  [
    "html measured24",
    {
      htmlRender: { attachmentId: "a", title: "t", height: 100, heights: Array(24).fill([1, 100]) },
    },
    {
      htmlRender: { attachmentId: "a", title: "t", height: 100, heights: Array(24).fill([1, 100]) },
    },
  ],
  [
    "html measured25",
    {
      htmlRender: { attachmentId: "a", title: "t", height: 100, heights: Array(25).fill([1, 100]) },
    },
    { htmlRender: { attachmentId: "a", title: "t", height: 100 } },
  ],
];
for (const [name, input, expected] of canonicalCases)
  test(`frozen8d canonical compactor: ${name}`, () => assert.deepEqual(compact(input), expected));
test("all206 retained events keep all44 exact canonical wire outputs, including absent output", () => {
  const [metadata, ...events] = readFileSync(
    new URL("./native-wire/native-initial-publication.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.length, 206);
  const projected = events.filter((e) => e.wirePayload);
  assert.equal(projected.length, 44);
  for (const e of projected.filter((e) => e.payload.type === "dynamic_tool"))
    assert.deepEqual(compact(e.payload.output), e.wirePayload.output, `event${e.sequence}`);
});
