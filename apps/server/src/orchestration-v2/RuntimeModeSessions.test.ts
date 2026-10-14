import { expect, it } from "vite-plus/test";
import { runtimeModeSessionsToDetach } from "./RuntimeModeSessions.ts";
const sessions = [false, true].map((supported, id) => ({
  id: String(id),
  capabilities: { sessions: { supportsRuntimeModeSwitchInSession: supported } },
})) as never;
it("project updates leave every provider session attached until the next turn", () => {
  expect(runtimeModeSessionsToDetach({ applyOnNextTurn: true }, sessions)).toEqual([]);
});
it("ordinary chat mode changes retain existing capability-sensitive detach behavior", () => {
  expect(runtimeModeSessionsToDetach({}, sessions)).toEqual(["0"]);
});
