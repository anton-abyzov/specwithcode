import * as Effect from "effect/Effect";
import { spawnMspConnection, MuseClient, readSessionDurability } from "@muse-code/sdk";
import type { MuseSettings } from "@specweave-studio/contracts";
/** Own only the host this call spawns; never attach to or terminate an external session host. */
export async function connectMuse(settings: MuseSettings, env: NodeJS.ProcessEnv, cwd: string) {
  const handshake = spawnMspConnection({
    command: settings.binaryPath || "muse",
    args: ["serve"],
    cwd,
    env,
    shutdownTimeoutMs: 2_000,
  });
  const timeout = new AbortController();
  try {
    const host = await Promise.race([
      handshake.initialize({
        clientInfo: { name: "specwithcode", version: "1.0.0" },
        capabilities: { userInputDialogs: false },
      }),
      Effect.runPromise(Effect.sleep(10_000), { signal: timeout.signal }).then(() => {
        throw new Error("Muse Code handshake timed out");
      }),
    ]);
    if (host.fingerprintWarning) {
      await host.close();
      throw new Error(
        "Muse Code protocol differs from the supported SDK. Update the integration before continuing.",
      );
    }
    const client = new MuseClient(host.connection, {
      durability: readSessionDurability(host.initializeResult),
      host,
    });
    return { host, client };
  } catch (error) {
    await handshake.close();
    throw error;
  } finally {
    timeout.abort();
  }
}

/** Discovery/control RPCs must not leave Refresh Providers or model selection hanging. */
export async function museControl<T>(
  operation: Promise<T>,
  close: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      operation,
      Effect.runPromise(Effect.sleep(timeoutMs), { signal: timeout.signal }).then(() => {
          void close();
        throw new Error("Muse Code control request timed out");
      }),
    ]);
  } finally {
    timeout.abort();
  }
}
