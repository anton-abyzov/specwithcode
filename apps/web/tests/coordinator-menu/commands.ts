// Fixture stand-in: every command resolves, so a start succeeds and the switcher shows that copy.
export function useAtomCommand() {
  return async () => ({ _tag: "Success" as const, value: {} });
}
