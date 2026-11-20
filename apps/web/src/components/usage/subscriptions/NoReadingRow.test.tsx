import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../studio/shell/Tip", () => ({
  Tip: ({ children }: { readonly children: unknown }) => children,
}));

import { NoReadingRow } from "./NoReadingRow";
import { noReadingRows } from "./subscriptionRows";

const acp = ProviderDriverKind.make("acpRegistry");
const claude = ProviderDriverKind.make("claudeAgent");

describe("NoReadingRow", () => {
  it("names the instance and machine, says why, links its usage page and offers no renewal editor", () => {
    const [row] = noReadingRows(
      [
        {
          key: "desk:copilot-home",
          driver: acp,
          environmentLabel: "Desk",
          offline: true,
          email: undefined,
          plan: undefined,
          reason: "unread",
          message: "Usage not reported by Copilot home",
          environmentId: EnvironmentId.make("desk"),
          instanceId: ProviderInstanceId.make("copilot-home"),
          displayName: "Copilot home",
        },
      ],
      () => "ACP agent",
    );
    const html = renderToStaticMarkup(<NoReadingRow row={row!} />);
    expect(html).toContain('data-no-reading-row="desk:copilot-home"');
    expect(html).toContain("Copilot home");
    expect(html).toContain(">Desk<");
    expect(html).toContain("offline");
    expect(html).toContain("Usage not reported by Copilot home");
    expect(html).toContain("https://github.com/settings/copilot");
    expect(html).toContain("A renewal day can be set once this account reports usage");
    expect(html).not.toContain("Set day");
  });

  it("falls back to the driver's name and gives an API-billed account no plan link", () => {
    const [row] = noReadingRows(
      [
        {
          key: "desk:claudeAgent",
          driver: claude,
          environmentLabel: "Desk",
          offline: false,
          email: "api@example.com",
          plan: undefined,
          reason: "apiBilling",
          message: "Billed by API key. No plan limits.",
        },
      ],
      () => "Claude",
    );
    expect(row?.name).toBe("Claude");
    const html = renderToStaticMarkup(<NoReadingRow row={row!} />);
    expect(html).toContain("Billed by API key. No plan limits.");
    expect(html).not.toContain("claude.ai/settings/usage");
  });
});
