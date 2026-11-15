import type { SecretRequestItem } from "@specweave-studio/client-runtime/secret-request";
import { EnvironmentId, ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/server", () => ({ serverEnvironment: { answerSecretRequest: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { SecretRequestCard } from "./SecretRequestCard";

const askedAt = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
const pending: SecretRequestItem = {
  type: "secret_request",
  id: TurnItemId.make("turn-item:secret-request:1"),
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
  startedAt: askedAt,
  completedAt: null,
  updatedAt: askedAt,
  label: "Deploy token",
  reason: "Needed to publish the build",
  secretStatus: "pending",
};

const renderField = () => {
  const markup = renderToStaticMarkup(
    <SecretRequestCard
      environmentId={EnvironmentId.make("env-1")}
      item={pending}
      visibility="local"
    />,
  );
  const field = /<input[^>]*>/.exec(markup)?.[0];
  if (field === undefined) throw new Error("the pending card renders no field");
  return { markup, field };
};

describe("SecretRequestCard", () => {
  it("takes the secret in a password field, so assistive technology never reads it aloud", () => {
    const { markup, field } = renderField();
    expect(field).toContain('type="password"');
    expect(markup).not.toContain("text-security");
  });

  it("keeps the field out of password managers and autofill", () => {
    const { field } = renderField();
    expect(field).toContain('autoComplete="off"');
    expect(field).toContain("data-1p-ignore");
    expect(field).toContain('data-lpignore="true"');
    expect(field).toContain("data-bwignore");
  });
});
