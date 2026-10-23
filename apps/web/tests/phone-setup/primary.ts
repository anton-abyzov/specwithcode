import * as DateTime from "effect/DateTime";
export const fixture = {
  calls: 0,
  scopes: [] as readonly string[],
  reject: false,
  delay: false,
  resolve: null as (() => void) | null,
};
export function readPrimaryEnvironmentTarget() {
  return { target: { httpBaseUrl: "http://127.0.0.1:8319" } };
}
export async function createServerPairingCredential(input: { scopes: readonly string[] }) {
  fixture.calls += 1;
  fixture.scopes = input.scopes;
  if (fixture.delay)
    await new Promise<void>((resolve) => {
      fixture.resolve = resolve;
    });
  if (fixture.reject) throw new Error("Synthetic credential failure");
  return {
    credential: `fixture-${fixture.calls}`,
    expiresAt: DateTime.makeUnsafe(Date.now() + 5000),
  };
}
Object.assign(window, { phoneFixture: fixture });
