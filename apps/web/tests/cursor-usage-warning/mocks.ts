// Stand-ins for the settings command the Cursor enable card calls. Every write
// is recorded in window.fixtureCalls instead of reaching a server.
declare global {
  interface Window {
    fixtureCalls: unknown[];
  }
}
window.fixtureCalls ??= [];

export const serverEnvironment = { updateSettings: "updateSettings" };

export function useAtomCommand(command: string) {
  return async (input: unknown) => {
    window.fixtureCalls.push({ command, input });
    return { _tag: "Success", value: {} };
  };
}
