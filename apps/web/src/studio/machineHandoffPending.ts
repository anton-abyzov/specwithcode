export interface PendingMachineHandoff {
  readonly operationId: string;
  readonly targetKey: string;
}

/** Only a retry pointer is kept in the browser; context stays on the machines. */
export const machineHandoffStorageKey = (environmentId: string, projectId: string) =>
  `studio:machine-handoff:v1:${JSON.stringify([environmentId, projectId])}`;

export function parsePendingMachineHandoff(value: string | null): PendingMachineHandoff | null {
  if (!value) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (typeof candidate !== "object" || candidate === null) return null;
    const { operationId, targetKey } = candidate as Record<string, unknown>;
    return typeof operationId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId) &&
      typeof targetKey === "string" &&
      targetKey.length > 0 &&
      targetKey.length <= 1024
      ? { operationId, targetKey }
      : null;
  } catch {
    return null;
  }
}
