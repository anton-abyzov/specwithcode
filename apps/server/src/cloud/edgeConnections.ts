/**
 * Counts the edge connections a running cloudflared holds, from its own log
 * lines. cloudflared keeps several connections to Cloudflare's edge, each
 * numbered by `connIndex`, and reconnects each by itself. The runtime used to
 * note only the first registration, so a connector that stayed alive with no
 * edge connection left the machine unreachable through Connect until someone
 * restarted it (1352, 1517).
 */

/** How long every edge connection may stay lost before the connector is restarted. */
export const EDGE_LOSS_RESTART_AFTER_MS = 2 * 60_000;

export type EdgeConnectionEvent =
  | { readonly kind: "up"; readonly index: number }
  | { readonly kind: "down"; readonly index: number };

const CONN_INDEX = /\bconnIndex=(\d+)\b/u;
const UP = /\bRegistered tunnel connection\b/iu;
// Each of these means that connection is not serving until it registers again.
const DOWN =
  /\b(?:Unregistered tunnel connection|Connection terminated|Serve tunnel error|Lost connection with the edge|Retrying connection in)\b/iu;

/** The edge event a cloudflared line reports, or null for any other line. */
export function edgeConnectionEvent(line: string): EdgeConnectionEvent | null {
  const index = CONN_INDEX.exec(line);
  if (index === null) return null;
  const value = Number(index[1]);
  if (UP.test(line)) return { kind: "up", index: value };
  if (DOWN.test(line)) return { kind: "down", index: value };
  return null;
}

/** The live edge connections of one connector process, and since when it has had none. */
export class EdgeConnections {
  private readonly live = new Set<number>();
  private registered = false;
  private lostSince: number | null = null;

  /** Applies one event; returns the number of live connections after it. */
  apply(event: EdgeConnectionEvent, now: number): number {
    if (event.kind === "up") {
      this.live.add(event.index);
      this.registered = true;
      this.lostSince = null;
    } else if (this.live.delete(event.index) && this.live.size === 0) {
      this.lostSince = now;
    }
    return this.live.size;
  }

  get count(): number {
    return this.live.size;
  }

  /**
   * True once the connector had at least one edge connection and has had none
   * for `afterMs`. A connector that never registered is the registration
   * watchdog's to handle, not this one's.
   */
  lostFor(now: number, afterMs: number = EDGE_LOSS_RESTART_AFTER_MS): boolean {
    return (
      this.registered &&
      this.live.size === 0 &&
      this.lostSince !== null &&
      now - this.lostSince >= afterMs
    );
  }
}
