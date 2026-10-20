import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const panel = vi.hoisted(() => ({ openPullRequest: vi.fn(), openFile: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => panel },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "host-1" }));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: "project-1",
      environmentId: "host-1",
      repositoryIdentity: {
        canonicalKey: "github.com/acme/app",
        provider: "github",
        owner: "acme",
        name: "app",
      },
    },
  ],
  useServerConfigs: () =>
    new Map([
      [
        "host-1",
        { environment: { capabilities: { pullRequests: true, threadPullRequests: true } } },
      ],
    ]),
}));

import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useViewerOverlayStore } from "../viewerOverlayStore";
import { useOpenChangeRequestLink } from "./openPullRequestLink";

const threadRef = { environmentId: "host-1", threadId: "thread-1" } as unknown as ScopedThreadRef;
const URL = "https://github.com/acme/app/pull/442";
const click = () => ({
  metaKey: false,
  ctrlKey: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

function useOpener(ref: ScopedThreadRef | undefined) {
  let opener!: ReturnType<typeof useOpenChangeRequestLink>;
  function Probe() {
    opener = useOpenChangeRequestLink(ref);
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return opener;
}

function openOverlay(threadRefInOverlay: ScopedThreadRef | null) {
  useViewerOverlayStore.getState().open({
    key: "report",
    title: "Reduce Mac load",
    kind: "Report",
    badge: "MD",
    detail: null,
    threadRef: threadRefInOverlay,
    origin: threadRefInOverlay ? null : "Library",
    trail: [],
    onBack: null,
  });
}

beforeEach(() => {
  panel.openPullRequest.mockClear();
  navigate.mockClear();
  const { active, close } = useViewerOverlayStore.getState();
  if (active) close(active.key);
});

describe("a pull request link clicked inside the viewer overlay", () => {
  it("opens the pull request in the overlay, not in the side panel behind it", () => {
    const open = useOpener(threadRef);
    openOverlay(threadRef);
    expect(open(click(), URL)).toBe(true);
    expect(panel.openPullRequest).not.toHaveBeenCalled();
    expect(useViewerOverlayStore.getState().linked).toMatchObject({
      kind: "pull-request",
      pullRequest: {
        environmentId: "host-1",
        threadRef,
        url: URL,
        reference: { projectId: "project-1", repository: "acme/app", number: 442 },
        panel: { ref: threadRef, target: { projectId: "project-1", number: 442 } },
      },
    });
  });

  it("does not move the page behind it when there is no thread to open beside", () => {
    const open = useOpener(undefined);
    openOverlay(null);
    expect(open(click(), URL)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(useViewerOverlayStore.getState().linked).toMatchObject({
      kind: "pull-request",
      pullRequest: { threadRef: null, panel: null },
    });
  });

  it("keeps opening beside the thread when no overlay is in front", () => {
    const open = useOpener(threadRef);
    expect(open(click(), URL)).toBe(true);
    expect(panel.openPullRequest).toHaveBeenCalledWith(
      threadRef,
      expect.objectContaining({ projectId: "project-1", number: 442, url: URL }),
    );
    expect(useViewerOverlayStore.getState().linked).toBeNull();
  });
});
