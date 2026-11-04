import type { AccessRequestItem } from "@specweave-studio/client-runtime/access-request";
import { ProviderDriverKind, ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AccessRequestCardView, AccessRequestPrompt, accessAgentLabel } from "./AccessRequestCard";

const at = DateTime.makeUnsafe("2026-11-04T15:20:00.000Z");
const item = (
  fields: Partial<Pick<AccessRequestItem, "accessStatus" | "accessScope">> = {},
): AccessRequestItem =>
  ({
    id: TurnItemId.make("turn-item:access-request:thread:1"),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    type: "access_request",
    accessTitle: "Use Notes and Control iPhone Duo",
    reason: "To copy the release notes onto the phone.",
    subjects: [
      {
        kind: "app",
        key: "app:notes",
        label: "Notes",
        detail: "See and control its windows",
        icon: { mimeType: "image/png", data: "iVBORw0KGgo=" },
      },
      {
        kind: "device",
        key: "device:iphone-duo",
        label: "iPhone Duo",
        detail: "See its screen, tap and type",
        hostLabel: "M1",
        platform: "ios",
      },
    ],
    accessStatus: "pending",
    ...fields,
  }) as AccessRequestItem;

const noAnswer = async () => null;

describe("AccessRequestPrompt", () => {
  it("names the agent, the reason, each subject with its tag, the note and the answers", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestPrompt item={item()} agentLabel="Claude" onAnswer={noAnswer} />,
    );

    expect(markup).toContain("Claude wants to use Notes and control iPhone Duo");
    expect(markup).toContain("To copy the release notes onto the phone.");
    expect(markup).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(markup).toContain("iPhone Duo");
    expect(markup).toContain(" on M1");
    expect(markup.match(/>All</g)).toHaveLength(2);
    expect(markup).toContain(
      "The agent can see your screen, click and type in these apps, and drive the device.",
    );
    expect(markup).toMatch(/data-access-decision="deny"[^>]*>Deny</);
    expect(markup).toMatch(/data-access-scope="thread"[^>]*>Allow for this session</);
    expect(markup).toMatch(/data-access-scope="machine"[^>]*>Always allow on this machine</);
    expect(markup).not.toContain('type="submit"');
    expect(markup).not.toContain("Studio");
  });

  it("falls back to The agent without a provider", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestPrompt item={item()} agentLabel={null} onAnswer={noAnswer} />,
    );

    expect(markup).toContain("The agent wants to use Notes and control iPhone Duo");
  });
});

describe("AccessRequestPrompt details", () => {
  it("shows a device's detail under its name and keeps an app's as the tooltip", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestPrompt item={item()} agentLabel="Claude" onAnswer={noAnswer} />,
    );

    expect(markup).toMatch(/data-access-subject-detail[^>]*>See its screen, tap and type</);
    expect(markup).not.toMatch(/data-access-subject-detail[^>]*>See and control its windows</);
    expect(markup).toContain('title="See and control its windows"');
    expect(markup).not.toContain('title="See its screen, tap and type"');
  });

  it("is a labelled region with a polite announcement and a described Always button", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestPrompt item={item()} agentLabel="Claude" onAnswer={noAnswer} />,
    );

    expect(markup).toMatch(/<section role="region"[^>]*aria-labelledby=/);
    expect(markup).toMatch(/role="status" aria-live="polite"/);
    expect(markup).toMatch(
      /aria-description="You can take back an Always grant in Settings → Integrations\."[^>]*>Always allow on this machine</,
    );
  });

  it("turns every answer off for a viewer who cannot operate the thread", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestPrompt item={item()} agentLabel="Claude" onAnswer={noAnswer} disabled />,
    );

    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
});

describe("AccessRequestCardView", () => {
  it("notes a pending request in the timeline without answering there", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestCardView item={item()} visibility="local" agentLabel="Codex" />,
    );

    expect(markup).toContain(
      "Waiting for your answer: Codex wants to use Notes and control iPhone Duo",
    );
    expect(markup).not.toContain("data-access-decision");
  });

  it.each([
    [{ accessStatus: "allowed", accessScope: "thread" }, "Allowed for this session"],
    [{ accessStatus: "allowed", accessScope: "machine" }, "Allowed on this machine"],
    [{ accessStatus: "denied" }, "Denied"],
    [{ accessStatus: "cancelled" }, "Request ended"],
  ] as const)("collapses an answered card to one line (%o)", (fields, label) => {
    const markup = renderToStaticMarkup(
      <AccessRequestCardView item={item(fields)} visibility="local" />,
    );

    expect(markup).toContain(`${label}: Use Notes and Control iPhone Duo`);
    expect(markup).not.toContain("data-access-decision");
  });

  it("only waits on a request inherited from another thread", () => {
    const markup = renderToStaticMarkup(
      <AccessRequestCardView item={item()} visibility="inherited" />,
    );

    expect(markup).toContain("Waiting for an answer in the original thread");
    expect(markup).not.toContain("data-access-decision");
  });
});

describe("accessAgentLabel", () => {
  it("uses the provider brand, an ACP agent's own name, or nothing", () => {
    expect(
      accessAgentLabel({
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Max",
      }),
    ).toBe("Claude");
    expect(
      accessAgentLabel({ driver: ProviderDriverKind.make("codex"), displayName: "Codex" }),
    ).toBe("Codex");
    expect(
      accessAgentLabel({ driver: ProviderDriverKind.make("acpRegistry"), displayName: "Copilot" }),
    ).toBe("Copilot");
    expect(accessAgentLabel(null)).toBe(null);
  });
});
