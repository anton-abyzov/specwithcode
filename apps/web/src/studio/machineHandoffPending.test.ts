import { describe, expect, it } from "vite-plus/test";
import { machineHandoffStorageKey, parsePendingMachineHandoff } from "./machineHandoffPending";

describe("machine handoff retry pointers", () => {
  it("retains the operation identity without copying context into browser storage", () => {
    const pointer = {
      operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
      targetKey: "m1:project",
    };
    expect(
      parsePendingMachineHandoff(JSON.stringify({ ...pointer, context: "private context" })),
    ).toEqual(pointer);
  });
  it.each([
    null,
    "",
    "{",
    "null",
    "[]",
    "1",
    '{"operationId":"../../escape","targetKey":"m1:p"}',
    '{"operationId":"7307ab55-fc59-4e07-abeb-de54be69215f","targetKey":1}',
  ])("rejects malformed browser state %s", (value) => {
    expect(parsePendingMachineHandoff(value)).toBeNull();
  });
  it("separates source machines and projects even when identifiers contain separators", () => {
    expect(machineHandoffStorageKey("a:b", "c")).not.toBe(machineHandoffStorageKey("a", "b:c"));
    expect(machineHandoffStorageKey("m1", "p")).not.toBe(machineHandoffStorageKey("m3", "p"));
  });
});
