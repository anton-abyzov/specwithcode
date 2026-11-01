// @vitest-environment jsdom
import { RuntimeRequestId, type ProviderApprovalOption } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { orderApprovalOptions } from "./approvalOptions";

const decisionsIn = (markup: string) =>
  [...markup.matchAll(/data-approval-decision="([^"]+)"/g)].map((match) => match[1]);

const render = (
  props: Partial<Parameters<typeof ComposerPendingApprovalActions>[0]> = {},
): string =>
  renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={RuntimeRequestId.make("approval-1")}
      canRespond
      isResponding={false}
      onRespondToApproval={async () => undefined}
      {...props}
    />,
  );

describe("ComposerPendingApprovalActions", () => {
  it("shows every default option as a button, with no overflow menu", () => {
    const markup = render();

    expect(decisionsIn(markup)).toEqual(["cancel", "decline", "acceptForSession", "accept"]);
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Always allow this session<");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain("More approval options");
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  it("puts accept last even when the provider lists it first", () => {
    const markup = render({
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow for this thread" },
        { decision: "decline", label: "Deny" },
      ],
    });

    expect(decisionsIn(markup)).toEqual(["decline", "acceptForSession", "accept"]);
    expect(markup).toContain(">Allow once<");
    expect(markup).toContain(">Deny<");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Decline<");
  });

  it("keeps provider labels for broader grants visible and readable when truncated", () => {
    const markup = render({
      options: [
        { decision: "decline", label: "Decline" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });

    expect(markup).toContain(">Always allow Safari<");
    expect(markup).toContain('title="Always allow Safari"');
    expect(markup).not.toContain("Always allow this session");
  });

  it("marks a warned option with its icon and description", () => {
    const markup = render({
      options: [
        { decision: "decline", label: "Decline" },
        { decision: "acceptAlways", label: "Always allow", warning: "Applies to every app" },
        { decision: "accept", label: "Approve" },
      ],
    });

    expect(markup).toMatch(
      /aria-description="Applies to every app"[^>]*data-approval-decision="acceptAlways"|data-approval-decision="acceptAlways"[^>]*aria-description="Applies to every app"/,
    );
  });

  it.each([
    ["the provider process is gone", { canRespond: false }],
    ["the thread cannot be operated", { disabled: true }],
    ["a response is in flight", { isResponding: true }],
  ])("disables every option when %s", (_, props) => {
    const markup = render({ ...props, onSwitchToFullAccess: () => undefined });
    const buttons = markup.match(/<button[^>]*>/g) ?? [];

    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(button).toContain("disabled");
  });

  it("offers Switch chat to Full access only when wired", () => {
    expect(render()).not.toContain("Switch chat to Full access");

    const markup = render({ onSwitchToFullAccess: () => undefined });
    expect(markup).toContain(">Switch chat to Full access<");
    expect(markup).toContain('title="Approves this and future requests in this chat"');
    expect(markup).toContain("data-access-glyph");
    expect(markup).toMatch(/<button[^>]*data-approval-full-access=""[^>]*>/);
  });

  it("calls the switch handler and the decision handler from their buttons", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSwitchToFullAccess = vi.fn();
    const onRespondToApproval = vi.fn(async () => undefined);
    await act(async () =>
      root.render(
        <ComposerPendingApprovalActions
          requestId={RuntimeRequestId.make("approval-1")}
          canRespond
          isResponding={false}
          onRespondToApproval={onRespondToApproval}
          onSwitchToFullAccess={onSwitchToFullAccess}
        />,
      ),
    );

    container.querySelector<HTMLButtonElement>("[data-approval-full-access]")!.click();
    container.querySelector<HTMLButtonElement>("[data-approval-decision='accept']")!.click();

    expect(onSwitchToFullAccess).toHaveBeenCalledTimes(1);
    expect(onRespondToApproval).toHaveBeenCalledWith("approval-1", "accept");
    act(() => root.unmount());
    container.remove();
  });
});

describe("orderApprovalOptions", () => {
  it("separates cancel and sorts the rest decline to accept, stably", () => {
    const options: ProviderApprovalOption[] = [
      { decision: "accept", label: "Approve" },
      { decision: "acceptAlways", label: "Always" },
      { decision: "cancel", label: "Stop" },
      { decision: "acceptForSession", label: "Session" },
      { decision: "decline", label: "No" },
    ];
    const { cancel, decisions } = orderApprovalOptions(options);

    expect(cancel?.label).toBe("Stop");
    expect(decisions.map((option) => option.decision)).toEqual([
      "decline",
      "acceptForSession",
      "acceptAlways",
      "accept",
    ]);
  });
});
