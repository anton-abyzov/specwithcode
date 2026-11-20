import { handleSourceRequest, type RawRequest, type RawResponse } from "./sourceRoutes.ts";
import type { SourceOperationRecord, SourceTransfers } from "./sourceService.ts";

/** Why this machine will not serve a copy now, whatever the request carries. */
export interface TransferRefusal {
  readonly status: 401 | 403;
  readonly code: "team_rules" | "unauthorized";
}

/**
 * The decision made for every request of a copy before its grant is even read:
 * the team's rules for machine links, and the approval of the device that
 * offered the copy. One function, asked by Connect for each request and by the
 * local-network path for each read and on every tick of a live generation.
 */
export type TransferAuthority = (
  record: SourceOperationRecord | null,
) => Promise<TransferRefusal | null>;

const OPERATION_PATH = /^\/([a-f0-9-]{36})\//;

/** Serves one Connect request of a copy, after the authority decision. */
export async function serveWithAuthority(
  authority: TransferAuthority,
  transfers: SourceTransfers,
  environmentId: string,
  request: RawRequest,
): Promise<RawResponse> {
  const operationId = OPERATION_PATH.exec(request.path)?.[1];
  const record =
    operationId === undefined ? null : await transfers.read(operationId).catch(() => null);
  const refused = await authority(record);
  if (refused !== null)
    return {
      status: refused.status,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify({ error: refused.code })),
    };
  return handleSourceRequest(transfers, environmentId, request);
}
