import { describe, expect, it, vi } from "vite-plus/test";
import type { CloudSessionsSnapshot } from "@specweave-studio/contracts";
import { visitElements } from "../../test/reactElementTree";

vi.mock("./settingsLayout", () => ({ SettingsSection: () => null }));
vi.mock("../../studio/cloudSessions", () => ({ useCloudSessions: () => null }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
import { CloudSessionsCard, cloudSessionPlace } from "./CloudSessionsConnections";

const now = Date.parse("2026-10-16T12:00:00Z");
const snapshot: CloudSessionsSnapshot = {
  availability: {
    status: "ready",
    cliVersion: "2.1.301",
    authMethod: "claude.ai",
    subscriptionType: "max",
    reason: "Signed in with a claude.ai max plan; cloud sessions draw from its usage limits.",
    fix: null,
    checkedAt: "2026-10-16T11:59:00Z",
  },
  sessions: [
    {
      sessionId: "session_01Kw5qcBaa27jRK3Hjn4zsC2",
      url: "https://claude.ai/code/session_01Kw5qcBaa27jRK3Hjn4zsC2?from=cli",
      title: "Single-word OK reply",
      task: "Reply with OK",
      repositoryPath: "/Users/me/.specwithcode/m4/scratch/cloud-probe",
      branch: "main",
      remoteUrl: null,
      uploaded: true,
      projectId: null,
      createdByThreadId: null,
      createdAt: "2026-10-16T10:00:00Z",
      lastSentAt: "2026-10-16T11:30:00Z",
    },
  ],
};
const render = (overrides: Partial<Parameters<typeof CloudSessionsCard>[0]> = {}) =>
  CloudSessionsCard({
    snapshot,
    loading: false,
    failed: false,
    onCopy: vi.fn(),
    onRefresh: vi.fn(),
    now,
    ...overrides,
  });
const text = (tree: unknown): string => {
  const parts: Array<string> = [];
  visitElements(tree, (element) => {
    const children = element.props.children;
    const own = (Array.isArray(children) ? children : [children])
      .filter((child): child is string => typeof child === "string")
      .join("");
    if (own.length > 0) parts.push(own);
    return false;
  });
  return parts.join(" ");
};

describe("cloud sessions card", () => {
  it("names where a session ran", () => {
    expect(cloudSessionPlace(snapshot.sessions[0]!)).toBe("cloud-probe · main");
    expect(cloudSessionPlace({ repositoryPath: "C:\\work\\app", branch: null })).toBe("app");
  });
  it("shows readiness, the session link and a copyable teleport command", () => {
    const onCopy = vi.fn();
    const tree = render({ onCopy });
    const plain = text(tree);
    expect(plain).toContain("Ready");
    expect(plain).toContain("Claude Code 2.1.301");
    expect(plain).toContain("uploaded");
    expect(plain).toContain("Started 2h ago");
    const link = visitElements(tree, (element) => element.type === "a");
    expect(link?.props.href).toBe(snapshot.sessions[0]!.url);
    const copy = visitElements(tree, (element) =>
      String(element.props["aria-label"] ?? "").startsWith("Copy the teleport command"),
    );
    expect(plain).toContain("claude --teleport session_01Kw5qcBaa27jRK3Hjn4zsC2");
    (copy!.props.onClick as () => void)();
    expect(onCopy).toHaveBeenCalledExactlyOnceWith("session_01Kw5qcBaa27jRK3Hjn4zsC2");
    expect(text(render({ copied: "session_01Kw5qcBaa27jRK3Hjn4zsC2" }))).toContain("Copied");
  });
  it("tells the user the fix when sessions are not available", () => {
    const plain = text(
      render({
        snapshot: {
          availability: {
            ...snapshot.availability,
            status: "needs_login",
            reason: "Claude Code is not signed in.",
            fix: "Run `claude auth login` with a Pro, Max or Team account.",
          },
          sessions: [],
        },
      }),
    );
    expect(plain).toContain("Not available");
    expect(plain).toContain("Run `claude auth login`");
    expect(plain).toContain("No cloud sessions started from this server yet.");
    expect(text(render({ failed: true }))).toContain("could not be checked");
  });
});
