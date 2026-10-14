import { existsSync } from "node:fs";
import { join } from "node:path";

export const STUDIO_NAME = "SpecWithCode";
export const STUDIO_CLI = "specweave-studio";
export const STUDIO_DEFAULT_PORT = 8319;
export const STUDIO_HOME_DIRECTORY = ".specwithcode";
export const LEGACY_STUDIO_HOME_DIRECTORY = ".specweave-studio";

/** The caller supplies its user's home; an upstream home variable is never consulted. */
export function studioDefaultHome(userHome: string): string {
  const legacy = join(userHome, LEGACY_STUDIO_HOME_DIRECTORY);
  const branded = join(userHome, STUDIO_HOME_DIRECTORY);
  // Direct state belongs to a legacy standalone profile; identity children belong
  // to managed services and must not displace an existing branded profile.
  if (existsSync(join(legacy, "userdata")) || existsSync(join(legacy, "dev"))) return legacy;
  if (existsSync(branded)) return branded;
  return existsSync(legacy) ? legacy : branded;
}
