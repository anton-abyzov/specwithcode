import type { CoordinatorMessageView } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../studio/useCoordinatorMessages", () => ({ useCoordinatorMessages: () => ({}) }));

import { usePeerMessagePlacement } from "./ConversationCoordinatorMessages";

const id = (letter: string) => `cm-${letter.repeat(40)}`;

function message(letter: string, over: Partial<CoordinatorMessageView> = {}) {
  return {
    id: id(letter),
    externalId: `ext-${letter}`,
    direction: "incoming",
    peerEnvironmentId: "env-m5",
    kind: "finding",
    subject: letter,
    text: "",
    refs: [],
    count: 1,
    state: "delivered",
    receivedAt: letter.charCodeAt(0),
    updatedAt: 1,
    ...over,
  } as CoordinatorMessageView;
}

function place(
  all: CoordinatorMessageView[],
  rows: { message: { id: string; runId?: string | null } }[],
  firstShown: number,
) {
  let result: ReturnType<typeof usePeerMessagePlacement> | undefined;
  function Probe() {
    result = usePeerMessagePlacement(
      { byId: new Map(all.map((each) => [each.id, each])), card: { all } },
      rows,
      firstShown,
    );
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

describe("usePeerMessagePlacement (1427 AC-18)", () => {
  it("keeps incoming messages no row stands for, and none a hidden row already stands for", () => {
    const posted = message("a");
    const above = message("b");
    const quiet = message("c", { state: "quiet" });
    const sent = message("d", { direction: "outgoing" });
    const rows = [
      { message: { id: `coordinator-message:${above.id}:1` } },
      { message: { id: `coordinator-message:${posted.id}:1` } },
    ];
    const { cards, incomingRest } = place([posted, above, quiet, sent], rows, 1);
    expect([...cards.keys()]).toEqual([`coordinator-message:${posted.id}:1`]);
    expect(incomingRest.map((each) => each.id)).toEqual([quiet.id]);
  });
});
