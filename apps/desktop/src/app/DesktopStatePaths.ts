import { studioDefaultHome } from "@specweave-studio/shared/studioIdentity";
import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(studioHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(studioHome)) {
    return Option.none();
  }
  const trimmed = studioHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly studioHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.studioHome), () =>
    studioDefaultHome(input.homeDirectory),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly studioHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.studioHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
