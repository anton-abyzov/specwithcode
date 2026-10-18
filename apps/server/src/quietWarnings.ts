// @effect-diagnostics nodeBuiltinImport:off
// Runs from bin.ts before any Effect runtime exists, so it stays on Node globals.

/**
 * Whether a warning is Node's "SQLite is an experimental feature" notice.
 *
 * Node 22 and 23 print it the first time `node:sqlite` loads. SpecWithCode
 * checks the node:sqlite APIs it needs at startup (nodeSqliteClient.ts), so in
 * a terminal the notice is noise that reads like an error. Every other warning,
 * including other experimental features, still prints.
 */
export const isSqliteExperimentalWarning = (warning: unknown, typeOrOptions: unknown): boolean => {
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions
        ? typeOrOptions.type
        : undefined;
  const experimental =
    type === "ExperimentalWarning" ||
    (warning instanceof Error && warning.name === "ExperimentalWarning");
  const message =
    typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  return experimental && /\bSQLite\b/.test(message);
};

/** Drops the node:sqlite experimental notice; call before the CLI graph loads node:sqlite. */
export const quietSqliteExperimentalWarning = (): void => {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: Array<unknown>) {
    if (isSqliteExperimentalWarning(warning, rest[0])) {
      return;
    }
    return Reflect.apply(emitWarning, process, [warning, ...rest]);
  } as typeof process.emitWarning;
};
