import { fixture } from "./fixture";

export function useServerConfigs() {
  const capabilities = fixture.deck === "old-server" ? {} : { designDeckPreview: true };
  return new Map([["fixture-host", { environment: { capabilities } }]]);
}
