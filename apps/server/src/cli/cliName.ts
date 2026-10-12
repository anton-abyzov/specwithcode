/**
 * The two names the Studio CLI answers to (docs/studio/naming.md). Both run the same
 * entry; output such as `--version` uses the one the user typed.
 */
export const STUDIO_CLI_NAMES = ["specweave-studio", "specwithcode"] as const;
export type StudioCliName = (typeof STUDIO_CLI_NAMES)[number];

const isStudioCliName = (value: string | undefined): value is StudioCliName =>
  value !== undefined && (STUDIO_CLI_NAMES as ReadonlyArray<string>).includes(value);

/**
 * `env` is STUDIO_CLI_NAME, which the fleet's shell launchers and the npm launcher set
 * from the name they were run as (the shell wrapper execs node on bin.mjs, so argv
 * alone cannot tell). `argv1` covers a bin linked straight to bin.mjs. Anything else
 * falls back to `specweave-studio`.
 */
export const invokedCliName = (input: {
  readonly env?: string | undefined;
  readonly argv1?: string | undefined;
}): StudioCliName => {
  if (isStudioCliName(input.env)) return input.env;
  const base = input.argv1
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:[cm]?js|exe|cmd)$/i, "");
  return isStudioCliName(base) ? base : "specweave-studio";
};
