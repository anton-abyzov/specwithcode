// "Check now" in a fixture: record the call instead of reaching a server.
export const useAtomCommand =
  () =>
  (input: unknown): Promise<void> => {
    (window as unknown as { fixtureChecks?: unknown[] }).fixtureChecks ??= [];
    (window as unknown as { fixtureChecks: unknown[] }).fixtureChecks.push(input);
    return Promise.resolve();
  };
