import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/environments/primary", () => ({ revokeServerClientSession: vi.fn() }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: vi.fn(async () => false) } }),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

import { AuthSessionId } from "@specweave-studio/contracts";

import type { UnusedClientCandidate } from "./ConnectionsSettings.logic";
import { RevokeUnusedClientsButton } from "./RevokeUnusedClientsButton";

const DAY = 24 * 60 * 60_000;
type Candidate = UnusedClientCandidate<AuthSessionId>;
const session = (sessionId: string, overrides: Partial<Candidate> = {}): Candidate => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "one-time-token",
  label: "installed check headless",
  deviceType: "desktop",
  principalKind: undefined,
  issuedAt: new Date(Date.now() - 3 * DAY).toISOString(),
  lastConnectedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  connected: false,
  current: false,
  ...overrides,
});

describe("RevokeUnusedClientsButton", () => {
  it("shows the number of unused sign-ins", () => {
    const html = renderToStaticMarkup(
      <RevokeUnusedClientsButton
        clientSessions={[session("a"), session("b"), session("me", { current: true })]}
      />,
    );
    expect(html).toContain("Revoke 2 unused");
  });

  it("is absent while the list is unknown or nothing is unused", () => {
    expect(renderToStaticMarkup(<RevokeUnusedClientsButton clientSessions={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <RevokeUnusedClientsButton
          clientSessions={[
            session("me", { current: true }),
            session("phone", { label: "iPhone", deviceType: "mobile" }),
            session("key", { subject: "fleet-invitation", lastConnectedAt: null }),
          ]}
        />,
      ),
    ).toBe("");
  });

  it("is disabled while another revoke runs", () => {
    const html = renderToStaticMarkup(
      <RevokeUnusedClientsButton clientSessions={[session("a")]} disabled />,
    );
    expect(html).toContain("disabled");
  });
});
