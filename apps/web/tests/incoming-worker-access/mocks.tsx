import { useState } from "react";
const params = new URLSearchParams(location.search);
export const isElectron = true;
export const useEnvironments = () => ({
  environments: [
    { environmentId: "m4", label: "M4 Max", connection: { phase: "connected" } },
    {
      environmentId: "m1",
      label: "M1",
      connection: { phase: params.has("offline") ? "disconnected" : "connected" },
    },
  ],
});
export const useEnvironmentScope = () => !params.has("denied");
export const useMachineNicknames = () => (_id: string, label: string) => label;
export const calls: unknown[] = [];
export async function requestConfirmDialog(text: string) {
  return window.confirm(text);
}
export async function addVisibleMachineToStudioFleet(...args: unknown[]) {
  calls.push(["add", ...args]);
  return { id: "m4", environmentId: "m4" };
}
export async function allowStudioFleetWorkers(...args: unknown[]) {
  calls.push(["allow", ...args]);
  if (params.has("partial")) throw new Error("Permission refused");
  return { id: "m4", workers: { status: "allowed" } };
}
Object.assign(window, { fixtureCalls: calls });
