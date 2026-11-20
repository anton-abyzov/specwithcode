import type { CoordinatorMessageView, EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CoordinatorMessageCard, CoordinatorOutgoingMessages } from "./CoordinatorMessageCard";

const ID = `cm-${"a".repeat(40)}`;
const REPLY = `cm-${"b".repeat(40)}`;

function message(over: Partial<CoordinatorMessageView> = {}): CoordinatorMessageView {
  return {
    id: ID,
    externalId: "ext-1",
    direction: "incoming",
    peerEnvironmentId: "env-m5",
    kind: "finding",
    subject: "Tests fail on main",
    text: "Two tests fail.",
    refs: [],
    count: 1,
    state: "delivered",
    receivedAt: 1,
    updatedAt: 1,
    ...over,
  } as CoordinatorMessageView;
}

const thread = {
  kind: "thread",
  environmentId: "env-m5",
  threadId: "t-1",
  title: "Fix tests",
  statusAtSend: "Running",
} as const;

describe("CoordinatorMessageCard (1427 AC-18)", () => {
  it("links only an http(s) pull request", () => {
    const html = renderToStaticMarkup(
      <CoordinatorMessageCard
        all={[]}
        messages={[
          message({
            refs: [
              { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "Good" },
              { kind: "pull_request", url: "javascript:alert(1)", title: "Bad" },
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain('href="https://github.com/o/r/pull/1"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Bad");
  });

  it("shows a thread's live status, else its status when sent", () => {
    const card = (threadStatus?: (threadId: string, environmentId: string) => string | null) =>
      renderToStaticMarkup(
        <CoordinatorMessageCard
          all={[]}
          threadStatus={threadStatus}
          messages={[message({ refs: [thread] as unknown as CoordinatorMessageView["refs"] })]}
        />,
      );
    const live = card((threadId, environmentId) =>
      threadId === "t-1" && environmentId === "env-m5" ? "Done" : null,
    );
    expect(live).toContain('data-thread-status="live"');
    expect(live).toContain("Done");
    const atSend = card(() => null);
    expect(atSend).toContain('data-thread-status="at-send"');
    expect(atSend).toContain("Running when sent");
  });

  it("nests replies by default and not when every message has its own row", () => {
    const all = [
      message(),
      message({
        id: REPLY,
        externalId: "ext-2",
        direction: "outgoing",
        kind: "reply",
        subject: "On it",
        replyTo: "ext-1",
      } as Partial<CoordinatorMessageView>),
    ];
    const nested = renderToStaticMarkup(<CoordinatorMessageCard all={all} messages={[all[0]!]} />);
    const flat = renderToStaticMarkup(
      <CoordinatorMessageCard all={all} nestReplies={false} messages={[all[0]!]} />,
    );
    expect(nested).toContain("On it");
    expect(flat).not.toContain("On it");
  });

  it("offers the peer's coordinator on an outgoing line", () => {
    const html = renderToStaticMarkup(
      <CoordinatorOutgoingMessages
        all={[]}
        onOpenThread={(_thread: ThreadId, _env: EnvironmentId) => undefined}
        peerCoordinator={() => "coord-m5" as ThreadId}
        messages={[message({ direction: "outgoing" })]}
      />,
    );
    expect(html).toContain("sws-coordinator-message-open");
  });
});
