// @vitest-environment jsdom
import { RuntimeRequestId, type OrchestrationV2McpElicitation } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { McpElicitationForm } from "./McpElicitationForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requestId = RuntimeRequestId.make("elicitation-1");
const elicitation: OrchestrationV2McpElicitation = {
  serverName: "github",
  mode: "form",
  message: "Delete octo/repo? This cannot be undone.",
  requestedSchema: {
    type: "object",
    properties: {
      confirm: { type: "string", title: "Type octo/repo to confirm" },
      email: { type: "string", format: "email", title: "Notify" },
      keep: { type: "integer", title: "Days to keep", default: 7, minimum: 0 },
      archive: { type: "boolean", title: "Archive first", default: true },
      reason: {
        type: "string",
        title: "Reason",
        oneOf: [
          { const: "old", title: "No longer used" },
          { const: "dup", title: "Duplicate" },
        ],
      },
      teams: { type: "array", title: "Tell", items: { type: "string", enum: ["web", "ops"] } },
    },
    required: ["confirm"],
  },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const field = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-elicitation-field="${key}"]`)!;

const click = (element: Element | null) => act(() => (element as HTMLElement).click());

const form = (onRespond = vi.fn(async () => undefined)) => (
  <McpElicitationForm
    requestId={requestId}
    elicitation={elicitation}
    pendingCount={1}
    disabled={false}
    isResponding={false}
    onRespond={onRespond}
  />
);

describe("McpElicitationForm", () => {
  it("names the server, shows the message and every field with its default", () => {
    const markup = renderToStaticMarkup(form());
    expect(markup).toContain("github asks for input");
    expect(markup).toContain("Delete octo/repo? This cannot be undone.");
    for (const title of [
      "Type octo/repo to confirm",
      "Notify",
      "Days to keep",
      "Archive first",
      "No longer used",
      "Duplicate",
      "web",
      "ops",
    ])
      expect(markup).toContain(title);
    expect(markup).toContain('type="email"');
    expect(markup).toContain('value="7"');
    expect(markup).toContain("Never enter a password or secret here");
  });

  it("keeps a required field from being sent empty", () => {
    const onRespond = vi.fn(async () => undefined);
    const container = mount(form(onRespond));
    click(container.querySelector('[data-approval-decision="accept"]'));
    expect(onRespond).not.toHaveBeenCalled();
    expect(field(container, "confirm").textContent).toContain("Required.");
  });

  it("sends typed content with Submit", () => {
    const onRespond = vi.fn(async () => undefined);
    const container = mount(form(onRespond));
    typeInto(field(container, "confirm").querySelector("input")!, "octo/repo");
    click(field(container, "reason").querySelector('[data-elicitation-option="dup"]'));
    click(field(container, "teams").querySelector('[data-elicitation-option="ops"]'));
    click(container.querySelector('[data-approval-decision="accept"]'));
    expect(onRespond).toHaveBeenCalledWith(requestId, "accept", {
      confirm: "octo/repo",
      keep: 7,
      archive: true,
      reason: "dup",
      teams: ["ops"],
    });
  });

  it("shows a format error instead of sending", () => {
    const onRespond = vi.fn(async () => undefined);
    const container = mount(form(onRespond));
    typeInto(field(container, "confirm").querySelector("input")!, "octo/repo");
    typeInto(field(container, "email").querySelector("input")!, "not-an-email");
    click(container.querySelector('[data-approval-decision="accept"]'));
    expect(onRespond).not.toHaveBeenCalled();
    expect(field(container, "email").textContent).toContain("Enter an email address.");
  });

  it("never submits the composer form it sits in", () => {
    const onRespond = vi.fn(async () => undefined);
    const outerSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const container = mount(<form onSubmit={outerSubmit}>{form(onRespond)}</form>);
    click(container.querySelector('[data-approval-decision="accept"]'));
    expect(field(container, "confirm").textContent).toContain("Required.");
    const input = field(container, "confirm").querySelector("input")!;
    typeInto(input, "octo/repo");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => void input.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(onRespond).toHaveBeenCalledWith(
      requestId,
      "accept",
      expect.objectContaining({ confirm: "octo/repo" }),
    );
    expect(outerSubmit).not.toHaveBeenCalled();
  });

  it("maps Decline and Cancel without content", () => {
    const onRespond = vi.fn(async () => undefined);
    const container = mount(form(onRespond));
    click(container.querySelector('[data-approval-decision="decline"]'));
    click(container.querySelector('[data-approval-decision="cancel"]'));
    expect(onRespond.mock.calls).toEqual([
      [requestId, "decline"],
      [requestId, "cancel"],
    ]);
  });
});

describe("ComposerPendingApprovalPanel with an MCP form", () => {
  const approval = (extra: Partial<PendingApproval>): PendingApproval => ({
    requestId,
    requestKind: "mcp-elicitation",
    createdAt: "2026-11-24T00:00:00.000Z",
    detail: elicitation.message,
    appName: "github",
    responseCapability: "live",
    ...extra,
  });

  it("draws the form for a request that carries one", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={approval({ elicitation })}
        pendingCount={1}
        onRespond={async () => undefined}
      />,
    );
    expect(markup).toContain("data-mcp-elicitation-form");
    expect(markup).not.toContain("App access approval");
  });

  it("keeps today's approval for a request without a form", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={approval({})}
        pendingCount={1}
        onRespond={async () => undefined}
      />,
    );
    expect(markup).toContain("App access approval");
    expect(markup).not.toContain("data-mcp-elicitation-form");
  });

  it("says the provider is gone instead of drawing a form nobody can send", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={approval({ elicitation, responseCapability: "not_resumable" })}
        pendingCount={1}
        onRespond={async () => undefined}
      />,
    );
    expect(markup).toContain("Provider process is gone");
    expect(markup).not.toContain("data-mcp-elicitation-form");
  });
});
