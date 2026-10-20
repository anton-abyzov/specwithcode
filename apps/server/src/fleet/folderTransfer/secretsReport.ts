// @effect-diagnostics nodeBuiltinImport:off - read by the CLI, outside the server runtime.
import * as NodePath from "node:path";

import { SentSecretsLedger, type SentSecret } from "./secrets.ts";

/**
 * The secret files this server home sent to one machine, newest last, read
 * from every state folder the server may have used (`userdata` and `dev`).
 */
export async function secretsSentTo(
  baseDir: string,
  destinationEnvironmentId: string,
): Promise<Array<SentSecret>> {
  const result: Array<SentSecret> = [];
  const seen = new Set<string>();
  for (const stateDir of ["userdata", "dev"]) {
    const ledger = new SentSecretsLedger(NodePath.join(baseDir, stateDir, "machine-handoffs"));
    try {
      for (const entry of await ledger.list(destinationEnvironmentId).catch(() => [])) {
        const key = `${entry.folder}\0${entry.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
      }
    } finally {
      await ledger.close();
    }
  }
  return result;
}
