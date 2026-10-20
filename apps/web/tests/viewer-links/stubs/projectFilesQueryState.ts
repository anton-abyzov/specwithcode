/* Fixture file reads: every file reads as a short source file. */
export function useProjectFileQuery(_environmentId: string, _cwd: string, path: string | null) {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `export const line${index + 1} = ${index + 1}; // ${path ?? ""}`,
  );
  return {
    data: path === null ? null : { contents: lines.join("\n"), truncated: false },
    error: null,
    isPending: false,
    isNotFile: false,
    readError: null,
    refresh: () => {},
  };
}
