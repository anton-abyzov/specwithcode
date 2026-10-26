// @effect-diagnostics nodeBuiltinImport:off - read before any server or Effect layer runs (provisioning).
/**
 * How this machine is linked to SpecWithCode Connect, read straight from the
 * server's secret files (`<secretsDir>/<name>.bin`, raw bytes) without the
 * ServerSecretStore layer, so provisioning can ask before any server runs.
 *
 * - `managed`: linked with a Connect tunnel; other devices reach it through Connect.
 * - `publish_only`: linked only to publish agent activity; reached some other way.
 * - `none`: not linked.
 */
import * as NodeFSP from "node:fs/promises";

import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "./config.ts";

export type ConnectLinkMode = "managed" | "publish_only" | "none";

export type ReadSecretText = (path: string) => Promise<string | null>;

const readFileText: ReadSecretText = async (path) => {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return null;
  }
};

/** The secrets folder of the server whose home is `home` (its `userdata` state). */
export const connectSecretsDir = (home: string) => `${home.replace(/\/+$/u, "")}/userdata/secrets`;

export async function readConnectLinkMode(
  secretsDir: string,
  readText: ReadSecretText = readFileText,
): Promise<ConnectLinkMode> {
  const secret = (name: string) => readText(`${secretsDir}/${name}.bin`);
  const desired = await secret(CLOUD_CLI_DESIRED_LINK_SECRET);
  if (desired === null) return "none";
  // A wanted link that never got its credential reaches nobody yet.
  const credential = await secret(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
  if (credential === null || credential.length === 0) return "none";
  // Legacy links stored the literal "true" and are always managed (as CliState reads it).
  return desired === "publish_only" ? "publish_only" : "managed";
}
