/** Waiting for a machine's connection before a command that needs its session. */

/** Phases that never become "connected" without the user changing something. */
const STUCK = new Set(["error", "unsupported"]);

export type ConnectionWait =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "timeout" | "failed"; readonly detail: string | null };

interface PhaseSource {
  readonly read: () => { readonly phase: string; readonly error: string | null } | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/** Resolves once `source` reports "connected", or with the reason it never did. */
export function waitForConnected(source: PhaseSource, timeoutMs: number): Promise<ConnectionWait> {
  return new Promise((done) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: ConnectionWait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      done(result);
    };
    const check = () => {
      const current = source.read();
      if (current?.phase === "connected") finish({ ok: true });
      else if (current !== null && STUCK.has(current.phase))
        finish({ ok: false, reason: "failed", detail: current.error });
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout", detail: source.read()?.error ?? null }),
      timeoutMs,
    );
    unsubscribe = source.subscribe(check);
    check();
  });
}

/** What to tell the user when the machine never connected. */
export function connectionMessage(wait: Extract<ConnectionWait, { ok: false }>): string {
  const base =
    wait.reason === "timeout"
      ? "This machine did not connect within 15 seconds."
      : "This machine's connection failed.";
  const detail = wait.detail?.trim() ? ` ${wait.detail.trim().replace(/\.?$/, ".")}` : "";
  return `${base}${detail} Nothing was created. Try again once it shows as connected.`;
}
