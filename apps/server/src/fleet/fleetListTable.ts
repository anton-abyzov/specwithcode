/**
 * What `fleet list` shows: every address of every machine probed at once, the
 * one traffic would use now and the state of the other, laid out to fit a
 * normal terminal. Probes read the public identity endpoint and carry no
 * credentials. This machine is not probed here: the caller says whether its
 * own service answered over loopback.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - aborting a global fetch leaves its connect running.
import * as NodeHttps from "node:https";

import {
  checkIdentity,
  FleetError,
  type FleetConfig,
  type FleetFetch,
  managementBindingOf,
} from "../studioFleet.ts";
import type { FleetTransport } from "./fleetOrigin.ts";
import { fleetAddresses } from "./fleetTransport.ts";

/** Each address gets this long, so a list with every machine down still returns quickly. */
export const FLEET_LIST_PROBE_TIMEOUT_MS = 2_500;

export interface FleetListLocal {
  readonly environmentId: string;
  /** Whether this machine's own service answered over loopback. */
  readonly answering: boolean;
}

export interface FleetListRow {
  readonly id: string;
  readonly label: string;
  readonly status: "reachable" | "unreachable" | "identity-mismatch";
  readonly route: string;
  readonly fallback: string;
  /** Connect first, the order traffic tries them. */
  readonly addresses: ReadonlyArray<{
    readonly origin: string;
    readonly transport: FleetTransport;
  }>;
  readonly notes: ReadonlyArray<string>;
}

type AddressState = "ok" | "no answer" | "wrong machine";

/** Bodies past this are not an identity; the same cap `readBoundedJson` applies. */
const PROBE_BODY_LIMIT_BYTES = 65_536;

/**
 * A one-shot GET whose abort destroys the socket. A global fetch stays connecting
 * to a peer that drops packets for ten seconds after its abort, which would hold
 * this command open long after it printed. Anything but a 200 reads as an error status.
 */
export const fleetProbeFetch = ((url, init) =>
  new Promise<Response>((resolve, reject) => {
    const request = NodeHttps.get(
      String(url),
      { agent: false, ...(init?.signal ? { signal: init.signal } : {}) },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          resolve(new Response(null, { status: 502 }));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > PROBE_BODY_LIMIT_BYTES) request.destroy(new Error("body too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: 200 })));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  })) as FleetFetch;

const transportName = (transport: FleetTransport) =>
  transport === "connect" ? "Connect" : "Tailscale";

export async function probeFleetList(input: {
  readonly config: FleetConfig;
  readonly local: FleetListLocal | null;
  readonly fetch: FleetFetch;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<FleetListRow>> {
  const timeoutMs = input.timeoutMs ?? FLEET_LIST_PROBE_TIMEOUT_MS;
  const timed: FleetFetch = (url, init) =>
    input.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return Promise.all(
    input.config.machines.map(async (target): Promise<FleetListRow> => {
      const addresses = fleetAddresses(target);
      const named = { id: target.id, label: target.label, addresses };
      if (input.local !== null && String(target.environmentId) === input.local.environmentId) {
        return {
          ...named,
          status: input.local.answering ? "reachable" : "unreachable",
          route: "this machine",
          fallback: "-",
          notes: input.local.answering ? [] : ["service not answering"],
        };
      }
      const states = await Promise.all(
        addresses.map(async (address): Promise<AddressState> => {
          try {
            await checkIdentity(timed, {
              url: address.origin,
              environmentId: target.environmentId,
            });
            return "ok";
          } catch (error) {
            return error instanceof FleetError && error.kind === "identity-mismatch"
              ? "wrong machine"
              : "no answer";
          }
        }),
      );
      const live = states.indexOf("ok");
      const notes = !target.managementToken
        ? ["no management token"]
        : managementBindingOf(target.managementToken) === "bearer" &&
            addresses.some((address) => address.transport === "connect")
          ? ["management token works over Tailscale only"]
          : [];
      if (live === -1) {
        return {
          ...named,
          status: states.includes("wrong machine") ? "identity-mismatch" : "unreachable",
          route: "-",
          fallback: "-",
          notes,
        };
      }
      const other = addresses.findIndex((_, index) => index !== live);
      return {
        ...named,
        status: "reachable",
        route: transportName(addresses[live]!.transport),
        fallback:
          other === -1 ? "none" : `${transportName(addresses[other]!.transport)} ${states[other]}`,
        notes,
      };
    }),
  );
}

const DETAIL_WIDTH = "Tailscale".length;
const detail = (name: string, value: string) => `  ${name.padEnd(DETAIL_WIDTH)}  ${value}`;

/** One aligned line per machine, then its name, addresses and notes on lines of their own. */
export function renderFleetTable(rows: ReadonlyArray<FleetListRow>): ReadonlyArray<string> {
  const columns = (row: FleetListRow) => [row.id, row.status, row.route, row.fallback];
  const header = ["MACHINE", "STATUS", "ROUTE", "FALLBACK"];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => columns(row)[index]!.length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    ...rows.flatMap((row) => [
      line(columns(row)),
      detail("Name", row.label),
      ...row.addresses.map((address) => detail(transportName(address.transport), address.origin)),
      ...row.notes.map((note) => detail("Note", note)),
    ]),
  ];
}
